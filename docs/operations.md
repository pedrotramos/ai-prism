# AI Prism operations

**English** · [Português (Brasil)](pt-BR/operations.md) · [Español](es/operations.md)

This document covers what it takes to keep an AI Prism installation running: how to tell
whether it is healthy, where the logs are, what to monitor, the proposed SLOs, and the
runbook for deploy, rollback and diagnosis.

Resource names are the ones in `databricks.yml` (app `ai-prism`, Lakebase `ai-prism`,
warehouse `ai-prism`, job `ai-prism-auto-config`). Commands use `<PROFILE>` for the CLI
profile of the target workspace; nothing here depends on a fixed host.

- Threat model and controls: [security-threat-model.md](security-threat-model.md)
- Performance and load: [performance.md](performance.md)
- Governance of several installations: [fleet-governance.md](fleet-governance.md)

---

## 1. Health

`GET /api/health` tells whether this process and its database answer:

| Response | Body | When |
|---|---|---|
| `200` | `{"status":"ok","db":"ok","version":"1.4.0","commit":null,"uptime_s":123}` | `SELECT 1` on Lakebase answered within 2 s |
| `503` | `{"status":"degraded"}` | The query failed or did not answer within 2 s; the reason is in the log (`health: database check failed: …`) |

```bash
# as the smoke does: a user OAuth token for the app URL
curl -sS -i -H "Authorization: Bearer $DATABRICKS_TOKEN" -H "x-request-id: probe-1" <APP_URL>/api/health
```

- It sits behind the same authentication as every `/api` route (the Apps proxy supplies the
  identity) and queries with the caller's identity through the shared pool, like any other query.
- It never holds a connection: Postgres itself aborts the query at 2 s (`SET LOCAL
  statement_timeout`, so the pooled connection is free again and keeps no setting), the response leaves at 2 s whatever
  the pool does, and at most one check runs at a time per process (probes that arrive meanwhile
  wait for the same check).
- `version` is stamped into the server bundle at build time (so it holds even without `package.json`
  next to `server-dist/`); the app also logs it at boot (`AI Prism version <x.y.z>`).
- `commit` comes from the `AI_PRISM_COMMIT` environment variable when the deploy sets it;
  otherwise it is `null`.
- AppKit's own `GET /health` (no `/api`) only says that the process is up; it also carries
  `x-request-id`.
- A healthy probe is not written to the log; a 503 is.

Other signals:

| Signal | How | What it proves | What it does not prove |
|---|---|---|---|
| SPA | `GET <APP_URL>/` without a redirect | Process is up and `client/dist` is present | Database, gateway |
| Identity | `GET <APP_URL>/api/me` authenticated | Process, proxy and token accepted | Database: `/api/me` degrades to "not admin" when the database fails |
| Persistence | `npm run smoke` (the "persistence" step) | Write and read on Lakebase | Real latency under load |

