#!/usr/bin/env bash
# AI Prism — full deploy to any Databricks workspace (AWS/Azure/GCP).
#
#   ./deploy.sh [options] <PROFILE> [CATALOG]
#
#   PROFILE   profile in ~/.databrickscfg (databricks auth login --host <url> --profile <name>).
#             No host is hard-coded here: the workspace is the profile's.
#   CATALOG   Unity Catalog catalog that holds AI Prism's `default` schema (Python UDF +
#             image volume). Default: ai_prism (created if you have CREATE CATALOG;
#             otherwise point it at an existing catalog you can use).
#
# Options (all optional; each one has an equivalent environment variable):
#
#   --tag key=value              resource tag, repeatable (up to 24). Same as TAGS="a=1,b=2".
#                                Applied to every resource the bundle creates and, through
#                                usage_context/query_tags, to what the app consumes. The
#                                built-in tag ai_prism_app=ai-prism is always added and
#                                cannot be overridden. Key/value: only letters, digits,
#                                space and + - = . : / @ (up to 255 characters), the same
#                                rules as server/resourceTags.js. See docs/tags.md.
#   --lakebase-suspend-minutes N minutes idle before Lakebase scales to zero (1..10080; bundle
#                                default otherwise). Same as LAKEBASE_SUSPEND_MINUTES=N.
#   --usage-policy-id ID         existing serverless usage policy (the account creates it; the
#                                bundle never does). Attributes the serverless usage of the App
#                                and the auto-config job. Same as SERVERLESS_USAGE_POLICY_ID=ID.
#   --classic-cluster-id ID      workspace WITHOUT serverless: id of a Dedicated / Single user
#                                classic cluster. The SQL Warehouse becomes classic Pro and the
#                                auto-config runs on that cluster. Same as CLASSIC_CLUSTER_ID=ID.
#   --skip-build                 do not run `npm run bundle` first; deploy client/dist and
#                                server-dist exactly as they are on disk (for example a release
#                                zip, or a machine without Node). Same as AI_PRISM_SKIP_BUILD=1.
#   --skip-smoke                 do not run `npm run smoke` against the deployed app at the end.
#                                Same as AI_PRISM_SKIP_SMOKE=1.
#   --models-file FILE           your models file (a copy of models.example.json with your chat and image
#                                models). Without it nothing changes: the model catalog follows the admin
#                                Models tab, exactly as before. Validated before anything is written
#                                (scripts/validate-models-config.mjs, which also checks each image model in
#                                the workspace) and staged at deploy-config/models.json (git-ignored, synced
#                                with the app; the tracked files are never touched). Same as
#                                AI_PRISM_MODELS_FILE. See docs/onboarding-deployment.md.
#
# Examples:
#   ./deploy.sh DEV
#   ./deploy.sh --tag cost_center=1234 --tag area=Finance DEV ai_prism
#   ./deploy.sh --lakebase-suspend-minutes 30 --usage-policy-id <id> DEV
#   ./deploy.sh --skip-build --skip-smoke DEV
#   ./deploy.sh --models-file my-models.json DEV      # start from models.example.json
#
# Lakebase (soft delete): an earlier `databricks bundle destroy` leaves the Lakebase
# project deleted in a reversible way, and it still holds the name. Before anything
# else the deploy checks for that and prints both commands (restore or purge). It
# NEVER purges by itself; see docs/onboarding-deployment.md, troubleshooting.
#
# What it does: npm run bundle (client/dist + server-dist) → bundle deploy (Lakebase,
# SQL Warehouse, cost and operations dashboards, job, app) → start the app → run the
# auto-config (SP role, your app tables to the owner role, UDF, volume, tags, admin) →
# `node scripts/migrate.mjs prepare` (opens the owner hand-off for the app SP) →
# publish the code (apps deploy) → npm run smoke against the app URL with your OAuth
# token → `node scripts/migrate.mjs up --role <app SP>` as you, the database owner
# (least-privilege grants; closes the hand-off). Once the hand-off is open, every exit
# path closes it, and the run only succeeds when it is closed. Without node the
# hand-off is never opened and the run fails at the end. Any failing step makes the
# script exit non-zero. Safe to re-run (idempotent).
#
# Requires: a recent Databricks CLI (with the `bundle` and `postgres` groups), python3,
# an authenticated profile, and Node 22 + npm with `npm ci` done (unless both
# --skip-build and --skip-smoke). `bundle deploy` alone does not republish the App
# code; this script does.
set -euo pipefail

