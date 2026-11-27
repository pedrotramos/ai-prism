-- 0017_agent_versions (rollback): drops agent_shares and agent_versions with their trigger, policies and indexes.
-- DATA LOSS: every saved version, its sharing approval and every share go with the tables; the agents themselves (0015) keep
-- their current definition and their scheduling approval. The documented rollback of a release is "redeploy the previous
-- release and keep the schema" (the previous code ignores these tables); this file is for a database that must go back to
-- 0016. Needs the table owner. Idempotent.
-- the recipients' read policy names agent_shares, so it goes first
DROP POLICY IF EXISTS aiav_shared_read ON ai_prism.agent_versions;
DROP TABLE IF EXISTS ai_prism.agent_shares;
DROP FUNCTION IF EXISTS ai_prism.aip_agent_shares_guard();
DROP TABLE IF EXISTS ai_prism.agent_versions;
DROP FUNCTION IF EXISTS ai_prism.aip_agent_versions_guard();
