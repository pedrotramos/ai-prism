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
topics. A second, fictitious user (`outro-usuario@example.com`) owns 20% of the rows, so
the plans show whether a query reads other users' data.

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
`EXPLAIN (ANALYZE, BUFFERS)` exactly as the app sends it today (parameters as literals)
and inside a transaction that carries the caller's identity, so the row-level security
policies are part of the plan, as they are for the app. Everything is rolled back. Run it
with `psql` against a test database, as the deploying identity with a fresh database
credential, never with credentials stored in the repository:

```bash
psql -X -v uemail=carga-teste@example.com -f scripts/bench/explain.sql
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
read (`WHERE message_id = ANY($1)`).

### 4.3 Q4: history retrieval by embedding

The query filters on one session (`e.session_id = $1`), numbers the rows with
`ROW_NUMBER() OVER (ORDER BY m.id DESC)`, drops the 6 most recent and orders by similarity
in an outer query. Because of the window function, **the HNSW index cannot serve it**: the
distance is computed for every embedding of the session, which makes the result exact.

### 4.4 Q5: semantic search across sessions

The query groups by session with `MAX` and filters with `HAVING`, which also rules out the
HNSW index. The plan reads every embedding in the table, of every user, and joins them to
the caller's sessions afterwards (measured in §4.6). The cost grows with the installation's
embeddings, not with the user's.

### 4.5 Q6 and Q7: usage (meter)

Q6 should use `idx_usage_ledger_user_time` and Q7 `idx_usage_ledger_session`. Both do.

### 4.6 EXPLAIN results

**Measured on 2026-11-19, commit `a27c9ca`**, `scripts/bench/explain.sql`, on the same
disposable branch (PostgreSQL 17, pgvector 0.8.0), synthetic data from §2.1:

- **Volume A:** 250 sessions (200 of the measured user) / 10,000 messages / 10,000
  embeddings / 6,240 ledger rows.
- **Volume B:** 2,500 sessions (2,000 of the measured user) / 100,000 messages / 100,000
  embeddings / 51,240 ledger rows.

The measured session has 40 messages. The B time is the first run after the load, then a
second run on the same schema.

| ID | Volume | Execution time (ms) | Buffers (hit/read) | Scan and index | Notes |
|---|---|---:|---|---|---|
| Q1 | A | 2.9 | 4,201 / 0 | Index Scan `idx_chat_sessions_user`; Bitmap Index Scan `idx_chat_messages_session` × 100 | |
| Q1 | B | 8.5 / 20.2 | 3,992 / 400 | Index Scan `idx_chat_sessions_user`; Index Scan `idx_chat_messages_session` × 100 | Grows with the 100 listed sessions, as expected |
| Q2 | A | 0.34 | 47 / 0 | Bitmap Index Scan `idx_chat_messages_session`; `chat_sessions_pkey` | |
| Q2 | B | 0.18 / 0.16 | 46 / 0 | Index Scan `idx_chat_messages_session`; `chat_sessions_pkey` | Independent of volume |
| Q3 | A | 0.14 | 9 / 0 | Bitmap Index Scan `idx_chat_tool_calls_message` | Session without tool calls |
| Q3 | B | 0.36 | 68 / 28 | Index Scan `idx_chat_tool_calls_message` | Session with 40 tool calls |
| Q4 | A | 0.71 | 344 / 0 | Index Scan `idx_msg_emb_session`; `chat_messages_pkey`; `chat_sessions_pkey` | No HNSW (§4.3) |
| Q4 | B | 1.7 / 2.7 | 403 / 21 | Same | Independent of volume |
| Q5 | A | 27.8 | 26,767 / 0 | **Seq Scan** `chat_message_embeddings` (10,000 rows, every user); Hash Join; Seq Scan `chat_sessions` | Reads the other user's 2,000 embeddings too |
| Q5 | B | **554.6 / 426.4** | 293,169 / 54,501 | **Seq Scan** `chat_message_embeddings` (100,000 rows); Hash Join; Bitmap Index Scan `idx_chat_sessions_user` | **Gap**: linear in the installation's embeddings (§5) |
| Q6 | A | 0.36 | 75 / 0 | Bitmap Index Scan `idx_usage_ledger_user_time` (844 rows this month) | |
| Q6 | B | 4.1 / 4.6 | 0 / 596 | Same (8,444 rows this month) | Grows with the user's rows of the month |
| Q7 | A | 0.17 | 22 / 0 | Bitmap Index Scan `idx_usage_ledger_session`, filter `user_email` | |
| Q7 | B | 0.53 / 0.18 | 20 / 2 | Index Scan `idx_usage_ledger_session`, filter `user_email` | |

**Before and after an index.** No plan showed a missing index: every lookup uses an
existing index, and the Q5 Seq Scan comes from the query's shape (the distance to every
vector the user owns has to be computed, and `idx_msg_emb_session` exists but does not
help when the user owns most rows). No index was added, so there is no `0008_indexes`
migration; the second B time is the "after", on the same schema.

### 4.7 HNSW: recall and latency

**Measured on 2026-11-19, commit `a27c9ca`**, same branch, 50 queries per volume. Each
query vector is a perturbation of a message of a random session of the measured user (a
"related question"). Ground truth: for Q4, computed outside the database from the raw
vectors with the same rules as `retrieveRelevantMessages` (exclude the 6 most recent,
similarity ≥ 0.35, top 6); for the direct HNSW query, the same query with index scans
disabled. Times are the database's execution time (`EXPLAIN ANALYZE`). From the laptop,
every query took about 195 ms more.

| Volume | Query | Recall (mean / min) | Execution p50 / p95 (ms) | Exact p50 / p95 (ms) | Uses HNSW |
|---|---|---|---|---|---|
| 10k | Q4 `retrieveRelevantMessages` (top 6) | 1.000 / 1.000 | 0.40 / 0.44 | — | 0 of 50 |
| 10k | Direct top 10, whole table, `ef_search` 40 | 1.000 / 1.000 | 0.40 / 0.45 | 30.0 / 32.9 | 50 of 50 |
| 10k | Direct top 10, user's sessions, `ef_search` 40 | 0.998 / 0.900 | 0.41 / 0.47 | 25.7 / 28.3 | 50 of 50 |
| 100k | Q4 `retrieveRelevantMessages` (top 6) | 1.000 / 1.000 | 0.45 / 0.49 | — | 0 of 50 |
| 100k | Direct top 10, whole table, `ef_search` 40 | 0.850 / 0.000 | 0.88 / 1.00 | 478 / 495 | 50 of 50 |
| 100k | Direct top 10, whole table, `ef_search` 100 | 0.912 / 0.000 | 1.25 / 1.46 | 475 / 515 | 50 of 50 |
| 100k | Direct top 10, user's sessions, `ef_search` 40 | 0.852 / 0.000 | 0.93 / 1.00 | 400 / 418 | 50 of 50 |
| 100k | Same, `ef_search` 40, `iterative_scan = relaxed_order` | 0.852 / 0.000 | 0.94 / 1.08 | 395 / 416 | 50 of 50 |

`ef_search` sweep at 100k (another 50 queries, whole table, top 10):

| `hnsw.ef_search` | Mean recall | Queries with recall 0 | Queries below 0.9 | Execution p50 / p95 (ms) |
|---:|---:|---:|---:|---|
| 40 (default) | 0.894 | 3 | 6 | 0.90 / 1.00 |
| 100 | 0.936 | 2 | 3 | 1.35 / 1.61 |
| 200 | 0.938 | 2 | 3 | 1.69 / 1.94 |
| 400 | 0.960 | 1 | 1 | 2.10 / 3.24 |

Index build (`CREATE INDEX ... USING hnsw`, default settings): 3.2 s at 10k, **4 min 28 s
at 100k**. The graph stopped fitting in `maintenance_work_mem` after 13,925 rows.

Reading the numbers:

- **The app's per-turn retrieval (Q4) is exact and fast at both volumes**: it reads only
  one session's embeddings and never uses the HNSW index.
- **No query of the app uses `idx_msg_emb_hnsw` today**: Q4 and Q5 both bypass it. The
  index costs write time on every embedding and minutes to rebuild.
- At 100k, direct HNSW misses are **bimodal**: a query either finds its cluster's
  neighbours or none of them. This is the well-known HNSW failure on well-separated
  clusters, and synthetic clusters are more separated than real embeddings. Measure
  recall on real embeddings before tuning `ef_search` or the build parameters.

---

## 5. Next steps after the measurement

- **Q5 (the gap).** Rewrite `searchSessionsByVector` so the database takes an HNSW
  candidate set restricted to the user's sessions and groups it by session, instead of
  computing the distance to every vector. A prototype on volume B, with `ef_search = 400`,
  `iterative_scan = relaxed_order` and 400 candidates, went from 397 / 414 ms to
  **5.6 / 7.6 ms** (p50 / p95, 20 queries), with 95% of the top 20 sessions in common with
  the exact query. It changes app code and search results, so it is a separate task: check
  recall on real data and gate it behind a flag. Until then, Q5 costs about 3 to 5 ms per 1,000
  embeddings in the installation.
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
