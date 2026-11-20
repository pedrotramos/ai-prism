-- 0012_project_artifact_read (rollback): members no longer read the artifacts of
-- a shared chat; only their creator does. Drops the four aipj_member_read
-- policies. No data is touched. Idempotent.
DO $down$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_decks', 'chat_spreadsheets', 'chat_documents', 'chat_images'] LOOP
    IF to_regclass(format('ai_prism.%I', t)) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS aipj_member_read ON ai_prism.%I', t);
    END IF;
  END LOOP;
END
$down$;
