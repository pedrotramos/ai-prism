-- 0012_project_artifact_read: members read the artifacts of a shared chat (N1b, W2-3 gap G2).
--
-- Why: chat_decks, chat_spreadsheets, chat_documents and chat_images carry only
-- the owner policy (aip_owner: user_email = me) and 0005's aipj_member_insert.
-- In a project chat, the artifacts another member generated were invisible to
-- every other member (broken cards).
--
-- What: one FOR SELECT policy, aipj_member_read, per table: the row's session is
-- a project chat the caller is a member of, using the SET form of 0008
-- (`x = ANY ((SELECT ai_prism.aip_my_project_ids())::bigint[])`, an InitPlan
-- computed once per statement, never a per-row definer call). Writes stay
-- owner-only (aip_owner is the only UPDATE / DELETE policy): the app answers a
-- member's edit with 403 artifact_read_only, and the database refuses it too.
-- No implicit access: an app admin who is not a member reads nothing, and a
-- member who leaves loses the rows at once (membership is read live).
--
-- 0005 and 0008 drop and recreate every `aipj_*` policy when re-run; run them
-- before this file (the runner does; the tests re-apply it after them).
-- DDL only (after 0003 a migration never touches rows); idempotent.
DO $up$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_decks', 'chat_spreadsheets', 'chat_documents', 'chat_images'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS aipj_member_read ON ai_prism.%I', t);
    EXECUTE format(
      'CREATE POLICY aipj_member_read ON ai_prism.%I FOR SELECT USING (EXISTS (SELECT 1 FROM ai_prism.chat_sessions s '
      'WHERE s.id = %I.session_id AND s.project_id IS NOT NULL '
      'AND s.project_id = ANY ((SELECT ai_prism.aip_my_project_ids())::bigint[])))', t, t);
  END LOOP;
END
$up$;
