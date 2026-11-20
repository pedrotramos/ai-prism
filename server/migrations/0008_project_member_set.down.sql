-- 0008_project_member_set (rollback): back to per-row membership tests. Drops and
-- recreates every aipj_* policy exactly as 0005 created them (the block below is
-- 0005's, verbatim), then drops aip_my_project_ids(). No data is touched.
-- Needs the table owner. Idempotent.
DO $up$
DECLARE
  me constant text := 'lower(NULLIF(current_setting(''app.user_email'', true), ''''))';
  -- the session behind a row is a project chat the caller is a member of
  member_of_session constant text := 'EXISTS (SELECT 1 FROM ai_prism.chat_sessions s WHERE s.id = %I.session_id '
    'AND s.project_id IS NOT NULL AND ai_prism.aip_project_rank(s.project_id) IS NOT NULL)';
  session_tables text[] := ARRAY['chat_messages', 'chat_genie_conversations', 'chat_compactions', 'chat_message_embeddings'];
  -- per-user rows that may point at a shared chat: the caller's own row, in a chat she is a member of
  owned_tables text[] := ARRAY['usage_ledger', 'chat_decks', 'chat_spreadsheets', 'chat_documents', 'chat_images'];
  p record;
  t text;
  own text;
BEGIN
  FOR p IN SELECT polname, polrelid::regclass::text AS t FROM pg_policy
            WHERE polname LIKE 'aipj\_%'
              AND polrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'ai_prism'::regnamespace) LOOP
    EXECUTE format('DROP POLICY %I ON %s', p.polname, p.t);
  END LOOP;

  -- projects: members read; the caller creates as herself; manage+ edits; the owner deletes
  EXECUTE 'CREATE POLICY aipj_read ON ai_prism.projects FOR SELECT USING (ai_prism.aip_project_rank(id) IS NOT NULL)';
  EXECUTE format('CREATE POLICY aipj_insert ON ai_prism.projects FOR INSERT WITH CHECK (created_by = %s)', me);
  EXECUTE 'CREATE POLICY aipj_update ON ai_prism.projects FOR UPDATE '
    'USING (ai_prism.aip_project_rank(id) >= 2) WITH CHECK (ai_prism.aip_project_rank(id) >= 2)';
  EXECUTE 'CREATE POLICY aipj_delete ON ai_prism.projects FOR DELETE USING (ai_prism.aip_project_rank(id) = 3)';

  -- project_members: members see the roster; manage+ writes non-owner rows; only an
  -- owner writes owner rows; anyone may remove her own row (leave)
  own := '(ai_prism.aip_project_rank(project_id) >= 2 AND (role <> ''owner'' OR ai_prism.aip_project_rank(project_id) = 3))';
  EXECUTE 'CREATE POLICY aipj_read ON ai_prism.project_members FOR SELECT USING (ai_prism.aip_project_rank(project_id) IS NOT NULL)';
  EXECUTE format('CREATE POLICY aipj_insert ON ai_prism.project_members FOR INSERT WITH CHECK %s', own);
  EXECUTE format('CREATE POLICY aipj_update ON ai_prism.project_members FOR UPDATE USING %s WITH CHECK %s', own, own);
  EXECUTE format('CREATE POLICY aipj_delete ON ai_prism.project_members FOR DELETE USING (%s OR (kind = ''user'' AND principal = %s))', own, me);

  -- project_files: members read; manage+ uploads (as herself) and deletes; no update
  EXECUTE 'CREATE POLICY aipj_read ON ai_prism.project_files FOR SELECT USING (ai_prism.aip_project_rank(project_id) IS NOT NULL)';
  EXECUTE format('CREATE POLICY aipj_insert ON ai_prism.project_files FOR INSERT '
    'WITH CHECK (ai_prism.aip_project_rank(project_id) >= 2 AND uploaded_by = %s)', me);
  EXECUTE 'CREATE POLICY aipj_delete ON ai_prism.project_files FOR DELETE USING (ai_prism.aip_project_rank(project_id) >= 2)';

  -- chat_sessions: the gate (restrictive) and the members' read / write
  EXECUTE format('CREATE POLICY aipj_project_gate ON ai_prism.chat_sessions AS RESTRICTIVE FOR ALL '
    'USING (project_id IS NULL OR ai_prism.aip_project_rank(project_id) IS NOT NULL) '
    'WITH CHECK (project_id IS NULL OR ai_prism.aip_project_rank(project_id) IS NOT NULL)');
  EXECUTE 'CREATE POLICY aipj_member_read ON ai_prism.chat_sessions FOR SELECT '
    'USING (project_id IS NOT NULL AND ai_prism.aip_project_rank(project_id) IS NOT NULL)';
  -- the new row may leave the project (project_id NULL): the guard trigger then
  -- requires manage on the project it leaves, and it stays its creator's chat
  EXECUTE 'CREATE POLICY aipj_member_update ON ai_prism.chat_sessions FOR UPDATE '
    'USING (project_id IS NOT NULL AND ai_prism.aip_project_rank(project_id) IS NOT NULL) '
    'WITH CHECK (project_id IS NULL OR ai_prism.aip_project_rank(project_id) IS NOT NULL)';

  FOREACH t IN ARRAY session_tables LOOP
    EXECUTE format('CREATE POLICY aipj_member_read ON ai_prism.%I FOR SELECT USING (' || member_of_session || ')', t, t);
    EXECUTE format('CREATE POLICY aipj_member_insert ON ai_prism.%I FOR INSERT WITH CHECK (' || member_of_session || ')', t, t);
    EXECUTE format('CREATE POLICY aipj_member_update ON ai_prism.%I FOR UPDATE USING (' || member_of_session || ') '
      'WITH CHECK (' || member_of_session || ')', t, t, t);
  END LOOP;

  -- chat_tool_calls hang off a message
  own := 'EXISTS (SELECT 1 FROM ai_prism.chat_messages m JOIN ai_prism.chat_sessions s ON s.id = m.session_id '
    'WHERE m.id = chat_tool_calls.message_id AND s.project_id IS NOT NULL AND ai_prism.aip_project_rank(s.project_id) IS NOT NULL)';
  EXECUTE format('CREATE POLICY aipj_member_read ON ai_prism.chat_tool_calls FOR SELECT USING (%s)', own);
  EXECUTE format('CREATE POLICY aipj_member_insert ON ai_prism.chat_tool_calls FOR INSERT WITH CHECK (%s)', own);

  FOREACH t IN ARRAY owned_tables LOOP
    EXECUTE format('CREATE POLICY aipj_member_insert ON ai_prism.%I FOR INSERT WITH CHECK (user_email = NULLIF(current_setting(''app.user_email'', true), '''') AND ' || member_of_session || ')', t, t);
  END LOOP;

  EXECUTE 'ALTER TABLE ai_prism.projects ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE ai_prism.projects FORCE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE ai_prism.project_files ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE ai_prism.project_files FORCE ROW LEVEL SECURITY';
  -- see the header: bound for every role but the owner, whose definer function reads it
  EXECUTE 'ALTER TABLE ai_prism.project_members ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE ai_prism.project_members NO FORCE ROW LEVEL SECURITY';
END
$up$;

DROP FUNCTION IF EXISTS ai_prism.aip_my_project_ids();