APP=ai-prism
TARGET="${AI_PRISM_TARGET:-dev}"
JOB=ai_prism_auto_config

# --help prints the comment block above (every line from 2 up to the first non-comment line)
usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }

# --- arguments: options with a value (separate or with =) mixed with the positionals ---
TAG_ARGS=()
POSITIONAL=()
SKIP_BUILD="${AI_PRISM_SKIP_BUILD:-0}"
SKIP_SMOKE="${AI_PRISM_SKIP_SMOKE:-0}"
MODELS_FILE="${AI_PRISM_MODELS_FILE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)                    TAG_ARGS+=("${2:?--tag needs a key=value}"); shift 2 ;;
    --tag=*)                  TAG_ARGS+=("${1#--tag=}"); shift ;;
    --lakebase-suspend-minutes) LAKEBASE_SUSPEND_MINUTES="${2:?--lakebase-suspend-minutes needs a number}"; shift 2 ;;
    --lakebase-suspend-minutes=*) LAKEBASE_SUSPEND_MINUTES="${1#*=}"; shift ;;
    --usage-policy-id)        SERVERLESS_USAGE_POLICY_ID="${2:?--usage-policy-id needs an id}"; shift 2 ;;
    --usage-policy-id=*)      SERVERLESS_USAGE_POLICY_ID="${1#*=}"; shift ;;
    --classic-cluster-id)     CLASSIC_CLUSTER_ID="${2:?--classic-cluster-id needs an id}"; shift 2 ;;
    --classic-cluster-id=*)   CLASSIC_CLUSTER_ID="${1#*=}"; shift ;;
    --skip-build)             SKIP_BUILD=1; shift ;;
    --skip-smoke)             SKIP_SMOKE=1; shift ;;
    --models-file)            MODELS_FILE="${2:?--models-file needs a file}"; shift 2 ;;
    --models-file=*)          MODELS_FILE="${1#--models-file=}"; shift ;;
    -h|--help)                usage; exit 0 ;;
    --)                       shift; while [ $# -gt 0 ]; do POSITIONAL+=("$1"); shift; done ;;
    -*)                       echo "unknown option: $1 (see ./deploy.sh --help)" >&2; exit 2 ;;
    *)                        POSITIONAL+=("$1"); shift ;;
  esac
done
set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

PROFILE="${1:?usage: ./deploy.sh [options] <PROFILE> [CATALOG]  (see ./deploy.sh --help)}"
CATALOG="${2:-ai_prism}"
# an alternative models file is resolved before the cd below, so a relative path means the caller's folder
if [ -n "$MODELS_FILE" ]; then
  [ -f "$MODELS_FILE" ] || { echo "models file not found: $MODELS_FILE" >&2; exit 1; }
  MODELS_FILE="$(cd "$(dirname "$MODELS_FILE")" && pwd -P)/${MODELS_FILE##*/}"
fi
cd "$(dirname "$0")"

# --- cheap checks, before touching any resource ---
if [ -n "${LAKEBASE_SUSPEND_MINUTES:-}" ]; then
  [[ "$LAKEBASE_SUSPEND_MINUTES" =~ ^[0-9]+$ ]] && [ "$((10#$LAKEBASE_SUSPEND_MINUTES))" -ge 1 ] && [ "$((10#$LAKEBASE_SUSPEND_MINUTES))" -le 10080 ] \
    || { echo "--lakebase-suspend-minutes must be a number from 1 to 10080 (minutes)" >&2; exit 1; }
