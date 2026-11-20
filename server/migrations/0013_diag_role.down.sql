-- 0013_diag_role (rollback): drops what 0013 created (the two policies, the view, the
-- ai_prism_diag schema) and the role's column grant on chat_tool_calls. It never GRANTs
-- anything and never touches an ACL of an object 0013 did not create. The cluster role and its
-- operator memberships are KEPT (drop the role by hand with DROP ROLE once nothing uses it); after
-- this it holds nothing in this database. What up revoked from a pre-existing role inside
-- ai_prism is NOT restored (a tightening, by design). DROP SCHEMA is RESTRICT: anything else in
-- ai_prism_diag fails the rollback loudly. Needs the table owner. Idempotent.
DO $down$
DECLARE
  guc text := nullif(current_setting('ai_prism.diag_role', true), '');
  diag text := CASE WHEN guc ~ '^ai_prism_diag_test_[a-z0-9]+$' THEN guc ELSE 'ai_prism_diag' END;
BEGIN
  DROP POLICY IF EXISTS aipd_diag_guard ON ai_prism.chat_tool_calls;
  DROP POLICY IF EXISTS aipd_diag_read ON ai_prism.chat_tool_calls;
  DROP VIEW IF EXISTS ai_prism_diag.chat_tool_calls;
  DROP SCHEMA IF EXISTS ai_prism_diag;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = diag) THEN
    EXECUTE format('REVOKE SELECT (tool_name, status, duration_ms, created_at) ON ai_prism.chat_tool_calls FROM %I', diag);
  END IF;
END
$down$;
