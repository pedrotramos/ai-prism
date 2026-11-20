-- 0011_ephemeral: temporary (ephemeral) chats (W3-6).
--
-- chat_sessions.ephemeral  true = a temporary chat: no embeddings, no memory
--                extraction, not searchable, deleted when the user leaves it
--                (the client calls DELETE) and, as the safety net, by the
--                sweep once it has been idle for 24 hours. Set only when the
--                row is created: trigger aipe_session_guard refuses a change
--                of the flag, and an ephemeral chat can never be in a project
--                (the route answers 400; the trigger is the backstop).
--
-- The sweep (server/retention.js) gets one more rule through
-- the SAME policies of 0007 (aipr_maint_read / aipr_maint_delete on
-- chat_sessions and the aipr_maint_read of its content tables): they now match
-- a session that is expired under the retention setting OR an ephemeral one
-- idle for 24 h (aip_session_swept). No policy is added or dropped there.
--
-- Audit, count only: a temporary chat started inserts ONE admin_audit row
-- (action 'ephemeral.started', actor 'system', no target, empty details) in the
-- transaction that creates the session, through aipe_started_insert. The row
-- carries no session id, title, user or content; admins read the COUNT through
-- GET /api/admin/ephemeral-chats. Policy prefix aipe_ (0003 re-creates 'aip\_%'
-- and 0007 drops 'aipr\_%' policies, so neither touches this one).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS +
-- CREATE. DDL only.

ALTER TABLE ai_prism.chat_sessions ADD COLUMN IF NOT EXISTS ephemeral BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_ephemeral ON ai_prism.chat_sessions (updated_at) WHERE ephemeral;

CREATE OR REPLACE FUNCTION ai_prism.aipe_session_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ai_prism, pg_temp
  AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.ephemeral IS DISTINCT FROM OLD.ephemeral THEN
    RAISE EXCEPTION 'chat_sessions.ephemeral cannot change' USING ERRCODE = '42501';
  END IF;
  IF NEW.ephemeral AND NEW.project_id IS NOT NULL THEN
    RAISE EXCEPTION 'a temporary chat cannot belong to a project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS aipe_session_guard ON ai_prism.chat_sessions;
CREATE TRIGGER aipe_session_guard BEFORE INSERT OR UPDATE ON ai_prism.chat_sessions
  FOR EACH ROW EXECUTE FUNCTION ai_prism.aipe_session_guard();

-- a session the sweep may see and delete: expired under the retention setting,
-- or ephemeral and idle for 24 hours (the floor; the sweep may ask for more).
-- No coalesce() around the comparison: a bare `updated_at < ...` stays an index
-- condition when the planner inlines this into the OR of the row policy, which
-- server/rls.test.js (EXPLAIN) holds to idx_chat_sessions_user.
CREATE OR REPLACE FUNCTION ai_prism.aip_session_swept(upd timestamptz, eph boolean) RETURNS boolean
  LANGUAGE sql STABLE
  AS $fn$
    SELECT upd < ai_prism.aip_retention_cutoff() OR (eph AND upd < now() - interval '24 hours')
  $fn$;

DO $up$
DECLARE
  t text;
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS aipr_maint_read ON ai_prism.chat_sessions';
  EXECUTE 'DROP POLICY IF EXISTS aipr_maint_delete ON ai_prism.chat_sessions';
  EXECUTE 'CREATE POLICY aipr_maint_read ON ai_prism.chat_sessions FOR SELECT '
    'USING (ai_prism.aip_maintenance() AND ai_prism.aip_session_swept(updated_at, ephemeral))';
  EXECUTE 'CREATE POLICY aipr_maint_delete ON ai_prism.chat_sessions FOR DELETE '
    'USING (ai_prism.aip_maintenance() AND ai_prism.aip_session_swept(updated_at, ephemeral))';
  FOREACH t IN ARRAY ARRAY['chat_images', 'chat_messages', 'chat_decks', 'chat_spreadsheets', 'chat_documents'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS aipr_maint_read ON ai_prism.%I', t);
    EXECUTE format('CREATE POLICY aipr_maint_read ON ai_prism.%I FOR SELECT '
      'USING (ai_prism.aip_maintenance() AND EXISTS (SELECT 1 FROM ai_prism.chat_sessions s '
      'WHERE s.id = %I.session_id AND ai_prism.aip_session_swept(s.updated_at, s.ephemeral)))', t, t);
  END LOOP;

  EXECUTE 'DROP POLICY IF EXISTS aipe_started_insert ON ai_prism.admin_audit';
  EXECUTE 'CREATE POLICY aipe_started_insert ON ai_prism.admin_audit FOR INSERT '
    'WITH CHECK (NULLIF(current_setting(''app.user_email'', true), '''') IS NOT NULL '
    'AND actor_hash = ''system'' AND action = ''ephemeral.started'' AND target IS NULL AND details = ''{}''::jsonb)';
END
$up$;