fi
[ "$SKIP_BUILD" = 1 ] || [ "$SKIP_BUILD" = true ] && SKIP_BUILD=1 || SKIP_BUILD=0
[ "$SKIP_SMOKE" = 1 ] || [ "$SKIP_SMOKE" = true ] && SKIP_SMOKE=1 || SKIP_SMOKE=0
# The build and the smoke both need npm (and Node 22). Fail now, not after the deploy.
if { [ "$SKIP_BUILD" = 0 ] || [ "$SKIP_SMOKE" = 0 ]; } && ! command -v npm >/dev/null 2>&1; then
  echo "npm not found: install Node 22 and run \`npm ci\` so the deploy can build the app and smoke it," >&2
  echo "or pass --skip-build --skip-smoke (AI_PRISM_SKIP_BUILD=1 AI_PRISM_SKIP_SMOKE=1) to deploy" >&2
  echo "client/dist + server-dist exactly as they are on disk, without the post-deploy smoke." >&2
  exit 1
fi

# --- models file (--models-file / AI_PRISM_MODELS_FILE): validated BEFORE anything is written or deployed ---
# Optional. Without it the deploy is exactly what it was: no validation, no staged file, and the model
# catalog follows the admin tab. scripts/validate-models-config.mjs checks "models" (id + label), "imageModels"
# (serving endpoint or Model Provider Service items) and, with the profile, each image model in the workspace
# (a check that cannot run is a warning). Without node, python3 runs the same structural checks.
validate_models() { # <file> [profile]
  if command -v node >/dev/null 2>&1; then
    node scripts/validate-models-config.mjs "$1" ${2:+--profile "$2"} || exit 1
    return
  fi
  echo "WARNING: node not found: the models file is checked for structure only, not against the workspace." >&2
  python3 - "$1" <<'PY' || exit 1
import json, re, sys

path = sys.argv[1]
try:
    cfg = json.load(open(path, encoding='utf-8'))
except Exception as e:
    sys.exit(f'Invalid models JSON in {path}: {e}')
errors = []
text = lambda v: isinstance(v, str) and v.strip() != ''
if not isinstance(cfg, dict):
    sys.exit('the file must be a JSON object')
models = cfg.get('models')
if not isinstance(models, list) or not models:
    errors.append('the "models" list is missing or empty')
    models = []
chat_ids = set()
for i, m in enumerate(models, 1):
    if not isinstance(m, dict) or not text(m.get('id')):
        errors.append(f'model {i} has no "id"')
        continue
    mid = m['id'].strip()
    if not text(m.get('label')):
        errors.append(f'model {i} ({mid}) has no "label"')
    if mid in chat_ids:
        errors.append(f'model {mid} appears more than once in "models"')
    chat_ids.add(mid)
serving = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$')
part = re.compile(r'^[A-Za-z0-9_]{1,255}$')
target = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$')
if 'imageModels' in cfg:
    images = cfg['imageModels']
    if not isinstance(images, list):
        errors.append('"imageModels" must be a list (use [] to turn image generation off)')
        images = []
    seen = set()
    for i, m in enumerate(images, 1):
        if not isinstance(m, dict):
            errors.append(f'image model {i} must be an object')
            continue
        is_provider = 'provider' in m or 'model' in m
        if is_provider and 'id' in m:
            errors.append(f'image model {i} mixes the two kinds: use "id" (serving endpoint) or "provider" + "model" (Unity Catalog Model Provider Service)')
            continue
        if is_provider:
            prov, model = str(m.get('provider', '')).strip(), str(m.get('model', '')).strip()
            parts = prov.split('.')
            if len(parts) != 3 or not all(part.match(p) for p in parts):
                errors.append(f'image model {i} has an invalid "provider" {prov!r}: use the 3-part UC name catalog.schema.service')
                continue
            if not target.match(model) or '..' in model:
                errors.append(f'image model {i} has an invalid "model" {model!r}')
                continue
            iid = f'{prov}/{model}'
        else:
            iid = str(m.get('id', '')).strip()
            if not serving.match(iid):
                errors.append(f'image model {i} has an invalid or missing "id" {iid!r}: use letters, digits, "-" and "_" only (up to 63 characters)')
                continue
        if not text(m.get('label')):
            errors.append(f'image model {i} ({iid}) has no "label"')
        if iid in seen:
            errors.append(f'image model {iid} appears more than once in "imageModels"')
        if iid in chat_ids:
            errors.append(f'image model {iid} is also in "models"')
        seen.add(iid)
if errors:
    print(f'Models file with problems ({path}):', file=sys.stderr)
    for e in errors:
        print(f'  - {e}', file=sys.stderr)
    sys.exit(1)
PY
}
if [ -n "$MODELS_FILE" ]; then
  validate_models "$MODELS_FILE" "$PROFILE"
  # staged at a git-ignored path the bundle syncs (databricks.yml sync.include); models.example.json and
  # every other tracked file stay as they are. pwd -P on both sides: a symlinked checkout is the same file.
  mkdir -p deploy-config
  if [ "$MODELS_FILE" != "$(cd deploy-config && pwd -P)/models.json" ]; then cp "$MODELS_FILE" deploy-config/models.json; fi
  echo "==> models file $MODELS_FILE: the models this deploy applies (admin Settings > Models, once)"
  if command -v node >/dev/null 2>&1; then node scripts/validate-models-config.mjs deploy-config/models.json --list; fi
