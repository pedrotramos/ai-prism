-- 0015_agents (rollback): drops agents and agent_runs with their trigger, policies and indexes, the scheduler's
-- audit policy and the three agents settings keys. DATA LOSS: every saved agent, its approval and its run history
-- go with the tables; there is nothing to export them to. The documented rollback of a release is "redeploy the
-- previous release and keep the schema" (the previous code ignores these tables); this file is for a database
-- that must go back to 0014. Needs the table owner. Idempotent.
DROP POLICY IF EXISTS aiau_sched_insert ON ai_prism.admin_audit;
DROP TABLE IF EXISTS ai_prism.agent_runs;
DROP TABLE IF EXISTS ai_prism.agents;
DROP FUNCTION IF EXISTS ai_prism.aip_agents_guard();

-- The settings keys are rows, and after 0003 FORCE RLS binds the owner role the runner acts as: delete them under
-- the admin identity the policy asks for, inside this transaction only (set_config is transaction-local).
DO $down$
BEGIN
  IF to_regclass('ai_prism.app_settings') IS NOT NULL THEN
    PERFORM set_config('app.user_email', 'migration@ai-prism.invalid', true);
    PERFORM set_config('app.is_admin', 'on', true);
    DELETE FROM ai_prism.app_settings WHERE key IN ('agents_enabled', 'agents_max_run_cost_usd', 'agents_approval_days');
    PERFORM set_config('app.is_admin', 'off', true);
    PERFORM set_config('app.user_email', '', true);
  END IF;
END
$down$;
