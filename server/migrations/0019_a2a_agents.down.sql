-- 0019_a2a_agents (rollback): drops a2a_agents and a2a_oauth_tokens with their policies and indexes, and
-- chat_tool_calls.auth with its CHECK. DATA LOSS: the admin's agent catalog and every user's stored (sealed) OAuth
-- tokens go with the tables, so each user connects again after a re-apply; a chat keeps its tool calls and their
-- plain results but loses the "Authorize" card. Needs the table owner. Idempotent.
DROP TABLE IF EXISTS ai_prism.a2a_agents;
DROP TABLE IF EXISTS ai_prism.a2a_oauth_tokens;
ALTER TABLE IF EXISTS ai_prism.chat_tool_calls DROP CONSTRAINT IF EXISTS chat_tool_calls_auth_shape;
ALTER TABLE IF EXISTS ai_prism.chat_tool_calls DROP COLUMN IF EXISTS auth;