else
  # a file staged by an earlier deploy must not leak into this one
  rm -f deploy-config/models.json
fi

# --- Lakebase: project soft-deleted by an earlier destroy? ---
# get-project + list-projects without --show-deleted (get-project has no such flag).
# Does not block when it cannot tell: lets bundle deploy try.
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
    sys.exit(0)  # no such project (fresh install) or API unavailable: do not block
try:
    proj = json.loads(out) if out.strip() else {}
except Exception:
    proj = {}

rc2, out2 = cli('list-projects')
if rc2 != 0:
    sys.exit(0)  # could not confirm: let bundle deploy try and fail with its own error
try:
    ativos = {p.get('project_id') for p in (json.loads(out2) or [])}
except Exception:
    sys.exit(0)

if project_id in ativos:
    sys.exit(0)  # normal active project: bundle deploy takes care of it

delete_time = proj.get('delete_time') or (proj.get('status') or {}).get('delete_time') or ''
when = f' (delete_time={delete_time})' if delete_time else ''
sys.exit(
    f"\nThe Lakebase project 'projects/{project_id}' is soft-deleted{when}, probably by an earlier "
    f"`databricks bundle destroy`, and it still holds that name, so this deploy would fail "
    f"trying to recreate it.\n\n"
    f"Pick one and run ./deploy.sh again:\n"
    f"  1) Restore the old project (recovers the Lakebase data; NOT destructive):\n"
    f"       databricks postgres undelete-project projects/{project_id} -p {profile}\n"
    f"  2) Delete the old project FOR GOOD and free the name (DESTRUCTIVE: its data is "
    f"lost forever; make sure this is what you want before running it):\n"
    f"       databricks postgres delete-project projects/{project_id} -p {profile} --purge\n\n"
    f"See docs/onboarding-deployment.md (troubleshooting) for more context.\n"
)
PY
}
echo "==> Lakebase: checking that project $APP is not soft-deleted by an earlier destroy"
check_lakebase_project "$APP"

# --- build: client/dist + server-dist are what the App runs ---
# Feature branches do not commit these artifacts (their file names carry a content
# hash), so the copy on disk can be older than the code. Build them here, before
# anything is deployed; a failed build stops the run.
if [ "$SKIP_BUILD" = 1 ]; then
  echo "==> build skipped (--skip-build): deploying client/dist + server-dist as they are on disk"
else
  echo "==> npm run bundle (client/dist + server-dist)"
  npm run bundle || {
    echo "npm run bundle failed: nothing was deployed. Fix the build (did you run \`npm ci\`?)," >&2
    echo "or pass --skip-build to deploy the artifacts already on disk." >&2
    exit 1
  }
fi

