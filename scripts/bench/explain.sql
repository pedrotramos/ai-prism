-- EXPLAIN (ANALYZE, BUFFERS) of the critical queries Q1-Q7 (docs/performance.md §4).
--
--   psql -X -v uemail=carga-teste@example.com -f scripts/bench/explain.sql
--
-- Run it ONLY against a test database (a disposable Lakebase branch), as the
-- deploying identity with a fresh database credential as PGPASSWORD. It changes
-- nothing: every query runs inside a transaction that is rolled back.
--
-- Each query is the SQL the app sends today (server/db.js: listSessions,
-- fetchActiveMessages, retrieveRelevantMessages, searchSessionsByVector,
-- usageTotals), with the parameters as literals. Each transaction carries the
-- caller's identity the way withTx does (server/db/pool.js), so the row-level
-- security policies (FORCE, server/migrations/0003_rls.up.sql) are part of the plan,
-- as they are for the app.
--
-- Variables: uemail (required). sid (a session of uemail) and qv (a query
-- vector) are picked below when not given: the session with the most messages,
-- and that session's newest embedding.
\set ON_ERROR_STOP 1
\pset pager off
SET search_path = ai_prism, public;

\if :{?sid}
\else
  SELECT set_config('app.user_email', :'uemail', false);
  SELECT m.session_id AS sid
    FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
   WHERE s.user_email = :'uemail'
   GROUP BY m.session_id ORDER BY count(*) DESC, m.session_id LIMIT 1 \gset
\endif
\if :{?qv}
\else
  SELECT set_config('app.user_email', :'uemail', false);
  SELECT e.embedding::text AS qv FROM chat_message_embeddings e
   WHERE e.session_id = :sid ORDER BY e.message_id DESC LIMIT 1 \gset
\endif
RESET app.user_email;

\echo '== volume (all users)'
SELECT (SELECT count(*) FROM chat_sessions) AS sessions,
       (SELECT count(*) FROM chat_messages) AS messages,
       (SELECT count(*) FROM chat_message_embeddings) AS embeddings,
       (SELECT count(*) FROM usage_ledger) AS ledger_rows;

\echo '== Q1 listSessions'
BEGIN;
SELECT set_config('app.user_email', :'uemail', true), set_config('app.is_admin', 'off', true) \g /dev/null
EXPLAIN (ANALYZE, BUFFERS)
SELECT s.id, s.title, s.model, s.system_prompt, s.enabled_tools, s.created_at, s.updated_at, s.project_id,
       COALESCE(att.names, ARRAY[]::text[]) AS attachment_names
FROM chat_sessions s
LEFT JOIN LATERAL (
  SELECT array_agg(DISTINCT elem) AS names
  FROM chat_messages m
  CROSS JOIN LATERAL jsonb_array_elements_text(m.attachments::jsonb) AS elem
  WHERE m.session_id = s.id AND m.attachments IS NOT NULL
) att ON true
WHERE (s.user_email = :'uemail' AND (s.project_id IS NULL OR ai_prism.aip_project_rank(s.project_id) IS NOT NULL))
ORDER BY s.updated_at DESC LIMIT 100;
ROLLBACK;

\echo '== Q2 fetchActiveMessages (messages)'
BEGIN;
SELECT set_config('app.user_email', :'uemail', true), set_config('app.is_admin', 'off', true) \g /dev/null
EXPLAIN (ANALYZE, BUFFERS)
SELECT m.id, m.role, m.content, m.attachments, m.model, m.prompt_tokens, m.completion_tokens, m.blocks,
       m.variant_group, m.active, m.created_at, m.media_processing, m.intent_classify, m.reasoning
FROM chat_messages m
JOIN chat_sessions s ON s.id = m.session_id
 AND ((s.project_id IS NULL AND s.user_email = :'uemail') OR
      (s.project_id IS NOT NULL AND ai_prism.aip_project_rank(s.project_id) IS NOT NULL))
