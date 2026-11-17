#!/usr/bin/env bash
# Deploy (create or update) one AI Prism dashboard (cost by default, or the
# operations one via DASHBOARD_FILE) as a Databricks AI/BI (Lakeview) dashboard.
# Idempotent: pass an existing DASHBOARD_ID to update in place, or omit it to
# create a new one (the script prints the new id to save).
#
# The dashboard reads Databricks SYSTEM TABLES directly (system.serving.endpoint_usage
# + served_entities for scope/tokens, system.ai_gateway.usage for latency/token_details,
# system.billing.usage/list_prices for cost), so admins audit AI Prism cost/usage
# in AI/BI instead of inside the app — no SQL Warehouse call ever blocks the UI.
# ai-costs.lvdash.json is the exact export from the Databricks dashboard editor
# (edit it there and re-export; don't hand-edit the JSON).
#
# All values below are yours to set — nothing is tied to a specific account:
#   PROFILE      your databricks CLI profile (from `databricks auth login`)
#   WAREHOUSE_ID any SQL Warehouse in your workspace
#   PARENT_PATH  workspace folder for a NEW dashboard, e.g. /Users/<you>@<company>.com
#   DASHBOARD_FILE optional: dashboard JSON in this folder (default ai-costs.lvdash.json;
#                 use ai-ops.lvdash.json for the operations dashboard, with its own DISPLAY_NAME)
#
# Usage:
#   PROFILE=<profile> WAREHOUSE_ID=<warehouse-id> \
#     PARENT_PATH=/Users/<you>@<company>.com [DASHBOARD_ID=...] \
#     ./dashboards/deploy.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# DASHBOARD_FILE picks the dashboard to push (default: costs), e.g. ai-ops.lvdash.json.
SERIALIZED_FILE="$HERE/${DASHBOARD_FILE:-ai-costs.lvdash.json}"

: "${PROFILE:?set PROFILE (a databricks CLI profile, from \`databricks auth login\`)}"
: "${WAREHOUSE_ID:?set WAREHOUSE_ID (the SQL Warehouse that runs dashboard queries)}"
DISPLAY_NAME="${DISPLAY_NAME:-AI Prism — AI costs per user}"

# The Lakeview API wants serialized_dashboard as a JSON *string*, so embed the
# file's contents as a string value. jq builds the request body safely into a
# temp file (this CLI's --json reads a string or @file, not stdin).
BODY_FILE="$(mktemp -t ai-prism-dashboard.XXXXXX.json)"
trap 'rm -f "$BODY_FILE"' EXIT

if [[ -n "${DASHBOARD_ID:-}" ]]; then
  echo "Updating dashboard ${DASHBOARD_ID} on profile ${PROFILE}..."
  jq -n --arg name "$DISPLAY_NAME" --arg wh "$WAREHOUSE_ID" \
        --rawfile ser "$SERIALIZED_FILE" \
        '{display_name: $name, warehouse_id: $wh, serialized_dashboard: $ser}' > "$BODY_FILE"
  databricks api patch "/api/2.0/lakeview/dashboards/$DASHBOARD_ID" \
    --profile "$PROFILE" --json "@$BODY_FILE"
else
  : "${PARENT_PATH:?set PARENT_PATH (workspace folder for a NEW dashboard, e.g. /Users/<you>@<company>.com)}"
  echo "Creating dashboard \"${DISPLAY_NAME}\" under ${PARENT_PATH} on profile ${PROFILE}..."
  jq -n --arg name "$DISPLAY_NAME" --arg wh "$WAREHOUSE_ID" --arg pp "$PARENT_PATH" \
        --rawfile ser "$SERIALIZED_FILE" \
        '{display_name: $name, warehouse_id: $wh, parent_path: $pp, serialized_dashboard: $ser}' > "$BODY_FILE"
  databricks api post "/api/2.0/lakeview/dashboards" \
    --profile "$PROFILE" --json "@$BODY_FILE"
  echo
  echo "Save the dashboard_id above; pass it as DASHBOARD_ID next time to update in place."
fi
