#!/usr/bin/env bash
# AI Prism — deploy completo em qualquer workspace Databricks (AWS/Azure/GCP).
#
#   ./deploy.sh [opções] <PROFILE> [CATALOGO]
#
#   PROFILE   perfil do ~/.databrickscfg (databricks auth login --host <url> --profile <nome>).
#             Nenhum host é fixado aqui: o workspace é o do perfil.
#   CATALOGO  catálogo UC onde ficam o schema `default` do ai_prism (UDF Python +
#             volume de imagens). Default: ai_prism (criado se você tiver CREATE CATALOG;
#             senão, aponte para um catálogo que já existe e você pode usar).
#
# Opções (todas opcionais; cada uma tem uma variável de ambiente equivalente):
#
#   --tag chave=valor            tag de recurso, repetível (até 24). Equivale a TAGS="a=1,b=2".
#                                Aplicada a todo recurso criado pelo bundle e, via
#                                usage_context/query_tags, ao que o app consome. A tag
#                                embutida ai_prism_app=ai-prism é sempre adicionada e não
#                                pode ser sobrescrita. Chave/valor: só letras, números,
#                                espaço e + - = . : / @ (até 255 caracteres) — as mesmas
#                                regras de server/resourceTags.js. Ver docs/tags.md.
#   --lakebase-suspend-minutes N minutos sem uso até o Lakebase dormir (1..10080; padrão do
#                                bundle). Equivale a LAKEBASE_SUSPEND_MINUTES=N.
#   --usage-policy-id ID         serverless usage policy já existente (a conta a cria; o bundle
#                                nunca cria). Atribui o consumo serverless do App e do job de
#                                auto-config. Equivale a SERVERLESS_USAGE_POLICY_ID=ID.
#   --classic-cluster-id ID      workspace SEM serverless: id de um cluster clássico Dedicado /
#                                Single user. O SQL Warehouse vira Pro clássico e o auto-config
#                                roda nesse cluster. Equivale a CLASSIC_CLUSTER_ID=ID.
#
# Exemplos:
#   ./deploy.sh DEV
#   ./deploy.sh --tag cost_center=1234 --tag area=Finanças DEV ai_prism
#   ./deploy.sh --lakebase-suspend-minutes 30 --usage-policy-id <id> DEV
#
# Lakebase (soft-delete): um `databricks bundle destroy` anterior deixa o projeto
# Lakebase apagado de forma reversível e reserva o nome. Antes de qualquer coisa, o
# deploy confere isso e mostra os dois comandos (restaurar ou purgar). NUNCA purga
# sozinho — ver docs/onboarding-deployment.md, "Resolvendo problemas comuns".
#
# O que faz: bundle deploy (Lakebase, SQL Warehouse, dashboard de custos, job, app)
# → start da app → publica o código (apps deploy) → roda o auto-config (role do SP no
# Lakebase, UDF, volume, tags, admin). Pode rodar de novo quantas vezes quiser
# (idempotente).
#
# Requer: Databricks CLI recente (com os grupos `bundle` e `postgres`), python3 e um
# perfil autenticado. O bundle sozinho não republica o código da App; este script faz.
set -euo pipefail

APP=ai-prism
TARGET="${AI_PRISM_TARGET:-dev}"
JOB=ai_prism_auto_config

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

# --- argumentos: opções com valor (separadas ou com =) misturadas com as posicionais ---
TAG_ARGS=()
POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)                    TAG_ARGS+=("${2:?--tag precisa de um valor chave=valor}"); shift 2 ;;
    --tag=*)                  TAG_ARGS+=("${1#--tag=}"); shift ;;
    --lakebase-suspend-minutes) LAKEBASE_SUSPEND_MINUTES="${2:?--lakebase-suspend-minutes precisa de um número}"; shift 2 ;;
    --lakebase-suspend-minutes=*) LAKEBASE_SUSPEND_MINUTES="${1#*=}"; shift ;;
    --usage-policy-id)        SERVERLESS_USAGE_POLICY_ID="${2:?--usage-policy-id precisa de um id}"; shift 2 ;;
    --usage-policy-id=*)      SERVERLESS_USAGE_POLICY_ID="${1#*=}"; shift ;;
    --classic-cluster-id)     CLASSIC_CLUSTER_ID="${2:?--classic-cluster-id precisa de um id}"; shift 2 ;;
    --classic-cluster-id=*)   CLASSIC_CLUSTER_ID="${1#*=}"; shift ;;
    -h|--help)                usage; exit 0 ;;
    --)                       shift; while [ $# -gt 0 ]; do POSITIONAL+=("$1"); shift; done ;;
    -*)                       echo "opção desconhecida: $1 (veja ./deploy.sh --help)" >&2; exit 2 ;;
    *)                        POSITIONAL+=("$1"); shift ;;
  esac
