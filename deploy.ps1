<#
AI Prism - deploy completo pelo PowerShell (Windows), equivalente ao deploy.sh.

  .\deploy.ps1 <PERFIL> [CATALOGO] [-Tag 'chave=valor',...] [-LakebaseSuspendMinutes N]
               [-UsagePolicyId ID] [-ClusterClassico ID]

  PERFIL    perfil da CLI (databricks auth login --host <url> --profile <nome>).
            Nenhum host é fixado aqui: o workspace é o do perfil.
  CATALOGO  catálogo UC onde ficam o schema `default` do ai_prism (UDF Python + volume
            de imagens). Default: ai_prism.

Tags de recurso (opcional, ver docs/tags.md): -Tag 'chave=valor','chave2=valor2' (um
array; uma ocorrência só, com os valores separados por vírgula). Também aceita
-Tag "chave=valor,chave2=valor2" numa string só (é o formato que funciona com
`powershell -File`, onde a vírgula não separa elementos de array). E/ou TAGS no
ambiente. Até 24 tags de operador (+ a embutida ai_prism_app = 25, o máximo da Jobs
API). ai_prism_app=ai-prism é sempre adicionada e não pode ser sobrescrita. Chave/valor:
só letras, números, espaço e + - = . : / @ (até 255 caracteres), as mesmas regras de
server/resourceTags.js.

Lakebase (opcional): -LakebaseSuspendMinutes N (ou LAKEBASE_SUSPEND_MINUTES), de 1 a
10080 minutos sem uso até o banco dormir.

Consumo serverless (opcional): -UsagePolicyId <id> (ou SERVERLESS_USAGE_POLICY_ID) para
atribuir o consumo do App e do job de auto-config a uma serverless usage policy já
existente. O bundle nunca cria a policy.

Workspace SEM serverless: -ClusterClassico <id> (ou CLASSIC_CLUSTER_ID) de um cluster
clássico Dedicado/Single user. O SQL Warehouse vira Pro clássico e o auto-config roda
nesse cluster.

O que faz: bundle deploy (Lakebase, SQL Warehouse, dashboard de custos, job, app)
-> start da app -> publica o código -> roda o auto-config (role do SP no Lakebase,
UDF, tags, volume, admin). Pode rodar de novo quantas vezes quiser (idempotente).
Só precisa da Databricks CLI; funciona no Windows PowerShell 5.1 e no PowerShell 7.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Perfil,
  [Parameter(Position = 1)][string]$Catalogo = 'ai_prism',
  # workspace SEM serverless: id de um cluster clássico Dedicado/Single user. O SQL
  # Warehouse vira Pro clássico e o auto-config roda nesse cluster.
  [string]$ClusterClassico = $env:CLASSIC_CLUSTER_ID,
  # Tags de recurso: array. Uma só ocorrência com valores separados por vírgula
  # (-Tag 'a=1','b=2'), NÃO -Tag a=1 -Tag b=2 (o PowerShell rejeita um parâmetro
  # nomeado repetido). E/ou TAGS="a=1,b=2" no ambiente.
  [string[]]$Tag = @(),
  [string]$UsagePolicyId = $env:SERVERLESS_USAGE_POLICY_ID,
  # Lakebase (opcional): minutos sem uso até o banco dormir, 1 a 10080.
  [string]$LakebaseSuspendMinutes = $env:LAKEBASE_SUSPEND_MINUTES
)
$ErrorActionPreference = 'Stop'
$App = 'ai-prism'
$Target = if ($env:AI_PRISM_TARGET) { $env:AI_PRISM_TARGET } else { 'dev' }
$Job = 'ai_prism_auto_config'
$Utf8 = New-Object System.Text.UTF8Encoding $false

# comando da CLI que para o script se falhar (exit code != 0)
function Invoke-Db {
  & databricks @args
  if ($LASTEXITCODE -ne 0) { throw "databricks $($args -join ' ') falhou (código $LASTEXITCODE)" }
}
function Get-DbJson {
  $out = & databricks @args
  if ($LASTEXITCODE -ne 0) { throw "databricks $($args -join ' ') falhou (código $LASTEXITCODE)" }
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
  throw 'Databricks CLI não encontrada. Instale com: winget install Databricks.DatabricksCLI (e abra um PowerShell novo).'
}

