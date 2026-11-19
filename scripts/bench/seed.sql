-- Synthetic volume for the EXPLAIN and HNSW measurements of docs/performance.md §4.6/§4.7.
-- Source of truth for that setup: docs/performance.md §2.1 describes this script.
-- Run ONLY on a disposable test database, as the deploying identity, after
-- `node scripts/migrate.mjs up` (it writes fictitious users' rows into ai_prism.*):
--   volume A: psql -X -v main_sessions=200 -v other_sessions=50 -v msgs=40 -v proj_sessions=20 -f scripts/bench/seed.sql
--   volume B: run it again with -v main_sessions=1800 -v other_sessions=450 -v proj_sessions=180
-- Fictitious users only: carga-teste@example.com (measured) and outro-usuario@example.com
-- (other tenants' rows, so Q5 shows whether it reads other users' embeddings).
-- Vectors: 64 random centroids + uniform noise; each session spans 3 clusters, so
-- nearest-neighbour structure looks like topics rather than uniform noise (uniform
-- random 1024-d vectors are a degenerate worst case for any ANN index).
\set ON_ERROR_STOP 1
SET search_path = ai_prism, public;
-- deterministic data: same seed, same vectors and texts on every run
SELECT setseed(0.4213);

CREATE TEMP TABLE IF NOT EXISTS w213_centroids AS
SELECT k, array_agg(random()::float4 - 0.5 ORDER BY i) AS v
FROM generate_series(0, 63) k, generate_series(1, 1024) i GROUP BY k;

-- one batch per user: RLS (FORCE) binds the owner too, so identity is set per batch
\set who 'carga-teste@example.com'
\set nsess :main_sessions
\ir seed_user.sql
\set who 'outro-usuario@example.com'
\set nsess :other_sessions
\ir seed_user.sql

-- group-shared project: owned by the other user, shared with group w213-analysts
-- (view); the measured user reaches it only through app.user_groups
\ir seed_project.sql
