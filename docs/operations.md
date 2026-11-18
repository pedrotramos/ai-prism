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

**There is no `/health` endpoint today.** For liveness, use:

| Signal | How | What it proves | What it does not prove |
|---|---|---|---|
| SPA | `GET <APP_URL>/` without a redirect | Process is up and `client/dist` is present | Database, gateway |
| Identity | `GET <APP_URL>/api/me` authenticated | Process, proxy and token accepted | Database: `/api/me` degrades to "not admin" when the database fails |
| Persistence | `npm run smoke` (the "persistence" step) | Write and read on Lakebase | Real latency under load |

The full smoke (`npm run smoke`, with `APP_URL` and `DATABRICKS_TOKEN`) is the health check
that matters after a deploy. It creates a test session, runs a real turn, reads the messages
back, generates a document, and deletes the session. See [§6.1](#61-deploy) for the order.

*Recommendation (outside this docs repository):* a `/api/health` route that runs `SELECT 1`
on Lakebase and returns 503 when it fails. This requires changing `server/index.js`.

---

## 2. Logs

```bash
# last lines of the app
databricks apps logs ai-prism -p <PROFILE>

# the command also accepts --help for filters; check the installed CLI version
databricks apps logs --help
```

There is no structured logging. Everything is `console.log/warn/error`. Messages worth a
manual alert (exact text, as it appears in the log):

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

*Example query:* to count these occurrences, copy the output of `apps logs` to a local file
and use `grep -c` per message. The server does no aggregation.

---

## 3. Telemetry (OpenTelemetry)

> **TO BE WRITTEN.** This section will be written when AppKit (with OTEL telemetry) is
> available in this project. Until then there are no traces, metrics or per-turn spans; what
> exists today is the log in §2 and the cost ledger.
>
> Points to record in this section: endpoint and export variables, span names (`chat.turn`,
> LLM call, tool call, SQL query), fields of each span, retention at the destination, and how
> to link a trace to a `request_id`.

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

---

## 7. Scale and known limits

- **Service principal pool:** a shared pool with `max: 8` connections (`POOL_OPTS` and
  `getSpPool`, `server/db/pool.js`). With many simultaneous users, queries wait for a connection.
  Measure before raising the ceiling.
- **Idle time:** idle connections close after 5 min (`idleTimeoutMillis`). Lakebase suspends
  after 30 min without use (`suspend_timeout_duration: 1800s`).
- **Warehouse:** 2X-Small, `max_num_clusters: 1`, auto-stop after 10 min. Raising the maximum
  raises the cost of the UDF and the UC Functions.
- **Input limits:** JSON 40 MB, upload 80 MB, 10 files.
