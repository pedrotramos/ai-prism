-- 0013_diag_role (rollback): removes the diagnostic role's policy and privileges on this
-- database and gives PUBLIC its EXECUTE on the SECURITY DEFINER helpers back (the state
-- before 0013). No data is touched. The role itself is a cluster object that may serve
-- other databases and operator memberships: it is KEPT (drop it by hand with DROP ROLE
-- once nothing else uses it). Needs the table owner. Idempotent.
DO $down$
DECLARE
  guc text := nullif(current_setting('ai_prism.diag_role', true), '');
  diag text := CASE WHEN guc ~ '^ai_prism_diag_test_[a-z0-9]+$' THEN guc ELSE 'ai_prism_diag' END;
  fn record;
BEGIN
  DROP POLICY IF EXISTS aipd_diag_read ON ai_prism.chat_tool_calls;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = diag) THEN
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ai_prism FROM %I', diag);
    EXECUTE format('REVOKE ALL ON SCHEMA ai_prism FROM %I', diag);
  END IF;
  FOR fn IN SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.pronamespace = 'ai_prism'::regnamespace AND p.prosecdef LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', fn.sig);
  END LOOP;
END
$down$;