Set-Location -Path $PSScriptRoot
$AppYaml = Join-Path $PSScriptRoot 'app.yaml'

# Lakebase (soft-delete): um `databricks bundle destroy` anterior deixa o projeto
# apagado de forma reversível e reserva o nome. Confere ANTES do deploy e mostra os
# dois comandos; NUNCA purga automaticamente.
function Test-LakebaseProject($projectId, $perfil) {
  $get = Invoke-DatabricksCli @('postgres', 'get-project', "projects/$projectId", '-p', $perfil, '-o', 'json')
  if ($get.Code -ne 0) { return }  # projeto não existe (instalação nova) ou API indisponível - não bloqueia
  try { $proj = $get.Out | ConvertFrom-Json } catch { $proj = $null }

  $list = Invoke-DatabricksCli @('postgres', 'list-projects', '-p', $perfil, '-o', 'json')
  if ($list.Code -ne 0) { return }  # não deu pra confirmar - deixa o bundle deploy tentar
  try { $ativos = @(($list.Out | ConvertFrom-Json) | ForEach-Object { $_.project_id }) } catch { return }
  if ($ativos -contains $projectId) { return }  # projeto ativo normal

  $deleteTime = $null
  if ($proj) {
    $deleteTime = $proj.delete_time
    if ((-not $deleteTime) -and $proj.status) { $deleteTime = $proj.status.delete_time }
  }
  $quando = if ($deleteTime) { " (delete_time=$deleteTime)" } else { '' }
  throw (
    "`nO projeto Lakebase 'projects/$projectId' esta soft-deleted$quando - provavelmente de um " +
    "databricks bundle destroy anterior - e ainda reserva esse nome, entao este deploy vai falhar " +
    "tentando recria-lo.`n`n" +
    "Escolha uma opcao e rode .\deploy.ps1 de novo:`n" +
    "  1) Restaurar o projeto antigo (recupera os dados do Lakebase; NAO destrutivo):`n" +
    "       databricks postgres undelete-project projects/$projectId -p $perfil`n" +
    "  2) Apagar o projeto antigo DE VEZ e liberar o nome (DESTRUTIVO - os dados dele sao " +
    "perdidos para sempre; confirme que e isso mesmo antes de rodar):`n" +
    "       databricks postgres delete-project projects/$projectId -p $perfil --purge`n`n" +
    "Ver docs/onboarding-deployment.md (Resolvendo problemas comuns) para mais contexto.`n"
  )
}
Write-Host "==> Lakebase: conferindo se o projeto $App ja nao esta soft-deleted de um destroy anterior"
Test-LakebaseProject $App $Perfil

Write-Host "==> Catalogo: $Catalogo  ·  perfil: $Perfil  ·  alvo: $Target"
# O runtime da App lê env SÓ do app.yaml (não das variables do bundle), então o
# catálogo precisa ser gravado lá também.
$yaml = Read-Text $AppYaml
$yaml = [regex]::Replace($yaml, "(name: (?:TOOLS_CATALOG|IMAGE_VOLUME_CATALOG)\r?\n\s*value: )'[^']*'", { param($mm) $mm.Groups[1].Value + "'" + $Catalogo + "'" })

$Vars = @('--var', "tools_catalog=$Catalogo", '--var', "image_volume_catalog=$Catalogo")
if ($ClusterClassico) {
  Write-Host "==> sem serverless: warehouse Pro clássico; auto-config no cluster $ClusterClassico"
  $Vars += @('--var', 'warehouse_serverless=false')
}
if ($UsagePolicyId) {
  $Vars += @('--var', "serverless_usage_policy_id=$UsagePolicyId")
}
if ($LakebaseSuspendMinutes) {
  $min = 0
  if (-not [int]::TryParse($LakebaseSuspendMinutes, [ref]$min) -or $min -lt 1 -or $min -gt 10080) { throw 'LakebaseSuspendMinutes precisa ser um número de 1 a 10080 (minutos)' }
  Write-Host "==> Lakebase dorme apos $min min sem uso"
  $Vars += @('--var', "lakebase_suspend_timeout=$($min * 60)s")
}

