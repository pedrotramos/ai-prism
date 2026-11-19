# Performance: load method and query analysis

**English** · [Português (Brasil)](pt-BR/performance.md) · [Español](es/performance.md)

This page describes how to measure AI Prism under load and how to analyze the critical
Lakebase queries with `EXPLAIN (ANALYZE, BUFFERS)`. It also records one measured run:
every table in §3, §4.6 and §4.7 states the commit, the date and the configuration it was
measured with. Numbers from one installation are a reference, not a promise for another:
measure your own installation in its own test environment before you rely on them.

Repository tools:

- `npm run smoke`: functional check, one user, one turn (see [operations.md](operations.md)).
- `npm run loadtest`: dependency-free load generator (`scripts/load-test.mjs`).
- `scripts/bench/explain.sql`: `EXPLAIN (ANALYZE, BUFFERS)` of the §4 queries, run with
  `psql` straight against a test database.

---

## 1. Goal and criteria

Answer three questions, in order:

1. At how many simultaneous users do read latency and first-token latency cross the SLO
   targets (see [operations.md §5.1](operations.md#51-proposed-slos))?
2. What is the bottleneck as load grows: the database pool, the model gateway, the
   warehouse or the app's CPU?
3. Which queries dominate database time, and does their plan change with data volume?

Default scenarios: **1, 5, 20 and 50 virtual users**, at least 60 s per stage so the queue
settles. These are the `loadtest` defaults.

---

## 2. Method

### 2.1 Preparation

1. **Dedicated test environment.** Use a test installation in the same workspace and
   region as your users. Measuring from a laptop far from the region measures the network,
   not the app (see the latency floor in §3).
2. **Disposable database.** Point the test installation at a disposable Lakebase branch
   (`databricks postgres create-branch ... --ttl 4h`), never at the production branch, and
   delete the branch at the end. A branch copies the source branch's tables and their
   owner roles: if the test app's service principal cannot take them over, create a
   separate database on the branch and run `node scripts/migrate.mjs up --role <test app SP>`
   against it as the deploying identity.
3. **Declared Lakebase state.** Record whether the test started with the endpoint
   suspended (cold) or active (warm). The first request after a suspension pays the cold start.
4. **Declared data volume.** Record how many sessions, messages and embeddings exist before
   the test. Without it, plans are not comparable.
5. **Smoke before load.** `npm run smoke` must pass. Load on a broken app only measures errors.

Synthetic data for a test user (run it **only** on a test installation; the email is
fictitious and the cleanup is mandatory). The tables live in the `ai_prism` schema and
row-level security is forced on them, so the inserting transaction must carry the identity
it writes as:

```sql
SET search_path = ai_prism, public;
BEGIN;
SELECT set_config('app.user_email', 'carga-teste@example.com', true);

-- 200 sessions x 40 messages
INSERT INTO chat_sessions (user_email, title, model)
SELECT 'carga-teste@example.com', 'load ' || g, 'databricks-claude-haiku-5-5'
FROM generate_series(1, 200) g;

INSERT INTO chat_messages (session_id, role, content, created_at)
SELECT s.id,
       CASE WHEN m % 2 = 0 THEN 'assistant' ELSE 'user' END,
       'load message ' || m,
       now() - (m || ' minutes')::interval
FROM chat_sessions s
CROSS JOIN generate_series(1, 40) m
WHERE s.user_email = 'carga-teste@example.com';

-- 1024-dimension embeddings (Q4 and Q5 need the pgvector variant of the table)
INSERT INTO chat_message_embeddings (message_id, session_id, embedding)
SELECT m.id, m.session_id,
       (SELECT ('[' || string_agg(round(random()::numeric, 4)::text, ',') || ']')::vector
          FROM generate_series(1, 1024))
FROM chat_messages m
JOIN chat_sessions s ON s.id = m.session_id
WHERE s.user_email = 'carga-teste@example.com';
COMMIT;

-- cleanup at the end (the cascade removes messages, embeddings and tool calls)
BEGIN;
SELECT set_config('app.user_email', 'carga-teste@example.com', true);
DELETE FROM chat_sessions WHERE user_email = 'carga-teste@example.com';
COMMIT;
```

Uniform random vectors are a degenerate case for an approximate index: every point is
about equally far from every other. For the HNSW measurements in §4.7 the vectors were
drawn around 64 random centroids (each session spans 3 of them), so neighbours look like
topics, with `setseed` so every run builds the same data. A second, fictitious user
(`outro-usuario@example.com`) owns 20% of the rows, so the plans show whether a query
reads other users' data. 20 of that user's sessions (200 in volume B) sit in a project
shared with the group `w213-analysts` (role view), which the measured user reaches only
through `app.user_groups`.

**Authoritative setup.** The measured data of §4.6 and §4.7 was built by
`scripts/bench/seed.sql` (with `seed_user.sql` and `seed_project.sql`), and the HNSW query
set by `scripts/bench/hnsw-bench.mjs`; this section summarizes them, and any divergence
between the two is a bug in this page. After `SELECT setseed(0.4213)`, the script builds 64
centroids of 1024 dimensions, each coordinate `random() - 0.5`; each message's embedding is
centroid `(session_id × 7 + message_id mod 3) mod 64` plus independent noise
`(random() - 0.5) × 0.6` on every coordinate, so a session's messages fall in 3 clusters.
Each bench query is the message a third of the way into a session (by id) plus noise
`(r - 0.5) × 0.3` per coordinate, where `r` comes from `mulberry32(4213)`, which also picks the
sessions. Volume A is one run with `main_sessions=200 other_sessions=50 msgs=40
proj_sessions=20`; volume B runs the same script again with `main_sessions=1800
other_sessions=450 proj_sessions=180`; the HNSW index was dropped before each load and
rebuilt after it.

**A role that row-level security binds.** The deploying identity cannot measure the
plans: on Lakebase it has `BYPASSRLS` (so does `databricks_superuser`), and a bypass role
skips even forced policies. The app's own service-principal role has `rolsuper = false`,
`rolbypassrls = false`, `rolinherit = true`. Run the §4 queries as that role, or as a role
with the same attributes and the app's grants, entered with `SET ROLE`:

```sql
CREATE ROLE bench_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;
GRANT bench_app TO CURRENT_USER;  -- lets the deploying identity SET ROLE to it
```

```bash
node scripts/migrate.mjs grants --role bench_app   # the app's least-privilege grants
```

### 2.2 Running it

```bash
# cheap reads, 1/5/20/50 users, 60 s per stage, 1 s think time
APP_URL=<app-URL> DATABRICKS_TOKEN=<oauth-token> \
  npm run loadtest -- --stages 1,5,20,50 --duration 60 --think 1000 > read-results.md

# with chat turns (SPENDS TOKENS): one turn every 10 iterations per user
APP_URL=<app-URL> DATABRICKS_TOKEN=<oauth-token> \
  npm run loadtest -- --chat --chat-every 10 --model <fast model> \
  --stages 1,5,20,50 --duration 60 --think 1000 > chat-results.md
```

`loadtest` does not run in CI: with the `CI` variable set it refuses to run. Each chat
turn's session is deleted afterwards, but the turns cost real gateway money and land in
`usage_ledger` (the ledger keeps the rows: `session_id` becomes `NULL`). Agree on the time
window and the model first. With `--chat` the report also has two derived rows per stage,
which are not requests and are left out of the stage totals: `chat: envio → 1º token`
(send to first token) and `chat: meta → 1º token (S3)` (the `meta` event to the first
`token` event, the S3 measure).

**Every virtual user is the same identity** (the token's owner). The per-user rate limiter
(`RATE_LIMIT_API_PER_MIN`, default 120, and `RATE_LIMIT_TURNS_PER_MIN`, default 12,
`server/middleware/rateLimit.js`) would answer most of the load with 429s and you would be
measuring the limiter. Real users each stay far below it, so on the **test installation
only** set both to `0` in `app.yaml` for the duration of the test.

Run one stage per invocation (`--stages N`) when you need the cost of each stage: read
`SUM(cost_usd)` from `usage_ledger` before and after each one.

Use the same `--think` and duration across runs you want to compare.

### 2.3 During the test

Record, per stage, what `loadtest` does not show:

- Lakebase: connections of the app's service principal (`pg_stat_activity` where
  `usename` is the SP's client id) and, if available, the CU in the console.
- The warehouse state (if the load goes through UC Functions or the Python UDF).
- Errors in the app logs: `databricks apps logs <app> -p <PROFILE>` (see
  [operations.md §2](operations.md#2-logs)).

### 2.4 Reading the results

- **The knee of the curve.** The point where p95 latency grows faster than the number of
  users. Before it, the system scales; after it, there is a queue.
- **Pool queueing.** The service principal's pool has a hard ceiling of 8 connections
  (`POOL_OPTS`, `server/db/pool.js`). If database-read p95 grows linearly with users while
  Lakebase is idle and the SP holds 8 connections that are all `active`, the bottleneck is
  the pool, not the database. There is no `PG_POOL_MAX` variable: the ceiling changes only
  in code (see §5). `PG_POOL_IDLE_TIMEOUT_MS` (default 2 min) is the only pool setting
  read from the environment.
- **Errors without high latency** point to an auth or routing failure. Read the most
  frequent errors table before concluding anything.
- **The error rate is not the only criterion.** A stage with 0% errors and p95 above the
  SLO still fails.

---

## 3. Load results

**Measured on 2026-11-19, commit `a27c9ca`** (main), with the `scripts/load-test.mjs` of
this change (the same request loop, plus the first-token rows).

**Environment:** a disposable test installation (its own app and service principal,
deleted after the run) in an internal AWS test workspace, region us-west-2 · Lakebase: a
disposable branch of the installation's project, autoscaling 0.5–16 CU, **warm** (endpoint
active, smoke run just before) · data: an empty, freshly migrated database (version 0007)
· the load generator ran on a laptop **outside the region**.

**Configuration:** `--duration 60 --think 1000 --timeout 30000 --chat --chat-every 10
--model databricks-claude-haiku-5-5`, one stage per invocation, `enabledTools: []`, one
identity for every virtual user, `RATE_LIMIT_API_PER_MIN=0` and `RATE_LIMIT_TURNS_PER_MIN=0`
on the test installation (§2.2). Chat traffic in total: 4 stages × 60 s.

**Latency floor.** The same queries measured inside the database take 0.4 ms and about
195 ms from the laptop (§4.7), so roughly 200 ms of every number below is the network
between the load generator and the region. Run from inside the region to remove it.

### 3.1 All requests, per stage

| Users | Requests | Errors | Error rate | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 40 | 0 | 0.00% | 0.66 | 208 | 1698 | 3661 |
| 5 | 211 | 0 | 0.00% | 3.45 | 203 | 1705 | 3314 |
| 20 | 853 | 0 | 0.00% | 13.99 | 205 | 1938 | 2257 |
| 50 | 2071 | 0 | 0.00% | 33.27 | 210 | 1767 | 3851 |

The stage p95/p99 are the chat turns (one request in eleven); the reads are in §3.2.

### 3.2 Reads, per endpoint

| Users | Endpoint | Requests | Errors | p50 (ms) | p95 (ms) | p99 (ms) |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `GET /api/me` | 12 | 0 | 198 | 903 | 903 |
| 1 | `GET /api/models` | 12 | 0 | 199 | 214 | 214 |
| 1 | `GET /api/sessions` | 12 | 0 | 212 | 221 | 221 |
| 5 | `GET /api/me` | 65 | 0 | 197 | 213 | 871 |
| 5 | `GET /api/models` | 63 | 0 | 199 | 225 | 845 |
| 5 | `GET /api/sessions` | 63 | 0 | 216 | 242 | 860 |
| 20 | `GET /api/me` | 257 | 0 | 197 | 235 | 861 |
| 20 | `GET /api/models` | 259 | 0 | 198 | 258 | 841 |
| 20 | `GET /api/sessions` | 257 | 0 | 214 | 265 | 891 |
| 50 | `GET /api/me` | 627 | 0 | 198 | 344 | 871 |
| 50 | `GET /api/models` | 620 | 0 | 200 | 341 | 867 |
| 50 | `GET /api/sessions` | 624 | 0 | 218 | 334 | 877 |

With 12 samples, the 1-user p95 and p99 are the slowest sample (the first `/api/me`).

### 3.3 Chat turns (`--chat`)

| Users | Turns | Errors | Turn p50 / p95 / p99 (ms) | Send → first token p50 / p95 / p99 (ms) | `meta` → first token p50 / p95 / p99 (ms) |
|---:|---:|---:|---|---|---|
| 1 | 4 | 0 | 1698 / 3661 / 3661 | 1055 / 1179 / 1179 | 800 / 919 / 919 |
| 5 | 20 | 0 | 1705 / 3647 / 4304 | 1099 / 2751 / 3722 | 808 / 2499 / 2798 |
| 20 | 80 | 0 | 1948 / 2369 / 2863 | 1376 / 1751 / 2299 | 849 / 1197 / 2047 |
| 50 | 200 | 0 | 1805 / 4023 / 4225 | 1208 / 2024 / 3108 | 875 / 1615 / 2805 |

The turn time runs until the `done` event. With 4 and 20 samples, the 1- and 5-user
percentiles are close to the maximum.

### 3.4 Cost per stage (`usage_ledger` delta)

| Users | Ledger rows | USD | Prompt tokens | Completion tokens | Of which: titles | chat | embeddings |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 16 | 0.001186 | 15,774 | 91 | 0.001015 | 0.000171 | 0.000000 |
| 5 | 80 | 0.005774 | 78,961 | 460 | 0.004892 | 0.000879 | 0.000003 |
| 20 | 320 | 0.023358 | 315,546 | 1,934 | 0.019810 | 0.003532 | 0.000016 |
| 50 | 800 | 0.058276 | 789,104 | 4,309 | 0.049737 | 0.008539 | 0.000000 |
| **Total** | **1,216** | **0.088594** | | | | | |

Every turn wrote 4 ledger rows (chat, title, 2 embeddings); none was unpriced. About
US$ 0.0003 per turn. **Titles are 85% of the cost** because the load test opens a new
session per turn, and every new session pays for a title. A real user pays for one title
per conversation. More than 99% of the chat prompt tokens were prompt-cache reads.

### 3.5 Resources during the test

| Users | SP connections (max) | Active at the sample (max) | Warehouse | Notes |
|---:|---:|---:|---|---|
| 1 | 4 | 0 | not used | |
| 5 | 6 | 0 | not used | |
| 20 | 8 | 1 | not used | the pool reached its ceiling of 8 |
| 50 | 8 | 2 | not used | at the ceiling, but read p95 still 334–344 ms |

Connections were sampled from `pg_stat_activity` about every 3.6 s (17 samples per stage).
The CU was not recorded.

### 3.6 Verdicts

| SLO | Target | Measured | Verdict |
|---|---|---|---|
| S2 | p95 ≤ 800 ms on `/api/me`, `/api/models`, `/api/sessions`, 20 users, warm app | 235 / 258 / 265 ms (50 users: 344 / 341 / 334 ms) | **Pass**, with about 200 ms of network included |
| S3 | `meta` → first token p95 ≤ 4 s, fast model, warm Lakebase | 1197 ms at 20 users, 1615 ms at 50 users (Haiku 5.5) | **Pass** |
| S4 | ≥ 98% of turns without an `error` event | 304 of 304 turns | Pass (one run, not a 7-day window) |

What this run does **not** prove: data volume (the load ran on an empty database; the
volume cost is in §4.6), cold start (S5), tools (no UC Function, Genie or web search in
the turns), real users spread over several identities, and an in-region client.

---

## 4. Critical queries

The queries come from `server/db.js`. `scripts/bench/explain.sql` runs each one with
`EXPLAIN (ANALYZE, BUFFERS)` exactly as the app sends it today (parameters as literals).
It runs as `bench_role` (§2.1): it prints the role's `rolsuper` and `rolbypassrls` and
stops if either is true. Each query runs inside a transaction that sets the three
settings `withTx` sets (`app.user_email`, `app.is_admin`, `app.user_groups`) and prints
them before its plan, so every plan carries the identity it ran with. Everything is
rolled back. Connect with `psql` to a test database, as the deploying identity with a
fresh database credential, never with credentials stored in the repository:

```bash
psql -X -v uemail=carga-teste@example.com -v bench_role=bench_app \
  -v groups='["w213-analysts"]' -f scripts/bench/explain.sql
# optional: -v sid=<session id> (default: the user's largest session)
```

| ID | Query | Called by | Expected frequency |
|---|---|---|---|
| Q1 | Session list (`listSessions`) | `GET /api/sessions` | Sidebar opening |
| Q2 | Session messages (`fetchActiveMessages`) | `GET /api/sessions/:id/messages`, every turn | Opening a conversation and every turn |
| Q3 | The session's tool calls (`fetchActiveMessages`, `chat_tool_calls`) | With Q2 | Same |
| Q4 | History retrieval by embedding (`retrieveRelevantMessages`) | Every turn, with `HISTORY_RETRIEVAL` on | Every turn |
| Q5 | Semantic search across sessions (`searchSessionsByVector`) | `GET /api/search` | Typing in the search box |
| Q6 | Month usage (`usageTotals`, month) | `GET /api/usage/summary` | Session start, conversation switch and end of every turn (the meter does not poll) |
| Q7 | Session usage (`usageTotals`, by kind) | Same, with `sessionId` | Same |

The relevant indexes (from the migrations): `idx_chat_sessions_user (user_email,
updated_at DESC)`, `idx_chat_messages_session (session_id, id)`,
`idx_chat_tool_calls_message (message_id, seq)`, `idx_msg_emb_session (session_id)`,
`idx_msg_emb_hnsw` (HNSW, `vector_cosine_ops`), `idx_usage_ledger_user_time (user_email,
created_at)` and `idx_usage_ledger_session (session_id)`.

### 4.1 Q1: session list

A `LATERAL` reads each listed session's messages to collect attachment names, so the cost
grows with the messages of the 100 listed sessions, not only with the number of sessions.

### 4.2 Q2 and Q3: messages and tool calls of a session

Q2 joins the messages back to their session (the ownership check). Q3 receives the ids Q2
read (`WHERE message_id = ANY($1)`). Under row-level security both also carry the
policies' checks: the session-family policies build the set of project sessions the
caller is a member of, calling `aip_project_rank()` once per project session, and Q3
checks each tool call's message and session row by row (§4.6).

### 4.3 Q4: history retrieval by embedding

The query filters on one session (`e.session_id = $1`), numbers the rows with
`ROW_NUMBER() OVER (ORDER BY m.id DESC)`, drops the 6 most recent and orders by similarity
in an outer query. Because of the window function, **the HNSW index cannot serve it**: the
distance is computed for every embedding of the session, which makes the result exact.

### 4.4 Q5: semantic search across sessions

The query groups by session with `MAX` and filters with `HAVING`, which also rules out the
HNSW index. Under row-level security the plan walks the caller's sessions and reads each
one's embeddings through `idx_msg_emb_session`, with a policy check per embedding row, and
computes the distance to every vector the caller owns (measured in §4.6). The cost grows
with the user's embeddings. (A role that bypasses the policies gets a different plan, a
Seq Scan over every user's embeddings: one more reason to measure with an RLS-bound role.)

### 4.5 Q6 and Q7: usage (meter)

Q6 should use `idx_usage_ledger_user_time` and Q7 `idx_usage_ledger_session`. Both do.

### 4.6 EXPLAIN results

**Measured on 2026-11-19 (20:22–21:00 UTC)** with the app's SQL and migrations of commit
`a27c9ca` (migrations 0001–0007) and the `scripts/bench/explain.sql` of this change, on a
disposable branch (PostgreSQL 17, pgvector 0.8.0), synthetic data from §2.1. **Data seed:**
`SELECT setseed(0.4213)` before any `random()` call (distinct from the HNSW query seed of
§4.7). **Role:**
`bench_role = w213_bench`, created as in §2.1 (`rolsuper = false`, `rolbypassrls = false`,
`rolinherit = true`, no role memberships, the app's grants), entered with `SET ROLE` from
the deploying identity (`rolbypassrls = true`). **Caller settings in every transaction:**
`app.user_email = carga-teste@example.com`, `app.is_admin = off`,
`app.user_groups = ["w213-analysts"]`.

- **Volume A:** 250 sessions (200 of the measured user, 20 group-shared) / 10,000
  messages / 10,000 embeddings / 5,000 ledger rows.
- **Volume B:** 2,500 sessions (2,000 of the measured user, 200 group-shared) / 100,000
  messages / 100,000 embeddings / 50,000 ledger rows.

Each query ran on two sessions of 40 messages: the measured user's own ("own") and a
group-shared project session with 40 tool calls ("group"). Two times for B "own" are two
runs on the same schema.

| ID | Volume | Session | Execution time (ms) | Buffers (hit/read) | Scan and index | Notes |
|---|---|---|---:|---|---|---|
| Q1 | A | — | 4.5 | 4,671 / 0 | Index Scan `idx_chat_sessions_user`; `idx_chat_messages_session` × 100 | |
| Q1 | B | — | 4.4 / 4.5 | 5,209 / 394 | Same | Grows with the 100 listed sessions only |
| Q2 | A | own / group | 2.8 / 3.0 | 121 / 0; 110 / 0 | Index Scan `idx_chat_messages_session`; `chat_sessions_pkey`; policy: hashed SubPlan over the project sessions (`idx_chat_sessions_project`) | |
| Q2 | B | own / group | 13.1 / 14.6 | 774 / 0; 617 / 40 | Same | **Policy cost**: one `aip_project_rank()` per project session (200), 12.6 ms |
| Q3 | A | own / group | 1.1 / 7.6 | 6 / 0; 526 / 0 | Index Scan `idx_chat_tool_calls_message`; policy `EXISTS` per row (`chat_messages_pkey`, `chat_sessions_pkey`) | Own session without tool calls; group session with 40 |
| Q3 | B | own / group | 1.1 / 7.6 | 2 / 4; 592 / 14 | Same | ~0.17 ms per tool call, independent of volume |
| Q4 | A | own / group | 3.0 / 8.4 | 580 / 0; 725 / 0 | `idx_msg_emb_session`; `chat_messages_pkey`; `chat_sessions_pkey`; policy SubPlan as Q2 | No HNSW (§4.3) |
| Q4 | B | own / group | 14.0 / 19.3 | 1,370 / 21; 1,390 / 0 | Same | Same policy cost as Q2 |
| Q5 | A | — | 37.5 | 28,034 / 0 | Nested Loop: caller's 200 sessions × Index Scan `idx_msg_emb_session` (8,000 rows); policy check per row | Reads only the caller's embeddings |
| Q5 | B | — | **902.3 / 738.2** | 535,974 / 76,147 | Same (2,000 sessions, 80,000 rows) | **Gap**: linear in the user's embeddings (§5) |
| Q6 | A | — | 0.55 | 66 / 0 | Bitmap Index Scan `idx_usage_ledger_user_time` (836 rows this month) | |
| Q6 | B | — | 5.0 / 5.0 | 0 / 624 | Same (8,436 rows this month) | Grows with the user's rows of the month |
| Q7 | A | — | 0.18 | 22 / 0 | Bitmap Index Scan `idx_usage_ledger_session` | |
| Q7 | B | — | 0.16 / 0.16 | 19 / 3 | Index Scan `idx_usage_ledger_session` | |

Volume B is volume A extended with the same data seed; the volume A plans were measured once
on load and again after B was trimmed back to exactly A (sessions with id > 250 deleted,
sessions 221–250 moved back out of the shared project), and the two runs agree within 1 ms
(Q5: 37.5 and 37.1 ms).

**Before and after an index.** No plan showed a missing index: every lookup uses an
existing index. The two volume-sensitive costs come from query and policy shapes, not
from a missing index: Q5 computes the distance to every vector the user owns, and the
session-family policies evaluate `aip_project_rank()` once per project session instead of
once per project. No index was added, so there is no `0008_indexes` migration; the
second B time is the "after", on the same schema.

**Earlier figures withdrawn.** A first run of this table (commit `1ca7bd6` of this change)
was measured as the deploying identity, which bypasses row-level security, without
`app.user_groups`. Its plans had no policy checks and its Q5 was a Seq Scan over every
user's embeddings. Those numbers are superseded by the table above.

### 4.7 HNSW: recall and latency

**Measured on 2026-11-19 (20:22–21:00 UTC)**, same branch, data and role as §4.6; app SQL
of commit `a27c9ca`. **Query set:** deterministic, `mulberry32` seed 4213: 50 of the
measured user's own sessions (and 20 group-shared ones for Q4), each query vector a
perturbation of one of that session's messages (a "related question"). **Ground truth,
computed outside the database:** every raw vector is read once (`vector_send`, binary
float4) and the exact answer is computed in JavaScript by cosine similarity. For Q4 with
the same rules as `retrieveRelevantMessages` (exclude the 6 most recent, similarity ≥ 0.35,
top 6); for the direct top 10, over the whole table and over the rows the caller may read
(own sessions plus the group-shared project). The same query with index scans disabled
(the database's exact scan) returned the JavaScript answer on every query (agreement
1.000 at both volumes). **Identity:** Q4 and the user-visible top 10 run as `w213_bench`
with the caller settings of §4.6, so the policies filter the rows; the whole-table top 10 is
an index characterization and runs as the deploying identity (no policies). Times are the
database's execution time (`EXPLAIN ANALYZE`); from the laptop every query took about
200 ms more.

| Volume | Query | Recall (mean / min) | Execution p50 / p95 (ms) | Uses HNSW |
|---|---|---|---|---|
| 10k | Q4, own sessions (50) | 1.000 / 1.000 | 2.58 / 2.78 | 0 of 50 |
| 10k | Q4, group-shared sessions (20) | 1.000 / 1.000 | 8.21 / 10.71 | 0 of 20 |
| 100k | Q4, own sessions (50) | 1.000 / 1.000 | 13.59 / 15.20 | 0 of 50 |
| 100k | Q4, group-shared sessions (20) | 1.000 / 1.000 | 19.49 / 22.12 | 0 of 20 |

Direct top 10 (`ORDER BY embedding <=> q LIMIT 10`), 50 queries:

| Volume | Rows searched | `ef_search` | `iterative_scan` | Recall (mean / min) | Queries with recall 0 / below 0.9 | Execution p50 / p95 (ms) | Exact scan p50 / p95 (ms) |
|---|---|---:|---|---|---|---|---|
| 10k | whole table | 40 | off | 0.978 / 0.0 | 1 / 1 | 0.43 / 0.52 | 32.4 / 35.3 |
| 10k | whole table | 100 | off | 0.998 / 0.9 | 0 / 0 | 0.53 / 0.77 | |
| 10k | whole table | 400 | off | 1.000 / 1.0 | 0 / 0 | 2.16 / 2.73 | |
| 10k | user-visible (RLS) | 40 | off | 0.978 / 0.0 | 1 / 1 | 2.42 / 4.04 | 32.9 / 35.3 |
| 10k | user-visible (RLS) | 400 | relaxed_order | 1.000 / 1.0 | 0 / 0 | 4.25 / 4.94 | |
| 100k | whole table | 40 | off | 0.916 / 0.0 | 1 / 7 | 0.93 / 1.05 | 489.6 / 514.5 |
| 100k | whole table | 100 | off | 0.968 / 0.7 | 0 / 3 | 1.36 / 1.50 | |
| 100k | whole table | 200 | off | 0.976 / 0.8 | 0 / 3 | 1.72 / 1.87 | |
| 100k | whole table | 400 | off | 0.984 / 0.8 | 0 / 2 | 2.16 / 2.32 | |
| 100k | user-visible (RLS) | 40 | off | 0.916 / 0.0 | 1 / 9 | 15.38 / 18.00 | 471.6 / 500.7 |
| 100k | user-visible (RLS) | 100 | off | 0.966 / 0.8 | 0 / 3 | 15.66 / 16.62 | |
| 100k | user-visible (RLS) | 40 | relaxed_order | 0.916 / 0.0 | 1 / 9 | 15.30 / 17.65 | |
| 100k | user-visible (RLS) | 400 | relaxed_order | 0.984 / 0.8 | 0 / 2 | 16.59 / 19.09 | |

Index build (`CREATE INDEX ... USING hnsw`, default settings): 3.3 s at 10k, **4 min 44 s
at 100k**. The graph stopped fitting in `maintenance_work_mem` after 13,935 rows.

Reading the numbers:

- **The app's per-turn retrieval (Q4) is exact at both volumes** and never uses the HNSW
  index. Under the policies it costs 2.6 ms at 10k and 13.6 ms at 100k; the growth is the
  policy check of §4.6 (one `aip_project_rank()` per project session), not the distance.
- **No query of the app uses `idx_msg_emb_hnsw` today**: Q4 and Q5 both bypass it. The
  index costs write time on every embedding and minutes to rebuild.
- **Direct HNSW recall** at 100k is 0.916 at the default `ef_search` (40) and 0.968 or
  better from 100 up, against the independent truth. The policies do not change recall;
  they add about 14 ms per query at 100k. A miss is usually all-or-nothing for a query (it
  finds its cluster or not), the known HNSW failure on well-separated clusters, and
  synthetic clusters are more separated than real embeddings. Measure recall on real
  embeddings before tuning `ef_search` or the build parameters.

**Earlier figures withdrawn.** The first run of this section (commit `1ca7bd6`) compared
direct HNSW with the database's own exact scan instead of an independent truth, drew a
fresh random query set, and seeded volume B with different centroids than volume A. Its
direct recall figures (0.850 at `ef_search` 40, 0.960 at 400) are superseded by the
tables above.

---

## 5. Next steps after the measurement

- **Q5 (the gap).** Rewrite `searchSessionsByVector` so the database takes an HNSW
  candidate set restricted to the user's sessions and groups it by session, instead of
  computing the distance to every vector. A prototype on volume B, run as `w213_bench`
  with the caller settings of §4.6, `ef_search = 400`, `iterative_scan = relaxed_order` and
  400 candidates, went from 685 / 717 ms to **20.2 / 22.9 ms** (p50 / p95, 20 queries), with
  98.8% of the top 20 sessions in common with the current query (one exploratory,
  unseeded run). It changes app code and
  search results, so it is a separate task: check recall on real data and gate it behind a
  flag. Until then, Q5 costs about 5 to 11 ms per 1,000 of the user's embeddings.
- **Project policies.** The session-family policies call `aip_project_rank()` once per
  project session the caller may see (12.6 ms for 200 sessions of one project), which Q2
  and Q4 pay on every turn. Evaluating membership once per project (for example, a join
  to the caller's projects instead of a per-row function call) is a migration and a
  separate task; measure it with this same script and role.
- **`idx_msg_emb_hnsw`.** Either the Q5 rewrite uses it, or it can be dropped (it serves
  no query today). If you keep it, give the index build a larger `maintenance_work_mem`
  for big tables.
- **The pool.** At 50 users of this mix the SP pool held its 8 connections, but with at
  most 2 active at a sample and flat read latency, it is not the bottleneck. There is no
  `PG_POOL_MAX`: the ceiling is `max: 8` in `POOL_OPTS` (`server/db/pool.js`). Add an
  environment variable only after a measurement shows 8 connections active for a sustained
  time while read p95 grows, and keep the Lakebase connection limit in mind.
- **The gateway.** Model latency is not the app's. Show the `system.ai_gateway.usage` data
  (dashboard `ai-ops`) in the report.
- Repeat the test from inside the region, with tools on and with more than one identity,
  and after every relevant change, with the same `--think` and duration.
