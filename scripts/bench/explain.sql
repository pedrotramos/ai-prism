-- EXPLAIN (ANALYZE, BUFFERS) of the critical queries Q1-Q7 (docs/performance.md §4).
--
--   psql -X -v uemail=carga-teste@example.com -v bench_role=<role> \
--        [-v groups='["<group>"]'] [-v sid=<session id>] -f scripts/bench/explain.sql
--
-- Run it ONLY against a test database (a disposable Lakebase branch), as the
-- deploying identity with a fresh database credential as PGPASSWORD. It changes
-- nothing: every query runs inside a transaction that is rolled back.
--
-- Row-level security binds the plans only for a role that is neither a
-- superuser nor BYPASSRLS (server/migrations/0003_rls.up.sql: FORCE binds the
-- table owner, not those two). So the script SET ROLEs to `bench_role` (the app
-- service principal's role, or a role with the same attributes and the app's
-- grants: `node scripts/migrate.mjs grants --role <role>`), prints the role's
-- attributes, and stops when the role could bypass the policies. Every
-- transaction prints the identity it ran with (role + caller settings) before
-- its plan, so each plan carries its own proof.
--
-- Each query is the SQL the app sends today (server/db.js: listSessions,
-- fetchActiveMessages, retrieveRelevantMessages, searchSessionsByVector,
-- usageTotals), with the parameters as literals. Each transaction sets the
-- three settings withTx sets (server/db/pool.js): app.user_email, app.is_admin
-- and app.user_groups (the caller's SCIM groups as a JSON array; `groups`,
-- default '[]').
--
-- Variables: uemail and bench_role (required). sid (a session uemail can read)
-- and qv (a query vector) are picked below when not given: the session with the
-- most messages among uemail's own, and that session's newest embedding.
\set ON_ERROR_STOP 1
\pset pager off
\if :{?groups}
\else
  \set groups '[]'
\endif
SET search_path = ai_prism, public;
\echo '== connecting identity (bypass here is why the plans run under bench_role)'
SELECT r.rolname AS session_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = session_user;
\echo '== volume (all users; counted as the connecting identity, before SET ROLE)'
SELECT (SELECT count(*) FROM chat_sessions) AS sessions,
       (SELECT count(*) FROM chat_messages) AS messages,
       (SELECT count(*) FROM chat_message_embeddings) AS embeddings,
       (SELECT count(*) FROM usage_ledger) AS ledger_rows;

SET ROLE :"bench_role";

\echo '== role identity'
SELECT current_user, session_user, r.rolsuper, r.rolbypassrls, r.rolinherit, r.rolcanlogin,
       (r.rolsuper OR r.rolbypassrls) AS bypasses_rls
  FROM pg_roles r WHERE r.rolname = current_user;
SELECT (r.rolsuper OR r.rolbypassrls) AS bypass FROM pg_roles r WHERE r.rolname = current_user \gset
\if :bypass
  \echo 'refusing: the role bypasses row-level security; the plans would not be the app''s'
  DO $$ BEGIN RAISE EXCEPTION 'bench_role bypasses row-level security'; END $$;
\endif

\if :{?sid}
\else
  SELECT set_config('app.user_email', :'uemail', false), set_config('app.user_groups', :'groups', false) \g /dev/null
  SELECT m.session_id AS sid
    FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
   WHERE s.user_email = :'uemail'
   GROUP BY m.session_id ORDER BY count(*) DESC, m.session_id LIMIT 1 \gset
\endif
\if :{?qv}
\else
  SELECT set_config('app.user_email', :'uemail', false), set_config('app.user_groups', :'groups', false) \g /dev/null
  SELECT e.embedding::text AS qv FROM chat_message_embeddings e
   WHERE e.session_id = :sid ORDER BY e.message_id DESC LIMIT 1 \gset
\endif
RESET app.user_email;
RESET app.user_groups;

