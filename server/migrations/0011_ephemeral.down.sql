-- 0011_ephemeral (rollback): removes chat_sessions.ephemeral and restores the
-- sweep policies of 0007. DATA LOSS: the flag goes; a temporary chat that is
-- still stored becomes an ordinary chat. The 'ephemeral.started' audit rows stay
-- (admin_audit is append-only; they hold a count and nothing else). Idempotent.
DO $down$
DECLARE
  t text;
BEGIN
  IF to_regclass('ai_prism.admin_audit') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS aipe_started_insert ON ai_prism.admin_audit';
  END IF;
  IF to_regclass('ai_prism.chat_sessions') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS aipe_session_guard ON ai_prism.chat_sessions';
    -- the 0007 policies, back as they were (only if 0007 is still applied)
    IF to_regprocedure('ai_prism.aip_retention_cutoff()') IS NOT NULL THEN
      EXECUTE 'DROP POLICY IF EXISTS aipr_maint_read ON ai_prism.chat_sessions';
      EXECUTE 'DROP POLICY IF EXISTS aipr_maint_delete ON ai_prism.chat_sessions';
      EXECUTE 'CREATE POLICY aipr_maint_read ON ai_prism.chat_sessions FOR SELECT '
        'USING (ai_prism.aip_maintenance() AND updated_at < ai_prism.aip_retention_cutoff())';
      EXECUTE 'CREATE POLICY aipr_maint_delete ON ai_prism.chat_sessions FOR DELETE '
        'USING (ai_prism.aip_maintenance() AND updated_at < ai_prism.aip_retention_cutoff())';
      FOREACH t IN ARRAY ARRAY['chat_images', 'chat_messages', 'chat_decks', 'chat_spreadsheets', 'chat_documents'] LOOP
        IF to_regclass(format('ai_prism.%I', t)) IS NOT NULL THEN
          EXECUTE format('DROP POLICY IF EXISTS aipr_maint_read ON ai_prism.%I', t);
          EXECUTE format('CREATE POLICY aipr_maint_read ON ai_prism.%I FOR SELECT '
            'USING (ai_prism.aip_maintenance() AND EXISTS (SELECT 1 FROM ai_prism.chat_sessions s '
            'WHERE s.id = %I.session_id AND s.updated_at < ai_prism.aip_retention_cutoff()))', t, t);
        END IF;
      END LOOP;
    END IF;
  END IF;
END
$down$;

DROP INDEX IF EXISTS ai_prism.idx_chat_sessions_ephemeral;
ALTER TABLE IF EXISTS ai_prism.chat_sessions DROP COLUMN IF EXISTS ephemeral;
DROP FUNCTION IF EXISTS ai_prism.aipe_session_guard();
DROP FUNCTION IF EXISTS ai_prism.aip_session_swept(timestamptz, boolean);
