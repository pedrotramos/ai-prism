# AI Prism — AI/BI dashboards

**English** · [Português (Brasil)](../docs/pt-BR/dashboards/README.md) · [Español](../docs/es/dashboards/README.md)

Admins audit AI Prism through three **Databricks AI/BI (Lakeview) dashboards**, not
inside the app. Two read Unity Catalog **system tables** only, so they need no
extra instrumentation and do not depend on the app's Lakebase. The queries run in
AI/BI on the bundle's SQL Warehouse, in their own executions: a cold warehouse or a
heavy system-table scan never blocks the app UI.

| Dashboard | File | Answers |
| --- | --- | --- |
| **AI Prism — AI costs per user** | `ai-costs.lvdash.json` | "How much did it cost, and who used it?" |
| **AI Prism — Operations** | `ai-ops.lvdash.json` | "Is the app being used, and is it answering?" |
| **AI Prism — Telemetry** | `ai-telemetry.lvdash.json` (generated) | "What failed, where, and which trace shows why?" |

One `databricks bundle deploy` (or `./deploy.sh`) ships all three: they are declared in
`databricks.yml` as `dashboards.ai_prism_costs`, `dashboards.ai_prism_ops` and `dashboards.ai_prism_telemetry`, on the
same warehouse as the app. Each workspace running AI Prism deploys its own copy;
nothing in this folder is bound to a particular account, warehouse or user.

## Cost dashboard (`ai-costs.lvdash.json`)

### What it shows

Real **billed** cost — `DBU × list price` from `system.billing.usage` ⋈
`system.billing.list_prices` — allocated to each user by their share of the
endpoint's daily tokens (`system.serving.endpoint_usage` ⋈
`system.serving.served_entities` for the endpoint name). Scoped to AI Prism via
the `usage_context['application'] = 'ai-prism'` stamp set on every gateway call
(see `server/llm.ts`). **Note:** `usage_context` lands in
`system.serving.endpoint_usage.usage_context`, *not* in
`system.ai_gateway.usage.request_tags`; an earlier query read the wrong
table/column and always returned "No data".

One dataset (**`ai_prism_detail`**), per user × endpoint × day, with `prompt_tokens`,
`completion_tokens`, `total_tokens`, `turns`, and the allocated `dbus` / `usd`,
feeds every widget (last 90 days).

Layout (12-column grid), matching the version curated in the dashboard editor:

- **Filters + headline KPIs** (top): a user multi-select and a period date-range
  picker (default last 30 days), plus counter cards: DBUs consumed, estimated cost
  (USD), turns, distinct users, input / output / total tokens.
- **Detail table**: user · endpoint · day with token and turn columns.
- **Four sections**, each a per-endpoint + per-day + per-user bar breakdown:
  **USD**, **Tokens**, **DBUs** and **Turns**.

Colors use the workspace theme's `visualizationColors` positions, so the dashboard
matches the app's visual language rather than a different color per chart.

### Notes

> **Ingestion lag.** `system.serving.endpoint_usage` (tokens) and
> `system.billing.usage` (cost) both lag about 1 h: the dashboard is near-real-time,
> not live.

