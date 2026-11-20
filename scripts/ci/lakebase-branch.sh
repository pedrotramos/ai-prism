#!/usr/bin/env bash
# Ephemeral Lakebase branch job (W3-1): proves the migrations up -> down -> up and the
# isolation + RLS suites against a REAL Lakebase (Postgres 17, databricks_auth) on a
# throwaway branch, then deletes the branch. Used by .github/workflows/lakebase-branch.yml
# and runnable locally:
#
#   SECRETS_PRESENT=1 LB_PROFILE=<profile> bash scripts/ci/lakebase-branch.sh run
#
# Subcommands
#   run                    the whole job (skips with a notice, exit 0, unless SECRETS_PRESENT=1)
#   delete-branch <path>   guarded delete by literal path (also used by the trap)
#   sweep <run-id>         belt and braces after a killed job: deletes this run's own
#                          branches (w3-1-<run-id>-*), through the same guard
#   check-role             role guard: prints current_user/rolsuper/rolbypassrls from the
#                          PG* environment and FAILS when either flag is true
#
# Environment
#   SECRETS_PRESENT   1 when the workspace credentials exist (the workflow sets it)
#   LB_PROFILE        CLI profile (local run). In CI the auth is DATABRICKS_HOST,
#                     DATABRICKS_CLIENT_ID, DATABRICKS_CLIENT_SECRET from the environment.
#   LB_PROJECT        Lakebase project (default ai-prism); branches are created FROM its
#                     production branch, which is never written to or deleted
#   LB_TTL            branch TTL, the safety net if the job dies (default 14400s)
#   LB_SUFFIX         branch name suffix (default: GITHUB_RUN_ID-<random>)
#   LB_EVIDENCE_DIR   where the redacted log is saved (optional)
#
# The deploying identity and databricks_superuser have rolbypassrls=t: RLS suites run
# under such a role PASS WITHOUT TESTING ANYTHING. The suites therefore run db.js as
# ai_prism_app, created here NOSUPERUSER NOBYPASSRLS in a NEW database of the branch, and
# the job fails if the role check says otherwise. The token is never printed.
set -euo pipefail

APP_ROLE=ai_prism_app
DB_NAME=ai_prism_ci
BRANCH_PREFIX=w3-1-
PROJECT="${LB_PROJECT:-ai-prism}"

dbx() {
  if [ -n "${LB_PROFILE:-}" ]; then databricks "$@" --profile "$LB_PROFILE"; else databricks "$@"; fi
}

die() { echo "::error::$*" >&2; exit 1; }

# ---- guards ---------------------------------------------------------------------
# Only this job's own branches (w3-1-...), never anything containing "production".
guard_branch_path() {
  local p="${1:-}" lower
  lower="$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in *production*) die "refusing to touch a path containing 'production': $p" ;; esac
  if ! [[ "$p" =~ ^projects/[a-z][a-z0-9-]*/branches/${BRANCH_PREFIX}[a-z0-9-]+$ ]]; then
    die "refusing: '$p' is not one of this job's branches (projects/<p>/branches/${BRANCH_PREFIX}<id>)"
  fi
}

delete_branch() {
  guard_branch_path "${1:-}"
  dbx postgres delete-branch "$1"
}

check_role() {
  local out user sup byp
  out="$(psql -X -tA -F'|' -c "SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user" 2>&1)" || die "role check could not run: ${out}"
  IFS='|' read -r user sup byp <<<"$out"
  [ -n "${user:-}" ] && [ -n "${sup:-}" ] && [ -n "${byp:-}" ] || die "role check returned an unusable answer"
  echo "role check: current_user=$user rolsuper=$sup rolbypassrls=$byp"
  if [ "$sup" != "f" ] || [ "$byp" != "f" ]; then
    die "the suites would run as a role that skips row-level security (rolsuper=$sup rolbypassrls=$byp)"
  fi
}

# ---- the job --------------------------------------------------------------------
BRANCH_PATH=""
PROXY_PID=""
TOKEN=""
CLEAN_DONE=0
MASK_FILE=""
SUITES_OUT=""

cleanup() {
  local rc=$?
  [ "$CLEAN_DONE" = 1 ] && return
  CLEAN_DONE=1
  set +e
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null
  rm -f "$MASK_FILE" "$SUITES_OUT"
  if [ -n "$BRANCH_PATH" ]; then
    echo "::group::cleanup: delete $BRANCH_PATH"
    delete_branch "$BRANCH_PATH" && verify_gone
    echo "::endgroup::"
  fi
  exit "$rc"
}