# Tags de recurso. resource_tags/resource_tags_list são variáveis COMPLEXAS (mapa/lista):
# vão por .databricks/bundle/<target>/variable-overrides.json. resource_tags_json
# (string simples) vai por $env:BUNDLE_VAR_resource_tags_json.
# Cada elemento de -Tag também é dividido por vírgula: sob `powershell -File`,
# -Tag 'a=1','b=2' chega como um único elemento "a=1,b=2". Num elemento sem vírgula
# (invocação nativa) o split não faz nada.
$TagPairs = @($Tag | ForEach-Object { $_ -split ',' } | Where-Object { $_.Trim() })
if ($env:TAGS) { $TagPairs = @($env:TAGS -split ',' | Where-Object { $_.Trim() }) + $TagPairs }
# Chave/valor: a mesma classe explícita por categoria Unicode que server/resourceTags.js
# (\p{L}\p{N}, + '_'). O \w do .NET não é o mesmo conjunto (aceita marcas combinantes).
$TagRe = '^[\p{L}\p{N}_+\-=.:/@ ]{1,255}$'
# Jobs API: no máximo 25 tags no total. 24 de operador + ai_prism_app = 25.
$MaxOperatorTags = 24
# A detecção de colisão de caixa roda ANTES de qualquer escrita, comparando
# ToLowerInvariant() à mão (a hashtable do PowerShell já é case-insensitive e
# sobrescreveria uma chave pela outra em silêncio).
$ResourceTags = [ordered]@{}
$SeenKeysByLowerCase = @{}
foreach ($pair in $TagPairs) {
  if ($pair -notmatch '=') { throw "tag inválida (use chave=valor): $pair" }
  $idx = $pair.IndexOf('=')
  $k = $pair.Substring(0, $idx).Trim()
  $v = $pair.Substring($idx + 1).Trim()
  $kLower = $k.ToLowerInvariant()
  if ($kLower -eq 'ai_prism_app') {
    Write-Warning "a tag '$k' é embutida e não pode ser sobrescrita; valor informado ignorado."
    continue
  }
  if ($kLower -eq 'application') {
    Write-Warning "a tag '$k' é reservada (usada para atribuir o custo ao AI Prism); valor informado ignorado."
    continue
  }
  if ($k -cnotmatch $TagRe) { throw "chave de tag inválida '$k': use só letras, números, espaço e + - = . : / @ (até 255 caracteres)" }
  if ($v -ne '' -and $v -cnotmatch $TagRe) { throw "valor de tag inválido para '$k' ('$v'): use só letras, números, espaço e + - = . : / @ (até 255 caracteres)" }
  if ($SeenKeysByLowerCase.ContainsKey($kLower)) {
    throw "a tag '$k' difere de '$($SeenKeysByLowerCase[$kLower])' só pela caixa (maiúsculas/minúsculas) — use só uma grafia"
  }
  if ($ResourceTags.Count -ge $MaxOperatorTags) {
    throw "mais de $MaxOperatorTags tags de operador (limite da Jobs API: 25 no total, incluindo a tag embutida ai_prism_app) — remova alguma(s) e rode de novo"
  }
  $ResourceTags[$k] = $v
  $SeenKeysByLowerCase[$kLower] = $k
}
$ResourceTags['ai_prism_app'] = $App
$ResourceTagsList = @($ResourceTags.Keys | ForEach-Object { [ordered]@{ key = $_; value = $ResourceTags[$_] } })
$ResourceTagsJson = $ResourceTags | ConvertTo-Json -Compress
Write-Host "==> tags de recurso: $(($ResourceTags.Keys | ForEach-Object { "$_=$($ResourceTags[$_])" }) -join ', ')"

# AI_PRISM_RESOURCE_TAGS no app.yaml (lido em runtime por server/resourceTags.js).
# [regex]::Replace com callback, para não escapar o JSON para o mecanismo de regex.
$yaml = [regex]::Replace($yaml, "(name: AI_PRISM_RESOURCE_TAGS\r?\n\s*value: )'[^']*'", { param($mm) $mm.Groups[1].Value + "'" + $ResourceTagsJson + "'" })
Write-Text $AppYaml $yaml

