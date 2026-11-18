-- 0003_rls: row-level security on every app table in ai_prism (W2-1).
--
-- The app connects as ONE Postgres role for every signed-in user: the app's
-- service principal, which owns no table, is no member of the owner role once
-- the deploy's grants ran, and has no BYPASSRLS. Isolation between users is
-- enforced here, by the database, instead of only by the WHERE clauses of the
-- queries (they stay, as defence in depth). server/db/pool.js withTx sets two
-- transaction-local settings before any query (set_config(..., true), the
-- parameterised SET LOCAL):
--
--   app.user_email  the signed-in user ('' or unset = nobody: no row matches;
--                   the policies read it through NULLIF(..., ''), because an
--                   owner column may itself hold '' (NOT NULL, not non-empty)
--                   and '' = '' would otherwise let "nobody" own those rows)
--   app.is_admin    'on' only for a write an admin route asked for, else 'off'
--
-- FORCE ROW LEVEL SECURITY makes the policies bind the table owner too, so the
-- only identities that skip them are superusers and BYPASSRLS roles. A data
-- migration that must see every row runs as the owner and switches FORCE off
-- and back on inside its own transaction (server/db/backfillUsage.js). Foreign
-- keys (checks and ON DELETE actions) are not subject to RLS.
--
-- Policy families (server/db/rls.js keeps the same lists):
--   direct   user_email = app.user_email (writes of a row that references a
--            session also need that session to be the caller's)
--   session  the row's session (chat_sessions) belongs to app.user_email
--   message  the row's message is in such a session
--   mixed    read own OR global; write own (scope 'user') OR global with the admin flag
--   global   read all; write only with the admin flag
-- The identity predicates are STABLE, so they work as index conditions on the
-- existing user_email / session_id / message_id indexes.
--
-- Needs the table owner (the runner acts as the owner role under the deploy's
-- hand-off). Idempotent: every aip_* policy is dropped and created again,
-- ENABLE / FORCE are no-ops when already set.
DO $up$
DECLARE
  direct_tables text[] := ARRAY['chat_sessions', 'chat_decks', 'chat_spreadsheets', 'chat_documents', 'chat_images',
    'usage_ledger', 'user_mcp_connections', 'user_template_selection', 'user_image_model_selection'];
  session_tables text[] := ARRAY['chat_messages', 'chat_genie_conversations', 'chat_compactions', 'chat_message_embeddings'];
  message_tables text[] := ARRAY['chat_tool_calls'];
  -- direct tables that also reference a session: writes need both to be the caller's
  session_owned text[] := ARRAY['chat_decks', 'chat_spreadsheets', 'chat_documents', 'chat_images', 'usage_ledger'];
  mixed_tables text[] := ARRAY['deck_templates', 'skills'];
  global_tables text[] := ARRAY['app_admins', 'app_mcp_catalog', 'app_tool_policy', 'model_catalog_overrides'];
  -- NULL when unset or '': owner = NULL is never true, in USING and WITH CHECK alike
  me constant text := 'NULLIF(current_setting(''app.user_email'', true), '''')';
  is_admin constant text := '(coalesce(current_setting(''app.is_admin'', true), '''') = ''on'')';
  t text;
  owner_col text;
  own text;
  p record;
BEGIN
  FOREACH t IN ARRAY direct_tables || session_tables || message_tables || mixed_tables || global_tables LOOP
    FOR p IN SELECT polname FROM pg_policy WHERE polrelid = format('ai_prism.%I', t)::regclass AND polname LIKE 'aip\_%' LOOP
      EXECUTE format('DROP POLICY %I ON ai_prism.%I', p.polname, t);
    END LOOP;
  END LOOP;

  FOREACH t IN ARRAY direct_tables LOOP
    IF t = ANY (session_owned) THEN
      -- a row of the caller may only point at a session of the caller
      own := format('(user_email = %s AND (session_id IS NULL OR EXISTS (SELECT 1 FROM ai_prism.chat_sessions s '
        'WHERE s.id = %I.session_id AND s.user_email = %s)))', me, t, me);
    ELSE
      own := format('(user_email = %s)', me);
    END IF;
    EXECUTE format('CREATE POLICY aip_owner ON ai_prism.%I FOR ALL USING (user_email = %s) WITH CHECK %s', t, me, own);
  END LOOP;

  FOREACH t IN ARRAY session_tables LOOP
    own := format('EXISTS (SELECT 1 FROM ai_prism.chat_sessions s WHERE s.id = %I.session_id AND s.user_email = %s)', t, me);
    EXECUTE format('CREATE POLICY aip_owner ON ai_prism.%I FOR ALL USING (%s) WITH CHECK (%s)', t, own, own);
  END LOOP;

  FOREACH t IN ARRAY message_tables LOOP
    own := format('EXISTS (SELECT 1 FROM ai_prism.chat_messages m JOIN ai_prism.chat_sessions s ON s.id = m.session_id '
      'WHERE m.id = %I.message_id AND s.user_email = %s)', t, me);
    EXECUTE format('CREATE POLICY aip_owner ON ai_prism.%I FOR ALL USING (%s) WITH CHECK (%s)', t, own, own);
  END LOOP;

  FOREACH t IN ARRAY mixed_tables LOOP
    owner_col := CASE t WHEN 'skills' THEN 'owner_email' ELSE 'user_email' END;
    own := format('((%I = %s AND scope <> ''global'') OR (scope = ''global'' AND %s))', owner_col, me, is_admin);
    EXECUTE format('CREATE POLICY aip_read ON ai_prism.%I FOR SELECT USING (%I = %s OR scope = ''global'')', t, owner_col, me);
    EXECUTE format('CREATE POLICY aip_insert ON ai_prism.%I FOR INSERT WITH CHECK %s', t, own);
    EXECUTE format('CREATE POLICY aip_update ON ai_prism.%I FOR UPDATE USING %s WITH CHECK %s', t, own, own);
    EXECUTE format('CREATE POLICY aip_delete ON ai_prism.%I FOR DELETE USING %s', t, own);
  END LOOP;

  FOREACH t IN ARRAY global_tables LOOP
    EXECUTE format('CREATE POLICY aip_read ON ai_prism.%I FOR SELECT USING (true)', t);
    EXECUTE format('CREATE POLICY aip_admin_insert ON ai_prism.%I FOR INSERT WITH CHECK %s', t, is_admin);
    EXECUTE format('CREATE POLICY aip_admin_update ON ai_prism.%I FOR UPDATE USING %s WITH CHECK %s', t, is_admin, is_admin);
    EXECUTE format('CREATE POLICY aip_admin_delete ON ai_prism.%I FOR DELETE USING %s', t, is_admin);
  END LOOP;

  FOREACH t IN ARRAY direct_tables || session_tables || message_tables || mixed_tables || global_tables LOOP
    EXECUTE format('ALTER TABLE ai_prism.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE ai_prism.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$up$;
