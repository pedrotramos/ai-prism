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
#
# Examples:
#   ./deploy.sh DEV
#   ./deploy.sh --tag cost_center=1234 --tag area=Finance DEV ai_prism
#   ./deploy.sh --lakebase-suspend-minutes 30 --usage-policy-id <id> DEV
#   ./deploy.sh --skip-build --skip-smoke DEV
#
# Lakebase (soft delete): an earlier `databricks bundle destroy` leaves the Lakebase
# project deleted in a reversible way, and it still holds the name. Before anything
# else the deploy checks for that and prints both commands (restore or purge). It
# NEVER purges by itself; see docs/onboarding-deployment.md, troubleshooting.
#
# Never deletes, never recreates: before any workspace write the script runs
# `databricks bundle plan -o json` and aborts (fail closed, no opt-out) if the plan
# cannot be read or holds any delete/recreate; it then applies exactly that checked
# plan with `bundle deploy --plan` (CLI >= 1.17; Terraform state: migrate first, the
# script prints the command). A cold Lakebase endpoint is woken first, and a deploy
# that hits its "Failed to grant permissions ... deadline exceeded" is redone once,
# with a fresh plan and the same gate. AI_PRISM_LAKEBASE_WAKE_TIMEOUT (default 120 s)
# caps the wait. See docs/onboarding-deployment.md.
#
# What it does: npm run bundle (client/dist + server-dist) → plan gate → bundle deploy
# (Lakebase, SQL Warehouse, cost and operations dashboards, job, app) → start the app → run the
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
    -h|--help)                usage; exit 0 ;;
    --)                       shift; while [ $# -gt 0 ]; do POSITIONAL+=("$1"); shift; done ;;
    -*)                       echo "unknown option: $1 (see ./deploy.sh --help)" >&2; exit 2 ;;
    *)                        POSITIONAL+=("$1"); shift ;;
  esac
done
set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

PROFILE="${1:?usage: ./deploy.sh [options] <PROFILE> [CATALOG]  (see ./deploy.sh --help)}"
CATALOG="${2:-ai_prism}"
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

# --- Databricks CLI: the plan gate (below) needs `bundle plan` and `bundle deploy --plan` ---
# The deploy only ever applies a plan that was checked first. A CLI without both
# (older than 1.17, the version the installer notebook pins) aborts here, before any
# workspace call. There is no opt-out.
command -v databricks >/dev/null 2>&1 \
  || { echo "Databricks CLI not found. Install it (https://docs.databricks.com/dev-tools/cli/install) and run again." >&2; exit 1; }
_deploy_help="$(databricks bundle deploy --help 2>&1 || true)"
if ! databricks bundle plan --help >/dev/null 2>&1 || [[ "$_deploy_help" != *"--plan"* ]]; then
  echo "this Databricks CLI ($(databricks --version 2>&1 | head -n 1)) has no \`bundle plan\` and \`bundle deploy --plan\`, which the never-delete-or-recreate guarantee depends on. Update the CLI (>= 1.17) and run again. Nothing was changed." >&2
  exit 1
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