done
set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

PROFILE="${1:?uso: ./deploy.sh [opções] <PROFILE> [CATALOGO]  (veja ./deploy.sh --help)}"
CATALOG="${2:-ai_prism}"
cd "$(dirname "$0")"

# --- validações baratas, antes de tocar em qualquer recurso ---
if [ -n "${LAKEBASE_SUSPEND_MINUTES:-}" ]; then
  [[ "$LAKEBASE_SUSPEND_MINUTES" =~ ^[0-9]+$ ]] && [ "$((10#$LAKEBASE_SUSPEND_MINUTES))" -ge 1 ] && [ "$((10#$LAKEBASE_SUSPEND_MINUTES))" -le 10080 ] \
    || { echo "--lakebase-suspend-minutes precisa ser um número de 1 a 10080 (minutos)" >&2; exit 1; }
fi

# --- Lakebase: projeto soft-deleted de um destroy anterior? ---
# get-project + list-projects sem --show-deleted (get-project não tem essa flag).
# Não bloqueia quando não dá para conferir: deixa o bundle deploy tentar.
check_lakebase_project() { # <project_id>
  python3 - "$1" "$PROFILE" <<'PY'
import json, subprocess, sys

project_id, profile = sys.argv[1], sys.argv[2]

def cli(*args):
    r = subprocess.run(['databricks', 'postgres', *args, '-p', profile, '-o', 'json'],
                        capture_output=True, text=True)
    return r.returncode, r.stdout

rc, out = cli('get-project', f'projects/{project_id}')
if rc != 0:
    sys.exit(0)  # projeto não existe (instalação nova) ou API indisponível — não bloqueia
try:
    proj = json.loads(out) if out.strip() else {}
except Exception:
    proj = {}

rc2, out2 = cli('list-projects')
if rc2 != 0:
    sys.exit(0)  # não deu pra confirmar — deixa o bundle deploy tentar e falhar com o erro dele
try:
    ativos = {p.get('project_id') for p in (json.loads(out2) or [])}
except Exception:
    sys.exit(0)

if project_id in ativos:
    sys.exit(0)  # projeto ativo normal — o bundle deploy cuida dele

delete_time = proj.get('delete_time') or (proj.get('status') or {}).get('delete_time') or ''
quando = f' (delete_time={delete_time})' if delete_time else ''
sys.exit(
    f"\nO projeto Lakebase 'projects/{project_id}' está soft-deleted{quando} — provavelmente de um "
    f"`databricks bundle destroy` anterior — e ainda reserva esse nome, então este deploy vai falhar "
    f"tentando recriá-lo.\n\n"
    f"Escolha uma opção e rode ./deploy.sh de novo:\n"
    f"  1) Restaurar o projeto antigo (recupera os dados do Lakebase; NÃO destrutivo):\n"
    f"       databricks postgres undelete-project projects/{project_id} -p {profile}\n"
    f"  2) Apagar o projeto antigo DE VEZ e liberar o nome (DESTRUTIVO — os dados dele são "
    f"perdidos para sempre; confirme que é isso mesmo antes de rodar):\n"
    f"       databricks postgres delete-project projects/{project_id} -p {profile} --purge\n\n"
    f"Ver docs/onboarding-deployment.md (Resolvendo problemas comuns) para mais contexto.\n"
)
PY
}
echo "==> Lakebase: conferindo se o projeto $APP já não está soft-deleted de um destroy anterior"
check_lakebase_project "$APP"

echo "==> Catálogo: $CATALOG  ·  perfil: $PROFILE  ·  alvo: $TARGET"
# O runtime da App lê env SÓ do app.yaml (não das variables do bundle), então o
# catálogo precisa ser gravado lá também. Um bloco python (não perl/sed) edita o
# app.yaml inteiro: as aspas e a barra do JSON de tags não passam por regex de shell.
python3 - "$CATALOG" <<'PY'
import re, sys
catalog = sys.argv[1]
text = open('app.yaml', encoding='utf-8').read()
new, n = re.subn(r"(name: (?:TOOLS_CATALOG|IMAGE_VOLUME_CATALOG)\n\s*value: )'[^']*'",
                 lambda m: f"{m.group(1)}'{catalog}'", text)
if n == 0:
    sys.exit('app.yaml: TOOLS_CATALOG/IMAGE_VOLUME_CATALOG não encontrados.')
