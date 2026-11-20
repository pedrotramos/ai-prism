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
become `[token]`, and SQL statements become `[sql]` (enforced by `server/log.test.js`). A
message is capped at 1000 characters.

Messages worth a manual alert (the start of `msg`, exact text):

| Message (start) | Meaning | Action |
|---|---|---|
| `AI Prism listening on :<porta>` | Process started | Confirm after each deploy/restart |
| `identity-binding: could not verify the forwarded token, allowing the request (…)` | The workspace did not answer `SCIM /Me` (timeout, 5xx, scope). The request went through without the email-to-token binding. At most 1 line per minute | Frequent: check the workspace and the `iam.current-user:read` scope of the OBO token |
| `identity-binding: identity_mismatch: … (IDENTITY_BINDING=warn, allowed)` / `identity-binding: invalid_token: …` | `warn` mode: the mismatch was logged and the request went through | Rollback diagnosis: fix the cause and go back to `enforce` ([SECURITY.md](../SECURITY.md#email-to-token-binding-serveridentitybindingjs)) |
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

Every chat round, title, intent classification, embedding and image generation makes one
`llm.call`; every tool invocation makes one `tool.call`. Attributes never carry prompt text,
tool arguments, e-mails or SQL. Each turn route makes one `chat.turn`, the parent of every
`llm.call` and `tool.call` of that turn, so a trace is one turn.

**Export.** Spans are exported only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set: AppKit then
registers the OTLP exporter. Without it, and always with `APPKIT_BOOT=0`, spans are no-ops:
nothing is exported and nothing fails. Databricks Apps sets the variable when app telemetry is
enabled (Beta, supported regions only; the tables must be managed Delta tables in the
workspace's region):

```bash
# send logs, metrics and spans to Unity Catalog tables, then redeploy the app (§6.1)
databricks apps update ai-prism -p <PROFILE> --json '{"telemetry_export_destinations":[{"unity_catalog":{"logs_table":"<catalog>.<schema>.otel_logs","metrics_table":"<catalog>.<schema>.otel_metrics","traces_table":"<catalog>.<schema>.otel_spans"}}]}'
```

Not yet verified on a live workspace: the runtime advertises `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`,
while AppKit's exporter speaks OTLP over HTTP/protobuf. If `otel_spans` stays empty after a
turn, check that first. Where the region is not supported, `OTEL_EXPORTER_OTLP_ENDPOINT` can
point to a collector you run.

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
| Availability (`/` and `/api/me` with 2xx) | Smoke and load test | Any failure in 5 min | See [§6.6](#66-stuck-or-unresponsive-process) |
| 5xx errors in the app | Logs (`apps logs`) | See SLO S1 | Diagnosis per [§6.7](#67-diagnose-a-slow-turn) |
| API latency | Load test (`npm run loadtest`) | See SLO S2 | Measure in the same environment |
| Chat turn (TTFT and completion) | Smoke and load test; client SSE | See SLO S3 and S4 | [§6.7](#67-diagnose-a-slow-turn) |
| Cost per day and per model | Cost dashboard (`ai-costs`) | Limit set by the operator (see alert A5) | Review user and endpoint |
| Volume, active users and tokens | Operations dashboard (`ai-ops`) | No fixed limit | Track the trend |
| Gateway latency | `system.ai_gateway.usage` (dashboard `ai-ops`) | See SLO S3 | Subject to ingestion delay |
| Lakebase CPU, memory and connections | Lakebase console | See alert A4 | Size the CU |
| SQL Warehouse usage | Warehouse console | 10 min auto-stop | Confirm that it turns off |

**Limitation:** there is no error metric per route and no server-side latency percentile.
Today these numbers come only from the load test, which measures from the client side.

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
| S4 | Turn completed without an `error` event | ≥ 98% | 7 days | **Not measured automatically**; measure with `loadtest --chat` |
| S5 | First request after Lakebase suspension | ≤ 15 s | Per occurrence | Logs and manual test (the pool's `connectionTimeoutMillis` is 15 s, `server/db/pool.js`) |
| S6 | Post-deploy smoke | 100% green before releasing traffic | Per deploy | `npm run smoke`; the same script runs on every PR in CI ([§5.3](#53-smoke-in-ci)) |

### 5.2 Proposed alert rules

| ID | Condition | Window | Severity | Action |
|---|---|---|---|---|
| A1 | Post-deploy smoke fails (S6) | Immediate | Critical | Rollback ([§6.2](#62-rollback)) |
| A2 | More than 5% of responses are 5xx or login errors (302 or 401) on `/api/*` | 10 min | High | Logs; token and Lakebase ([§6.5](#65-tokens-and-lakebase)) |
| A3 | Sequence of `lakebase: service-principal login unavailable` in the logs | 10 min | High | See [§6.5](#65-tokens-and-lakebase) |
| A4 | Lakebase at the 16 CU ceiling for more than 15 min | 15 min | Medium | Review load; consider a higher ceiling |
| A5 | Daily cost (`usd` in `ai-costs`) above 2× the 7-day moving average | Daily | Medium | Review user and endpoint in the dashboard |
| A6 | User with call volume above expected (`ai-ops` dashboard, per-user tab) | Daily | Medium | Check the case; it may be abuse (G4) |

**How to run it today:** A1 comes from the deploy script (smoke fails = deploy fails). A5 and
A6 are alert queries in Databricks SQL over the dashboard datasets. A2 and A3 depend on
reading the logs manually; **there is no automated alert on the log** until telemetry is
ready ([§3](#3-telemetry-opentelemetry)).

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

---

## 6. Runbook

### 6.1 Deploy

Prerequisite: artifacts rebuilt with `npm run bundle` right before the deploy. Feature PRs
do not commit `client/dist` or `server-dist`; release PRs (branch `release/*` or label
`release`) rebuild and commit them, and only those PRs get the CI check that they are
current. `deploy.sh` does not run the build on its own yet.

<!-- i18n: code-translated -->
```bash
# validates the configuration (creates nothing)
databricks bundle validate -p <PROFILE> -t dev

# 1) Lakebase, warehouse, app, dashboards and job
databricks bundle deploy -p <PROFILE> -t dev

# 2) publishes the App CODE. The bundle deploy does NOT republish the running process.
#    <SRC> is printed by bundle deploy (typically .../.bundle/ai-prism/dev/files)
databricks apps deploy ai-prism --source-code-path <SRC> -p <PROFILE>

# 3) runs auto-config (the SP's PG role, Python UDF, images Volume, admin bootstrap)
databricks bundle run ai_prism_auto_config -p <PROFILE> -t dev

# 4) smoke (S6): blocks the release if it fails
APP_URL=<app-URL> DATABRICKS_TOKEN=<oauth-token> npm run smoke
```

For `DATABRICKS_TOKEN`, use the user's OAuth token (`databricks auth token -p <PROFILE>`).
Do not paste the token into logs or issues.

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

### 6.3 Stop and start the app

```bash
databricks apps get ai-prism -p <PROFILE>
databricks apps stop ai-prism -p <PROFILE>
databricks apps start ai-prism -p <PROFILE>
```

Check `databricks apps --help` for the installed CLI version.

### 6.4 Database migrations

The Lakebase schema is versioned in SQL files:

<!-- i18n: code-translated -->
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
`server/db.js`. Create the next number (`NNNN_<name>.up.sql` and `.down.sql`) with a tested
`down`: `server/migrate.test.js` and `server/schemaAiPrism.test.js` show the round-trip
tests on a scratch database, the latter with mixed table ownership. Queries
for a new feature go in `server/db/<feature>.js`, using `withClient` or `withTx`
(transaction) from `server/db/pool.js`.

### 6.5 Tokens and Lakebase

| Symptom (log or response) | Likely cause | Action |
|---|---|---|
| HTTP 401 on `/api/*` | Token missing or expired | Generate a new token and retry |
| HTTP 401 `{"code":"identity_mismatch"}` or `{"code":"invalid_token"}` | The proxy email is not the token owner, or the workspace rejected the token (`server/identityBinding.js`) | If it affects legitimate users, set `IDENTITY_BINDING=warn` in the `env` of `app.yaml`, deploy, and read the `identity-binding:` lines before going back to `enforce` |
| HTTP 403 `{"code":"cross_site_request"}` | A write to `/api/*` came from another origin (`server/csrfGuard.js`) | Expected for another site. If it is the app itself, check whether `DATABRICKS_APP_URL` and the `Host` forwarded by the proxy match the URL open in the browser |
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

Query to find the slowest tools (run it on Lakebase, with the diagnostic user, never with
the app's credentials in the repository):

```sql
SELECT tool_name, status, duration_ms, created_at
FROM chat_tool_calls
WHERE created_at >= now() - interval '24 hours'
ORDER BY duration_ms DESC NULLS LAST
LIMIT 20;
```

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

**The sweep** (`server/retention.js`) checks every hour, starting 5 minutes after boot, and
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
above. A row holds `at`, `actor_hash`, `action`, `target` and `details`. `actor_hash` is the
same 12-character hash as `user_hash` in the logs (§2), never the e-mail, so you can join a
row to its request log line. A user target is hashed the same way. The table is append-only
for the app role (no update or delete policy, and those privileges are revoked).
`GET /api/admin/audit?limit=50&cursor=<nextCursor>` pages it newest first (at most 200 rows
per page). `migrate.mjs down` past version 7 drops the table, so export it first if you need
to keep it.

---

### 6.9 Probe which models accept a reasoning effort

The `reasoning` flag on a catalog model (`server/llm.js`, `MODELS`) turns on the **Reasoning effort**
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

### 6.10 Project context in the turn

Every turn of a chat in a project carries the project's instructions (always in full) and its
files, up to a token budget (`server/projectContext.js`, ADR 0013).

- `PROJECT_CONTEXT_FILES_MAX_TOKENS` (default `32000`, `0` to `120000`): the file budget per
  turn. `0` switches files off and keeps the instructions. It is the kill switch for files and
  the knob for cost: tokens are counted conservatively (ASCII 0.5 token per character), and
  the cost shows per turn in `usage_ledger` (`prompt_tokens`, `cache_read_tokens`); tool rounds
  within a turn read the project text from the prompt cache.
- Files over the budget are named to the model and flagged by `GET /api/projects/:id/files`
  (`context: "excluded"`). If that is the case for more than about 20% of the active projects,
  it is the signal to build retrieval over the files.
- A read slower than 1.5 s, or one that fails, is logged as `project context: read failed`
  and the turn goes on without the project. A steady stream of these points at the database.
- Migration `0009_project_context` adds `project_files.context_tokens` and
  `chat_messages.sent_by` (stamped by a trigger from the transaction identity). It needs the
  table owner and takes no long lock. `migrate.mjs down --to 8` drops both columns, so stored
  authorship is lost.

---

## 7. Scale and known limits

- **Service principal pool:** a shared pool with `max: 8` connections (`POOL_OPTS` and
  `getSpPool`, `server/db/pool.js`). With many simultaneous users, queries wait for a connection.
  Measure before raising the ceiling. The ceiling is in code: there is no `PG_POOL_MAX` variable
  (`PG_POOL_IDLE_TIMEOUT_MS` is the only pool setting read from the environment). In the measured
  run of [performance.md §3](performance.md#3-load-results), 50 virtual users kept the 8
  connections open with at most 2 active and flat read latency: the pool was not the bottleneck.
- **Idle time:** idle connections close after 5 min (`idleTimeoutMillis`). Lakebase suspends
  after 30 min without use (`suspend_timeout_duration: 1800s`).
- **Warehouse:** 2X-Small, `max_num_clusters: 1`, auto-stop after 10 min. Raising the maximum
  raises the cost of the UDF and the UC Functions.
- **Input limits:** JSON 40 MB, upload 80 MB, 10 files.
