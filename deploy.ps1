<#
AI Prism - full deploy from PowerShell (Windows), the equivalent of deploy.sh.

  .\deploy.ps1 <PROFILE> [CATALOG] [-Tag 'key=value',...] [-LakebaseSuspendMinutes N]
               [-UsagePolicyId ID] [-ClusterClassico ID] [-SkipBuild] [-SkipSmoke]
  .\deploy.ps1 -CheckTree

  PROFILE   CLI profile (databricks auth login --host <url> --profile <name>).
            No host is hard-coded here: the workspace is the profile's.
  CATALOG   Unity Catalog catalog that holds AI Prism's `default` schema (Python UDF +
            image volume). Default: ai_prism.

Resource tags (optional, see docs/tags.md): -Tag 'key=value','key2=value2' (an array;
one occurrence, values separated by commas). Also accepts -Tag "key=value,key2=value2"
as one string (the form that works with `powershell -File`, where the comma does not
split array elements). And/or TAGS in the environment. Up to 24 operator tags (+ the
built-in ai_prism_app = 25, the Jobs API maximum). ai_prism_app=ai-prism is always added
and cannot be overridden. Key/value: only letters, digits, space and + - = . : / @ (up
to 255 characters), the same rules as server/resourceTags.js.

Lakebase (optional): -LakebaseSuspendMinutes N (or LAKEBASE_SUSPEND_MINUTES), 1 to 10080
idle minutes before the database scales to zero.

Serverless usage (optional): -UsagePolicyId <id> (or SERVERLESS_USAGE_POLICY_ID) to
attribute the App and auto-config job usage to an existing serverless usage policy. The
bundle never creates the policy.

Workspace WITHOUT serverless: -ClusterClassico <id> (or CLASSIC_CLUSTER_ID) of a
Dedicated/Single user classic cluster. The SQL Warehouse becomes classic Pro and the
auto-config runs on that cluster.

Build and smoke (on by default): the script runs `npm run bundle` before deploying and
`npm run smoke` against the app URL at the end, with your OAuth token; either failing
makes the script fail. -SkipBuild (or AI_PRISM_SKIP_BUILD=1) deploys client/dist and
server-dist exactly as they are on disk (a release zip, a machine without Node).
-SkipSmoke (or AI_PRISM_SKIP_SMOKE=1) skips the post-deploy smoke.

Folder guard (no opt-out): `bundle deploy` uploads the WHOLE folder to the workspace and to the
App, and outside a git checkout it does not apply .gitignore. So, before any workspace call and
any write, the script refuses to run in the user profile folder or the disk root, and: outside a
git checkout, only in the exact tree of the customer ZIP (ai-prism-<version>.zip, built by
scripts/build-customer-zip.sh): ai-prism-manifest.txt must exist, list every file of the folder
(no extra file, no linked folder) and every listed file must have the sha256 in the manifest
(app.yaml only needs to exist: the deploy rewrites it); a folder that mixes versions is refused.
In that mode the build is skipped (the ZIP ships client/dist and server-dist) and the CLI's local
sync-snapshots are deleted before the deploy (never through a link). Inside a git checkout, only
when there is no untracked file outside .gitignore and the sync excludes of databricks.yml
(developers: AI_PRISM_ALLOW_UNTRACKED=1). -CheckTree runs ONLY this guard, prints the package
version and exits: no CLI, no profile, no network, nothing written or deleted. The first line
printed is `==> AI Prism <version> commit <sha>`.

Never deletes, never recreates: before any workspace write the script runs
`databricks bundle plan -o json` and aborts (fail closed, no opt-out) if the plan cannot be
read or holds any delete/recreate; it then applies exactly that checked plan with
`bundle deploy --plan` (CLI >= 1.17; Terraform state: migrate first, the script prints the
command). A cold Lakebase endpoint is woken first, and a deploy that hits its "Failed to
grant permissions ... deadline exceeded" is redone once, with a fresh plan and the same
gate. AI_PRISM_LAKEBASE_WAKE_TIMEOUT (default 120 s) caps the wait.

What it does: npm run bundle -> plan gate -> bundle deploy (Lakebase, SQL Warehouse, cost
and operations dashboards, job, app) -> start the app -> run the auto-config (SP role, your
app tables to the owner role, UDF, tags, volume, admin) -> `node scripts/migrate.mjs
prepare` (opens the owner hand-off) -> publish the code -> npm run smoke ->
`node scripts/migrate.mjs up --role <app SP>` as you, the database owner
(least-privilege grants; closes the hand-off). Once opened, every exit path closes the
hand-off and the run only succeeds when it is closed; without node it is never opened
and the run fails at the end. Safe to re-run (idempotent). Needs the Databricks CLI, plus Node 22 + npm with `npm ci` done
unless both -SkipBuild and -SkipSmoke; works on Windows PowerShell 5.1 and PowerShell 7.
#>
param(
  # Required, except with -CheckTree (it only checks the folder; see above)
  [Parameter(Position = 0)][string]$Perfil = '',
  [Parameter(Position = 1)][string]$Catalogo = 'ai_prism',
  # workspace WITHOUT serverless: id of a Dedicated/Single user classic cluster. The SQL
  # Warehouse becomes classic Pro and the auto-config runs on that cluster.
  [string]$ClusterClassico = $env:CLASSIC_CLUSTER_ID,
  # Resource tags: an array. One occurrence with values separated by commas
  # (-Tag 'a=1','b=2'), NOT -Tag a=1 -Tag b=2 (PowerShell rejects a repeated named
  # parameter). And/or TAGS="a=1,b=2" in the environment.
  [string[]]$Tag = @(),
  [string]$UsagePolicyId = $env:SERVERLESS_USAGE_POLICY_ID,
  # Lakebase (optional): idle minutes before the database scales to zero, 1 to 10080.
  [string]$LakebaseSuspendMinutes = $env:LAKEBASE_SUSPEND_MINUTES,
  # Deploy client/dist + server-dist as they are on disk (no `npm run bundle`).
  [switch]$SkipBuild,
  # No `npm run smoke` against the deployed app at the end.
  [switch]$SkipSmoke,
  # ONLY check the folder (the same guard the deploy runs), print the package version and exit: no CLI, no profile,
  # no network, nothing written or deleted.
  [switch]$CheckTree
)
$ErrorActionPreference = 'Stop'
if (-not $CheckTree -and -not $Perfil) { throw 'usage: .\deploy.ps1 <PROFILE> [CATALOG] [-Tag ...]  (or -CheckTree)' }
$App = 'ai-prism'
$Target = if ($env:AI_PRISM_TARGET) { $env:AI_PRISM_TARGET } else { 'dev' }
$Job = 'ai_prism_auto_config'
$Utf8 = New-Object System.Text.UTF8Encoding $false
if ($env:AI_PRISM_SKIP_BUILD -in @('1', 'true')) { $SkipBuild = $true }
if ($env:AI_PRISM_SKIP_SMOKE -in @('1', 'true')) { $SkipSmoke = $true }