echo "==> catalog: $CATALOG  ·  profile: $PROFILE  ·  target: $TARGET"
# The App runtime reads env ONLY from app.yaml (not from the bundle variables), so the
# catalog has to be written there too. A python block (not perl/sed) edits the whole
# app.yaml: the quotes and slash of the tags JSON do not survive a shell regex.
python3 - "$CATALOG" <<'PY'
import re, sys
catalog = sys.argv[1]
text = open('app.yaml', encoding='utf-8').read()
new, n = re.subn(r"(name: (?:TOOLS_CATALOG|IMAGE_VOLUME_CATALOG)\n\s*value: )'[^']*'",
                 lambda m: f"{m.group(1)}'{catalog}'", text)
if n == 0:
    sys.exit('app.yaml: TOOLS_CATALOG/IMAGE_VOLUME_CATALOG not found.')
open('app.yaml', 'w', encoding='utf-8').write(new)
PY

VARS=(--var "tools_catalog=$CATALOG" --var "image_volume_catalog=$CATALOG")

CLASSIC="${CLASSIC_CLUSTER_ID:-}"
if [ -n "$CLASSIC" ]; then
  echo "==> no serverless: classic Pro warehouse; auto-config on cluster $CLASSIC"
  VARS+=(--var warehouse_serverless=false)
fi

if [ -n "${LAKEBASE_SUSPEND_MINUTES:-}" ]; then
  echo "==> Lakebase scales to zero after $LAKEBASE_SUSPEND_MINUTES min idle"
  VARS+=(--var "lakebase_suspend_timeout=$((10#$LAKEBASE_SUSPEND_MINUTES * 60))s")
fi

if [ -n "${SERVERLESS_USAGE_POLICY_ID:-}" ]; then
  VARS+=(--var "serverless_usage_policy_id=$SERVERLESS_USAGE_POLICY_ID")
fi

# --- resource tags ---
# resource_tags / resource_tags_list are COMPLEX bundle variables (map / list): the CLI
# rejects `--var` with quotes in the value and rejects BUNDLE_VAR_* for a complex
# variable, so the only way is an overrides file in .databricks/bundle/<target>/.
# resource_tags_json (a plain string) does accept BUNDLE_VAR_resource_tags_json.
# Also writes AI_PRISM_RESOURCE_TAGS into app.yaml (read at runtime by server/resourceTags.js).
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
# The bundle job gets resource_tags as `tags` (a map), and the Jobs API accepts at
# most 25: 24 from the operator + ai_prism_app = 25. Clear error HERE, before the deploy.
MAX_OPERATOR_TAGS = 24
tags = {}
seen_lower = {}
for p in pairs:
    if '=' not in p:
        sys.exit(f'invalid tag (use key=value): {p!r}')
    k, v = p.split('=', 1)
    k, v = k.strip(), v.strip()
    # compare lower-cased: PowerShell (deploy.ps1) treats keys case-insensitively
    lower = k.lower()
    if lower == 'ai_prism_app':
        print('WARNING: the ai_prism_app tag is built in and cannot be overridden; the value given was ignored.', file=sys.stderr)
        continue
    if lower == 'application':
        print("WARNING: the 'application' tag is reserved (it attributes cost to AI Prism); the value given was ignored.", file=sys.stderr)
        continue
    if not TAG_RE.match(k):
        sys.exit(f'invalid tag key {k!r}: use only letters, digits, space and + - = . : / @ (up to 255 characters)')
    if not (v == '' or TAG_RE.match(v)):
        sys.exit(f'invalid tag value for {k!r} ({v!r}): use only letters, digits, space and + - = . : / @ (up to 255 characters)')
    if lower in seen_lower:
        sys.exit(f'tag {k!r} differs from {seen_lower[lower]!r} only by letter case; '
                 'PowerShell treats both as the same key, so use one spelling')
    if len(tags) >= MAX_OPERATOR_TAGS:
        sys.exit(f'more than {MAX_OPERATOR_TAGS} operator tags (Jobs API limit: 25 in total, '
                 'including the built-in ai_prism_app tag); remove some and run again')
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