WHERE m.session_id = :sid ORDER BY m.id ASC;
ROLLBACK;

\echo '== Q3 fetchActiveMessages (tool calls; the app passes the ids Q2 read)'
BEGIN;
SELECT set_config('app.user_email', :'uemail', true), set_config('app.is_admin', 'off', true) \g /dev/null
SELECT '{' || string_agg(id::text, ',' ORDER BY id) || '}' AS ids FROM chat_messages WHERE session_id = :sid \gset
EXPLAIN (ANALYZE, BUFFERS)
SELECT message_id, call_id, tool_name, tool_label, arguments, result, status, duration_ms
FROM chat_tool_calls WHERE message_id = ANY(:'ids'::bigint[]) ORDER BY message_id, seq ASC;
ROLLBACK;

\echo '== Q4 retrieveRelevantMessages (topN 6, excludeRecent 6, minSimilarity 0.35)'
BEGIN;
SELECT set_config('app.user_email', :'uemail', true), set_config('app.is_admin', 'off', true) \g /dev/null
EXPLAIN (ANALYZE, BUFFERS)
WITH scoped AS (
  SELECT m.id, m.role, m.content, m.created_at,
         1 - (e.embedding <=> :'qv'::vector) AS similarity,
         ROW_NUMBER() OVER (ORDER BY m.id DESC) AS recency_rank
    FROM chat_message_embeddings e
    JOIN chat_messages m ON m.id = e.message_id
    JOIN chat_sessions s ON s.id = m.session_id
     AND ((s.project_id IS NULL AND s.user_email = :'uemail') OR
          (s.project_id IS NOT NULL AND ai_prism.aip_project_rank(s.project_id) IS NOT NULL))
   WHERE e.session_id = :sid AND m.active = true
)
SELECT id, role, content, similarity FROM scoped
 WHERE recency_rank > 6 AND similarity >= 0.35
 ORDER BY similarity DESC LIMIT 6;
ROLLBACK;

\echo '== Q5 searchSessionsByVector (limit 20, minSimilarity 0.3)'
BEGIN;
SELECT set_config('app.user_email', :'uemail', true), set_config('app.is_admin', 'off', true) \g /dev/null
EXPLAIN (ANALYZE, BUFFERS)
SELECT s.id, s.title, MAX(1 - (e.embedding <=> :'qv'::vector)) AS score
  FROM chat_message_embeddings e
  JOIN chat_sessions s ON s.id = e.session_id
   AND (s.user_email = :'uemail' AND (s.project_id IS NULL OR ai_prism.aip_project_rank(s.project_id) IS NOT NULL))
 GROUP BY s.id, s.title
HAVING MAX(1 - (e.embedding <=> :'qv'::vector)) >= 0.3
 ORDER BY score DESC LIMIT 20;
ROLLBACK;

\echo '== Q6 usageTotals (month)'
BEGIN;
SELECT set_config('app.user_email', :'uemail', true), set_config('app.is_admin', 'off', true) \g /dev/null
EXPLAIN (ANALYZE, BUFFERS)
SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd,
       COALESCE(BOOL_OR(estimated), false) AS estimated,
       COALESCE(BOOL_OR(cost_usd IS NULL), false) AS unpriced
  FROM usage_ledger WHERE user_email = :'uemail' AND created_at >= date_trunc('month', now());
ROLLBACK;

\echo '== Q7 usageTotals (session, by kind)'
BEGIN;
SELECT set_config('app.user_email', :'uemail', true), set_config('app.is_admin', 'off', true) \g /dev/null
EXPLAIN (ANALYZE, BUFFERS)
SELECT kind, COALESCE(SUM(cost_usd), 0)::float8 AS usd, COUNT(*)::int AS calls,
       COALESCE(BOOL_OR(estimated), false) AS estimated,
       COALESCE(BOOL_OR(cost_usd IS NULL), false) AS unpriced
  FROM usage_ledger WHERE user_email = :'uemail' AND session_id = :sid GROUP BY kind;
ROLLBACK;