open('app.yaml', 'w', encoding='utf-8').write(new)
PY

VARS=(--var "tools_catalog=$CATALOG" --var "image_volume_catalog=$CATALOG")

CLASSIC="${CLASSIC_CLUSTER_ID:-}"
if [ -n "$CLASSIC" ]; then
  echo "==> sem serverless: warehouse Pro clássico; auto-config no cluster $CLASSIC"
  VARS+=(--var warehouse_serverless=false)
fi

if [ -n "${LAKEBASE_SUSPEND_MINUTES:-}" ]; then
  echo "==> Lakebase dorme após $LAKEBASE_SUSPEND_MINUTES min sem uso"
  VARS+=(--var "lakebase_suspend_timeout=$((10#$LAKEBASE_SUSPEND_MINUTES * 60))s")
fi

if [ -n "${SERVERLESS_USAGE_POLICY_ID:-}" ]; then
  VARS+=(--var "serverless_usage_policy_id=$SERVERLESS_USAGE_POLICY_ID")
fi

# --- tags de recurso ---
# resource_tags / resource_tags_list são variáveis de bundle COMPLEXAS (mapa / lista):
# a CLI recusa `--var` com aspas no valor e recusa BUNDLE_VAR_* para variável complexa,
# então a única forma é um arquivo de overrides em .databricks/bundle/<target>/. Já
# resource_tags_json (string simples) aceita BUNDLE_VAR_resource_tags_json.
# Grava também AI_PRISM_RESOURCE_TAGS no app.yaml (lido em runtime por server/resourceTags.js).
apply_resource_tags() { # <target>
  python3 - "$1" "$APP" "${TAG_ARGS[@]+"${TAG_ARGS[@]}"}" <<'PY'
import json, os, re, sys

target = sys.argv[1]
APP_NAME = sys.argv[2]
pairs = sys.argv[3:]
env_tags = os.environ.get('TAGS', '')
if env_tags:
    pairs = [p for p in env_tags.split(',') if p.strip()] + pairs

TAG_RE = re.compile(r'^[\w+\-=.:/@ ]{1,255}$')
# O job de bundle recebe resource_tags como `tags` (mapa), e a Jobs API aceita no
# máximo 25: 24 de operador + ai_prism_app = 25. Erro claro AQUI, antes do deploy.
MAX_OPERATOR_TAGS = 24
tags = {}
seen_lower = {}
for p in pairs:
    if '=' not in p:
        sys.exit(f'tag inválida (use chave=valor): {p!r}')
    k, v = p.split('=', 1)
    k, v = k.strip(), v.strip()
    # comparação por minúsculas: o PowerShell (deploy.ps1) trata chaves sem diferenciar caixa
    lower = k.lower()
    if lower == 'ai_prism_app':
        print('AVISO: a tag ai_prism_app é embutida e não pode ser sobrescrita; valor informado ignorado.', file=sys.stderr)
        continue
    if lower == 'application':
        print("AVISO: a tag 'application' é reservada (usada para atribuir o custo ao AI Prism); valor informado ignorado.", file=sys.stderr)
        continue
    if not TAG_RE.match(k):
        sys.exit(f'chave de tag inválida {k!r}: use só letras, números, espaço e + - = . : / @ (até 255 caracteres)')
    if not (v == '' or TAG_RE.match(v)):
        sys.exit(f'valor de tag inválido para {k!r} ({v!r}): use só letras, números, espaço e + - = . : / @ (até 255 caracteres)')
    if lower in seen_lower:
        sys.exit(f'tag {k!r} difere de {seen_lower[lower]!r} só pela caixa (maiúsculas/minúsculas) — '
                 'o PowerShell trata as duas como a mesma chave; use só uma grafia')
    if len(tags) >= MAX_OPERATOR_TAGS:
        sys.exit(f'mais de {MAX_OPERATOR_TAGS} tags de operador (limite da Jobs API: 25 no total, '
                 'incluindo a tag embutida ai_prism_app) — remova alguma(s) e rode de novo')
    tags[k] = v
    seen_lower[lower] = k

merged = {**tags, 'ai_prism_app': APP_NAME}
tags_list = [{'key': k, 'value': v} for k, v in merged.items()]

ov_dir = os.path.join('.databricks', 'bundle', target)
os.makedirs(ov_dir, exist_ok=True)
ov_path = os.path.join(ov_dir, 'variable-overrides.json')
overrides = {}
if os.path.exists(ov_path):
    try:
        overrides = json.load(open(ov_path, encoding='utf-8'))
    except Exception:
        overrides = {}
overrides['resource_tags'] = merged
overrides['resource_tags_list'] = tags_list
json.dump(overrides, open(ov_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

# app.yaml: AI_PRISM_RESOURCE_TAGS. re.sub com função (não string de substituição)
# para não escapar nada do JSON para o mecanismo de regex.
app_yaml = open('app.yaml', encoding='utf-8').read()
value_json = json.dumps(merged, ensure_ascii=False)
pattern = re.compile(r"(name: AI_PRISM_RESOURCE_TAGS\n\s*value: )'[^']*'")
new_yaml, n = pattern.subn(lambda m: f"{m.group(1)}'{value_json}'", app_yaml)
if n == 0:
    sys.exit('app.yaml: variável AI_PRISM_RESOURCE_TAGS não encontrada (bloco env: faltando).')
open('app.yaml', 'w', encoding='utf-8').write(new_yaml)

# para o chamador (stdout): o JSON que vai para BUNDLE_VAR_resource_tags_json
print(value_json)
print(f'==> tags de recurso: {", ".join(f"{k}={v}" for k, v in merged.items())}', file=sys.stderr)
PY
}
RESOURCE_TAGS_JSON="$(apply_resource_tags "$TARGET")"
export BUNDLE_VAR_resource_tags_json="$RESOURCE_TAGS_JSON"

echo "==> bundle deploy"
databricks bundle deploy -p "$PROFILE" -t "$TARGET" "${VARS[@]}"

echo "==> start da app (ignora se já estiver rodando)"
databricks apps start "$APP" -p "$PROFILE" >/dev/null 2>&1 || true

SRC=$(databricks bundle summary -p "$PROFILE" -t "$TARGET" -o json | python3 -c "import sys,json; print(json.load(sys.stdin)['workspace']['file_path'])")
echo "==> apps deploy ($SRC)"
databricks apps deploy "$APP" --source-code-path "$SRC" -p "$PROFILE" >/dev/null

echo "==> auto-config (role do SP no Lakebase, UDF, volume, tags, admin)"
if [ -z "$CLASSIC" ]; then
  databricks bundle run "$JOB" -p "$PROFILE" -t "$TARGET" "${VARS[@]}"
else
  # mesma tarefa do job (parâmetros já resolvidos pelo bundle), num run avulso no
  # cluster clássico — o job do bundle usaria compute serverless
  JOB_ID=$(databricks bundle summary -p "$PROFILE" -t "$TARGET" "${VARS[@]}" -o json | python3 -c "import sys,json; print(json.load(sys.stdin)['resources']['jobs']['$JOB']['id'])")
  SUBMIT=$(mktemp)
  databricks jobs get "$JOB_ID" -p "$PROFILE" -o json | python3 -c "
import sys, json
t = json.load(sys.stdin)['settings']['tasks'][0]
print(json.dumps({'run_name': 'ai-prism auto-config (cluster clássico)', 'tasks': [{
    'task_key': t['task_key'], 'notebook_task': t['notebook_task'], 'existing_cluster_id': sys.argv[1]}]}))
" "$CLASSIC" > "$SUBMIT"
  RUN_OUT=$(mktemp)
  # o comando pode sair 0 com o run FAILED: confere result_state explicitamente
  databricks jobs submit --json @"$SUBMIT" -p "$PROFILE" --timeout 40m -o json > "$RUN_OUT" || true
  rm -f "$SUBMIT"
  python3 - "$RUN_OUT" <<'PY' || { rm -f "$RUN_OUT"; exit 1; }
import json, sys
raw = open(sys.argv[1], encoding='utf-8').read()
try:
    run = json.loads(raw[raw.index('{'):])
except Exception:
    sys.exit('auto-config: o run não terminou (saída da CLI: ' + raw.strip()[:300] + ')')
states = [run.get('state', {})] + [t.get('state', {}) for t in run.get('tasks', [])]
if any(st.get('result_state') != 'SUCCESS' for st in states):
    msg = next((st.get('state_message') for st in states if st.get('result_state') != 'SUCCESS'), '')
    sys.exit(f"auto-config FALHOU ({msg or 'sem detalhes'}) — veja o run: {run.get('run_page_url', '')}")
PY
  rm -f "$RUN_OUT"
  echo "    auto-config concluído"
fi

URL=$(databricks apps get "$APP" -p "$PROFILE" -o json | python3 -c "import sys,json; print(json.load(sys.stdin).get('url',''))")
echo
echo "Pronto: $URL"
echo "Próximo passo: abra o app como admin (o deployer já é admin bootstrap) e, para liberar"
echo "o acesso aos usuários, dê Can Use em Compute → Apps → $APP → Permissions."