# The CLI (Go) writes UTF-8, but PowerShell decodes the CAPTURED output of a native command with
# [Console]::OutputEncoding (on Windows the OEM code page: 850/437), which corrupts all non-ASCII
# text (the saved plan, paths, tag values...). Every capture goes through here: it forces UTF-8
# (no BOM) during the block and restores the console encoding at the end.
function Use-Utf8Output([scriptblock]$Block) {
  $old = $null
  try { $old = [Console]::OutputEncoding; [Console]::OutputEncoding = $Utf8 } catch { $old = $null }
  try { & $Block } finally { if ($null -ne $old) { try { [Console]::OutputEncoding = $old } catch { } } }
}
# CLI command that stops the script when it fails (exit code != 0)
function Invoke-Db {
  & databricks @args
  if ($LASTEXITCODE -ne 0) { throw "databricks $($args -join ' ') failed (exit code $LASTEXITCODE)" }
}
function Get-DbJson {
  $cliArgs = $args
  $out = Use-Utf8Output { & databricks @cliArgs }
  if ($LASTEXITCODE -ne 0) { throw "databricks $($args -join ' ') failed (exit code $LASTEXITCODE)" }
  ($out -join "`n") | ConvertFrom-Json
}
function Invoke-DatabricksCli($cliArgs) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $out = Use-Utf8Output { & databricks @cliArgs 2>&1 }
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  $std = @($out | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
  [pscustomobject]@{ Code = $code; Out = ($std -join "`n") }
}
function Read-Text($path) { [System.IO.File]::ReadAllText($path, $Utf8) }
function Write-Text($path, $text) { [System.IO.File]::WriteAllText($path, $text, $Utf8) }

# Folder guard: before any workspace call and any write (no opt-out; see deploy.sh for the full story). `bundle deploy`
# uploads the WHOLE folder (source_code_path ./) to the workspace and to the App, and outside a git checkout its sync does NOT
# apply .gitignore: a ZIP unpacked into Downloads or the user profile would upload PDFs, keys (.ssh, .aws,
# .databrickscfg)... So WITHOUT a git of its own in this folder the deploy only goes on when the folder is exactly the tree of
# the customer ZIP: ai-prism-manifest.txt (written by scripts/build-customer-zip.sh) lists every file with its sha256, and any
# file OUTSIDE it, or a listed file that is missing or differs, aborts. Exempt: what the deploy generates (.databricks/, a
# root node_modules/ from `npm ci`: the sync excludes both) and the junk the sync already excludes (.DS_Store, Thumbs.db,
# desktop.ini). In a git checkout (the git root is this folder) the untracked files that .gitignore does not cover are checked
# instead (below). AI_PRISM_ALLOW_UNTRACKED=1 (developers) turns the second check off.

# In a git checkout the folder is the git root, and the sync of `bundle deploy` also uploads UNTRACKED files that .gitignore does
# not cover (an id_rsa, credentials.json, a PDF, a forgotten server\token.txt). They are listed (git ls-files --others
# --exclude-standard), filtered by the SAME excludes as the sync (databricks.yml) and by the expected build outputs
# (server-dist/, client/dist/); if any is left, the deploy stops before any CLI call.
function Test-UntrackedFiles([string]$Dir) {
  if ($env:AI_PRISM_ALLOW_UNTRACKED -ceq '1') {
    Write-Warning 'AI_PRISM_ALLOW_UNTRACKED=1: not checking untracked files (the deploy uploads the ones .gitignore does not cover).'
    return
  }
  $lines = @()
  try {
    $lines = @(Use-Utf8Output { & git -C $Dir -c core.quotepath=off ls-files --others --exclude-standard 2>$null })
    if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed' }
  } catch {
    throw "could not list the untracked files ($($_.Exception.Message)); for safety the deploy does NOT go on: nothing was changed. Run it again, or use AI_PRISM_ALLOW_UNTRACKED=1 if you know what you are doing."
  }
  # sync excludes (block `sync:` > `exclude:` of databricks.yml)
  $pats = New-Object System.Collections.Generic.List[string]
  $yml = Join-Path $Dir 'databricks.yml'
  if (Test-Path -LiteralPath $yml) {
    $inSync = $false; $inBlock = $false
    foreach ($line in (Get-Content -LiteralPath $yml -Encoding UTF8)) {
      if (-not $inBlock) {
        if ($line -ceq 'sync:') { $inSync = $true }
        elseif ($inSync -and $line -ceq '  exclude:') { $inBlock = $true }
        elseif ($inSync -and $line -match '^\S') { $inSync = $false }
        continue
      }
      if ($line -match '^    - (.*)$') {
        $v = $Matches[1].Trim()
        if ($v.Length -ge 2 -and $v.StartsWith("'") -and $v.EndsWith("'")) { $v = $v.Substring(1, $v.Length - 2).Replace("''", "'") }
        $pats.Add($v)
      } elseif ($line.Trim() -eq '' -or $line.StartsWith('    #')) { continue } else { break }
    }
  }
  $rules = @()
  foreach ($raw in $pats) {
    $neg = $raw.StartsWith('!')
    $pat = if ($neg) { $raw.Substring(1) } else { $raw }
    $anchored = $pat.StartsWith('/')
    if ($anchored) { $pat = $pat.Substring(1) }
    if ($pat.EndsWith('/**')) { $pat = $pat.Substring(0, $pat.Length - 3) }
    if ($pat.Contains('/')) { $anchored = $true }
    $body = (@($pat.ToCharArray() | ForEach-Object { if ($_ -eq '*') { '[^/]*' } else { [regex]::Escape([string]$_) } }) -join '')
    $prefix = if ($anchored) { '^' } else { '(^|/)' }
    $rules += [pscustomobject]@{ Neg = $neg; Rx = [regex]($prefix + $body + '(/|$)') }
  }
  $isExcluded = { param($f) $out = $false; foreach ($r in $rules) { if ($r.Rx.IsMatch($f)) { $out = -not $r.Neg } }; $out }
  $extra = @($lines | Where-Object { $_ -and -not ($_.StartsWith('server-dist/') -or $_.StartsWith('client/dist/')) -and -not (& $isExcluded $_) } | Sort-Object)
  if ($extra.Count -gt 0) {
    $shown = ($extra | Select-Object -First 10) -join ', '
    if ($extra.Count -gt 10) { $shown += " (+$($extra.Count - 10))" }
    throw "this git checkout has $($extra.Count) UNTRACKED file(s) outside .gitignore that ``bundle deploy`` would upload to the workspace and to the App ($shown). The sync does not look at git for this: track them (git add), add them to .gitignore, move or delete them, and run again (developers who know what they are doing: AI_PRISM_ALLOW_UNTRACKED=1). Nothing was changed."
  }
}