The full smoke (`npm run smoke`, with `APP_URL` and `DATABRICKS_TOKEN`) is the health check
that matters after a deploy. It creates a test session, runs a real turn, reads the messages
back, generates a document, and deletes the session. See [§6.1](#61-deploy) for the order.

---

## 2. Logs

```bash
# last lines of the app
databricks apps logs ai-prism -p <PROFILE>

# the command also accepts --help for filters; check the installed CLI version
databricks apps logs --help
```

Every server line is one JSON object with exactly these fields (`null` when a field does not
apply):

| Field | Content |
|---|---|
| `ts` | ISO-8601 timestamp |
| `level` | `debug`, `info`, `warn` or `error` (`warn` and `error` go to stderr) |
| `request_id` | The request's id, also returned in the `x-request-id` response header. An incoming `x-request-id` (letters, digits, `.`, `_`, `:`, `-`, up to 128 characters) is kept; otherwise the server generates a UUID |
| `user_hash` | First 12 hex characters of the SHA-256 of the user's lowercased e-mail: groups one user's lines without the address |
| `route` | Method and route pattern (`POST /api/sessions/:id/compact`); never the query string |
| `status` | HTTP status, on the access line |
| `duration_ms` | Request duration, on the access line |
| `msg` | The message; an error is appended after `: ` |

Each `/api` request writes one access line (`"msg":"request"`) when its response finishes, and
so does any 5xx elsewhere. Lines written while serving a request (a warning deep in a turn)
carry that request's `request_id`, so every line of one request can be pulled together; a user
who reports a problem can give the `x-request-id` of the failed response.

What never reaches the log: only the fields above are written, so no prompt, answer, request
body or tool argument; e-mails become `[email]`, bearer tokens, personal access tokens and JWTs
become `[token]`, and SQL statements become `[sql]` (enforced by `server/log.test.ts`). A
message is capped at 1000 characters.

Messages worth a manual alert (the start of `msg`, exact text):

| Message (start) | Meaning | Action |
|---|---|---|
| `AI Prism listening on :<porta>` | Process started | Confirm after each deploy/restart |
| `identity-binding: could not verify the forwarded token, allowing the request (…)` | The workspace did not answer `SCIM /Me` (timeout, 5xx, scope). The request went through without the email-to-token binding. At most 1 line per minute | Frequent: check the workspace and the `iam.current-user:read` scope of the OBO token |
| `identity-binding: identity_mismatch: … (IDENTITY_BINDING=warn, allowed)` / `identity-binding: invalid_token: …` | `warn` mode: the mismatch was logged and the request went through | Rollback diagnosis: fix the cause and go back to `enforce` ([SECURITY.md](../SECURITY.md#email-to-token-binding-serveridentitybindingts)) |
| `identity-binding: rejected a request: identity_mismatch` / `invalid_token` | A request arrived with an email that is not the token owner's, or with a token the workspace rejected, and got a 401 | See [§6.5](#65-tokens-and-lakebase). Repeated without an explanation, it is a sign of an impersonation attempt |
| `unhandled error on <MÉTODO> <rota> -> <status>:` | An error no route handled (malformed JSON, large upload, exception); the client got a generic JSON response | Read the detail on the line itself |
| `lakebase: service-principal login unavailable, using per-user identity:` | The SP login failed; the app used the user's identity | See [§6.5](#65-tokens-and-lakebase) |
| `lakebase: permission denied for the service principal (…); identity unchanged` | The SP lacks a privilege: its grants are missing or stale | Run `node scripts/migrate.mjs grants --role <SP>` as the table owner ([§6.4](#64-database-migrations)) |
| `migrations: 0002 schema_ai_prism deferred … ownership not normalized` | The owner hand-off did not run before the new code was published; the app keeps running on `public` | Run the auto-config job (or `migrate.mjs prepare`), then `migrate.mjs grants` ([§6.4](#64-database-migrations)) |
| `lakebase SP pool: idle client error (dropped):` | An idle connection dropped (normal after suspension) | Investigate only if frequent |
| `embedding update failed:` / `message embedding index failed:` / `title/session update failed:` | Post-processing of the turn failed (does not block the response) | Frequent failures point to a problem with the embedding gateway |
| `transcrição falhou (…)` / `análise de planilha falhou (…)` / `ingestão de pptx falhou (…)` | A specific attachment failed | Read the message for the reason |
| `history retrieval failed:` | History retrieval (pgvector) failed | Check the `vector` extension and the index |
| `python tool setup failed, continuing without it:` | Python UDF unavailable (warehouse, grant or `sql` scope) | See [§6.5](#65-tokens-and-lakebase) |
| `migrations: applied <NNNN> <name>` / `migrations: recorded 0001 baseline for an existing 1.x schema (no DDL run)` | A migration was applied at boot / a 1.x database was recorded as version 1 | Expected once per new migration. See [§6.4](#64-database-migrations) |
| `migrations: existing 1.x schema is incomplete (missing N: …)` | A 1.x database lacks some baseline item (table, column, index or constraint); the idempotent `0001` runs instead of only being recorded | None, unless the next line follows |
| `migrations: after 0001 baseline the schema still differs from the baseline (…)` | Drift `0001` cannot repair (e.g. a constraint dropped by hand); the app keeps running | Fix by hand or restore a backup ([§6.4](#64-database-migrations)) |
| `migrations: the database has versions this code does not know (…)` | The database was migrated by a newer release (e.g. after a code rollback) | Expected during a rollback; see [§6.2](#62-rollback) |
| `migrations: no privilege to record the schema version (42501: …)` | The app's identity cannot create or write `schema_migrations`; the 1.x schema is complete and the app keeps running | Run `scripts/migrate.mjs up` as the table owner ([§6.4](#64-database-migrations)) |
| `migrations: applied file changed: …` `[MIGRATION_CHECKSUM]` | A migration file that was already applied has been edited; the app does not start | Restore the released file ([§6.4](#64-database-migrations)) |
| `limpeza de imagens da sessão falhou:` | File in the Volume was not deleted | Clean up manually if it persists |

*Example queries:* with the output of `apps logs` in a local file (each JSON line may carry a
prefix from the log collector, hence the `grep -o`):

```bash
# save the log
databricks apps logs ai-prism -p <PROFILE> > app.log

# every line of one request
grep -o '{"ts".*}' app.log | jq -c 'select(.request_id == "<REQUEST_ID>")'

# server errors with route and duration
grep -o '{"ts".*}' app.log | jq -r 'select(.status >= 500) | [.ts, .route, .status, .duration_ms, .msg] | @tsv'

# requests per route
grep -o '{"ts".*}' app.log | jq -r 'select(.msg == "request") | .route' | sort | uniq -c | sort -rn
```

The server does no aggregation; for counts over time, use the telemetry tables
([§3](#3-telemetry-opentelemetry)).

---

## 3. Telemetry (OpenTelemetry)

The server creates three kinds of span with the OpenTelemetry API:

| Span | Attribute | Meaning |
|---|---|---|
| `llm.call` | `gen_ai.request.model` | Serving endpoint called |
| `llm.call` | `gen_ai.usage.input_tokens` | Prompt tokens (cached tokens included), as the gateway reported them |
| `llm.call` | `gen_ai.usage.output_tokens` | Output tokens, counted like the cost ledger: the larger of `completion_tokens` and `total_tokens − prompt_tokens` |
| `llm.call` | `cost_usd` | Priced cost of the call (the ledger's price); absent outside a user request |
| `llm.call` | `status` | `ok` or `error` |
| `tool.call` | `tool.name` | Function name the model called (`execute_python`, `ask_genie_one`, a UC function, an MCP tool) |
| `tool.call` | `tool.kind` | `python`, `genie`, `genie-one`, `vector-search`, `uc`, `mcp-external`, `image-gen`, … |
| `tool.call` | `duration_ms` | Duration of the tool call |
| `tool.call` | `status` | `ok` or `error` (also `error` when the tool answered with an `ERROR:` text) |
| `chat.turn` | `route` | `/api/chat`, `/api/sessions/:id/continue` or `/api/sessions/:id/messages/:messageId/regenerate` |
| `chat.turn` | `request_id` | The response's `x-request-id`, also in the log lines and in the SSE `meta` event |
| `chat.turn` | `session.id` | Chat session id (empty when the request was refused before one was known) |
| `chat.turn` | `model` | Model the user chose for the turn |
| `chat.turn` | `caps` | Capabilities switched on for the turn, comma-separated (`deck`, `document`, `image`, …) |
| `chat.turn` | `status` | `ok`, `error`, `cancelled` (the client left; nothing was saved) or `rejected` (4xx before streaming, such as `409 turn_in_flight`) |
| `chat.turn` | `saved` | Only on `cancelled`: `false` when nothing was saved (the rule), `true` when the client left while the answer was already being written, so it was saved in full |
| HTTP server span | `http.status_code`, `http.method`, `http.target` | One span per request, named `<METHOD> <route>` (`kind = SPAN_KIND_SERVER`); added by AppKit, not by AI Prism. The trace of a turn starts here: `POST /api/chat` is the parent of `chat.turn` |

Every chat round, title, intent classification, embedding and image generation makes one
`llm.call`; every tool invocation makes one `tool.call`. Attributes never carry prompt text,
tool arguments, e-mails or SQL. Each turn route makes one `chat.turn`, the parent of every
`llm.call` and `tool.call` of that turn, so a trace is one turn.

**Export.** Spans are exported only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set: AppKit then
registers the OTLP exporter. Without it, and always with `APPKIT_BOOT=0`, spans are no-ops:
nothing is exported and nothing fails. Databricks Apps sets the variable when app telemetry is
enabled (Beta, supported regions only; the tables must be managed Delta tables in the
workspace's region). Verified on a live workspace: after a redeploy, spans reach
`otel_spans` about a minute after the request (the `grpc` protocol the runtime advertises is not a problem).

Use the script, not a hand-written command. `databricks apps update --json` **replaces the whole
app spec**: sending only `telemetry_export_destinations` would drop the app's resources
(warehouse, Lakebase) and its user API scopes. The script reads the app first and merges.

```bash
# create the schema once; the app's service principal needs USE CATALOG on the catalog and
# USE SCHEMA + CREATE TABLE + SELECT + MODIFY on the schema (the platform creates the tables)
scripts/telemetry/enable.sh --profile <PROFILE> --app <APP_NAME> --catalog <catalog> --schema <schema> --dry-run   # print only
scripts/telemetry/enable.sh --profile <PROFILE> --app <APP_NAME> --catalog <catalog> --schema <schema>
# then redeploy the app (§6.1): the variable is read at start
```

The script needs an explicit `--profile` and `--app`, accepts only plain identifiers, prints no
secret, and **refuses the app named `ai-prism`**: change the live app by hand with the same
payload (`{"telemetry_export_destinations":[{"unity_catalog":{"logs_table":"<c>.<s>.otel_logs","metrics_table":"<c>.<s>.otel_metrics","traces_table":"<c>.<s>.otel_spans"}}]}`),
after reading its current spec so nothing else is lost. Where the region is not supported,
`OTEL_EXPORTER_OTLP_ENDPOINT` can point to a collector you run.

**Dashboard.** `dashboards/ai-telemetry.lvdash.json` ("AI Prism — Telemetry") is **generated**
by `dashboards/build.py` for one `catalog.schema` (a Lakeview file cannot take a bundle
variable). Edit the generator, never the JSON; `python3 dashboards/build.py --check` fails when
the file on disk is stale. The committed file targets `ai_prism.telemetry`, the defaults of the
bundle variables `telemetry_catalog` and `telemetry_schema`; for another schema run
`python3 dashboards/build.py --catalog <catalog> --schema <schema>` before `bundle deploy`.
Tab **Telemetria**: requests, 5xx, turns and gateway calls, requests per day by status class,
turns per day by outcome, and tables of routes (p95), models (calls, errors, tokens, cost, p95)
and tools. Tab **Falhas e trace**: the failures of the last 7 days with their `trace_id`, and a
filter that shows every span of one trace.

**Query.** `attributes` is a `VARIANT`; check the columns with
`DESCRIBE TABLE <catalog>.<schema>.otel_spans` before the first query. The slowest gateway and
tool calls of the last 24 hours:

```sql
SELECT
  time,
  trace_id,
  name,
  attributes:['gen_ai.request.model']::string AS model,
  attributes:['gen_ai.usage.input_tokens']::bigint AS input_tokens,
  attributes:['gen_ai.usage.output_tokens']::bigint AS output_tokens,
  attributes:['cost_usd']::double AS cost_usd,
  attributes:['tool.name']::string AS tool,
  attributes:['status']::string AS status,
  (end_time_unix_nano - start_time_unix_nano) / 1e6 AS duration_ms
FROM <catalog>.<schema>.otel_spans
WHERE service_name = 'ai-prism'
  AND name IN ('llm.call', 'tool.call')
  AND time >= current_timestamp() - INTERVAL 24 HOURS
ORDER BY duration_ms DESC
LIMIT 50
```

`service_name` is the app name. Retention is that of the Delta table (the app sets none).

---

## 4. What to monitor

| Signal | Source today | Attention threshold | Action |
|---|---|---|---|
| Availability (`/api/health` with 200 and `db: ok`, `/` and `/api/me` with 2xx) | Smoke and load test; `GET /api/health` (authenticated; answers `{ status, db, version, commit, uptime_s }`, 503 `degraded` when the database does not answer in 2 s) | Any failure in 5 min | See [§6.6](#66-stuck-or-unresponsive-process) |
| 5xx errors in the app | Logs (`apps logs`) | See SLO S1 | Diagnosis per [§6.7](#67-diagnose-a-slow-turn) |
| API latency | Load test (`npm run loadtest`) | See SLO S2 | Measure in the same environment |
| Chat turn (TTFT and completion) | Smoke and load test; client SSE | See SLO S3 and S4 | [§6.7](#67-diagnose-a-slow-turn) |
| Cost per day and per model | Cost dashboard (`ai-costs`) | Limit set by the operator (see alert A5) | Review user and endpoint |
| Volume, active users and tokens | Operations dashboard (`ai-ops`) | No fixed limit | Track the trend |
| Gateway latency | `system.ai_gateway.usage` (dashboard `ai-ops`) | See SLO S3 | Subject to ingestion delay |
| Lakebase CPU, memory and connections | Lakebase console | See alert A4 | Size the CU |
| SQL Warehouse usage | Warehouse console | 10 min auto-stop | Confirm that it turns off |
| Admin changes and retention runs | `GET /api/admin/audit` (admins only) | Any admin action nobody can explain; a `retention.sweep` row missing for more than a day while `retentionDays` is on | [§6.8](#68-retention-org-instructions-and-the-admin-audit-trail) |
| Boot warnings | Logs (`apps logs`): `APP_AUDIT_HASH_KEY is not set`, `the database has versions this code does not know`, `migrations: no privilege to record the schema version` | Any of them after a deploy | [§6.4](#64-database-migrations), [§6.10](#610-roles-and-row-level-security) |

**Limitation:** without telemetry ([§3](#3-telemetry-opentelemetry)) there is no error metric per
route and no server-side latency percentile; those numbers come only from the load test, which
measures from the client side. With telemetry on, the `ai-telemetry` dashboard shows both
(5xx and p95 per route, errors per model and tool) and the alerts A2 and A7 watch them.

---

## 5. SLOs and alerts

The numbers below are **proposals**. Validate them with `npm run loadtest` in the real
environment before making them a commitment. Measurement: the sources in §4.

### 5.1 Proposed SLOs

| ID | SLO | Target | Window | Measured today |
|---|---|---|---|---|
| S1 | API availability (`/api/me` returns 2xx) | ≥ 99.5% | 30 days, excluding announced deploy windows | Periodic load test; logs |
| S2 | Read latency (`/api/me`, `/api/models`, `/api/sessions`) | p95 ≤ 800 ms with the app warm, at 20 virtual users | Per load test | `npm run loadtest` |
| S3 | First token of the turn (`meta` event until the first `token`) | p95 ≤ 4 s, fast model, no Lakebase cold start | Per load test | Smoke and `loadtest --chat` |
| S4 | Turn completed without an `error` event | ≥ 98% | 7 days | `chat.turn` spans with `status = error` (dashboard `ai-telemetry`, alert A7) when telemetry is on; otherwise `loadtest --chat` |
| S5 | First request after Lakebase suspension | ≤ 15 s | Per occurrence | Logs and manual test (the pool's `connectionTimeoutMillis` is 15 s, `server/db/pool.ts`) |
| S6 | Post-deploy smoke | 100% green before releasing traffic | Per deploy | `npm run smoke`; the same script runs on every PR in CI ([§5.3](#53-smoke-in-ci)) |

### 5.2 Proposed alert rules

| ID | Condition | Window | Severity | Action |
|---|---|---|---|---|
| A1 | Post-deploy smoke fails (S6) | Immediate | Critical | Rollback ([§6.2](#62-rollback)) |
| A2 | More than 5% of responses are 5xx or login errors (302 or 401) on `/api/*` (at least 5 requests) | 10 min | High | Trace of the failing request (below); token and Lakebase ([§6.5](#65-tokens-and-lakebase)) |
| A3 | Sequence of `lakebase: service-principal login unavailable` in the logs | 10 min | High | See [§6.5](#65-tokens-and-lakebase) |
| A4 | Lakebase at the 16 CU ceiling for more than 15 min | 15 min | Medium | Review load; consider a higher ceiling |
| A5 | Daily cost (`usd` in `ai-costs`) above 2× the 7-day moving average | Daily | Medium | Review user and endpoint in the dashboard |
| A6 | User with call volume above expected (`ai-ops` dashboard, per-user tab) | Daily | Medium | Check the case; it may be abuse (G4) |
| A7 | More than 10% of `chat.turn` spans end in `error` (at least 5 turns) | 30 min | High | Trace of the failing turn (below); SLO S4 |

**How to run it today:** A1 comes from the deploy script (smoke fails = deploy fails). A5 and
A6 are alert queries in Databricks SQL over the dashboard datasets. **A2 and A7 are SQL alerts
over the telemetry tables**, declared in `databricks.yml` (`alerts.ai_prism_a2_http_errors`,
`alerts.ai_prism_a7_turn_errors`) with the tables taken from the variables `telemetry_catalog` and
`telemetry_schema`. They are created **paused** (`telemetry_alerts_pause=PAUSED`): their queries read
`otel_spans`, which exists only after telemetry is enabled ([§3](#3-telemetry-opentelemetry)).
Once it does, deploy with `--var telemetry_alerts_pause=UNPAUSED` (and your catalog and schema) and add
subscribers to each alert in the workspace. Each alert returns `error_pct` (the evaluated column)
and `last_failing_trace_id`. A3 still depends on reading the logs.

**From alert to trace in three clicks.**

1. Open the alert from its notification: the result row shows `error_pct` and `last_failing_trace_id`.
2. Open the telemetry dashboard from the link in the alert description, tab **Falhas e trace**.
3. Pick that trace id in the **Trace id** filter: the table lists every span of the turn
   (`POST /api/...` → `chat.turn` → `llm.call` / `tool.call`) with outcome and duration. The
   failing step is the one with `error` or a 5xx.

Without the dashboard, the same trace in SQL: `SELECT time, name, attributes:['status']::string AS status,
(end_time_unix_nano - start_time_unix_nano) / 1e6 AS duration_ms FROM <catalog>.<schema>.otel_spans
WHERE trace_id = '<id>' ORDER BY time`. The `request_id` of the turn (log lines, SSE `meta`) is an
attribute of the `chat.turn` span.

### 5.3 Smoke in CI

The post-deploy `scripts/smoke.mjs` (S6) also runs on every PR and every push to `main`,
in the `Build & QA` job. A break in the user's path then shows up before merge, not only
after a deploy. The step:

1. starts `scripts/fake-gateway.mjs` on `127.0.0.1:8787`. It is a fake AI Gateway whose
   shapes (streaming, `tool_calls`, `usage`, embeddings) are pinned to a recording of a
   real gateway (`tests/fixtures/gateway-shapes.live.json`);
2. starts `node server/index.js` with `LOCAL_DEV_MODE=1`, `DATABRICKS_HOST` pointing at
   the fake and the CI service's pgvector Postgres;
3. runs `npm run smoke` with `SMOKE_SKIP_ARTIFACT=0` and `SMOKE_EXPECT_EMAIL`. It checks
   the SPA, identity, models, a chat turn over SSE, persistence, listing, the artifact and
   cleanup. For the artifact, the fake answers the document request with a `document`
   block, which the server saves;
4. on failure, prints the server and fake logs in the job.

What this smoke does **not** prove: the Apps proxy authentication, a real Lakebase, real
models and latency. Those stay with the post-deploy smoke against the App URL
([§6.1](#61-deploy)). To reproduce it locally, see "Local smoke" in
[CONTRIBUTING.md](../CONTRIBUTING.md#local-smoke).

### CI (ephemeral Lakebase branch)

The [`Lakebase branch`](../.github/workflows/lakebase-branch.yml) workflow (separate from
`ci.yml`) proves, against a **real** Lakebase (Postgres 17, `databricks_auth`), what the
disposable Postgres of the main job cannot: the migrations go up, down to 0 and up again, and the
isolation and RLS suites pass. It runs on PRs that touch migrations, `server/db*` or the script,
and on demand. [`scripts/ci/lakebase-branch.sh`](../scripts/ci/lakebase-branch.sh) does the work:

1. creates the branch `w3-1-<run>` from `production` with a 4 h TTL (the safety net if the job
   dies). `production` is only the copy source; it is never written to or deleted;
2. creates a **new database** `ai_prism_ci` and the role `ai_prism_app` (`NOSUPERUSER`,
   `NOBYPASSRLS`) in it. The copied production tables belong to the live app's service principal
   and cannot be taken over, so nothing from them is used;
3. runs `migrate.mjs up`, then the role guard: it prints `current_user`, `rolsuper` and
   `rolbypassrls` of the role the suites run as, and **fails the job** if either flag is true. The
   deploying identity and `databricks_superuser` have `rolbypassrls = t`, and an RLS suite run as
   such a role passes without testing anything;
4. runs `server/isolation.test.js` and `server/rls.test.js` (35 cases, none skipped);
5. runs `migrate.mjs down --to 0 --yes`, then `up` again;
6. deletes the branch by its literal path, in a trap that also runs when a step fails. The delete
   refuses any path that contains `production` or is not `projects/<p>/branches/w3-1-<id>`. An
   `always()` step then sweeps the run's own branches.

The suites connect with `ssl: false`, to a loopback host, with one password for every role.
Lakebase requires TLS, accepts only the OAuth token as login (native password login is disabled)
and a role created by SQL cannot log in. So the job runs
[`scripts/ci/pg-tls-proxy.mjs`](../scripts/ci/pg-tls-proxy.mjs) on `127.0.0.1`: it speaks TLS
upstream, swaps a throwaway password for the token, and maps a login as role `X` to the deploying
identity with `-c role=X`. The session then runs as `X` (`current_user = X`, `X`'s
`rolbypassrls`), which is what the role guard checks.

**Without credentials the job skips and stays green**, with a notice in the log. It needs three
repository secrets, created by a person (the workflow never creates them): `LAKEBASE_CI_HOST`,
`LAKEBASE_CI_CLIENT_ID` and `LAKEBASE_CI_CLIENT_SECRET` (a service principal that can create and
delete branches of the project and belongs to `databricks_superuser`), and optionally the variable
`LAKEBASE_CI_PROJECT` (default `ai-prism`). Wall time is about 15 minutes, almost all of it the RLS
suite over the network. Run it locally the same way:

```bash
# needs: databricks CLI, psql, node, jq, perl. Never touches the production branch.
SECRETS_PRESENT=1 LB_PROFILE=<PROFILE> LB_SUFFIX=local1 \
  LB_EVIDENCE_DIR=./evidence bash scripts/ci/lakebase-branch.sh run
```

If a job dies, look for leftover `w3-1-*` branches (`databricks postgres list-branches
projects/<p>`); the TTL removes them anyway. A branch in `ARCHIVED` state wakes on its first
connection; that is not an incident.

---

## 6. Runbook

### 6.1 Deploy

**Preferred: one script.** `./deploy.sh [options] <PROFILE> [CATALOG]` builds the artifacts
(`npm run bundle`), runs `bundle deploy`, runs the auto-config job, opens the owner hand-off
(`migrate.mjs prepare`), publishes the code (`apps deploy`), runs the smoke (`npm run smoke`)
against the app URL and finally runs `migrate.mjs up --role <app SP>` as the database owner
(migrations, least-privilege grants, closes the hand-off). The target comes from
`AI_PRISM_TARGET` (`dev` by default; `prod` for the official deploy). A failed smoke does not
roll back: the new version is already live, so read the smoke table before you give users
access. The full description and the options (`--skip-build`, `--skip-smoke`, tags, usage policy)
are in [onboarding-deployment.md](onboarding-deployment.md).

```bash
AI_PRISM_TARGET=prod ./deploy.sh <PROFILE>
```

**Manual, step by step** (the same sequence the script runs; use it to resume a failed run).
Feature PRs do not commit `client/dist` or `server-dist`; release PRs rebuild and commit them.

<!-- i18n: code-translated en=19a229b432d5 -->
```bash
# validates the configuration (creates nothing)
databricks bundle validate -p <PROFILE> -t dev

# 0) artifacts the app runs
npm run bundle

# 1) Lakebase, warehouse, app, dashboards and job
databricks bundle deploy -p <PROFILE> -t dev

# 2) auto-config (the SP's PG role and owner hand-off, Python UDF, images Volume, admin seed).
#    Run it BEFORE publishing the code.
databricks bundle run ai_prism_auto_config -p <PROFILE> -t dev

# 2b) as the database owner: open the owner hand-off for the app SP (§6.4)
node scripts/migrate.mjs prepare --role <app SP client id>

# 3) publishes the app CODE. The bundle deploy does NOT republish the running process.
#    <SRC> is printed by bundle deploy (typically .../.bundle/ai-prism/dev/files)
databricks apps deploy ai-prism --source-code-path <SRC> -p <PROFILE>

# 4) smoke (S6): blocks the release if it fails
APP_URL=<app-URL> DATABRICKS_TOKEN=<oauth-token> npm run smoke

# 5) as the database owner: pending migrations and the SP's grants; closes the hand-off
node scripts/migrate.mjs up --role <app SP client id>
```

For `DATABRICKS_TOKEN`, use the user's OAuth token (`databricks auth token -p <PROFILE>`).
Do not paste the token into logs or issues. Never leave step 2b without step 5: if a run stops
in between, run `node scripts/migrate.mjs close --role <app SP client id>` (revoke-only).

### 6.2 Rollback

The normal rollback is a **code** rollback. The database schema only goes back with it
when the new version brought a migration the old one cannot live with (see [§6.4](#64-database-migrations)).

1. Find the last good commit (tag or SHA) whose `client/dist` and `server-dist` were
   consistent.
2. **Schema:** compare `server/migrations/` in both versions. If the new version brought
   no migration, or its new migration only adds (a table or column the old version
   ignores), leave the database alone: the old version boots fine on a newer database
   (every boot logs `the database has versions this code does not know`). If the new
   migration changes something the old version reads, run the `down` **with the new code
   still at hand**, before switching code:
   `node scripts/migrate.mjs down --to <last version of the old release> --yes`.
3. Check out the good artifacts on a hotfix branch (do not rewrite `main`).
4. Repeat [§6.1](#61-deploy) from step 1.
5. Confirm with `npm run smoke`.

*Warning:* a migration's `down` can delete data that only the new version wrote. Read the
`.down.sql` file before running it.

**By environment.**

| Environment | Who may roll back | How | Extra checks |
|---|---|---|---|
| Local development | The developer | `git checkout`, then `node --env-file=.env.local scripts/migrate.mjs status`; `down --to <N> --yes` is fine on a scratch database | Check the `target:` line the command prints before `down` |
| CI / ephemeral database | Nobody: discard the database | Re-create it | `down --to 0` is acceptable only here |
| `dev` target (`AI_PRISM_TARGET=dev`) | The technical owner | Steps 1-5 above with the previous artifacts; `down` only for an incompatible migration | Tell the people testing; `dev` prefixes resource names with the deployer's user name |
| `prod` target | The technical owner, with the cost/data owner informed ([fleet-governance.md §2](fleet-governance.md#2-owner-and-responsible-people)) | Steps 1-5 above from a hotfix branch; `down` **only** after reading the `.down.sql` and, if it drops data, after a Lakebase point-in-time restore point is noted | Run `npm run smoke` against the app URL; record the commit SHA in the inventory |

If the artifacts are good but the data is wrong (for example a lowered `retentionDays`), code
rollback does not help: Lakebase point-in-time restore is the only way back ([§6.8](#68-retention-org-instructions-and-the-admin-audit-trail)).

### 6.3 Stop and start the app

```bash
databricks apps get ai-prism -p <PROFILE>
databricks apps stop ai-prism -p <PROFILE>
databricks apps start ai-prism -p <PROFILE>
```

Check `databricks apps --help` for the installed CLI version.

### 6.4 Database migrations

The Lakebase schema is versioned in SQL files:

<!-- i18n: code-translated en=72cf80e8695f -->
```
server/migrations/NNNN_<name>.up.sql     the change (required)
server/migrations/NNNN_<name>.down.sql   its rollback (required)
```

The `schema_migrations(version, name, checksum, applied_at)` table records what has been
applied. Version `0001_baseline` is exactly the schema 1.4 created at boot.

**At boot (automatic).** The first request of each process runs `ensureSchema`, which
applies the pending migrations in order. Each one runs in a transaction together with its
`schema_migrations` row: it is either fully applied and recorded, or not applied. A
Postgres advisory lock lets only one process migrate at a time; the others wait and then
find everything applied. With everything applied, the cost is two `SELECT`s and no lock. The wait for the lock is
bounded (2 min): after that the request fails with `[MIGRATION_LOCK_TIMEOUT]` and the next
one retries. Because each file runs in a transaction, statements Postgres refuses inside a
transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`) cannot go in a migration.

**Database created by a 1.x version.** Without `schema_migrations`, the runner checks in the
Postgres catalog every table, column, index and constraint (with its definition) that
`0001` creates. If all of it is there, it records version 1 without running any DDL (log
`recorded 0001 baseline for an existing 1.x schema`). If anything is missing (an older 1.x,
or a partial schema), it runs the whole `0001`, which is idempotent and fills in what is
missing without touching the data, and logs what was missing
(`existing 1.x schema is incomplete`). `0001` does not recreate everything: a constraint
dropped by hand, for example, stays missing. The log then says
`the schema still differs from the baseline` with the list, and the app keeps running;
fix it by hand.

**Identity.** Whoever creates `schema_migrations` and runs DDL must own the tables. If the
app boots as the service principal on a database another identity created, and the 1.x
schema is already complete, the app keeps working and logs
`migrations: no privilege to record the schema version`. In that case run `up` once as
the owner (below). If a new migration is pending and the SP cannot apply it, the error
surfaces. A `permission denied` (42501) on the SP no longer switches to the user's
identity: the app logs `lakebase: permission denied for the service principal (…); identity unchanged`,
returns the error, and asks for one grants run (at most every 5 minutes). On a deployed
app that run is a no-op, because the SP cannot grant to itself. The fix is
`node scripts/migrate.mjs grants --role <SP>` as the table owner (below).

**Dedicated schema and least privilege (0002).** Migration `0002_schema_ai_prism` moves
the 20 app tables and `schema_migrations` from `public` to the `ai_prism` schema. Their
sequences, indexes (the HNSW vector index too) and rows move with them. `down` moves them
back and drops the emptied schema. The app connects with `search_path = ai_prism, public`
(`vector` stays in `public`). Deployed databases have mixed table ownership: the SP owns
most tables and the deploying identity owns `app_admins`. So the deploy hands them to a
neutral `NOLOGIN` role, `ai_prism_owner`, in three steps:
`prepare` (the auto-config job, then `migrate.mjs prepare` in `deploy.sh`/`deploy.ps1`,
before the code is published), `0002` (the SP's first request), and `grants`
(`migrate.mjs up --role` after the smoke, on every exit path once the hand-off is open;
the wrappers only succeed when the SP is out of `ai_prism_owner`). After `grants` the SP
has `USAGE` on `ai_prism`, DML on the app tables, `USAGE/SELECT` on their sequences and
`SELECT` on `schema_migrations`. It owns no table, has no explicit grant on `public` and
is not a member of `ai_prism_owner`. This closes the privilege half of threat-model row
G2; the isolation half (row-level security) is W2-1. Without `prepare`, `0002` stops
before changing anything (`migrations: 0002 schema_ai_prism deferred … ownership not normalized`):
the app keeps working on `public` and retries a minute later. See
[onboarding-deployment.md](onboarding-deployment.md#about-lakebase-roles-and-grants)
for the roles and the manual commands.

**From the command line.** `scripts/migrate.mjs` uses the standard Postgres variables
(`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`) and the app's
`PG_SSL_CA`/`PG_SSL_VERIFY` (`PG_SSL_REJECT_UNAUTHORIZED` is its old name). On Lakebase,
use a database credential of the table owner as `PGPASSWORD`
(`databricks postgres generate-database-credential <endpoint>`). The CLI
token is not accepted. Every command first prints its target
(`target: <host>:<port>/<database> as <user>`): check it before going on, above all when
`.env.local` points at the same Lakebase as the app.

```bash
# what is applied, pending or changed (exits 1 if an applied file changed)
node scripts/migrate.mjs status

# upgrade: apply the pending ones (what the boot does)
node scripts/migrate.mjs up

# rollback: undo, newest first, every version above N
# (without --yes it only prints the target and stops)
node scripts/migrate.mjs down --to <N> --yes

# least-privilege grants of the app SP on ai_prism (idempotent; deploy.sh runs it as up --role)
node scripts/migrate.mjs grants --role <app SP client id>

# owner hand-off before new code is published (the auto-config job runs it)
node scripts/migrate.mjs prepare --role <app SP client id>

# revoke-only: the app SP leaves the owner role (the deploy's cleanup before the code is published)
node scripts/migrate.mjs close --role <app SP client id>

# local development database
node --env-file=.env.local scripts/migrate.mjs status
```

`down --to 0` undoes `0001_baseline`, that is, it **drops every app table and its data**,
and then drops `schema_migrations` itself: the schema is left empty. Use it only on a test
or CI database. In production a schema rollback is one specific,
planned migration ([§6.2](#62-rollback)).

**File changed after it was applied.** The runner stores the SHA-256 of each applied
`.up.sql` (CRLF line endings and a BOM do not count). If the file changed, the boot and
`up` stop with `migrations: applied file changed … [MIGRATION_CHECKSUM]` and nothing else
runs: two databases with the same version and different schemas would be worse than a
stopped app. Restore the file from the release and put the change in a new migration.

**Schema changes (developers).** Never edit a released file and never put DDL in
`server/db.ts`. Create the next number (`NNNN_<name>.up.sql` and `.down.sql`) with a tested
`down`: `server/migrate.test.ts` and `server/schemaAiPrism.test.ts` show the round-trip
tests on a scratch database, the latter with mixed table ownership. Queries
for a new feature go in `server/db/<feature>.js`, using `withTx` from `server/db/pool.ts` (a lint test in `server/rls.test.js` rejects `withClient(` outside that file).

**`0010_admin_usage_read` (admin web-search cost tile).** It adds one SELECT policy on
`usage_ledger` (`aipa_admin_read`, keyed on the admin flag and a present identity) and the index
`idx_usage_ledger_kind_time (kind, created_at)`. The index is a plain `CREATE INDEX`, not
`CONCURRENTLY` (a migration runs in a transaction), so it **blocks ledger inserts while it builds**:
seconds at current volume. If the ledger is large, deploy in a quiet window. Rollback is
`node scripts/migrate.mjs down --to 0009`: it drops the policy and the index and touches no data.
Only `server/db/adminUsage.ts` reads the ledger with the admin flag, and it returns aggregates.

### 6.5 Tokens and Lakebase

| Symptom (log or response) | Likely cause | Action |
|---|---|---|
| HTTP 401 on `/api/*` | Token missing or expired | Generate a new token and retry |
| HTTP 401 `{"code":"identity_mismatch"}` or `{"code":"invalid_token"}` | The proxy email is not the token owner, or the workspace rejected the token (`server/identityBinding.ts`) | If it affects legitimate users, set `IDENTITY_BINDING=warn` in the `env` of `app.yaml`, deploy, and read the `identity-binding:` lines before going back to `enforce` |
| HTTP 403 `{"code":"cross_site_request"}` | A write to `/api/*` came from another origin (`server/csrfGuard.ts`) | Expected for another site. If it is the app itself, check whether `DATABRICKS_APP_URL` and the `Host` forwarded by the proxy match the URL open in the browser |
| HTTP 302 on the root or in the smoke ("login redirect") | The proxy did not accept the credential | Check the profile/token and access to the app |
| `External authorization failed` or SQLSTATE `28000` | Wrong Lakebase host for this workspace | Check the resources and the injection of `PG_ENDPOINT`/`PGHOST` (see the comment in `app.yaml`). Do not pin the host in `app.yaml` |
| `permission denied` on the database | SP grants not applied yet, or not re-applied after a migration | Run `node scripts/migrate.mjs grants --role <SP>` as the table owner ([§6.4](#64-database-migrations)); `deploy.sh`/`deploy.ps1` do it after the smoke |
| `OAuth token does not have required scopes: genie` | Missing OBO scope | Adjust `user_api_scopes` in the **bundle** (`app.yaml` is not applied) and re-consent |
| `python tool setup failed` | Warehouse unavailable, `CREATE FUNCTION` grant or `sql` scope missing | The chat continues without the Python tool; fix the cause |

### 6.6 Stuck or unresponsive process

1. `databricks apps get ai-prism -p <PROFILE>` and check the state.
2. `databricks apps logs ai-prism -p <PROFILE>` and look for the last
   `AI Prism listening on` line.
3. If the process is up but not responding, restart it with `stop`/`start` (§6.3) and run
   the smoke.
4. If the problem returns after the restart, suspect Lakebase. Check the endpoint in the
   console (state and CU) before touching the app.

### 6.7 Diagnose a slow turn

The turn has several parts with different costs:

- **Before the first token:** writing the user's message, reading history (Lakebase),
  history retrieval by embedding (gateway), the model call. The `meta` event goes out right
  after the user's message is written. If `meta` is slow, the bottleneck is the database. If
  `meta` goes out quickly but the `token` is slow, it is the model or a tool.
- **During the response:** tools. Each recorded tool has `duration_ms` in `chat_tool_calls`
  (query below). The `tool_call` and `tool_progress` SSE events show progress.
- **After the last token:** the `done` event only goes out after embedding, indexing and
  title (`Promise.all` in `server/index.js`). A late `done` with a complete response almost
  always comes from there, not from the model.

**Which tools are slow.** Prefer the traces: with telemetry export on ([§3](#3-telemetry-opentelemetry)), every `tool.call` span carries its `duration_ms`, and reading them needs no access to user rows (see *By trace* below).

To read `ai_prism.chat_tool_calls` directly, know what row-level security does to an operator connection. The table has forced row-level security, and its rows belong to users (directly or through a project). A connection without a user identity therefore sees **0 rows, with no error**, even as the table owner, because `FORCE` binds the owner too (migration 0003). Only a superuser or a role with `BYPASSRLS` sees every row. On Lakebase, the deploying identity, whose database credential `migrate.mjs` uses ([§6.4](#64-database-migrations)), has `BYPASSRLS` ([performance.md §2.1](performance.md#21-preparation)). There is no narrower read-only diagnostic role yet.

1. Connect as the deploying identity, with the connection variables of [§6.4](#64-database-migrations), and confirm that this connection bypasses row-level security:

   ```sql
   SELECT current_user, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user;
   ```

   If both are `false`, stop. The query below would return 0 rows, and that would not mean there were no tool calls. On a local or CI database, use the superuser that created it.
2. Run the aggregate in a read-only transaction. Select only these columns: `arguments` and `result` hold user content and are not needed to diagnose latency.

   ```sql
   BEGIN READ ONLY;
   SELECT tool_name, status, count(*) AS calls,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
          max(duration_ms) AS max_ms
   FROM ai_prism.chat_tool_calls
   WHERE created_at >= now() - interval '24 hours'
   GROUP BY tool_name, status
   ORDER BY p95_ms DESC NULLS LAST
   LIMIT 20;
   COMMIT;
   ```

Do not get the rows any other way:

- never with the app's service-principal credentials;
- never by setting the app's transaction settings. `app.user_email` reads one user's data as that user. `app.is_admin` opens no per-user row. `app.maintenance` belongs to the retention sweep and opens only expired personal chats, not tool calls;
- never with `ALTER TABLE … NO FORCE ROW LEVEL SECURITY`: it takes an `ACCESS EXCLUSIVE` lock that holds every chat request until commit.

This connection bypasses every policy. Use it only for this query and the checks of [§6.10](#610-roles-and-row-level-security), and never for application traffic.

For the gateway latency of a specific response, join `system.serving.endpoint_usage` with
`system.ai_gateway.usage` on `databricks_request_id = request_id` (the same join as the
`ai-ops` dashboard). There is an ingestion delay of a few minutes.

**By trace** (with telemetry export on, §3): take the `request_id` from the SSE `meta` event or
the `x-request-id` response header, find the `chat.turn` span with that `request_id` in
`otel_spans`, and read its children by `trace_id`. Each `llm.call` is one model round (or a
slide of a deck, the title, the intent classifier), each `tool.call` one tool with its
`duration_ms`; the gap between them is time in the database or in the server. A `chat.turn`
with `status = 'cancelled'` was stopped by the user or a dropped connection: its gateway and
tool calls were cancelled and nothing was saved.

### 6.8 Retention, org instructions and the admin audit trail

Admins set two org settings with `PUT /api/admin/settings` (stored in `app_settings`,
migration 0007):

- `retentionDays`: `0` = off (the default), or 1 to 3650. A chat whose **last activity**
  is older than that is deleted with everything in it:
  messages, tool calls, embeddings, compactions, Genie threads, decks, spreadsheets,
  documents and images. The cost rows in `usage_ledger` stay (their `session_id` becomes
  `NULL`), so the costs dashboard keeps its history. The image files on the UC Volume are
  deleted after the database rows.
  Last activity is the newest of: the chat's own update time (`chat_sessions.updated_at`,
  which every new message and every studio save refreshes), its newest message, and the last edit of its decks,
  spreadsheets and documents. A chat with any of these inside the period is kept, including
  chats whose `updated_at` is stale from before this version.
- `orgInstructions`: up to 8,000 characters, added to every turn as one system message.
  An empty value removes it. Other app instances pick up a change within a minute.

**The sweep** (`server/retention.ts`) checks every hour, starting 5 minutes after boot, and
runs at most once a day across every instance. It runs inside a `pg_try_advisory_xact_lock`:
if a second instance tries while one runs, it skips and logs `retention sweep: skipped
(locked)`. Each run logs one line with its counts, for example
`retention sweep: done sessions=12 users=3 images=4 files_deleted=4 files_failed=0
retention_days=90`, and writes a `retention.sweep` row (actor `system`) to the audit trail.
A chat that has a turn running on this instance is skipped until the next run.
`files_failed` counts image files that could not be deleted. They are left on the volume as
orphans and are not retried. One run deletes at most 100,000 chats, in statements of 500. A
larger backlog logs `capped=true`, and the next daily runs finish it.

- **Turn it off for an incident:** set the app environment variable `RETENTION_SWEEP=off` and
  restart. The setting itself stays, so the sweep resumes when the variable is removed.
- **Check the last run:** `GET /api/admin/settings` returns `retentionLastSweepAt`, and
  `GET /api/admin/audit` lists the `retention.sweep` rows with their counts.
- **Lower the retention carefully:** going from 365 to 30 days deletes, in the next run,
  every chat idle for more than 30 days. There is no undo. Lakebase point-in-time restore
  is the only way back.

The sweep has no user identity: its transaction sets `app.maintenance = 'on'` (transaction
local), and the row-level security policies of 0007 then let it see and delete **only**
chats that are already expired, and read the image paths of those chats. A transaction that
carries a user (every request) never gets that access.

**Audit trail.** Every admin mutation writes one `admin_audit` row in the same transaction as
the change: admins, MCP catalog, tool policy, template scope, edits and deletes of global
templates and skills, model endpoints (including the first-open seed) and the settings
above. A row holds `at`, `actor_hash`, `action`, `target` and `details`. `actor_hash` is a hash of the e-mail, never the e-mail. **With `APP_AUDIT_HASH_KEY` set** it is
`h2:` + 12 hex of an HMAC with that secret, and it does **not** equal the `user_hash` of the logs
(§2), on purpose: the audit table cannot be checked against a list of e-mails without the secret.
Without the key (and for rows written before 2026-11-19) it is the same unsalted 12-character hash
as `user_hash`, and a row joins its log lines by that value. A user target is hashed the same way.
To look up one known person in both sources, or to tie a row to a request, follow
[security-threat-model.md §6.1](security-threat-model.md#61-correlating-the-audit-trail-with-the-logs).
Keep the same key across deploys: after a key change, old rows no longer match new hashes. A
missing key logs one warning at boot (`APP_AUDIT_HASH_KEY is not set`); wiring it is described in
`bundle/optional/audit-hash-key-secret.yml.example`. The table is append-only
for the app role (no update or delete policy, and those privileges are revoked).
`GET /api/admin/audit?limit=50&cursor=<nextCursor>` pages it newest first (at most 200 rows
per page). `migrate.mjs down` past version 7 drops the table, so export it first if you need
to keep it.

### 6.9 Probe which models accept a reasoning effort

The `reasoning` flag on a catalog model (`server/llm.ts`, `MODELS`) turns on the **Reasoning effort**
control in the model list. It is set only from evidence: run the probe against the workspace you
deploy to whenever you add a model or the gateway changes.

```bash
node scripts/probe/reasoning-effort.mjs --profile <databricks-cli-profile> \
  [--models id1,id2] [--shape auto|openai|anthropic|anthropic-budget|gemini] \
  --out /path/outside/the/repo/reasoning-effort-probe.json
```

For each curated chat model it sends five tiny, non-streaming requests (no tools, `max_tokens`
2048, a short question that needs reasoning): one without the parameter, one each for `low`,
`medium` and `high`, and one with an invalid value as a negative control. It writes one row per
request (`model`, `shape`, `level`, `accepted`, `status`, `usage`, a truncated `error`) to `--out`
and prints a table. It only calls `serving-endpoints/chat/completions`; it creates, changes and
deletes nothing. The token comes from `databricks auth token` and is never printed or written.
It is a manual tool and never runs in CI.

Set the flag on a model when `low`, `medium` and `high` are accepted **and** the invalid value is
rejected (the endpoint validates the field, so the acceptance is real), and an effect shows in the
usage or the provider documents one. `param` is the body shape that was accepted: `openai`
(`reasoning_effort`), `anthropic` (`thinking: adaptive` plus `output_config.effort`),
`anthropic-budget` (`thinking.enabled` with a token budget) or `gemini` (`thinking_config`).

### 6.10 Roles and row-level security

One Postgres role serves every user (decision D1): the app's service principal. It owns no
table and has no `BYPASSRLS`. Every app table in the `ai_prism` schema has row-level security
enabled and forced (migration 0003; `project_members` is the one documented exception, see
[security-threat-model.md TB9](security-threat-model.md#3-trust-boundaries)). The user's identity
reaches the policies per transaction: `withTx` (`server/db/pool.ts`) sets `app.user_email`,
`app.is_admin` and `app.user_groups` with `set_config(..., true)` (local to the transaction), so
a query with no identity sees no rows. The tables belong to the `NOLOGIN` role `ai_prism_owner`;
the deploy gives the SP membership in it only during the hand-off window (`prepare` … `up --role`).

Routine checks (as the table owner, with the connection variables of [§6.4](#64-database-migrations)):

```bash
# versions applied, pending or changed
node scripts/migrate.mjs status

# re-apply the least-privilege grants (idempotent) after a migration or a permission denied
node scripts/migrate.mjs grants --role <app SP client id>
```

```sql
-- the app role must have rolbypassrls = false and rolsuper = false
SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = '<app SP client id>';

-- tables of the app schema WITHOUT forced row-level security (expected: project_members and schema_migrations)
SELECT c.relname
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'ai_prism' AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

-- the SP must not be a member of the owner role once the deploy has finished
SELECT pg_has_role('<app SP client id>', 'ai_prism_owner', 'member');   -- expected: false
```

| Symptom | Meaning | Action |
|---|---|---|
| A user sees an empty list that should have rows | The request ran without identity (a route outside `withTx`), or the user is not the owner | Check the log line of that `request_id`; the lint test `server/rls.test.js` ("no withClient( call outside server/db/pool.ts") should have caught a new route |
| `permission denied` for the SP | Grants not applied after a migration | `migrate.mjs grants --role <SP>` as the owner ([§6.5](#65-tokens-and-lakebase)) |
| 503 `service_unavailable` and the log line `lakebase: per-user fallback refused` | The service principal is unavailable and the per-user fallback role is a superuser or has `BYPASSRLS` (the deploying identity). The app fails closed instead of running outside the policies (G15) | Restore the service principal ([§6.5](#65-tokens-and-lakebase)). There is no setting to disable the check |
| The `pg_has_role` query returns `true` | The hand-off window is still open (a deploy stopped halfway) | `node scripts/migrate.mjs close --role <SP>` |

Never run application traffic as `ai_prism_owner` or as a role with `BYPASSRLS`: the policies
would no longer bind. Data migrations that must read every user's rows (`migrate.mjs
backfill-usage`) run only as the owner, by hand.

### 6.11 Alerts to actions

| Alert ([§5.2](#52-proposed-alert-rules)) | First command | Then |
|---|---|---|
| A1 post-deploy smoke fails | `npm run smoke` output table; `databricks apps logs ai-prism -p <PROFILE>` | Roll back ([§6.2](#62-rollback)); do not release traffic |
| A2 more than 5% 5xx or login errors | `databricks apps logs ai-prism -p <PROFILE>` and filter on `status` ≥ 500 (each line is JSON: `route`, `status`, `request_id`) | Token/Lakebase table ([§6.5](#65-tokens-and-lakebase)); a slow route: [§6.7](#67-diagnose-a-slow-turn) |
| A3 `lakebase: service-principal login unavailable` | `databricks apps get ai-prism -p <PROFILE>` and the Lakebase endpoint state in the console | [§6.5](#65-tokens-and-lakebase), then [§6.6](#66-stuck-or-unresponsive-process) |
| A4 Lakebase at 16 CU for 15 min | Lakebase console (CPU, connections) | Check [§6.7](#67-diagnose-a-slow-turn) for a slow query; raise the ceiling only after measuring ([§7](#7-scale-and-known-limits)) |
| A5 daily cost above 2× the 7-day average | `ai-costs` dashboard: user and endpoint | If one user: check `GET /api/admin/audit` for a recent model or policy change, then the user's volume; consider the per-user or group budget in the AI Gateway (G4) |
| A6 user volume above expected | `ai-ops` dashboard, per-user tab | Same as A5; the per-process rate limit (429) is not a cost cap |
| Retention row missing | `GET /api/admin/settings` (`retentionLastSweepAt`) and the log line `retention sweep:` | [§6.8](#68-retention-org-instructions-and-the-admin-audit-trail); `RETENTION_SWEEP=off` is the kill switch |

### 6.12 Project context in the turn

Every turn of a chat in a project carries the project's instructions (always in full) and its
files, up to a token budget (`server/projectContext.ts`, ADR 0013).

- `PROJECT_CONTEXT_FILES_MAX_TOKENS` (default `32000`, `0` to `120000`): the file budget per
  turn. `0` switches files off and keeps the instructions. It is the kill switch for files and
  the knob for cost: tokens are counted conservatively (ASCII 0.5 token per character), and
  the cost shows per turn in `usage_ledger` (`prompt_tokens`, `cache_read_tokens`); tool rounds
  within a turn read the project text from the prompt cache.
- Files over the budget are named to the model and flagged by `GET /api/projects/:id/files`
  (`context: "excluded"`). If that is the case for more than about 20% of the active projects,
  it is the signal to build retrieval over the files.
- A read slower than 1.5 s, or one that fails, is logged as `project context: read failed`
  and the turn goes on without the project. The read also carries a server-side statement timeout just
  below that bound, so Postgres cancels a slow statement and the connection returns to the pool. A steady
  stream of these points at the database.
- Migration `0009_project_context` adds `project_files.context_tokens` and
  `chat_messages.sent_by` (stamped by a trigger from the transaction identity). It needs the
  table owner and takes no long lock. `migrate.mjs down --to 8` drops both columns, so stored
  authorship is lost.

### 6.13 Session search with HNSW candidates (`SEARCH_VECTOR_ANN`)

The sidebar search (`GET /api/search`, `searchSessionsByVector` in `server/db.ts`) ranks sessions by the best
match among their message vectors. By default it is an exact scan of the caller's own vectors under RLS, which
grows with how much the caller has written (about 0.5 s at 70,000 vectors).

- `SEARCH_VECTOR_ANN=on` (default off, read once at start, any other value is off) makes the search start from
  the `idx_msg_emb_hnsw` index: it reads the `K = max(400, limit*20)` nearest messages among the caller's
  sessions, groups them by session and, when a few huge sessions ate the whole `K`, reads further rounds that
  skip the sessions already found (at most 8). It sets `hnsw.ef_search` and `hnsw.iterative_scan` with
  `SET LOCAL`, so nothing leaks to the pool. Scoping (own sessions, project membership, no temporary chats)
  and the result shape are the same as the exact query.
- It never trusts a short round: an HNSW scan is approximate and can return fewer rows than asked while eligible
  rows remain. When the rounds cannot show they are complete (any short or empty round, even one that holds `limit` sessions, or the 8-round cap
  reached with fewer than `limit` sessions above the similarity floor), that call is answered by the exact
  query instead, and a debug log line (no user data) says so. Callers with few vectors therefore mostly take
  the exact path, which is cheap for them.
- Needs pgvector 0.8 or newer (iterative scan). With an older version the app logs
  `SEARCH_VECTOR_ANN=on needs pgvector 0.8 or newer` once and keeps the exact query.
- Measured on 100,000 real embeddings (75 held-out questions, as a role without `BYPASSRLS`): for a caller with
  70,000 vectors the exact query took p50 483 ms and the HNSW path p50 51 ms, with top-20 session overlap mean
  0.997 (p5 0.95, minimum 0.95): about 1 query in 19 swaps one session at the tail. Callers with few vectors
  get an exact plan either way. Run `scripts/bench/q5-ann.mjs` against a disposable branch with your own data
  before turning it on.
- Off by default and no migration: turning it off again is unsetting the variable. The index stays.

### 6.14 Unattended runs: identity

A scheduled agent runs one chat turn with nobody at the keyboard. This subsection says whose identity each part of
that run uses. The scheduler (`server/scheduler/index.ts`) starts the run core (`server/scheduler/run.ts`,
`runTurnHeadless` in `server/turn.ts`) only when `AGENTS_ENABLED=1`; with the variable absent nothing starts it, the
agent routes answer 404 `agents_disabled` and the UI is hidden. The three interactive turn routes behave exactly as
before. Enabling, monitoring and rolling back: [6.15](#615-scheduled-agents-enable-grants-monitor-disable-roll-back).

| Layer | Identity in an unattended run |
|---|---|
| Model calls, tools, MCP | the app's service principal (its token is the run's `req.token`); `withRunIdentity({ runAs: 'app_sp' })` wraps the whole run |
| The run's chat, messages, artifacts | the **owner's** row-level-security identity, so the rows are exactly the owner's, as if the owner had sent the message |
| Cost | the owner's meter: ledger rows with `kind = 'scheduled'` and the run's chat; the gateway call carries `usage_context.ai_prism_run_kind = 'scheduled'`, `ai_prism_agent_id` and `ai_prism_agent_run_id` (never an e-mail) |

What a run may do: create one new chat for the owner, write that chat's messages, tool calls and artifacts, read the
owner's selected deck template and image model, and call the model and the admitted tools.

What a run may not do (each one has a test):

- Read the owner's other chats (no history retrieval; the chat is new) or use memories, project context, authored
  skills or the intent classifier. Context providers and completion hooks are skipped unless registered with
  `{ headless: true }`; none is in this release.
- Use any per-user credential. In an `app_sp` run the personal-connection entry points fail closed with
  `sp_no_user_credentials`: an MCP service that is not of class `databricks`, the owner's adopted connections, and
  the MCP warm-up. Admission refuses `per_user`, `shared` and `unverified` services and `web_search` when the org
  policy has it off, and re-checks the model, before the run creates anything.
- Use the built-in Python tool, or a capability the agent did not list (a prompt that mentions a deck does not
  grant `artifact:deck`).

**Data governance.** `genie_one` and MCP services of class `databricks` run with the **service principal's** Unity
Catalog grants, not the owner's. An agent can therefore see data its owner cannot, if the service principal was
granted it, and cannot see data its owner can, if it was not. Grant the service principal only data that every
agent owner may see. This work adds no grant.

**Stopping a run.** A timeout, the per-run cost cap and a shutdown abort the turn at the next call boundary. The
spend already happened, so the turn's ledger rows are written (they are dropped only when a person cancels an
interactive chat), and the partial answer is committed with a notice. A model with no price is capped at 200,000
tokens instead of dollars and flagged `unpriced`.

**Outcome codes.** A run stores a code, never a message text. Permanent (the schedule is disabled at once):
`approval_expired`, `approval_changed`, `tool_not_admitted`, `model_not_allowed`, `sp_model_denied`,
`sp_no_user_credentials`, `sp_permission_denied`. Transient (three in a row disable it): `sp_unavailable`,
`gateway_error`, `timeout`, `lease_lost`, `lease_expired`, `db_error`. Neither: `cost_cap` and `shutdown`.

### 6.15 Scheduled agents: enable, grants, monitor, disable, roll back

What follows was observed on a real workspace on 2026-11-23 (two apps built from the same commit, bound to one
disposable Lakebase branch and one database, standing in for two replicas). The evidence is kept with the
change that introduced this section; anything this runbook could not observe is marked **not verified**.

**Enable (two switches, both needed).**

1. The operator sets `AGENTS_ENABLED` to `'1'` in `app.yaml` (the commented lines are there) and republishes the app. Without it the scheduler
   does not start and `GET /api/agents/status` answers `{ "enabled": false, "reason": "env_off" }`.
2. An administrator turns the feature on in Settings (or `PUT /api/admin/agents/settings` with `{ "enabled": true }`).
   Until then the status is `admin_off`, and an approved agent cannot be enabled (`agents_setting_off`).

An owner writes the agent, submits it, an administrator approves the exact definition (`expectedHash`), and the owner
enables it. The first scheduled slot is the next time on the clock after enabling (an hourly agent at minute 0 enabled
at 04:03 UTC got `next_run_at` 05:00 UTC). **Run now** queues a manual run that is claimed in about a second.

**Grants.** The agent runs as the app's service principal, so the service principal (not the owner) needs:

- Its Lakebase role and the app grants (the same as the app itself; nothing extra).
- Permission to call the agent's model. On the test workspace the service principal called the pay-per-token endpoint
  `databricks-claude-haiku-5-5` through `chat/completions` with **no extra grant and no serving-endpoint resource
  declared on the app**. Another workspace may restrict the endpoint; a run that ends `sp_model_denied` is the
  signal, and the fix is to grant the app's service principal `CAN_QUERY` on that endpoint (this grant was **not
  exercised** in the proof).
- Whatever data a `genie_one` or `mcp:` tool of class `databricks` should see: the run uses the service principal's
  grants, not the owner's (see 6.14). Grant it only data every agent owner may see.

**What was measured (hourly agent, 3 scheduled slots, two apps).**

| Check | Observed |
|---|---|
| One run per slot | Slots 05:00, 06:00 and 07:00 UTC: 3 `agent_runs` rows with `trigger = 'schedule'`, 3 distinct `slot_at`. The 05:00 and 07:00 runs were claimed by app B, the 06:00 run by app A (B was stopped for that one); no slot ran twice |
| Identity | The gateway recorded the app's service principal as the requester of every run, with `usage_context` `ai_prism_run_kind = scheduled`, `ai_prism_agent_id`, `ai_prism_agent_run_id` and `ai_prism_app` (no e-mail). `system.serving.endpoint_usage` showed the rows about an hour after the calls; check again before concluding there is none |
| Cost | One ledger row per run with `kind = 'scheduled'`, the owner's e-mail and the run's chat (`session_id`); the cost meter (`GET /api/usage/summary`) included them. A tiny prompt on the cheapest catalog model cost 0.00022 USD per run |
| Audit | `admin_audit` has `agent.approve`, `agent.run.start` and `agent.run.finish` rows with ids and codes only (the revoke's own audit row was not collected) |
| Personal MCP | A service of class `per_user` is refused when the agent is saved (`mcp_class_refused`); a `shared` or absent service is `mcp_not_in_catalog`; a personal-connection style ref is `tool_unknown`. Forcing the row past the API does not work either: an `UPDATE` that put a `per_user` service into an approved agent's definition (even as the no-user admin identity) reset the row to `draft` with the approval cleared, and run-now answered `409 not_approved` with no run created. The run-time `sp_no_user_credentials` path itself was **not** exercised live |

**A replica that stops mid-run.** Stopping an app while it held a run did not write a `cancelled/shutdown` row: the
row stayed `running` until its lease (120 s) had expired **and** a surviving replica next woke. That wake is not
immediate: the scheduler sleeps up to `AGENT_SCHEDULER_MAX_SLEEP_MS` (default 15 minutes; the delay seen is
consistent with that sleep, but the cause was not isolated), and the run was recorded
`failed/lease_expired` 14 minutes 48 seconds after it started. It was not re-run, and the next slot ran on the
surviving app. Two consequences for an operator: a run row can read `running` for up to about 15 minutes after its
app died (lowering `AGENT_SCHEDULER_MAX_SLEEP_MS` should shorten that; not tested), and the model call that was in
flight was billed by the gateway (3,145 output tokens in `system.serving.endpoint_usage`) but wrote no ledger row, so
the meter understates the spend of a killed run. `lease_expired` counts toward the
three-in-a-row disable.

**Lakebase suspends: not shown.** The endpoint was set to the bundle default suspend timeout (`600s`). From 05:18 to
05:55 UTC (37 one-minute samples, control-plane calls only, no agent due) it reported `ACTIVE` every time, which is
longer than the timeout. The scheduler was running on one app and a browser tab opened that app at 05:42 and 05:56, so
the proof of "suspends between checks" is **not** obtained: either the scheduler's periodic reads or the tab kept it
awake, and the two were not separated. Budget Lakebase compute as if it does not scale to zero while an app with
`AGENTS_ENABLED=1` is running, until a clean measurement says otherwise.

**Monitor.** The scheduler logs one line per claim and per run outcome. In the database (as the owner role):

```sql
-- the runs of the last day
SELECT id, agent_id, trigger, slot_at, status, error_code, started_at, finished_at, cost_usd
  FROM ai_prism.agent_runs WHERE created_at > now() - interval '1 day' ORDER BY id DESC;
-- what the scheduler wrote to the audit
SELECT at, action, target, details FROM ai_prism.admin_audit WHERE action LIKE 'agent.%' ORDER BY id DESC LIMIT 50;
```

and for the billed side (usage tables lag by about an hour):

```sql
SELECT request_time, requester, usage_context
  FROM system.serving.endpoint_usage
 WHERE usage_context['ai_prism_run_kind'] = 'scheduled' AND request_time > current_timestamp() - INTERVAL 1 DAY;
```

**Disable and roll back, least to most drastic.**

1. Revoke or disable one agent: an administrator's revoke sets `enabled = false`, clears `next_run_at` and records
   `disabled_reason = 'revoked'` at once (seen in the API answer). That the following slot then did **not** run was
   **not verified**: the disposable database expired before the 08:00 UTC slot could be read.
2. Switch the feature off in Settings (soft: nothing new is claimed or enabled).
3. Remove `AGENTS_ENABLED` and republish (hard: no scheduler, routes answer 404).
4. Go back to the previous release; the schema stays. The `0015_agents` down migration deletes every definition and
   run and is **not** a routine rollback.

### 6.16 MCP Apps: what the live check showed

MCP Apps are off until an administrator turns them on (`docs/mcp-apps.md`). On 2026-11-23 a test app built from the
same commit was published on a workspace and checked through the Databricks Apps proxy and the Unity AI Gateway. Part
of the question was answered; the rest is marked **not verified**.

| Question | Result |
|---|---|
| Does the Unity AI Gateway forward the `extensions` capability, the tool `_meta` and `resources/read` of an MCP App server? | **Yes, all three.** A fixture MCP App server (hosted as a Databricks App, registered as a Unity Catalog MCP service over an OAuth M2M connection) received `initialize` with `extensions["io.modelcontextprotocol/ui"].mimeTypes = ["text/html;profile=mcp-app"]`, `tools/list` kept `_meta.ui.resourceUri` and `visibility`, and `resources/read` returned the `text/html;profile=mcp-app` HTML. Setting this up needed one grant: the fixture app's own service principal needs `CAN_USE` on that app, otherwise the Apps proxy answers 401 and the gateway reports `-32006` |
| Can the app capture a View from that service? | **Not with this setup.** The service is backed by an OAuth M2M connection, so its credential is one shared identity; the app's admission rule classes it `shared` (here `unverified`, because its metadata could not be read) and offers the model none of its tools, and a chat turn that asked for the tool answered that no such tool was available. A service whose credential is per user or the caller's own Databricks identity is needed to see the capture end to end; that was not tried |
| Does the Apps proxy keep our response headers? | **Yes, for the View.** A View record was stored (inserted in the test database, because the fixture's M2M credential keeps a chat turn from capturing one) and opened in headless Chromium inside a `sandbox="allow-scripts allow-forms"` iframe through the Apps proxy. The response was `200` (the route answers 400 without `Sec-Fetch-Dest: iframe`, so the browser sent it) and its `Content-Security-Policy` (starting `sandbox allow-scripts allow-forms; default-src 'none'; ...; frame-ancestors 'self'`), `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy`, `Cache-Control: no-store` and `Content-Type` were byte-identical to what the app's own code computes for that record; the app-wide `Content-Security-Policy-Report-Only` was absent from the View, as intended. The proxy added no security header; `X-Content-Type-Options: nosniff` was also present (its source, proxy or app-wide middleware, was not isolated). From inside the frame, `window.parent.document` raised a `SecurityError` |

**Hosting an MCP server on Databricks Apps.** The Unity Catalog connection that fronts the server authenticates as a
principal; that principal must hold `CAN_USE` on the Databricks App that hosts the server. With an OAuth M2M connection
that principal is the hosting app's own service principal, which is **not** in the app's access list by default: grant it
`CAN_USE` on that app, or the Apps proxy answers 401 and the gateway reports `-32006` ("rejected this connection's
credential"). Seen live; the grant fixed it.

**Outcome.** The gateway forwards what MCP Apps needs and the proxy leaves the View's headers alone, so neither the
"ships off because the gateway does not forward" outcome nor the dedicated sandbox origin is needed. The feature still ships
off by default, as designed. What this check did not cover: capturing a View in a real chat turn (it needs a service whose
credential is per user or the caller's own Databricks identity) and the View running its bridge inside a real conversation.

---

## 7. Scale and known limits

- **Service principal pool:** a shared pool with `max: 8` connections (`POOL_OPTS` and
  `getSpPool`, `server/db/pool.ts`). With many simultaneous users, queries wait for a connection.
  Measure before raising the ceiling. The ceiling is in code: there is no `PG_POOL_MAX` variable
  (`PG_POOL_IDLE_TIMEOUT_MS` is the only pool setting read from the environment). In the measured
  run of [performance.md §3](performance.md#3-load-results), 50 virtual users kept the 8
  connections open with at most 2 active and flat read latency: the pool was not the bottleneck.
- **Idle time:** idle connections close after 2 min by default (`PG_POOL_IDLE_TIMEOUT_MS`, 1 s to 30 min). Lakebase suspends
  after 10 min without use by default (bundle variable `lakebase_suspend_timeout`, `600s`).
- **Warehouse:** 2X-Small, `max_num_clusters: 1`, auto-stop after 10 min. Raising the maximum
  raises the cost of the UDF and the UC Functions.
- **Input limits:** JSON bodies have a class per route: 1 MB by default, 4 MB for a workbook
  save, 40 MB for a design-system import, 46 MiB for the deck studio writes with media; chat
  uploads go up to 80 MB and 10 files. The AppKit boot reads every JSON body up to 64 MB before
  the per-route check (`JSON_ROUTE_LIMITS`, `APPKIT_BODY_LIMIT` in
  `server/middleware/security.ts`; the table is in
  [security-threat-model.md C11](security-threat-model.md#5-controls-in-place)).
- **Rate limits:** per user and per process, 120 `/api` requests/min and 12 turns/min
  (`RATE_LIMIT_API_PER_MIN`, `RATE_LIMIT_TURNS_PER_MIN`; `0` disables). With several app
  instances the ceiling multiplies, and it is not a spending cap (G4).
- **Retention sweep:** at most 100,000 chats per run, in statements of 500 ([§6.8](#68-retention-org-instructions-and-the-admin-audit-trail)).
