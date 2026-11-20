#!/usr/bin/env bash
# Turn on Unity Catalog telemetry export (logs, metrics, spans) for ONE named Databricks App.
#
#   scripts/telemetry/enable.sh --profile <profile> --app <app-name> \
#       --catalog <catalog> --schema <schema> [--dry-run]
#
# Guard rails: an explicit --profile (never the CLI default), an explicit --app, no
# `ai-prism` (the live app is changed by hand, see docs/operations.md §3), plain
# identifiers only, and nothing printed except the destination table names.
# The schema must exist and the app's service principal needs USE/CREATE on it (the
# platform creates otel_logs, otel_metrics and otel_spans). Redeploy the app afterwards.
set -euo pipefail

usage() {
  cat <<'U'
Usage: enable.sh --profile <profile> --app <app-name> --catalog <catalog> --schema <schema> [--dry-run]
  --profile   databricks CLI profile (required; the CLI default is never used)
  --app       app to update (required; "ai-prism" is refused)
  --catalog   Unity Catalog catalog that holds the telemetry tables
  --schema    schema inside the catalog (must already exist)
  --dry-run   print the update payload and call nothing
U
}

die() { echo "enable.sh: $*" >&2; exit 2; }

PROFILE="" APP="" CATALOG="" SCHEMA="" DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) [ $# -ge 2 ] || die "--profile needs a value"; PROFILE="$2"; shift 2 ;;
    --app) [ $# -ge 2 ] || die "--app needs a value"; APP="$2"; shift 2 ;;
    --catalog) [ $# -ge 2 ] || die "--catalog needs a value"; CATALOG="$2"; shift 2 ;;
    --schema) [ $# -ge 2 ] || die "--schema needs a value"; SCHEMA="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

[ -n "$PROFILE" ] || die "--profile is required"
[ -n "$APP" ] || die "--app is required"
[ -n "$CATALOG" ] || die "--catalog is required"
[ -n "$SCHEMA" ] || die "--schema is required"

APP_LC="$(printf '%s' "$APP" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
[ "$APP_LC" != "ai-prism" ] || die "refusing to change the live app ai-prism; enable it by hand (docs/operations.md §3)"

ident() { [[ "$2" =~ ^[A-Za-z0-9_-]+$ ]] || die "$1 must be a plain identifier (letters, digits, _ and -)"; }
ident app "$APP"; ident catalog "$CATALOG"; ident schema "$SCHEMA"; ident profile "$PROFILE"
case "$CATALOG$SCHEMA" in *-*) die "catalog and schema must use letters, digits and _ only" ;; esac

DEST="{\"telemetry_export_destinations\":[{\"unity_catalog\":{\"logs_table\":\"$CATALOG.$SCHEMA.otel_logs\",\"metrics_table\":\"$CATALOG.$SCHEMA.otel_metrics\",\"traces_table\":\"$CATALOG.$SCHEMA.otel_spans\"}}]}"

# `databricks apps update --json` REPLACES the app spec: sending only the destination would
# drop the app's resources and user API scopes. Read the current spec and merge into it.
merge() {
  python3 -c '
import json, sys
cur = json.loads(sys.argv[1])
dest = json.loads(sys.argv[2])
spec = dest
for k in ("description", "resources", "usage_policy_id", "budget_policy_id"):
    if cur.get(k):
        spec[k] = cur[k]
scopes = [s for s in cur.get("user_api_scopes") or cur.get("effective_user_api_scopes") or [] if not s.startswith("iam.")]
if scopes:
    spec["user_api_scopes"] = scopes
print(json.dumps(spec, separators=(",", ":")))
' "$1" "$2"
}

if [ "$DRY" = 1 ]; then
  echo "$DEST"
  exit 0
fi

CURRENT="$(databricks apps get "$APP" -p "$PROFILE" -o json)" || die "could not read app $APP"
PAYLOAD="$(merge "$CURRENT" "$DEST")"
databricks apps update "$APP" -p "$PROFILE" --json "$PAYLOAD" >/dev/null
echo "telemetry export enabled for $APP -> $CATALOG.$SCHEMA.{otel_logs,otel_metrics,otel_spans}; redeploy the app to pick up OTEL_EXPORTER_OTLP_ENDPOINT"
