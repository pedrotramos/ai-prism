-- 0005_projects (rollback): drops every aipj_* policy, the triggers and
-- functions of 0005, chat_sessions.project_id and the project tables. DATA
-- LOSS: projects, their members and files go; the chats that were in a project
-- stay and become their creators' personal chats again (the column goes, the
-- rows stay). Needs the table owner. Idempotent.
DO $down$
DECLARE
  p record;
BEGIN
  FOR p IN SELECT polname, polrelid::regclass::text AS t FROM pg_policy
            WHERE polname LIKE 'aipj\_%'
              AND polrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'ai_prism'::regnamespace) LOOP
    EXECUTE format('DROP POLICY %I ON %s', p.polname, p.t);
  END LOOP;
  IF to_regclass('ai_prism.chat_sessions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS aipj_session_guard ON ai_prism.chat_sessions;
  END IF;
END
$down$;

DROP INDEX IF EXISTS ai_prism.idx_chat_sessions_project;
ALTER TABLE IF EXISTS ai_prism.chat_sessions DROP COLUMN IF EXISTS project_id;
DROP TABLE IF EXISTS ai_prism.project_files;
DROP TABLE IF EXISTS ai_prism.project_members;
DROP TABLE IF EXISTS ai_prism.projects;
DROP FUNCTION IF EXISTS ai_prism.aipj_session_guard();
DROP FUNCTION IF EXISTS ai_prism.aipj_project_owner_row();
DROP FUNCTION IF EXISTS ai_prism.aip_project_rank(bigint);
DROP FUNCTION IF EXISTS ai_prism.aip_my_groups();
