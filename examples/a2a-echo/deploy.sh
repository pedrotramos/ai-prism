#!/usr/bin/env bash
# Deploys (or removes) the example A2A echo agent as its own Databricks App, "ai-prism-a2a-echo".
#
#   examples/a2a-echo/deploy.sh deploy  <cli-profile>     # bundle, create the App if missing, sync, deploy, print the card URL
#   examples/a2a-echo/deploy.sh cleanup <cli-profile>     # delete the App and its workspace folder
#
# It only ever touches the App named below and its own folder under the caller's workspace home. Run it from the repo
# root. The App sees every request already authenticated by the Apps proxy, so grant the users who should reach it
# CAN_USE (the creator already has it), then register its card URL (or the App name) in Settings → Tools → A2A agents.
set -euo pipefail

APP=ai-prism-a2a-echo
ACTION=${1:-}
PROFILE=${2:-}
[ -n "$ACTION" ] && [ -n "$PROFILE" ] || { sed -n 2,9p "$0"; exit 2; }

ME=$(databricks current-user me -p "$PROFILE" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["userName"])')
REMOTE="/Workspace/Users/$ME/$APP"

case "$ACTION" in
  deploy)
    STAGE=$(mktemp -d)
    trap 'rm -rf "$STAGE"' EXIT
    npx --no-install esbuild examples/a2a-echo/main.ts --bundle --platform=node --target=node22 --format=cjs --outfile="$STAGE/index.cjs" --log-level=warning
    cp examples/a2a-echo/app.yaml examples/a2a-echo/package.json "$STAGE/"
    databricks apps get "$APP" -p "$PROFILE" >/dev/null 2>&1 || databricks apps create "$APP" --description "Example A2A echo agent for AI Prism (docs/a2a.md)" -p "$PROFILE"
    databricks sync "$STAGE" "$REMOTE" --full -p "$PROFILE"
    databricks apps deploy "$APP" --source-code-path "$REMOTE" -p "$PROFILE"
    URL=$(databricks apps get "$APP" -p "$PROFILE" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')
    echo "card: $URL/.well-known/agent-card.json"
    ;;
  cleanup)
    databricks apps delete "$APP" -p "$PROFILE"
    databricks workspace delete "$REMOTE" --recursive -p "$PROFILE" || true
    ;;
  *)
    sed -n 2,9p "$0"
    exit 2
    ;;
esac