\echo '== Q1 listSessions'
BEGIN;
SELECT set_config('app.user_email', :'uemail', true), set_config('app.is_admin', 'off', true), set_config('app.user_groups', :'groups', true) \g /dev/null
SELECT current_user AS role, current_setting('app.user_email') AS user_email, current_setting('app.is_admin') AS is_admin, current_setting('app.user_groups') AS user_groups;
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
SELECT set_config('app.user_email', :'uemail', true), set_config('app.is_admin', 'off', true), set_config('app.user_groups', :'groups', true) \g /dev/null
SELECT current_user AS role, current_setting('app.user_email') AS user_email, current_setting('app.is_admin') AS is_admin, current_setting('app.user_groups') AS user_groups;
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
SELECT set_config('app.user_email', :'uemail', true), set_config('app.is_admin', 'off', true), set_config('app.user_groups', :'groups', true) \g /dev/null
SELECT current_user AS role, current_setting('app.user_email') AS user_email, current_setting('app.is_admin') AS is_admin, current_setting('app.user_groups') AS user_groups;
SELECT '{' || string_agg(id::text, ',' ORDER BY id) || '}' AS ids FROM chat_messages WHERE session_id = :sid \gset
EXPLAIN (ANALYZE, BUFFERS)
SELECT message_id, call_id, tool_name, tool_label, arguments, result, status, duration_ms
FROM chat_tool_calls WHERE message_id = ANY(:'ids'::bigint[]) ORDER BY message_id, seq ASC;
ROLLBACK;

\echo '== Q4 retrieveRelevantMessages (topN 6, excludeRecent 6, minSimilarity 0.35)'
BEGIN;
SELECT set_config('app.user_email', :'uemail', true), set_config('app.is_admin', 'off', true), set_config('app.user_groups', :'groups', true) \g /dev/null
SELECT current_user AS role, current_setting('app.user_email') AS user_email, current_setting('app.is_admin') AS is_admin, current_setting('app.user_groups') AS user_groups;
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
SELECT set_config('app.user_email', :'uemail', true), set_config('app.is_admin', 'off', true), set_config('app.user_groups', :'groups', true) \g /dev/null
SELECT current_user AS role, current_setting('app.user_email') AS user_email, current_setting('app.is_admin') AS is_admin, current_setting('app.user_groups') AS user_groups;
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
SELECT set_config('app.user_email', :'uemail', true), set_config('app.is_admin', 'off', true), set_config('app.user_groups', :'groups', true) \g /dev/null
SELECT current_user AS role, current_setting('app.user_email') AS user_email, current_setting('app.is_admin') AS is_admin, current_setting('app.user_groups') AS user_groups;
EXPLAIN (ANALYZE, BUFFERS)
SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd,
       COALESCE(BOOL_OR(estimated), false) AS estimated,
       COALESCE(BOOL_OR(cost_usd IS NULL), false) AS unpriced
  FROM usage_ledger WHERE user_email = :'uemail' AND created_at >= date_trunc('month', now());
ROLLBACK;

\echo '== Q7 usageTotals (session, by kind)'
BEGIN;
SELECT set_config('app.user_email', :'uemail', true), set_config('app.is_admin', 'off', true), set_config('app.user_groups', :'groups', true) \g /dev/null
SELECT current_user AS role, current_setting('app.user_email') AS user_email, current_setting('app.is_admin') AS is_admin, current_setting('app.user_groups') AS user_groups;
EXPLAIN (ANALYZE, BUFFERS)
SELECT kind, COALESCE(SUM(cost_usd), 0)::float8 AS usd, COUNT(*)::int AS calls,
       COALESCE(BOOL_OR(estimated), false) AS estimated,
       COALESCE(BOOL_OR(cost_usd IS NULL), false) AS unpriced
  FROM usage_ledger WHERE user_email = :'uemail' AND session_id = :sid GROUP BY kind;
ROLLBACK;
