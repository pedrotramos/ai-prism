-- 0013_diag_role (rollback): removes the diagnostic role's policy and privileges
-- on this database. No data is touched. The role itself is a cluster object that
-- may serve other databases and operator memberships: it is KEPT (drop it by hand
-- with DROP ROLE once nothing else uses it). Needs the table owner. Idempotent.
DO $down$
DECLARE
  diag text := coalesce(nullif(current_setting('ai_prism.diag_role', true), ''), 'ai_prism_diag');
BEGIN
  DROP POLICY IF EXISTS aipd_diag_read ON ai_prism.chat_tool_calls;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = diag) THEN
    EXECUTE format('REVOKE ALL ON ai_prism.chat_tool_calls FROM %I', diag);
    EXECUTE format('REVOKE ALL ON SCHEMA ai_prism FROM %I', diag);
  END IF;
END
$down$;