verify_gone() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! dbx postgres get-branch "$BRANCH_PATH" -o json >/dev/null 2>&1; then
      echo "branch $BRANCH_PATH is gone"
      return 0
    fi
    perl -e 'select(undef,undef,undef,3)'
  done
  echo "::warning::branch $BRANCH_PATH still listed after delete (its TTL will remove it)"
  return 1
}

step_t0=0
step() { step_t0=$SECONDS; echo "::group::$*"; }
done_step() { echo "::endgroup::"; echo "timing: $1 took $((SECONDS - step_t0))s"; }

wait_state() { # <get-cmd...> ; waits for status.current_state == READY
  local i s
  for i in $(seq 1 60); do
    s="$(dbx "$@" -o json 2>/dev/null | jq -r '.status.current_state // empty' || true)"
    [ "$s" = "READY" ] && return 0
    perl -e 'select(undef,undef,undef,5)'
  done
  die "timed out waiting for $* (last state: ${s:-none})"
}

run_job() {
  if [ "${SECRETS_PRESENT:-0}" != "1" ]; then
    echo "::notice::Lakebase branch job skipped: no workspace credentials (SECRETS_PRESENT!=1). Nothing was created."
    exit 0
  fi
  for t in databricks psql node jq perl; do command -v "$t" >/dev/null || die "missing tool: $t"; done
  local here repo
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo="$(cd "$here/../.." && pwd)"
  cd "$repo"

  MASK_FILE="$(mktemp)"; chmod 600 "$MASK_FILE"
  exec 3>&1
  if [ -n "${LB_EVIDENCE_DIR:-}" ]; then
    mkdir -p "$LB_EVIDENCE_DIR"
    # secrets never reach the saved log: the token is masked once it exists (see mask_stream)
    exec > >(mask_stream | tee "$LB_EVIDENCE_DIR/lakebase-branch.log") 2>&1
  fi
  local started=$SECONDS
  SUITES_OUT="$(mktemp)"
  trap cleanup EXIT INT TERM

  local suffix="${LB_SUFFIX:-${GITHUB_RUN_ID:-local}-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c4)}"
  local branch_id="${BRANCH_PREFIX}${suffix}"
  local want="projects/$PROJECT/branches/$branch_id"
  guard_branch_path "$want"

  step "1. create branch $branch_id (ttl ${LB_TTL:-14400s}) from production"
  dbx postgres create-branch "projects/$PROJECT" "$branch_id" --no-wait \
    --json "{\"spec\":{\"source_branch\":\"projects/$PROJECT/branches/production\",\"ttl\":\"${LB_TTL:-14400s}\"}}" >/dev/null
  BRANCH_PATH="$want" # from here on the trap deletes it
  wait_state postgres get-branch "$BRANCH_PATH"
  done_step "create branch"

  step "2. endpoint and credentials"
  local ep="$BRANCH_PATH/endpoints/primary" host owner
  if ! dbx postgres get-endpoint "$ep" -o json >/dev/null 2>&1; then
    dbx postgres create-endpoint "$BRANCH_PATH" primary --no-wait \
      --json '{"spec":{"endpoint_type":"ENDPOINT_TYPE_READ_WRITE","autoscaling_limit_min_cu":0.5,"autoscaling_limit_max_cu":0.5}}' >/dev/null
  fi
  wait_endpoint "$ep"
  host="$(dbx postgres get-endpoint "$ep" -o json | jq -r '.status.hosts.host')"
  TOKEN="$(dbx postgres generate-database-credential "$ep" -o json | jq -r '.token')"
  [ -n "$TOKEN" ] && [ "$TOKEN" != null ] || die "no database credential"
  printf '%s\n' "$TOKEN" >"$MASK_FILE"
  # to the runner's own stdout (fd 3), never into the saved log
  echo "::add-mask::$TOKEN" >&3
  owner="$(dbx current-user me -o json | jq -r '.userName')"
  # what the suites use as PGPASSWORD: a throwaway, never the token (see pg-tls-proxy.mjs)
  local dummy_pw
  dummy_pw="Zq9#$(openssl rand -hex 16)"
  echo "endpoint host present: $([ -n "$host" ] && echo yes || echo no); deploying identity: $owner"
  done_step "endpoint and credentials"

  step "3. new database $DB_NAME and the $APP_ROLE role (NOBYPASSRLS)"
  export PGOPTIONS="-c createrole_self_grant=set,inherit"
  PGPASSWORD="$TOKEN" PGSSLMODE=require PGHOST="$host" PGPORT=5432 PGUSER="$owner" PGDATABASE=databricks_postgres \
    psql -X -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME"
  PGPASSWORD="$TOKEN" PGSSLMODE=require PGHOST="$host" PGPORT=5432 PGUSER="$owner" PGDATABASE="$DB_NAME" psql -X -v ON_ERROR_STOP=1 -q -f - <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE $APP_ROLE LOGIN PASSWORD '$dummy_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
SQL
  done_step "database and role"

  # the suites connect with ssl:false to a loopback host: bridge to Lakebase over TLS
  local port_line
  port_line="$(mktemp)"
  unset PGOPTIONS
  PG_PROXY_OWNER="$owner" PG_PROXY_TOKEN="$TOKEN" node "$here/pg-tls-proxy.mjs" "$host" 5432 0 >"$port_line" &
  PROXY_PID=$!
  local i
  for i in $(seq 1 50); do grep -q listening "$port_line" && break; perl -e 'select(undef,undef,undef,0.1)'; done
  local port
  port="$(awk '/listening/{print $2}' "$port_line")"
  rm -f "$port_line"
  [ -n "$port" ] || die "TLS bridge did not start"

  export PGPASSWORD="$dummy_pw" PGHOST=127.0.0.1 PGPORT="$port" PGUSER="$owner" PGDATABASE="$DB_NAME" PGSSLMODE=disable

  step "4. migrate up"
  node scripts/migrate.mjs up
  node scripts/migrate.mjs status
  done_step "migrate up"

  step "5. role guard (the identity the suites run db.js as)"
  PGUSER="$APP_ROLE" check_role
  done_step "role guard"

  local rc
  step "6. isolation + RLS suites"
  node --test --test-concurrency=1 --test-reporter=spec server/isolation.test.js server/rls.test.js >"$SUITES_OUT" 2>&1 && rc=0 || rc=$?
  cat "$SUITES_OUT"
  assert_counts "$SUITES_OUT"
  [ "$rc" = 0 ] || die "isolation/RLS suites failed (exit $rc)"
  done_step "suites"

  step "7. migrate down --to 0, then up again"
  node scripts/migrate.mjs down --to 0 --yes
  node scripts/migrate.mjs status
  node scripts/migrate.mjs up
  node scripts/migrate.mjs status
  done_step "down/up"

  echo "total wall time: $((SECONDS - started))s (steps above); branch deletion follows"
}