$OverridesDir = Join-Path $PSScriptRoot ".databricks\bundle\$Target"
New-Item -ItemType Directory -Force -Path $OverridesDir | Out-Null
$OverridesPath = Join-Path $OverridesDir 'variable-overrides.json'
# PSCustomObject (não hashtable): ConvertFrom-Json -AsHashtable só existe no PowerShell 6+,
# e este script também roda no 5.1.
$Overrides = if (Test-Path $OverridesPath) { try { Read-Text $OverridesPath | ConvertFrom-Json } catch { [pscustomobject]@{} } } else { [pscustomobject]@{} }
if ($null -eq $Overrides) { $Overrides = [pscustomobject]@{} }
$Overrides | Add-Member -NotePropertyName 'resource_tags' -NotePropertyValue $ResourceTags -Force
$Overrides | Add-Member -NotePropertyName 'resource_tags_list' -NotePropertyValue $ResourceTagsList -Force
Write-Text $OverridesPath ($Overrides | ConvertTo-Json -Depth 10)
$env:BUNDLE_VAR_resource_tags_json = $ResourceTagsJson

Write-Host '==> bundle deploy'
Invoke-Db bundle deploy -p $Perfil -t $Target @Vars

Write-Host '==> start da app (ignora se ja estiver rodando)'
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& databricks apps start $App -p $Perfil *> $null
$ErrorActionPreference = $prev

$Src = (Get-DbJson bundle summary -p $Perfil -t $Target -o json).workspace.file_path
Write-Host "==> apps deploy ($Src)"
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& databricks apps deploy $App --source-code-path $Src -p $Perfil > $null
$code = $LASTEXITCODE
$ErrorActionPreference = $prev
if ($code -ne 0) { throw "databricks apps deploy falhou (código $code)" }

Write-Host '==> auto-config (role do SP no Lakebase, UDF, volume, tags, admin)'
if (-not $ClusterClassico) {
  Invoke-Db bundle run $Job -p $Perfil -t $Target @Vars
} else {
  # mesma tarefa do job (parâmetros já resolvidos pelo bundle), num run avulso no
  # cluster clássico — o job do bundle usaria compute serverless
  $JobId = (Get-DbJson bundle summary -p $Perfil -t $Target @Vars -o json).resources.jobs.$Job.id
  $task = (Get-DbJson jobs get $JobId -p $Perfil -o json).settings.tasks[0]
  $submit = @{ run_name = 'ai-prism auto-config (cluster clássico)'; tasks = @(@{
      task_key = $task.task_key; notebook_task = $task.notebook_task; existing_cluster_id = $ClusterClassico }) }
  $tmp = [System.IO.Path]::GetTempFileName()
  Write-Text $tmp ($submit | ConvertTo-Json -Depth 10)
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $out = (& databricks jobs submit --json "@$tmp" -p $Perfil --timeout 40m -o json 2>&1) -join "`n"
  $ErrorActionPreference = $prev
  Remove-Item $tmp -Force
  # o comando pode sair 0 com o run FAILED: confere result_state explicitamente
  $i = $out.IndexOf('{')
  if ($i -lt 0) { throw "auto-config: o run não terminou (saída da CLI: $($out.Trim()))" }
  $run = $out.Substring($i) | ConvertFrom-Json
  $states = @($run.state) + @($run.tasks | ForEach-Object { $_.state })
  $bad = @($states | Where-Object { $_.result_state -ne 'SUCCESS' })
  if ($bad.Count -gt 0) { throw "auto-config FALHOU ($($bad[0].state_message)) — veja o run: $($run.run_page_url)" }
  Write-Host '    auto-config concluido'
}

$Url = (Get-DbJson apps get $App -p $Perfil -o json).url
Write-Host ''
Write-Host "Pronto: $Url"
Write-Host "Proximo passo: abra o app como admin (o deployer ja e admin bootstrap) e, para liberar"
Write-Host "o acesso aos usuarios, de Can Use em Compute -> Apps -> $App -> Permissions."
