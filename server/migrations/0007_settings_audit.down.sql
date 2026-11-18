-- 0007_settings_audit (rollback): drops the maintenance policies of the sweep
-- (app.maintenance), their functions, and the app_settings / admin_audit
-- tables. DATA LOSS: the org settings (retention, org instructions) and the
-- whole admin audit trail go with the tables; export admin_audit first if it
-- must be kept. Needs the table owner. Idempotent.
DO $down$
DECLARE
  t text;
  p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_sessions', 'chat_images', 'chat_messages', 'chat_decks', 'chat_spreadsheets', 'chat_documents'] LOOP
    IF to_regclass(format('ai_prism.%I', t)) IS NULL THEN
      CONTINUE;
    END IF;
    FOR p IN SELECT polname FROM pg_policy WHERE polrelid = format('ai_prism.%I', t)::regclass AND polname LIKE 'aipr\_%' LOOP
      EXECUTE format('DROP POLICY %I ON ai_prism.%I', p.polname, t);
    END LOOP;
  END LOOP;
END
$down$;

DROP TABLE IF EXISTS ai_prism.admin_audit;
DROP TABLE IF EXISTS ai_prism.app_settings;
DROP FUNCTION IF EXISTS ai_prism.aip_retention_cutoff();
DROP FUNCTION IF EXISTS ai_prism.aip_maintenance();