# --- plan gate: nothing is written to the workspace before the plan is checked ---
# This deploy NEVER deletes a user resource and NEVER replaces/recreates one that
# already exists. `bundle plan -o json` is read-only and gives the action of every
# bundle resource. The check FAILS CLOSED and has no opt-out: a command error,
# output that is not JSON, an unexpected shape, an unsupported plan_version, any
# delete/recreate, or ANY action outside the allowlist (create, skip, update, update_id,
# resize: an empty, unknown or newer-CLI action stops it too) aborts BEFORE the first
# workspace write. There is no CLI confirmation to lean on: `bundle deploy`
# asks nothing for apps, jobs, sql_warehouses or postgres_endpoints. So what gets
# applied is EXACTLY the checked plan: the saved JSON goes to `bundle deploy --plan`
# (direct engine; same on the CLI 1.17.0 the installer notebook pins and on 1.24.0),
# without re-planning. A plan without `plan_version` (state still on Terraform)
# ABORTS with the migration command: there is never a deploy without a checked plan.
#
# Cold Lakebase: with the endpoint idle (suspend_timeout), the database grant for the
# App that `bundle deploy` makes can time out ("Failed to grant permissions ...
# deadline exceeded") and leave a half-applied deploy. Before the deploy, if the
# endpoint already exists and is not ACTIVE, it is woken up and awaited until ACTIVE.
# Waking = opening and closing one authenticated Postgres connection (the protocol
# handshake, stdlib only, no SQL, no write) with your own OAuth credential
# (`databricks postgres generate-database-credential`). Best effort: any failure only
# warns and the deploy goes on (the retry below covers the rest). First deploy (no
# endpoint yet): nothing to do. ONE monotonic deadline, AI_PRISM_LAKEBASE_WAKE_TIMEOUT (seconds,
# 120), bounds the whole wake: every CLI call, connect, TLS handshake, read and poll.
DB_EP="projects/$APP/branches/production/endpoints/primary"
wake_lakebase_endpoint() {
  AI_PRISM_EP="$DB_EP" AI_PRISM_PROFILE="$PROFILE" python3 -I - <<'PY' || true
import json, os, signal, socket, ssl, struct, subprocess, sys, time
ep, profile = os.environ['AI_PRISM_EP'], os.environ['AI_PRISM_PROFILE']
try:
    limit = int(os.environ.get('AI_PRISM_LAKEBASE_WAKE_TIMEOUT', '120'))
except ValueError:
    limit = 120
# ONE monotonic deadline, taken here at entry: every CLI call, connect, TLS handshake, read and
# poll below gets only what is left of it. At expiry: close, warn, go on with the deploy.
deadline = time.monotonic() + max(limit, 0)
def left():
    r = deadline - time.monotonic()
    if r <= 0:
        raise TimeoutError(f'the {limit}s wake budget (AI_PRISM_LAKEBASE_WAKE_TIMEOUT) ran out')
    return r
def cli(*a):
    p = subprocess.Popen(['databricks', *a, '-p', profile, '-o', 'json'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        out, err = p.communicate(timeout=left())
    except BaseException:
        try:
            os.killpg(p.pid, signal.SIGKILL)  # the CLI and anything it started
        except Exception:
            p.kill()
        p.wait()
        raise
    return p.returncode, out, err
def state():
    rc, out, _ = cli('postgres', 'get-endpoint', ep)
    if rc != 0:
        return None, None, False
    try:
        st = (json.loads(out) or {}).get('status') or {}
    except Exception:
        return None, None, False
    return st.get('current_state'), (st.get('hosts') or {}).get('host'), bool(st.get('disabled'))
def warn(m):
    print(f'WARNING: {m}', file=sys.stderr)
try:
    cur, host, disabled = state()
except subprocess.TimeoutExpired:
    warn('the Lakebase endpoint lookup did not answer within the wake budget; going on with the deploy (if it times out it retries once).')
    sys.exit(0)
except TimeoutError as e:
    warn(f'{e}; going on with the deploy.')
    sys.exit(0)
if cur is None or disabled:
    sys.exit(0)  # first deploy (no endpoint yet) or endpoint turned off on purpose
if cur == 'ACTIVE':
    print('    Lakebase: endpoint ACTIVE')
    sys.exit(0)
print(f'    Lakebase: endpoint {cur}; waking it (read-only) so the deploy does not hit a cold database...')
s = None
try:
    rc, out, err = cli('postgres', 'generate-database-credential', ep)
    token = json.loads(out)['token']
    rc, out, err = cli('current-user', 'me')
    user = json.loads(out)['userName']
    s = socket.create_connection((host, int(os.environ.get('AI_PRISM_PG_PORT', '5432'))), timeout=left())
    s.settimeout(left())
    s.sendall(struct.pack('!II', 8, 80877103))  # SSLRequest
    s.settimeout(left())
    if s.recv(1) != b'S':
        raise RuntimeError('the server did not accept TLS')
    s.settimeout(left())
    s = ssl.create_default_context().wrap_socket(s, server_hostname=host)  # handshake, bounded by the timeout set above
    params = b'user\0' + user.encode() + b'\0database\0databricks_postgres\0\0'
    s.settimeout(left())
    s.sendall(struct.pack('!II', 8 + len(params), 196608) + params)
    def recvn(n):
        b = b''
        while len(b) < n:
            s.settimeout(left())
            c = s.recv(n - len(b))
            if not c:
                return None
            b += c
        return b
    while True:
        h = recvn(5)
        if h is None:
            break
        b = recvn(struct.unpack('!I', h[1:])[0] - 4)
        t = h[:1]
        if b is None or t in (b'Z', b'E'):
            break
        if t == b'R':
            auth = struct.unpack('!I', b[:4])[0]
            if auth == 3:  # AuthenticationCleartextPassword (OAuth token)
                pw = token.encode() + b'\0'
                s.settimeout(left())
                s.sendall(b'p' + struct.pack('!I', 4 + len(pw)) + pw)
            elif auth != 0:  # any other method (SASL, MD5, ...) is never answered: the handshake already reached the server
                break
    s.settimeout(left())
    s.sendall(b'X' + struct.pack('!I', 4))
except Exception as e:
    warn(f'could not wake Lakebase by connecting ({type(e).__name__}: {str(e)[:160]}); going on: if the deploy times out it retries once.')
finally:
    try:
        if s is not None:
            s.close()
    except Exception:
        pass
while True:
    try:
        cur, _, _ = state()
        if cur == 'ACTIVE':
            print('    Lakebase: endpoint ACTIVE')
            sys.exit(0)
        time.sleep(min(3, left()))
    except (TimeoutError, subprocess.TimeoutExpired):
        break
warn(f'the Lakebase endpoint is still not ACTIVE (state: {cur}); going on with the deploy.')
PY
}

# The gate is a function so it can run again (with a fresh plan) on the deploy retry below.
run_plan_gate() {
  echo "==> bundle plan (checking that nothing will be deleted or recreated)"
  # On the retry (GATE_RETRY=1) the first deploy may have been partly applied: "nothing was changed" would be untrue.
  if [ -n "${GATE_RETRY:-}" ]; then
    NOCHG="the first deploy may have been partly applied (whatever it already created or updated is still there) and this retry changed nothing more; running ./deploy.sh again is safe (idempotent)"
  else
    NOCHG="nothing was changed in the workspace"
  fi
  PLAN_OUT=$(mktemp)
  PLAN_ERR=$(mktemp)
  if ! databricks bundle plan -p "$PROFILE" -t "$TARGET" "${VARS[@]}" -o json >"$PLAN_OUT" 2>"$PLAN_ERR"; then
    echo "could not get the bundle plan (\`databricks bundle plan -o json\` failed: $(head -c 400 "$PLAN_ERR" | tr '\n' ' ')). For safety the deploy does NOT go on without checking that nothing will be deleted or recreated — $NOCHG. Fix the error above (update the Databricks CLI to >= 1.17 if needed) and run again." >&2
    rm -f "$PLAN_OUT" "$PLAN_ERR" "${DEPLOY_LOG:-}"
    exit 1
  fi
  NOCHG="$NOCHG" python3 -I - "$PLAN_OUT" "$PROFILE" "$TARGET" "${VARS[@]}" >"$PLAN_ERR" 2>&1 <<'PY' || { cat "$PLAN_ERR" >&2; rm -f "$PLAN_OUT" "$PLAN_ERR" "${DEPLOY_LOG:-}"; exit 1; }
import sys, json, shlex, os
nochg = os.environ["NOCHG"]
# Allowlist (CLI deployplan/action.go): every action the plan may carry that never deletes or
# replaces a resource. `resize` and `update_id` are in-place API calls (scale a pool / rename
# keeping the data), not delete+create. ANYTHING else - delete, recreate, an empty or unknown
# action, an action from a newer CLI - is rejected, as is a plan_version that is not supported.
SAFE_ACTIONS = ("create", "skip", "update", "update_id", "resize")
SUPPORTED_PLAN_VERSIONS = (2,)
review = " ".join(shlex.quote(a) for a in ["databricks", "bundle", "plan", "-t", sys.argv[3], "-p", sys.argv[2]] + sys.argv[4:])
def unexpected(why):
    sys.exit("the `bundle plan -o json` output is empty, unreadable or has an unexpected shape (" + why + "); for safety the deploy does NOT go on without checking that nothing will be deleted or recreated — " + nochg + ".")
try:
    doc = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    unexpected("not JSON")
if not isinstance(doc, dict) or not isinstance(doc.get("plan"), dict):
    unexpected("no `plan` object")
res = doc["plan"]
if not res:
    unexpected("no resources")
for k, v in res.items():
    if not (isinstance(k, str) and k.startswith("resources.")):
        unexpected("unexpected entry " + json.dumps(k)[:80])
    if not isinstance(v, dict) or not isinstance(v.get("action"), str):
        unexpected(json.dumps(k)[:80] + " has no `action`")
destructive = sorted(f"{k} ({v['action']})" for k, v in res.items() if v["action"] in ("delete", "recreate"))
if destructive:
    sys.exit("\nThe bundle plan would delete or recreate existing resources:\n  - " + "\n  - ".join(destructive) +
             "\nThis deploy never deletes or recreates an existing resource — " + nochg + ". "
             "Review the difference with `" + review + "` before going on.")
unknown = sorted(f"{k} ({v['action']!r})" for k, v in res.items() if v["action"] not in SAFE_ACTIONS)
if unknown:
    sys.exit("\nThe bundle plan has actions this deploy does not recognise as safe (it only accepts " + ", ".join(SAFE_ACTIONS) + "):\n  - " + "\n  - ".join(unknown) +
             "\nThis deploy never goes on with a plan it cannot fully classify — " + nochg + ". "
             "Review the difference with `" + review + "`; a newer Databricks CLI may have added actions this script does not know yet.")
if "plan_version" not in doc:
    sys.exit("\nThis `bundle plan` is not a saved direct-engine plan (no `plan_version`): this installation still uses Terraform state. "
             "The deploy only applies EXACTLY the checked plan (`bundle deploy --plan`), which needs the direct engine — and it never deploys without a checked plan. "
             "Migrate the state first (local only, it does not change the workspace; the `bundle deploy` of this script then syncs it):\n"
             "    " + " ".join(shlex.quote(a) for a in ["databricks", "bundle", "deployment", "migrate", "-t", sys.argv[3], "-p", sys.argv[2]] + sys.argv[4:]) + "\n"
             "and run ./deploy.sh again. " + nochg[0].upper() + nochg[1:] + ".")
ver = doc["plan_version"]
if type(ver) is not int or ver not in SUPPORTED_PLAN_VERSIONS:
    sys.exit("\nThis `bundle plan` has plan_version " + json.dumps(ver)[:40] + ", which this deploy does not support (supported: " + ", ".join(map(str, SUPPORTED_PLAN_VERSIONS)) +
             "). For safety the deploy does NOT go on with a plan format it cannot check — " + nochg + ". Use the Databricks CLI version this release was tested with (docs/onboarding-deployment.md).")
counts = {}
for v in res.values():
    counts[v["action"]] = counts.get(v["action"], 0) + 1
print("    plan: " + ", ".join(f"{n} {a}" for a, n in sorted(counts.items())))
print("    ok: no resource will be deleted or recreated")
PY
  cat "$PLAN_ERR"
  rm -f "$PLAN_ERR"
}
run_plan_gate

echo "==> bundle deploy"
# Wake Lakebase first (see wake_lakebase_endpoint). If the deploy still hits the deadline of the
# database grant ("Failed to grant permissions ... deadline exceeded": the database was cold), wake
# it again, redo the plan AND THE GATE (the check is never skipped) and retry ONCE, applying exactly
# the new checked plan. Any other error, or a second failure, aborts.
wake_lakebase_endpoint
DEPLOY_LOG=$(mktemp)
run_deploy() {
  databricks bundle deploy -p "$PROFILE" -t "$TARGET" "${VARS[@]}" --plan "$PLAN_OUT" 2>&1 | tee "$DEPLOY_LOG"
  return "${PIPESTATUS[0]}"
}
if ! run_deploy; then
  if grep -Eq 'Failed to grant permissions for .* on database projects/[^ ]*: deadline exceeded' "$DEPLOY_LOG"; then
    echo "==> the deploy hit the deadline granting the database permission on Lakebase (cold database): waking it, redoing the checked plan and retrying ONCE" >&2
    rm -f "$PLAN_OUT"
    wake_lakebase_endpoint
    GATE_RETRY=1
    run_plan_gate
    if ! run_deploy; then
      echo "the deploy failed again after the retry; nothing more will be tried. Run ./deploy.sh once more (it is idempotent)." >&2
      rm -f "$PLAN_OUT" "$DEPLOY_LOG"
      exit 1
    fi
  else
    rm -f "$PLAN_OUT" "$DEPLOY_LOG"
    exit 1
  fi
fi
rm -f "$PLAN_OUT" "$DEPLOY_LOG"

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
