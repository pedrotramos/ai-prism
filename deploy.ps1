<#
AI Prism - full deploy from PowerShell (Windows), the equivalent of deploy.sh.

  .\deploy.ps1 <PROFILE> [CATALOG] [-Tag 'key=value',...] [-LakebaseSuspendMinutes N]
               [-UsagePolicyId ID] [-ClusterClassico ID] [-SkipBuild] [-SkipSmoke]

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

What it does: npm run bundle -> bundle deploy (Lakebase, SQL Warehouse, cost and
operations dashboards, job, app) -> start the app -> run the auto-config (SP role +
owner hand-off in Lakebase, UDF, tags, volume, admin) -> publish the code -> npm run
smoke -> `node scripts/migrate.mjs up --role <app SP>` as you, the database owner
(least-privilege grants; skipped with a warning without node). Safe to re-run
(idempotent). Needs the Databricks CLI, plus Node 22 + npm with `npm ci` done
unless both -SkipBuild and -SkipSmoke; works on Windows PowerShell 5.1 and PowerShell 7.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Perfil,
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
  [switch]$SkipSmoke
)
$ErrorActionPreference = 'Stop'
$App = 'ai-prism'
$Target = if ($env:AI_PRISM_TARGET) { $env:AI_PRISM_TARGET } else { 'dev' }
$Job = 'ai_prism_auto_config'
$Utf8 = New-Object System.Text.UTF8Encoding $false
if ($env:AI_PRISM_SKIP_BUILD -in @('1', 'true')) { $SkipBuild = $true }
if ($env:AI_PRISM_SKIP_SMOKE -in @('1', 'true')) { $SkipSmoke = $true }

# CLI command that stops the script when it fails (exit code != 0)
function Invoke-Db {
  & databricks @args
  if ($LASTEXITCODE -ne 0) { throw "databricks $($args -join ' ') failed (exit code $LASTEXITCODE)" }
}
function Get-DbJson {
  $out = & databricks @args
  if ($LASTEXITCODE -ne 0) { throw "databricks $($args -join ' ') failed (exit code $LASTEXITCODE)" }
  ($out -join "`n") | ConvertFrom-Json
}
function Invoke-DatabricksCli($cliArgs) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $out = & databricks @cliArgs 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  $std = @($out | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
  [pscustomobject]@{ Code = $code; Out = ($std -join "`n") }
}
function Read-Text($path) { [System.IO.File]::ReadAllText($path, $Utf8) }
function Write-Text($path, $text) { [System.IO.File]::WriteAllText($path, $text, $Utf8) }

if (-not (Get-Command databricks -ErrorAction SilentlyContinue)) {
  throw 'Databricks CLI not found. Install it with: winget install Databricks.DatabricksCLI (and open a new PowerShell).'
}
# The build and the smoke both need npm (and Node 22). Fail now, not after the deploy.
if ((-not $SkipBuild -or -not $SkipSmoke) -and -not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw ('npm not found: install Node 22 and run `npm ci` so the deploy can build the app and smoke it, ' +
    'or pass -SkipBuild -SkipSmoke (AI_PRISM_SKIP_BUILD=1 AI_PRISM_SKIP_SMOKE=1) to deploy client/dist + ' +
    'server-dist exactly as they are on disk, without the post-deploy smoke.')
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

Write-Host '==> bundle deploy'
Invoke-Db bundle deploy -p $Perfil -t $Target @Vars

Write-Host '==> start the app (ignored if it is already running)'
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& databricks apps start $App -p $Perfil *> $null
$ErrorActionPreference = $prev

Write-Host '==> auto-config (SP role + owner hand-off in Lakebase, UDF, volume, tags, admin)'
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

# The code is published AFTER the auto-config: the auto-config prepares the
# Lakebase owner hand-off (server/db/grants.js), which the new code's first
# request needs to move the tables into the ai_prism schema (migration 0002).
$Src = (Get-DbJson bundle summary -p $Perfil -t $Target -o json).workspace.file_path
Write-Host "==> apps deploy ($Src)"
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& databricks apps deploy $App --source-code-path $Src -p $Perfil > $null
$code = $LASTEXITCODE
$ErrorActionPreference = $prev
if ($code -ne 0) { throw "databricks apps deploy failed (exit code $code)" }

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

# Database: migrations + least-privilege grants as the deploying identity. The
# deploying identity owns the database; after the smoke (whose first request made
# the new code apply its migrations as the app SP), it runs
# `migrate.mjs up --role <app SP>`: anything still pending, then the SP's
# least-privilege grants on the ai_prism schema, which also closes the owner
# hand-off. The database credential is minted here and only reaches node's
# environment; it is never printed. Exit 3 = migration 0002 still deferred
# (no request reached the new code yet): a warning, not a failure.
$DbEp = "projects/$App/branches/production/endpoints/primary"
$DbManual = 'node scripts/migrate.mjs up --role <app SP client id>   (as the database owner; docs/operations.md §6.4)'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Warning ('node not found: the database grants step was skipped. The app SP keeps the owner hand-off ' +
    "until you run, with PGHOST/PGUSER/PGPASSWORD of the database owner: $DbManual")
} else {
  Write-Host '==> database: migrate up + grants for the app SP (as the deploying identity)'
  $DbSp = ''; $DbHost = ''; $DbUser = ''; $DbToken = ''
  try { $DbSp = (Get-DbJson apps get $App -p $Perfil -o json).service_principal_client_id } catch { $DbSp = '' }
  try { $DbHost = (Get-DbJson postgres get-endpoint $DbEp -p $Perfil -o json).status.hosts.host } catch { $DbHost = '' }
  try { $DbUser = (Get-DbJson current-user me -p $Perfil -o json).userName } catch { $DbUser = '' }
  $cred = Invoke-DatabricksCli @('postgres', 'generate-database-credential', $DbEp, '-p', $Perfil, '-o', 'json')
  if ($cred.Code -eq 0) { try { $DbToken = ($cred.Out | ConvertFrom-Json).token } catch { $DbToken = '' } }
  if (-not $DbSp -or -not $DbHost -or -not $DbUser -or -not $DbToken) {
    throw ("database: could not resolve the app SP, the Lakebase endpoint $DbEp or a database credential. " +
      "The app is deployed; run it by hand: $DbManual")
  }
  $saved = @{}
  $dbEnv = @{ PGHOST = $DbHost; PGPORT = '5432'; PGUSER = $DbUser; PGPASSWORD = $DbToken; PGDATABASE = 'databricks_postgres'; PGSSLMODE = 'require' }
  try {
    foreach ($k in $dbEnv.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $dbEnv[$k]) }
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & node scripts/migrate.mjs up --role $DbSp
    $dbCode = $LASTEXITCODE
    $ErrorActionPreference = $prev
  } finally {
    foreach ($k in $dbEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    $DbToken = $null
  }
  if ($dbCode -eq 3) {
    Write-Warning ('migration 0002 is still deferred (the new code has not served a request yet). ' +
      'Open the app once, then run: node scripts/migrate.mjs grants --role <app SP client id>')
  } elseif ($dbCode -ne 0) {
    throw ("database: migrate up + grants FAILED (exit code $dbCode). The app is deployed; fix it and rerun .\deploy.ps1, " +
      "or run by hand: $DbManual")
  }
}

Write-Host ''
Write-Host "Done: $Url"
Write-Host "Next step: open the app as an admin (the deployer is the bootstrap admin) and, to let"
Write-Host "users in, grant Can Use in Compute -> Apps -> $App -> Permissions."