# the suites must really run: isolation 19 and rls 16 passing, nothing skipped
assert_counts() {
  local f="$1" pass skip fail
  pass="$(grep -E '^ℹ pass ' "$f" | awk '{print $3}' | tail -1)"
  skip="$(grep -E '^ℹ skipped ' "$f" | awk '{print $3}' | tail -1)"
  fail="$(grep -E '^ℹ fail ' "$f" | awk '{print $3}' | tail -1)"
  echo "suite totals: pass=${pass:-?} fail=${fail:-?} skipped=${skip:-?}"
  [ "${skip:-1}" = 0 ] || die "suites skipped tests: that proves nothing on a real Lakebase"
  [ "${pass:-0}" -ge 35 ] || die "expected at least 35 passing cases (isolation 19 + rls 16), got ${pass:-0}"
}

wait_endpoint() {
  local i s
  for i in $(seq 1 60); do
    s="$(dbx postgres get-endpoint "$1" -o json 2>/dev/null | jq -r '.status.current_state // empty' || true)"
    case "$s" in READY|ACTIVE|IDLE) return 0 ;; esac
    perl -e 'select(undef,undef,undef,5)'
  done
  die "timed out waiting for endpoint $1 (last state: ${s:-none})"
}

# masks the credential in everything that is saved or printed
# (the token does not exist yet when the stream starts, so it is read from a 0600 file)
mask_stream() {
  LB_MASK_FILE="$MASK_FILE" perl -ne 'BEGIN{$|=1} if(!$t && -s $ENV{LB_MASK_FILE}){open F,$ENV{LB_MASK_FILE};chomp($t=<F>);close F} s/\Q$t\E/***/g if $t; print'
}

sweep() {
  local run_id="${1:-}" n
  [[ "$run_id" =~ ^[0-9]+$ ]] || die "sweep needs a numeric run id"
  while IFS= read -r n; do
    [ -n "$n" ] && { echo "sweeping $n"; delete_branch "$n"; }
  done < <(dbx postgres list-branches "projects/$PROJECT" -o json | jq -r --arg p "projects/$PROJECT/branches/${BRANCH_PREFIX}${run_id}-" '.[].name | select(startswith($p))')
}

case "${1:-}" in
  sweep) sweep "${2:-}" ;;
  run) run_job ;;
  delete-branch) delete_branch "${2:-}" ;;
  check-role) check_role ;;
  *) echo "usage: lakebase-branch.sh run | delete-branch <path> | sweep <run-id> | check-role" >&2; exit 2 ;;
esac