# app.yaml: AI_PRISM_RESOURCE_TAGS. re.sub with a function (not a replacement string)
# so nothing in the JSON is escaped for the regex engine.
app_yaml = open('app.yaml', encoding='utf-8').read()
value_json = json.dumps(merged, ensure_ascii=False)
pattern = re.compile(r"(name: AI_PRISM_RESOURCE_TAGS\n\s*value: )'[^']*'")
new_yaml, n = pattern.subn(lambda m: f"{m.group(1)}'{value_json}'", app_yaml)
if n == 0:
    sys.exit('app.yaml: variable AI_PRISM_RESOURCE_TAGS not found (env: block missing).')
open('app.yaml', 'w', encoding='utf-8').write(new_yaml)

# for the caller (stdout): the JSON that goes into BUNDLE_VAR_resource_tags_json
print(value_json)
print(f'==> resource tags: {", ".join(f"{k}={v}" for k, v in merged.items())}', file=sys.stderr)
PY
}
RESOURCE_TAGS_JSON="$(apply_resource_tags "$TARGET")"
export BUNDLE_VAR_resource_tags_json="$RESOURCE_TAGS_JSON"

echo "==> bundle deploy"
databricks bundle deploy -p "$PROFILE" -t "$TARGET" "${VARS[@]}"

echo "==> start the app (ignored if it is already running)"
databricks apps start "$APP" -p "$PROFILE" >/dev/null 2>&1 || true

echo "==> auto-config (SP role + app tables to the owner role in Lakebase, UDF, volume, tags, admin)"
if [ -z "$CLASSIC" ]; then
  databricks bundle run "$JOB" -p "$PROFILE" -t "$TARGET" "${VARS[@]}"
else
  # same task as the job (parameters already resolved by the bundle), as a one-off
  # run on the classic cluster: the bundle job would use serverless compute
  JOB_ID=$(databricks bundle summary -p "$PROFILE" -t "$TARGET" "${VARS[@]}" -o json | python3 -c "import sys,json; print(json.load(sys.stdin)['resources']['jobs']['$JOB']['id'])")
  SUBMIT=$(mktemp)
  databricks jobs get "$JOB_ID" -p "$PROFILE" -o json | python3 -c "
import sys, json
t = json.load(sys.stdin)['settings']['tasks'][0]
print(json.dumps({'run_name': 'ai-prism auto-config (classic cluster)', 'tasks': [{
    'task_key': t['task_key'], 'notebook_task': t['notebook_task'], 'existing_cluster_id': sys.argv[1]}]}))
" "$CLASSIC" > "$SUBMIT"
  RUN_OUT=$(mktemp)
  # the command can exit 0 with the run FAILED: check result_state explicitly
  databricks jobs submit --json @"$SUBMIT" -p "$PROFILE" --timeout 40m -o json > "$RUN_OUT" || true
  rm -f "$SUBMIT"
  python3 - "$RUN_OUT" <<'PY' || { rm -f "$RUN_OUT"; exit 1; }
import json, sys
raw = open(sys.argv[1], encoding='utf-8').read()
try:
    run = json.loads(raw[raw.index('{'):])
except Exception:
    sys.exit('auto-config: the run did not finish (CLI output: ' + raw.strip()[:300] + ')')
states = [run.get('state', {})] + [t.get('state', {}) for t in run.get('tasks', [])]
if any(st.get('result_state') != 'SUCCESS' for st in states):
    msg = next((st.get('state_message') for st in states if st.get('result_state') != 'SUCCESS'), '')
    sys.exit(f"auto-config FAILED ({msg or 'no details'}); see the run: {run.get('run_page_url', '')}")
PY
  rm -f "$RUN_OUT"
  echo "    auto-config done"
fi