> **Editing.** `ai-costs.lvdash.json` is the exact export from the Databricks
> dashboard editor. Edit there and bring the change back into the repo (see
> [Edit a dashboard](#edit-a-dashboard)); don't hand-edit the JSON.

## Operations dashboard (`ai-ops.lvdash.json`)

Complements the cost dashboard with **volume, users and latency**. Same scope
(`usage_context['application'] = 'ai-prism'` on `system.serving.endpoint_usage`),
same 90-day window in the queries, and a period filter (default: last 30 days).

### What it shows

| Widget | Dataset | Measure |
| --- | --- | --- |
| Calls, active users, tokens (counters) | `ops_daily`, `ops_user` | Total in the period |
| Calls per day × endpoint | `ops_daily` | Daily volume, stacked by endpoint |
| Tokens per day × endpoint | `ops_daily` | Same, in tokens |
| Calls per user | `ops_user` | How concentrated usage is |
| Totals per endpoint | `ops_daily` | Calls and tokens per model |
| Gateway p95 latency per day | `ops_latency` (joined with `system.ai_gateway.usage`) | p95 per day and endpoint, with ingestion lag |

The latency join uses `databricks_request_id = request_id`. It only returns rows for
calls that also land in `system.ai_gateway.usage`. In the test workspace checked on
2026-11-17 the query ran but returned 0 rows: AI Prism's `/serving-endpoints` calls
were not in that table there, so the latency panel stays empty until they are. The
other five widgets do not depend on it.

### What it does not show (and why)

- **Error rate**: `system.serving.endpoint_usage` has a `status_code` column
  (schema checked on 2026-11-17), but no widget uses it yet. An error-rate panel is
  planned together with the OpenTelemetry panels below.
- **Unpriced calls** (`cost_usd IS NULL`): that is a concept of `usage_ledger`, which
  lives in the app's Lakebase and is not a system table.
- **Volume per call type** (chat, media, intent classifier, image): the app only
  writes `application` into `usage_context`. Splitting by type needs `server/llm.ts`
  to also pass a key such as `feature`.
- **End-to-end latency of a turn**: the gateway only times the model call. The
  latency of the whole turn (database, tools, post-processing) comes from the
  OpenTelemetry telemetry.

## Telemetry dashboard (`ai-telemetry.lvdash.json`)

Unlike the other two it reads the **app's own telemetry tables** (`otel_spans`), so it exists
only after telemetry is enabled with `scripts/telemetry/enable.sh`
([docs/operations.md §3](../docs/operations.md#3-telemetry-opentelemetry)). The file is
**generated** by `build.py` for one `catalog.schema`, because a dashboard file cannot take a
bundle variable:

```bash
python3 dashboards/build.py                                  # ai_prism.telemetry (bundle variable defaults)
python3 dashboards/build.py --catalog <catalog> --schema <schema>
python3 dashboards/build.py --check                          # exit 1 if the file on disk is stale
```

- **Tab Telemetria**: requests to `/api`, 5xx, chat turns and gateway calls (counters); requests
  per day by status class and turns per day by outcome (stacked bars); tables of routes (volume,
  5xx, p95), models (calls, errors, tokens, cost, p95) and tools (calls, errors, p95).
- **Tab Falhas e trace**: failures of the last 7 days (5xx response, failed turn, gateway call or
  tool) with their `trace_id`, and a **Trace id** filter that lists every span of that trace.
  This is where the SQL alerts A2 and A7 (`databricks.yml`) lead.

Edit `build.py`, never the JSON. `tests/dashboardsBuild.test.mjs` checks that the committed file
equals the generator's output and that no widget is left in draft state (counters with a `trend`
key, versions, fields that do not match their dataset).

## Deploy and publish

### With the bundle (default)

You usually don't deploy these by hand. `databricks bundle deploy` (which
`./deploy.sh` and `.\deploy.ps1` run for you) creates or updates both dashboards as
**drafts** in the bundle's workspace folder. Then:

- **Cost dashboard**: the post-deploy auto-config job (`bundle/auto_config.py`)
  **publishes** it, so admins see it live with no manual step.
- **Operations dashboard**: stays a **draft**. Open it in the workspace
  (*Dashboards* → "AI Prism — Operations"; on the `dev` target the name carries a
  `[dev <user>]` prefix) and click **Publish** once. Later deploys update the draft;
  publish again to roll the change out to viewers.

### On its own, with `deploy.sh`

`dashboards/deploy.sh` pushes one dashboard through the Lakeview API, outside the
bundle. It needs an authenticated `databricks` CLI profile and `jq`. Set these to
your own values (nothing here is tied to a specific account):

| Variable | What to set it to |
| --- | --- |
| `PROFILE` | Your `databricks` CLI profile (from `databricks auth login`). |
| `WAREHOUSE_ID` | Any SQL Warehouse in your workspace that can query the system tables. |
| `PARENT_PATH` | The workspace folder to create the dashboard in, e.g. `/Users/<you>@<company>.com`. |
| `DASHBOARD_ID` | Only when updating in place: the id printed on first create. |
| `DASHBOARD_FILE` | Optional: `ai-costs.lvdash.json` (default) or `ai-ops.lvdash.json`. |
| `DISPLAY_NAME` | Optional: the dashboard name (default "AI Prism — AI costs per user"). |

```bash
# First time (creates a new dashboard in your workspace, prints its id):
PROFILE=<your-cli-profile> \
WAREHOUSE_ID=<your-warehouse-id> \
PARENT_PATH=/Users/<you>@<company>.com \
  ./dashboards/deploy.sh

# Update in place afterwards (idempotent):
PROFILE=<your-cli-profile> \
WAREHOUSE_ID=<your-warehouse-id> \
DASHBOARD_ID=<id-from-create> \
  ./dashboards/deploy.sh

# The operations dashboard, with its own name:
PROFILE=<your-cli-profile> \
WAREHOUSE_ID=<your-warehouse-id> \
PARENT_PATH=/Users/<you>@<company>.com \
DASHBOARD_FILE=ai-ops.lvdash.json \
DISPLAY_NAME="AI Prism — Operations" \
  ./dashboards/deploy.sh
```

Then open the dashboard in your workspace and **Publish** it so other admins can
view it. The `.lvdash.json` files are fully portable, and the system tables they read
(`system.billing.*`, `system.serving.*`, `system.ai_gateway.*`) exist in every Unity
Catalog workspace.

## Edit a dashboard

The JSON files are exports from the dashboard editor, and the repo copy is what every
deploy ships. To change a dashboard:

1. Edit the deployed draft in the dashboard editor and check that every dataset runs.
2. Bring the change back into the repo, for example
   `databricks bundle generate dashboard --resource ai_prism_ops --force -p <PROFILE>`
   (or `ai_prism_costs`), or *File → Export* and overwrite the file here.
3. Commit the JSON. The next `bundle deploy` ships it as-is.

The telemetry dashboard is the exception: it is generated (see above), so change
`build.py` and re-run it.

The unit test `tests/bundleDashboards.test.mjs` checks, offline, that every file here
is declared in `databricks.yml`, that every widget reads a dataset that exists, and
that every query on `system.serving.endpoint_usage` is scoped to AI Prism.

## Files

- `ai-costs.lvdash.json`: the cost dashboard (source of truth for the bundle).
- `ai-ops.lvdash.json`: the operations dashboard (source of truth for the bundle).
- `ai-telemetry.lvdash.json`: the telemetry dashboard, generated by `build.py` (committed for `ai_prism.telemetry`).
- `build.py`: the generator of the telemetry dashboard.
- `deploy.sh`: create or update one dashboard in a workspace via the Lakeview API,
  outside the bundle.