function Test-ProjectTree([string]$Dir) {
  $norm = { param($p) [System.IO.Path]::GetFullPath($p).TrimEnd('\', '/') }
  $here = & $norm $Dir
  $userHome = if ($env:USERPROFILE) { & $norm $env:USERPROFILE } elseif ($HOME) { & $norm $HOME } else { $null }
  $hint = ' The deploy uploads the WHOLE folder to the workspace and to the App, so for safety nothing was changed. Unpack ai-prism-<version>.zip into an empty folder (it creates an ai-prism\ folder) and run .\deploy.ps1 from inside it.'
  if ($userHome -and ($here -ieq $userHome)) { throw "the deploy does not run in '$here' (the user profile folder): it would upload everything in it.$hint" }
  if ($here -eq [System.IO.Path]::GetPathRoot($here).TrimEnd('\', '/')) { throw "the deploy does not run in the disk root ($here).$hint" }
  if (Get-Command git -ErrorAction SilentlyContinue) {
    # --show-prefix is empty exactly when $Dir IS the git root (no path comparison: it holds with symlinked parents, such as
    # /var -> /private/var on macOS, and with the case-insensitive paths of Windows); a git above this folder gives a prefix.
    $isRoot = $false
    try {
      $prefixOut = Use-Utf8Output { & git -C $Dir rev-parse --show-prefix 2>$null }
      if ($LASTEXITCODE -eq 0 -and -not ((@($prefixOut) -join '').Trim())) { $isRoot = $true }
    } catch { $isRoot = $false }
    if ($isRoot) { $script:ProjectMode = 'git'; Test-UntrackedFiles $Dir; return }
  }
  $script:ProjectMode = 'zip'
  $manifest = Join-Path $Dir 'ai-prism-manifest.txt'
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "this folder is neither a git checkout nor the tree of the AI Prism ZIP (ai-prism-manifest.txt is missing).$hint" }
  $lines = @(Get-Content -LiteralPath $manifest -Encoding UTF8)
  if ($lines.Count -eq 0 -or $lines[0].Trim() -cne '# ai-prism-manifest 2') { throw "ai-prism-manifest.txt is unreadable or not a version this script knows.$hint" }
  $listed = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::OrdinalIgnoreCase)
  $optional = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)  # '# optional <file>': in the ZIP, outside the check (the Workspace import converts the installer notebook)
  foreach ($l in $lines) {
    $t = $l.TrimEnd("`r")
    if ($t.StartsWith('# optional ')) { [void]$optional.Add($t.Substring('# optional '.Length)); continue }
    if (-not $t.Trim() -or $t.StartsWith('#')) { continue }
    if (-not ($t -cmatch '^([0-9a-f]{64})  (.+)$')) { throw "ai-prism-manifest.txt is unreadable (unexpected line).$hint" }
    $listed[$Matches[2]] = $Matches[1]
  }
  $exempt = @('.DS_Store', 'Thumbs.db', 'desktop.ini')
  $extra = New-Object System.Collections.Generic.List[string]
  foreach ($it in (Get-ChildItem -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue)) {
    $rel = ($it.FullName.Substring($here.Length).TrimStart('\', '/')) -replace '\\', '/'
    # root folders the deploy itself creates and the sync excludes (.databricks: CLI state; node_modules: `npm ci`); a LINK with
    # either name is not exempt
    if (-not ($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      if ($rel -eq '.databricks' -or $rel.StartsWith('.databricks/') -or $rel -eq 'node_modules' -or $rel.StartsWith('node_modules/')) { continue }
    }
    if ($it.PSIsContainer) {
      # a folder link is not followed: its content would be invisible to this check
      if ($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $extra.Add($rel) }
      continue
    }
    if ($rel -ceq 'ai-prism-manifest.txt' -or $listed.ContainsKey($rel) -or $optional.Contains($rel) -or ($exempt -contains $it.Name)) { continue }
    $extra.Add($rel)
  }
  if ($extra.Count -gt 0) {
    $sorted = @($extra | Sort-Object)
    $shown = ($sorted | Select-Object -First 8) -join ', '
    if ($sorted.Count -gt 8) { $shown += " (+$($sorted.Count - 8))" }
    throw "this folder has $($sorted.Count) file(s) that are not part of AI Prism ($shown). If you imported a new version of the ZIP (Workspace -> Import) over an ai-prism/ folder that already existed, the files of the old version are still there (the import merges, it does not replace): import each version into a NEW, empty folder, or delete the old folder first.$hint"
  }
  # Every file in the manifest must exist and have exactly the sha256 of the ZIP (app.yaml and models.json are only required to
  # exist: the deploy rewrites app.yaml and models.json is editable by the user). A folder that mixes versions (an import over an
  # old folder) is refused even when the list of files is the same.
  $hashExempt = @('app.yaml', 'models.json')
  $bad = New-Object System.Collections.Generic.List[string]
  foreach ($rel in @($listed.Keys | Sort-Object)) {
    $path = Join-Path $Dir ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if (-not $item -or $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { $bad.Add("$rel (missing)"); continue }
    if ($hashExempt -contains $rel) { continue }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $listed[$rel]) { $bad.Add($rel) }
  }
  if ($bad.Count -gt 0) {
    $shownBad = (@($bad) | Select-Object -First 8) -join ', '
    if ($bad.Count -gt 8) { $shownBad += " (+$($bad.Count - 8))" }
    throw "this folder mixes versions of AI Prism: $($bad.Count) file(s) differ from the ZIP ($shownBad). That happens when a new ZIP is imported (Workspace -> Import) over an ai-prism/ folder that already existed: the import merges, it does not replace. Import each version into a NEW, empty folder, or delete the old folder first.$hint"
  }
}
$script:ProjectMode = ''
Test-ProjectTree $PSScriptRoot

# After the guard: print the package version (the ZIP manifest's; in a git checkout the package.json's plus the commit) and,
# OUTSIDE a git, delete the CLI's sync snapshots (.databricks/bundle/*/sync-snapshots, local state, nothing in the workspace).
# The CLI's incremental sync only uploads a file whose mtime is NEWER than the snapshot's, and the ZIP stamps the files with the
# commit date: an older ZIP unpacked over an already deployed folder would leave the new code out of the App. Without a snapshot
# the sync is complete. In a git checkout the mtimes are the real ones: nothing is touched.
function Get-ProjectVersion([string]$Dir) {
  $ver = ''
  if ($script:ProjectMode -eq 'zip') {
    $line = @(Get-Content -LiteralPath (Join-Path $Dir 'ai-prism-manifest.txt') -Encoding UTF8 -TotalCount 2)
    if ($line.Count -ge 2) { $ver = ($line[1] -replace '^# version ', '').Trim() }
  } else {
    try { $ver = [string](Get-Content -LiteralPath (Join-Path $Dir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { $ver = '' }
    try { $sha = (& git -C $Dir rev-parse --short HEAD 2>$null); if ($sha) { $ver = "$ver commit $sha".Trim() } } catch { }
  }
  if (-not $ver) { $ver = '(unknown version)' }
  return $ver
}
function Initialize-ProjectTree([string]$Dir) {
  Write-Host "==> AI Prism $(Get-ProjectVersion $Dir)"
  if ($script:ProjectMode -eq 'zip') {
    $root = [System.IO.Path]::GetFullPath($Dir).TrimEnd('\', '/')
    $isLink = { param($p) $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue; [bool]($i -and (($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or -not $i.PSIsContainer)) }
    $dbx = Join-Path $Dir '.databricks'
    $bundleDir = Join-Path $dbx 'bundle'
    foreach ($snap in @(Get-ChildItem -LiteralPath $bundleDir -Directory -Force -ErrorAction SilentlyContinue)) {
      $sd = Join-Path $snap.FullName 'sync-snapshots'
      if (-not (Test-Path -LiteralPath $sd)) { continue }
      # NEVER delete through a path that goes through a link: every component from .databricks to sync-snapshots must be a real
      # folder and the path must stay inside this folder; otherwise the deploy STOPS, deleting nothing.
      $full = [System.IO.Path]::GetFullPath($sd)
      $inside = $full.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
      if (-not $inside -or (& $isLink $dbx) -or (& $isLink $bundleDir) -or (& $isLink $snap.FullName) -or (& $isLink $sd)) {
        throw "'$sd' (or a folder on the path to it) is a link or is not inside this folder: for safety nothing was deleted and the deploy stopped. Remove the link (or the .databricks folder) and run again."
      }
      Remove-Item -LiteralPath $sd -Recurse -Force
    }
  }
}
if ($CheckTree) {
  Write-Host "==> AI Prism $(Get-ProjectVersion $PSScriptRoot)"
  Write-Host 'The folder matches the package (folder guard: ok). Nothing was changed.'
  return
}
Initialize-ProjectTree $PSScriptRoot

# The sync re-admits the root .npmrc and .nvmrc (databricks.yml); they have to be regular FILES. A folder (or a link) with that
# name aborts here, before any workspace call. Missing is fine.
foreach ($npmName in @('.npmrc', '.nvmrc')) {
  $npmItem = Get-Item -LiteralPath (Join-Path $PSScriptRoot $npmName) -Force -ErrorAction SilentlyContinue
  if ($npmItem -and ($npmItem.PSIsContainer -or ($npmItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint))) {
    throw "'$npmName' exists but is not a regular file (it is a folder or a link): the deploy uploads that name to the workspace and to the App and only accepts a plain file. Remove or rename '$npmName' and run again. Nothing was changed."
  }
}
# In the customer ZIP the package ships client/dist and server-dist already built and the manifest pins their hash: building
# again would need `npm ci --include=dev` and would change those files, so the next run would be refused.
if ($script:ProjectMode -eq 'zip' -and -not $SkipBuild) {
  $SkipBuild = $true
  Write-Host '==> ZIP package: build skipped (client/dist + server-dist come built in the ZIP)'
}

if (-not (Get-Command databricks -ErrorAction SilentlyContinue)) {
  throw 'Databricks CLI not found. Install it with: winget install Databricks.DatabricksCLI (and open a new PowerShell).'
}
# The build and the smoke both need npm (and Node 22). Fail now, not after the deploy.
if ((-not $SkipBuild -or -not $SkipSmoke) -and -not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw ('npm not found: install Node 22 and run `npm ci` so the deploy can build the app and smoke it, ' +
    'or pass -SkipBuild -SkipSmoke (AI_PRISM_SKIP_BUILD=1 AI_PRISM_SKIP_SMOKE=1) to deploy client/dist + ' +
    'server-dist exactly as they are on disk, without the post-deploy smoke.')
}

# Prerequisite of the never-delete-or-recreate guarantee (the plan gate below): the CLI must have
# `bundle plan` and `bundle deploy --plan` (CLI >= 1.17, the version the installer notebook pins).
# Without both the deploy aborts here, before any workspace call - no opt-out.
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$deployHelp = (Use-Utf8Output { & databricks bundle deploy --help 2>&1 }) -join "`n"
& databricks bundle plan --help *> $null
$planHelpCode = $LASTEXITCODE
$cliVersion = (Use-Utf8Output { & databricks --version 2>&1 } | Select-Object -First 1)
$ErrorActionPreference = $prev
if ($planHelpCode -ne 0 -or $deployHelp -notmatch '--plan') {
  throw "this Databricks CLI ($cliVersion) has no ``bundle plan`` and ``bundle deploy --plan``, which the never-delete-or-recreate guarantee depends on. Update the CLI (>= 1.17) and run again - nothing was changed."
}

Set-Location -Path $PSScriptRoot
$AppYaml = Join-Path $PSScriptRoot 'app.yaml'

# Lakebase (soft delete): an earlier `databricks bundle destroy` leaves the project
# deleted in a reversible way, holding the name. Checked BEFORE the deploy, printing
# both commands; it NEVER purges by itself.
function Test-LakebaseProject($projectId, $perfil) {
  $get = Invoke-DatabricksCli @('postgres', 'get-project', "projects/$projectId", '-p', $perfil, '-o', 'json')
  if ($get.Code -ne 0) { return }  # no such project (fresh install) or API unavailable: do not block
  try { $proj = $get.Out | ConvertFrom-Json } catch { $proj = $null }

  $list = Invoke-DatabricksCli @('postgres', 'list-projects', '-p', $perfil, '-o', 'json')
  if ($list.Code -ne 0) { return }  # could not confirm: let bundle deploy try
  try { $ativos = @(($list.Out | ConvertFrom-Json) | ForEach-Object { $_.project_id }) } catch { return }
  if ($ativos -contains $projectId) { return }  # normal active project

  $deleteTime = $null
  if ($proj) {
    $deleteTime = $proj.delete_time
    if ((-not $deleteTime) -and $proj.status) { $deleteTime = $proj.status.delete_time }
  }
  $when = if ($deleteTime) { " (delete_time=$deleteTime)" } else { '' }
  throw (
    "`nThe Lakebase project 'projects/$projectId' is soft-deleted$when, probably by an earlier " +
    "databricks bundle destroy, and it still holds that name, so this deploy would fail " +
    "trying to recreate it.`n`n" +
    "Pick one and run .\deploy.ps1 again:`n" +
    "  1) Restore the old project (recovers the Lakebase data; NOT destructive):`n" +
    "       databricks postgres undelete-project projects/$projectId -p $perfil`n" +
    "  2) Delete the old project FOR GOOD and free the name (DESTRUCTIVE: its data is " +
    "lost forever; make sure this is what you want before running it):`n" +
    "       databricks postgres delete-project projects/$projectId -p $perfil --purge`n`n" +
    "See docs/onboarding-deployment.md (troubleshooting) for more context.`n"
  )
}
Write-Host "==> Lakebase: checking that project $App is not soft-deleted by an earlier destroy"
Test-LakebaseProject $App $Perfil

# Build: client/dist + server-dist are what the App runs. Feature branches do not
# commit them (their file names carry a content hash), so the copy on disk can be
# older than the code. Built here, before anything is deployed; a failed build stops.
if ($SkipBuild) {
  Write-Host '==> build skipped (-SkipBuild): deploying client/dist + server-dist as they are on disk'
} else {
  Write-Host '==> npm run bundle (client/dist + server-dist)'
  & npm run bundle
  if ($LASTEXITCODE -ne 0) {
    throw ('npm run bundle failed: nothing was deployed. Fix the build (did you run `npm ci`?), ' +
      'or pass -SkipBuild to deploy the artifacts already on disk.')
  }
}

Write-Host "==> catalog: $Catalogo  ·  profile: $Perfil  ·  target: $Target"
# The App runtime reads env ONLY from app.yaml (not from the bundle variables), so the
# catalog has to be written there too.
$yaml = Read-Text $AppYaml
$yaml = [regex]::Replace($yaml, "(name: (?:TOOLS_CATALOG|IMAGE_VOLUME_CATALOG)\r?\n\s*value: )'[^']*'", { param($mm) $mm.Groups[1].Value + "'" + $Catalogo + "'" })

$Vars = @('--var', "tools_catalog=$Catalogo", '--var', "image_volume_catalog=$Catalogo")
if ($ClusterClassico) {
  Write-Host "==> no serverless: classic Pro warehouse; auto-config on cluster $ClusterClassico"
  $Vars += @('--var', 'warehouse_serverless=false')
}
if ($UsagePolicyId) {
  $Vars += @('--var', "serverless_usage_policy_id=$UsagePolicyId")
}
if ($LakebaseSuspendMinutes) {
  $min = 0
  if (-not [int]::TryParse($LakebaseSuspendMinutes, [ref]$min) -or $min -lt 1 -or $min -gt 10080) { throw 'LakebaseSuspendMinutes must be a number from 1 to 10080 (minutes)' }
  Write-Host "==> Lakebase scales to zero after $min min idle"
  $Vars += @('--var', "lakebase_suspend_timeout=$($min * 60)s")
}

# Resource tags. resource_tags/resource_tags_list are COMPLEX variables (map/list):
# they go through .databricks/bundle/<target>/variable-overrides.json. resource_tags_json
# (a plain string) goes through $env:BUNDLE_VAR_resource_tags_json.
# Each -Tag element is also split on commas: under `powershell -File`, -Tag 'a=1','b=2'
# arrives as one element "a=1,b=2". On an element without a comma (native invocation)
# the split does nothing.
$TagPairs = @($Tag | ForEach-Object { $_ -split ',' } | Where-Object { $_.Trim() })
if ($env:TAGS) { $TagPairs = @($env:TAGS -split ',' | Where-Object { $_.Trim() }) + $TagPairs }
# Key/value: the same explicit Unicode-category class as server/resourceTags.js
# (\p{L}\p{N}, + '_'). .NET's \w is not the same set (it accepts combining marks).
$TagRe = '^[\p{L}\p{N}_+\-=.:/@ ]{1,255}$'
# Jobs API: at most 25 tags in total. 24 from the operator + ai_prism_app = 25.
# The letter-case collision check runs BEFORE any write, comparing ToLowerInvariant()
# by hand (PowerShell's hashtable is already case-insensitive and would silently
# overwrite one key with the other).
$MaxOperatorTags = 24
$ResourceTags = [ordered]@{}
$SeenKeysByLowerCase = @{}
foreach ($pair in $TagPairs) {
  if ($pair -notmatch '=') { throw "invalid tag (use key=value): $pair" }
  $idx = $pair.IndexOf('=')
  $k = $pair.Substring(0, $idx).Trim()
  $v = $pair.Substring($idx + 1).Trim()
  $kLower = $k.ToLowerInvariant()
  if ($kLower -eq 'ai_prism_app') {
    Write-Warning "the '$k' tag is built in and cannot be overridden; the value given was ignored."
    continue
  }
  if ($kLower -eq 'application') {
    Write-Warning "the '$k' tag is reserved (it attributes cost to AI Prism); the value given was ignored."
    continue
  }
  if ($k -cnotmatch $TagRe) { throw "invalid tag key '$k': use only letters, digits, space and + - = . : / @ (up to 255 characters)" }
  if ($v -ne '' -and $v -cnotmatch $TagRe) { throw "invalid tag value for '$k' ('$v'): use only letters, digits, space and + - = . : / @ (up to 255 characters)" }
  if ($SeenKeysByLowerCase.ContainsKey($kLower)) {
    throw "tag '$k' differs from '$($SeenKeysByLowerCase[$kLower])' only by letter case; use one spelling"
  }
  if ($ResourceTags.Count -ge $MaxOperatorTags) {
    throw "more than $MaxOperatorTags operator tags (Jobs API limit: 25 in total, including the built-in ai_prism_app tag); remove some and run again"
  }
  $ResourceTags[$k] = $v
  $SeenKeysByLowerCase[$kLower] = $k
}
$ResourceTags['ai_prism_app'] = $App
$ResourceTagsList = @($ResourceTags.Keys | ForEach-Object { [ordered]@{ key = $_; value = $ResourceTags[$_] } })
$ResourceTagsJson = $ResourceTags | ConvertTo-Json -Compress
Write-Host "==> resource tags: $(($ResourceTags.Keys | ForEach-Object { "$_=$($ResourceTags[$_])" }) -join ', ')"

# AI_PRISM_RESOURCE_TAGS in app.yaml (read at runtime by server/resourceTags.js).
# [regex]::Replace with a callback, so the JSON is not escaped for the regex engine.
$yaml = [regex]::Replace($yaml, "(name: AI_PRISM_RESOURCE_TAGS\r?\n\s*value: )'[^']*'", { param($mm) $mm.Groups[1].Value + "'" + $ResourceTagsJson + "'" })
Write-Text $AppYaml $yaml

$OverridesDir = Join-Path $PSScriptRoot ".databricks\bundle\$Target"
New-Item -ItemType Directory -Force -Path $OverridesDir | Out-Null
$OverridesPath = Join-Path $OverridesDir 'variable-overrides.json'
# PSCustomObject (not a hashtable): ConvertFrom-Json -AsHashtable only exists in PowerShell 6+,
# and this script also runs on 5.1.
$Overrides = if (Test-Path $OverridesPath) { try { Read-Text $OverridesPath | ConvertFrom-Json } catch { [pscustomobject]@{} } } else { [pscustomobject]@{} }
if ($null -eq $Overrides) { $Overrides = [pscustomobject]@{} }
$Overrides | Add-Member -NotePropertyName 'resource_tags' -NotePropertyValue $ResourceTags -Force
$Overrides | Add-Member -NotePropertyName 'resource_tags_list' -NotePropertyValue $ResourceTagsList -Force
Write-Text $OverridesPath ($Overrides | ConvertTo-Json -Depth 10)
$env:BUNDLE_VAR_resource_tags_json = $ResourceTagsJson

# Plan gate: nothing is written to the workspace before the plan is checked. This deploy NEVER
# deletes a user resource nor replaces/recreates an existing one. `bundle plan -o json` is
# read-only and gives the action of every bundle resource. The check FAILS CLOSED and has no
# opt-out: a command error, output that is not JSON, an unexpected shape or any delete/recreate
# aborts BEFORE the first workspace write. There is no CLI confirmation to lean on: `bundle
# deploy` asks nothing for apps, jobs, sql_warehouses or postgres_endpoints. So what is applied
# is EXACTLY the checked plan: the saved JSON goes to `bundle deploy --plan` (direct engine;
# same on the CLI 1.17.0 the installer notebook pins and on 1.24.0), without re-planning. A plan
# without `plan_version` (state still on Terraform) ABORTS with the migration command.
# Cold Lakebase: with the endpoint idle (suspend_timeout), the database grant for the App that
# `bundle deploy` makes can time out ("Failed to grant permissions ... deadline exceeded") and
# leave a half-applied deploy. Before the deploy, if the endpoint already exists and is not
# ACTIVE, it is woken up and awaited until ACTIVE. Waking = opening and closing one
# authenticated Postgres connection (the protocol handshake, .NET only, no SQL, no write) with
# your own OAuth credential (`databricks postgres generate-database-credential`). Best effort:
# any failure only warns and the deploy goes on (the retry below covers the rest). First deploy
# (no endpoint yet): nothing to do. Timeout: AI_PRISM_LAKEBASE_WAKE_TIMEOUT (seconds, 120).
function Get-LakebaseEndpointState([string]$Endpoint) {
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $o = Use-Utf8Output { & databricks postgres get-endpoint $Endpoint -p $Perfil -o json 2>$null }
    if ($LASTEXITCODE -ne 0) { return $null }
    $st = ((($o -join "`n") | ConvertFrom-Json).status)
    if ($null -eq $st) { return $null }
    return [pscustomobject]@{ State = [string]$st.current_state; Host = [string]$st.hosts.host; Disabled = [bool]$st.disabled }
  } catch { return $null } finally { $ErrorActionPreference = $prevEap }
}
function Wake-LakebaseEndpoint {
  $endpoint = "projects/$App/branches/production/endpoints/primary"
  $cur = Get-LakebaseEndpointState $endpoint
  if ($null -eq $cur -or $cur.Disabled) { return }
  if ($cur.State -ceq 'ACTIVE') { Write-Host '    Lakebase: endpoint ACTIVE'; return }
  Write-Host "    Lakebase: endpoint $($cur.State); waking it (read-only) so the deploy does not hit a cold database..."
  $tcp = $null; $tls = $null
  $prevEap = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $cred = (Use-Utf8Output { & databricks postgres generate-database-credential $endpoint -p $Perfil -o json 2>$null }) -join "`n" | ConvertFrom-Json
    $me = (Use-Utf8Output { & databricks current-user me -p $Perfil -o json 2>$null }) -join "`n" | ConvertFrom-Json
    $ErrorActionPreference = $prevEap
    $port = if ($env:AI_PRISM_PG_PORT) { [int]$env:AI_PRISM_PG_PORT } else { 5432 }
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.ReceiveTimeout = 120000; $tcp.SendTimeout = 60000
    $tcp.Connect($cur.Host, $port)
    $raw = $tcp.GetStream()
    $be = { param([int]$n) $b = [BitConverter]::GetBytes($n); [Array]::Reverse($b); $b }   # int32 big-endian
    $raw.Write(([byte[]]((& $be 8) + (& $be 80877103))), 0, 8)                              # SSLRequest
    if ($raw.ReadByte() -ne [int][char]'S') { throw 'the server did not accept TLS' }
    $tls = New-Object System.Net.Security.SslStream($raw, $false)
    $tls.AuthenticateAsClient($cur.Host)
    $params = [System.Text.Encoding]::UTF8.GetBytes("user`0$($me.userName)`0database`0databricks_postgres`0`0")
    $tls.Write(([byte[]]((& $be (8 + $params.Length)) + (& $be 196608) + $params)), 0, 8 + $params.Length)
    $readN = { param([int]$n) $buf = New-Object byte[] $n; $got = 0; while ($got -lt $n) { $r = $tls.Read($buf, $got, $n - $got); if ($r -le 0) { return $null }; $got += $r }; $buf }
    while ($true) {
      $h = & $readN 5
      if ($null -eq $h) { break }
      $len = ([int]$h[1] -shl 24) -bor ([int]$h[2] -shl 16) -bor ([int]$h[3] -shl 8) -bor [int]$h[4]
      $body = if ($len -gt 4) { & $readN ($len - 4) } else { [byte[]]@() }
      $t = [char]$h[0]
      if ($t -ceq 'Z' -or $t -ceq 'E') { break }
      if ($t -ceq 'R' -and $body.Length -ge 4 -and $body[3] -eq 3) {                         # AuthenticationCleartextPassword (OAuth token)
        $pw = [System.Text.Encoding]::UTF8.GetBytes([string]$cred.token) + [byte]0
        $tls.Write(([byte[]]((,[byte][char]'p') + (& $be (4 + $pw.Length)) + $pw)), 0, 5 + $pw.Length)
      }
    }
    $tls.Write(([byte[]]((,[byte][char]'X') + (& $be 4))), 0, 5)
  } catch {
    Write-Warning "could not wake Lakebase by connecting ($($_.Exception.GetType().Name): $("$($_.Exception.Message)".Substring(0, [Math]::Min(160, "$($_.Exception.Message)".Length)))); going on - if the deploy times out it retries once."
  } finally {
    $ErrorActionPreference = $prevEap
    try { if ($tls) { $tls.Dispose() } } catch { }
    try { if ($tcp) { $tcp.Close() } } catch { }
  }
  $limit = 120
  if ($env:AI_PRISM_LAKEBASE_WAKE_TIMEOUT) { $parsed = 0; if ([int]::TryParse($env:AI_PRISM_LAKEBASE_WAKE_TIMEOUT, [ref]$parsed)) { $limit = $parsed } }
  $end = (Get-Date).AddSeconds($limit)
  while ((Get-Date) -lt $end) {
    $cur = Get-LakebaseEndpointState $endpoint
    if ($cur -and $cur.State -ceq 'ACTIVE') { Write-Host '    Lakebase: endpoint ACTIVE'; return }
    Start-Sleep -Seconds 3
  }
  Write-Warning "the Lakebase endpoint is still not ACTIVE (state: $($cur.State)); going on with the deploy."
}

# The gate is a scriptblock run in the script scope (`. $InvokePlanGate`, dot-sourced so $planFile
# etc. stay visible afterwards) so it can run again, with a fresh plan, on the deploy retry.
$GateRetry = $false
$InvokePlanGate = {
  # On the retry ($GateRetry) the first deploy may have been partly applied: "nothing was changed" would be untrue.
  $nothing = if ($GateRetry) { 'the first deploy may have been partly applied (whatever it already created or updated is still there) and this retry changed nothing more; running the deploy again is safe (idempotent)' } else { 'nothing was changed in the workspace' }
  Write-Host '==> bundle plan (checking that nothing will be deleted or recreated)'
  $planFile = [System.IO.Path]::GetTempFileName()
  $planErrFile = [System.IO.Path]::GetTempFileName()
  # Use-Utf8Output does not fail the deploy when the host has no console (the encoding switch fails
  # silently); that cannot pass here: a plan decoded in the OEM page would carry corrupted text to
  # `bundle deploy --plan`. Check, BEFORE capturing the plan, that the capture really is UTF-8 (65001).
  $captureCodePage = Use-Utf8Output { try { [Console]::OutputEncoding.CodePage } catch { 0 } }
  if ($captureCodePage -ne 65001) {
    Remove-Item $planFile, $planErrFile -Force -ErrorAction SilentlyContinue
    throw "could not set the CLI output capture to UTF-8 (code page $captureCodePage; this host probably has no console). Without it the saved plan, which the deploy applies, would come out with corrupted accents - so the deploy does NOT go on. Run it in a PowerShell with a console (powershell.exe/pwsh) - nothing was changed."
  }
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $planOut = Use-Utf8Output { & databricks bundle plan -p $Perfil -t $Target @Vars -o json 2>$planErrFile }
  $planCode = $LASTEXITCODE
  $ErrorActionPreference = $prev
  $planErr = ''
  try { $planErr = Read-Text $planErrFile } catch { $planErr = '' }
  Remove-Item $planErrFile -Force -ErrorAction SilentlyContinue
  $planText = ($planOut -join "`n")
  $planFail = $null
  $planObj = $null
  # migration command (Terraform -> direct engine) with the SAME --var of this deploy (copy/paste: EVERY
  # argument in single quotes, escaped by PowerShell itself - it also treats U+2018/U+2019/U+201A/U+201B
  # as single quotes, so a profile like d'angelo or d’angelo would paste fine)
  $migrateArgs = @('-t', $Target, '-p', $Perfil) + @($Vars) | ForEach-Object { "'" + [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent("$_") + "'" }
  $migrateCmd = 'databricks bundle deployment migrate ' + ($migrateArgs -join ' ')
  if ($planCode -ne 0) {
    $planFail = "could not get the bundle plan (``databricks bundle plan -o json`` failed: $($planErr.Trim()))"
  } else {
    try { $planObj = $planText | ConvertFrom-Json } catch { $planObj = $null }
    $planRes = @()
    if ($null -ne $planObj -and $null -ne $planObj.plan) {
      $planRes = @($planObj.plan.PSObject.Properties | Where-Object { $_.Name -like 'resources.*' })
    }
    if ($planRes.Count -eq 0 -or @($planRes | Where-Object { $_.Value -isnot [pscustomobject] -or $_.Value.action -isnot [string] }).Count -gt 0) {
      $planFail = 'the `bundle plan -o json` output is empty, unreadable or has an unexpected shape'
    } elseif ($null -eq $planObj.PSObject.Properties['plan_version']) {
      $planFail = "this ``bundle plan`` is not a saved direct-engine plan (no ``plan_version``): this installation still uses Terraform state. The deploy only applies EXACTLY the checked plan (``bundle deploy --plan``), which needs the direct engine - and it never deploys without a checked plan. Migrate the state first (local only, it does not change the workspace; the ``bundle deploy`` of this script then syncs it): ``$migrateCmd`` and run the deploy again"
    }
  }
  if ($planFail) {
    Remove-Item $planFile -Force -ErrorAction SilentlyContinue
    throw "$planFail. For safety the deploy does NOT go on without checking that nothing will be deleted or recreated - $nothing. Fix the error above (update the Databricks CLI to >= 1.17 if needed) and run again."
  }
  $ruins = @($planRes | Where-Object { @('delete', 'recreate') -contains $_.Value.action.ToLower() } | ForEach-Object { "$($_.Name) ($($_.Value.action))" })
  if ($ruins.Count -gt 0) {
    Remove-Item $planFile -Force -ErrorAction SilentlyContinue
    throw ("The bundle plan would delete or recreate existing resources:`n  - " + ($ruins -join "`n  - ") + "`nThis deploy never deletes or recreates an existing resource - $nothing. Review the difference with ``databricks bundle plan -t $Target`` before going on.")
  }
  $planCounts = @($planRes | Group-Object { $_.Value.action.ToLower() } | Sort-Object Name | ForEach-Object { "$($_.Count) $($_.Name)" })
  Write-Host "    plan: $($planCounts -join ', ')"
  Write-Host '    ok: no resource will be deleted or recreated'
  Write-Text $planFile $planText
}
. $InvokePlanGate

Write-Host '==> bundle deploy'
# Wake Lakebase first (see Wake-LakebaseEndpoint). If the deploy still hits the deadline of the
# database grant ("Failed to grant permissions ... deadline exceeded": the database was cold), wake
# it again, redo the plan AND THE GATE (the check is never skipped) and retry ONCE, applying exactly
# the new checked plan. Any other error, or a second failure, aborts.
Wake-LakebaseEndpoint
function Invoke-BundleDeploy {
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $script:deployLog = @()
  & databricks bundle deploy -p $Perfil -t $Target @Vars --plan $planFile 2>&1 | Tee-Object -Variable script:deployLog | ForEach-Object { Write-Host "$_" }
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  return $rc
}
$deployRc = Invoke-BundleDeploy
if ($deployRc -ne 0) {
  if (($script:deployLog -join "`n") -match 'Failed to grant permissions for .* on database projects/\S*: deadline exceeded') {
    Write-Warning 'the deploy hit the deadline granting the database permission on Lakebase (cold database): waking it, redoing the checked plan and retrying ONCE'
    Remove-Item $planFile -Force -ErrorAction SilentlyContinue
    Wake-LakebaseEndpoint
    $GateRetry = $true
    . $InvokePlanGate
    $deployRc = Invoke-BundleDeploy
    if ($deployRc -ne 0) {
      Remove-Item $planFile -Force -ErrorAction SilentlyContinue
      throw "the deploy failed again after the retry (exit code $deployRc); nothing more will be tried. Run .\deploy.ps1 once more (it is idempotent)."
    }
  } else {
    Remove-Item $planFile -Force -ErrorAction SilentlyContinue
    throw "databricks bundle deploy failed (exit code $deployRc)"
  }
}
Remove-Item $planFile -Force -ErrorAction SilentlyContinue

Write-Host '==> start the app (ignored if it is already running)'
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& databricks apps start $App -p $Perfil *> $null
$ErrorActionPreference = $prev

Write-Host '==> auto-config (SP role + app tables to the owner role in Lakebase, UDF, volume, tags, admin)'
if (-not $ClusterClassico) {
  Invoke-Db bundle run $Job -p $Perfil -t $Target @Vars
} else {
  # same task as the job (parameters already resolved by the bundle), as a one-off
  # run on the classic cluster: the bundle job would use serverless compute
  $JobId = (Get-DbJson bundle summary -p $Perfil -t $Target @Vars -o json).resources.jobs.$Job.id
  $task = (Get-DbJson jobs get $JobId -p $Perfil -o json).settings.tasks[0]
  $submit = @{ run_name = 'ai-prism auto-config (classic cluster)'; tasks = @(@{
      task_key = $task.task_key; notebook_task = $task.notebook_task; existing_cluster_id = $ClusterClassico }) }
  $tmp = [System.IO.Path]::GetTempFileName()
  Write-Text $tmp ($submit | ConvertTo-Json -Depth 10)
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $out = (& databricks jobs submit --json "@$tmp" -p $Perfil --timeout 40m -o json 2>&1) -join "`n"
  $ErrorActionPreference = $prev
  Remove-Item $tmp -Force
  # the command can exit 0 with the run FAILED: check result_state explicitly
  $i = $out.IndexOf('{')
  if ($i -lt 0) { throw "auto-config: the run did not finish (CLI output: $($out.Trim()))" }
  $run = $out.Substring($i) | ConvertFrom-Json
  $states = @($run.state) + @($run.tasks | ForEach-Object { $_.state })
  $bad = @($states | Where-Object { $_.result_state -ne 'SUCCESS' })
  if ($bad.Count -gt 0) { throw "auto-config FAILED ($($bad[0].state_message)); see the run: $($run.run_page_url)" }
  Write-Host '    auto-config done'
}

# Database: the owner hand-off (server/db/grants.js), opened and closed here. The
# auto-config handed your app tables to the owner role. Right before the code is
# published, `migrate.mjs prepare` lets the app SP act as that role, so the new
# code's first request (the smoke) can move every table into the ai_prism schema
# (migration 0002). From then on EVERY exit path runs `migrate.mjs up --role <SP>`
# (finally): least-privilege grants, or the revoke alone when 0002 is still
# deferred. The deploy only reports success when the hand-off is closed. The
# database credential is minted with the CLI and only reaches node's environment;
# it is never printed. Without node the hand-off is not opened at all: the app
# keeps running on the public schema and the run fails at the end.
$DbEp = "projects/$App/branches/production/endpoints/primary"
$DbManual = 'node scripts/migrate.mjs up --role <app SP client id>   (as the database owner; docs/operations.md §6.4)'
$DbCloseManual = 'node scripts/migrate.mjs close --role <app SP client id>   (as the database owner; docs/operations.md §6.4)'
$script:Handoff = $false
$script:Published = $false
$NoNode = $false
# runs `node scripts/migrate.mjs <args>` as you, with a fresh database credential; returns its exit code
# (90 = node was NOT started, no credential: nothing can have changed)
function Invoke-Migrate([string[]]$MigArgs) {
  $cred = Invoke-DatabricksCli @('postgres', 'generate-database-credential', $DbEp, '-p', $Perfil, '-o', 'json')
  $tokenValue = ''
  if ($cred.Code -eq 0) { try { $tokenValue = ($cred.Out | ConvertFrom-Json).token } catch { $tokenValue = '' } }
  if (-not $tokenValue) {
    Write-Host "database: could not mint a database credential for $DbEp (databricks postgres generate-database-credential)."
    return 90
  }
  $saved = @{}
  $dbEnv = @{ PGHOST = $DbHost; PGPORT = '5432'; PGUSER = $DbUser; PGPASSWORD = $tokenValue; PGDATABASE = 'databricks_postgres'; PGSSLMODE = 'require' }
  try {
    foreach ($k in $dbEnv.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $dbEnv[$k]) }
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    # Out-Host: node's output must not become this function's return value
    & node scripts/migrate.mjs @MigArgs 2>&1 | ForEach-Object { "$_" } | Out-Host
    $migCode = $LASTEXITCODE
    $ErrorActionPreference = $prev
  } finally {
    foreach ($k in $dbEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    $tokenValue = $null
  }
  return $migCode
}
# $true when the hand-off is closed (or was never opened). Before the new code is
# published: revoke only (`close`); `up` could move the schema under the old release
# that is still serving. After: `up --role`.
function Complete-Handoff {
  if (-not $script:Handoff) { return $true }
  $script:Handoff = $false
  if (-not $script:Published) {
    Write-Host '==> database: revoke the owner hand-off (the new code was not published)'
    $closeCode = Invoke-Migrate @('close', '--role', $DbSp)
    if ($closeCode -eq 0) {
      Write-Host 'database: owner hand-off closed; the new code was NOT published.'
      return $true
    }
    Write-Host ("database: could not confirm that the owner hand-off is closed (exit code $closeCode): the app SP may still " +
      "be able to act as the table owner (still OPEN until revoked). Run, as the database owner: $DbCloseManual")
    return $false
  }
  Write-Host '==> database: migrate up + grants for the app SP (closes the owner hand-off)'
  $dbCode = Invoke-Migrate @('up', '--role', $DbSp)
  if ($dbCode -eq 0) { return $true }
  if ($dbCode -eq 3) {
    Write-Host ('database: migration 0002 is still deferred (no request reached the new code), so the least-privilege ' +
      'grants were NOT applied; the owner hand-off was closed and the app keeps running on the public schema. ' +
      'Run .\deploy.ps1 again (without -SkipSmoke: the smoke makes the app apply it).')
  } elseif ($dbCode -eq 4) {
    Write-Host ('database: the owner hand-off is still OPEN (the app SP can act as the table owner). ' +
      "Close it now, as the database owner that ran this deploy: $DbManual")
  } else {
    Write-Host ("database: migrate up + grants FAILED (exit code $dbCode); the owner hand-off may still be open. " +
      "Fix the cause and run, as the database owner: $DbManual (or, to only revoke it: $DbCloseManual)")
  }
  return $false
}
$closed = $true
try {
  # every exit once prepare may have run (a failed or interrupted prepare included,
  # a failed apps deploy, smoke, ...) closes the hand-off (finally)
  if (Get-Command node -ErrorAction SilentlyContinue) {
    $DbSp = ''; $DbHost = ''; $DbUser = ''
    try { $DbSp = (Get-DbJson apps get $App -p $Perfil -o json).service_principal_client_id } catch { $DbSp = '' }
    try { $DbHost = (Get-DbJson postgres get-endpoint $DbEp -p $Perfil -o json).status.hosts.host } catch { $DbHost = '' }
    try { $DbUser = (Get-DbJson current-user me -p $Perfil -o json).userName } catch { $DbUser = '' }
    if (-not $DbSp -or -not $DbHost -or -not $DbUser) {
      throw ("database: could not resolve the app SP, the Lakebase endpoint $DbEp or your user name; " +
        'the new code was NOT published. Fix it and rerun .\deploy.ps1.')
    }
    Write-Host '==> database: open the owner hand-off for the app SP (closed again after the smoke)'
    # armed BEFORE prepare: prepare commits the SP's membership in the database, and a
    # failure or an interrupt can come after that commit (QA round 2)
    $script:Handoff = $true
    $prepCode = Invoke-Migrate @('prepare', '--role', $DbSp)
    if ($prepCode -eq 90) { $script:Handoff = $false } # node never started: nothing was opened
    if ($prepCode -ne 0) { throw 'database: prepare FAILED; the new code was NOT published. Fix it and rerun .\deploy.ps1.' }
  } else {
    $NoNode = $true
    Write-Warning ('node not found: the owner hand-off is NOT opened; the app will keep running on the public schema ' +
      'and this run will fail at the end (install Node 22 and rerun .\deploy.ps1).')
  }

  $Src = (Get-DbJson bundle summary -p $Perfil -t $Target -o json).workspace.file_path
  Write-Host "==> apps deploy ($Src)"
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & databricks apps deploy $App --source-code-path $Src -p $Perfil > $null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0) { throw "databricks apps deploy failed (exit code $code)" }
  $script:Published = $true

  $Url = (Get-DbJson apps get $App -p $Perfil -o json).url

  # Post-deploy smoke: the real user path against the deployed app. scripts/smoke.mjs
  # signs in with your OAuth token (the Apps proxy forwards your identity), runs one chat
  # turn, reads it back and deletes the test chat. The token only goes to the smoke's
  # environment; it is never printed. A failure does not roll anything back: the new
  # version is live, so read the table above before giving users access.
  if ($SkipSmoke) {
    Write-Host '==> smoke skipped (-SkipSmoke)'
  } elseif (-not $Url) {
    throw "smoke: the app has no URL yet (databricks apps get $App -p $Perfil); pass -SkipSmoke to skip it."
  } else {
    Write-Host "==> npm run smoke ($Url)"
    $tok = Invoke-DatabricksCli @('auth', 'token', '-p', $Perfil, '-o', 'json')
    $SmokeToken = ''
    if ($tok.Code -eq 0) { try { $SmokeToken = ($tok.Out | ConvertFrom-Json).access_token } catch { $SmokeToken = '' } }
    if (-not $SmokeToken) {
      throw ("smoke: could not get an OAuth token for profile $Perfil (databricks auth token -p $Perfil). " +
        "The app is deployed; log in again (databricks auth login -p $Perfil) and rerun, or pass -SkipSmoke.")
    }
    $prevUrl = $env:APP_URL; $prevToken = $env:DATABRICKS_TOKEN
    try {
      $env:APP_URL = $Url; $env:DATABRICKS_TOKEN = $SmokeToken
      & npm run smoke
      $smokeCode = $LASTEXITCODE
    } finally {
      $env:APP_URL = $prevUrl; $env:DATABRICKS_TOKEN = $prevToken
    }
    if ($smokeCode -ne 0) {
      throw ("smoke FAILED against ${Url}: the new version is deployed, but a user path is broken (see the table above). " +
        'Fix it and rerun .\deploy.ps1, or pass -SkipSmoke to deploy without this check.')
    }
  }

  if ($NoNode) {
    throw ('database: node not found, so the least-privilege step did not run: the app runs on the public schema ' +
      "with the app SP's old privileges. Install Node 22 (``npm ci``) and rerun .\deploy.ps1.")
  }
} finally {
  # any exit after the hand-off is opened (a failed apps deploy, smoke, ...) closes it
  $closed = Complete-Handoff
}
if (-not $closed) { throw 'database: the owner hand-off step did not complete (see above).' }

Write-Host ''
Write-Host "Done: $Url"
Write-Host "Next step: open the app as an admin (the deployer is the bootstrap admin) and, to let"
Write-Host "users in, grant Can Use in Compute -> Apps -> $App -> Permissions."