# --- database: the owner hand-off (server/db/grants.js), opened and closed here ---
# The auto-config handed your app tables to the owner role. Right before the code
# is published, `migrate.mjs prepare` lets the app SP act as that role, so the new
# code's first request (the smoke) can move every table into the ai_prism schema
# (migration 0002). From then on EVERY exit path runs `migrate.mjs up --role <SP>`
# (EXIT trap): least-privilege grants, or the revoke alone when 0002 is still
# deferred. The deploy only reports success when the hand-off is closed. The
# database credential is minted with the CLI and only reaches node's environment;
# it is never printed. Without node the hand-off is not opened at all: the app
# keeps running on the public schema and the run fails at the end.
DB_EP="projects/$APP/branches/production/endpoints/primary"
DB_MANUAL="node scripts/migrate.mjs up --role <app SP client id>   (as the database owner; docs/operations.md §6.4)"
HANDOFF=0
PUBLISHED=0
NO_NODE=0
DB_CLOSE_MANUAL="node scripts/migrate.mjs close --role <app SP client id>   (as the database owner; docs/operations.md §6.4)"
json_field() { python3 -c "import sys,json
d=json.load(sys.stdin)
for k in sys.argv[1].split('.'): d=(d or {}).get(k) if isinstance(d, dict) else None
print(d or '')" "$1"; }
# runs `node scripts/migrate.mjs <args>` as you, with a fresh database credential.
# Exit 90 = node was NOT started (no credential): nothing can have changed.
run_migrate() {
  local token rc=0
  token=$(databricks postgres generate-database-credential "$DB_EP" -p "$PROFILE" -o json 2>/dev/null | json_field token) || token=""
  if [ -z "$token" ]; then
    echo "database: could not mint a database credential for $DB_EP (databricks postgres generate-database-credential)." >&2
    return 90
  fi
  PGHOST="$DB_HOST" PGPORT=5432 PGUSER="$DB_USER" PGPASSWORD="$token" PGDATABASE=databricks_postgres PGSSLMODE=require \
    node scripts/migrate.mjs "$@" || rc=$?
  return "$rc"
}
# returns 0 when the hand-off is closed (or was never opened), 1 otherwise.
# Before the new code is published: revoke only (`close`); `up` could move the
# schema under the old release that is still serving. After: `up --role`.
finish_handoff() {
  local db_rc=0
  [ "$HANDOFF" = 1 ] || return 0
  HANDOFF=0
  if [ "$PUBLISHED" != 1 ]; then
    echo "==> database: revoke the owner hand-off (the new code was not published)"
    run_migrate close --role "$DB_SP" || db_rc=$?
    if [ "$db_rc" = 0 ]; then
      echo "database: owner hand-off closed; the new code was NOT published." >&2
      return 0
    fi
    echo "database: could not confirm that the owner hand-off is closed (exit $db_rc): the app SP may still" >&2
    echo "be able to act as the table owner (still OPEN until revoked). Run, as the database owner: $DB_CLOSE_MANUAL" >&2
    return 1
  fi
  echo "==> database: migrate up + grants for the app SP (closes the owner hand-off)"
  run_migrate up --role "$DB_SP" || db_rc=$?
  case "$db_rc" in
    0) return 0 ;;
    3)
      echo "database: migration 0002 is still deferred (no request reached the new code), so the least-privilege" >&2
      echo "grants were NOT applied; the owner hand-off was closed and the app keeps running on the public schema." >&2
      echo "Run ./deploy.sh again (without --skip-smoke: the smoke makes the app apply it)." >&2 ;;
    4)
      echo "database: the owner hand-off is still OPEN (the app SP can act as the table owner)." >&2
      echo "Close it now, as the database owner that ran this deploy: $DB_MANUAL" >&2 ;;
    *)
      echo "database: migrate up + grants FAILED (exit $db_rc); the owner hand-off may still be open." >&2
      echo "Fix the cause and run, as the database owner: $DB_MANUAL" >&2
      echo "(or, to only revoke it: $DB_CLOSE_MANUAL)" >&2 ;;
  esac
  return 1
}
# every exit once prepare may have run (a failed or interrupted prepare included,
# a failed apps deploy, smoke, ...) closes the hand-off
on_exit() {
  local rc=$?
  trap - EXIT INT TERM
  finish_handoff || rc=1
  [ "$rc" = 0 ] && rc=1 # reached only on an early exit: never a success
  exit "$rc"
}
if command -v node >/dev/null 2>&1; then
  DB_SP=$(databricks apps get "$APP" -p "$PROFILE" -o json | json_field service_principal_client_id) || DB_SP=""
  DB_HOST=$(databricks postgres get-endpoint "$DB_EP" -p "$PROFILE" -o json | json_field status.hosts.host) || DB_HOST=""
  DB_USER=$(databricks current-user me -p "$PROFILE" -o json | json_field userName) || DB_USER=""
  if [ -z "$DB_SP" ] || [ -z "$DB_HOST" ] || [ -z "$DB_USER" ]; then
    echo "database: could not resolve the app SP, the Lakebase endpoint $DB_EP or your user name;" >&2
    echo "the new code was NOT published. Fix it and rerun ./deploy.sh." >&2
    exit 1
  fi
  echo "==> database: open the owner hand-off for the app SP (closed again after the smoke)"
  # armed BEFORE prepare: prepare commits the SP's membership in the database, and a
  # failure or an interrupt can come after that commit (QA round 2)
  HANDOFF=1
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  PREP_RC=0
  run_migrate prepare --role "$DB_SP" || PREP_RC=$?
  if [ "$PREP_RC" = 90 ]; then
    HANDOFF=0 # node never started: nothing was opened
  fi
  if [ "$PREP_RC" != 0 ]; then
    echo "database: prepare FAILED; the new code was NOT published. Fix it and rerun ./deploy.sh." >&2
    exit 1
  fi
else
  NO_NODE=1
  echo "WARNING: node not found: the owner hand-off is NOT opened; the app will keep running on the public" >&2
  echo "schema and this run will fail at the end (install Node 22 and rerun ./deploy.sh)." >&2
fi

SRC=$(databricks bundle summary -p "$PROFILE" -t "$TARGET" -o json | python3 -c "import sys,json; print(json.load(sys.stdin)['workspace']['file_path'])")
echo "==> apps deploy ($SRC)"
databricks apps deploy "$APP" --source-code-path "$SRC" -p "$PROFILE" >/dev/null
PUBLISHED=1

URL=$(databricks apps get "$APP" -p "$PROFILE" -o json | python3 -c "import sys,json; print(json.load(sys.stdin).get('url',''))")

# --- post-deploy smoke: the real user path against the deployed app ---
# scripts/smoke.mjs signs in with your OAuth token (the Apps proxy forwards your
# identity), runs one chat turn, reads it back and deletes the test chat. The token
# only goes to the smoke's environment; it is never printed. A failure here does not
# roll anything back: the new version is live, so look at the table above before
# giving users access.
if [ "$SKIP_SMOKE" = 1 ]; then
  echo "==> smoke skipped (--skip-smoke)"
elif [ -z "$URL" ]; then
  echo "smoke: the app has no URL yet (databricks apps get $APP -p $PROFILE); pass --skip-smoke to skip it." >&2
  exit 1
else
  echo "==> npm run smoke ($URL)"
  SMOKE_TOKEN=$(databricks auth token -p "$PROFILE" -o json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null) || SMOKE_TOKEN=""
  if [ -z "$SMOKE_TOKEN" ]; then
    echo "smoke: could not get an OAuth token for profile $PROFILE (databricks auth token -p $PROFILE)." >&2
    echo "The app is deployed; log in again (databricks auth login -p $PROFILE) and rerun, or pass --skip-smoke." >&2
    exit 1
  fi
  APP_URL="$URL" DATABRICKS_TOKEN="$SMOKE_TOKEN" npm run smoke || {
    echo "smoke FAILED against $URL: the new version is deployed, but a user path is broken (see the table above)." >&2
    echo "Fix it and rerun ./deploy.sh, or pass --skip-smoke to deploy without this check." >&2
    exit 1
  }
fi

if [ "$NO_NODE" = 1 ]; then
  echo "database: node not found, so the least-privilege step did not run: the app runs on the public schema" >&2
  echo "with the app SP's old privileges. Install Node 22 (\`npm ci\`) and rerun ./deploy.sh." >&2
  exit 1
fi
trap - EXIT INT TERM
finish_handoff || exit 1

echo
echo "Done: $URL"
echo "Next step: open the app as an admin (the deployer is the bootstrap admin) and, to let"
echo "users in, grant Can Use in Compute → Apps → $APP → Permissions."
