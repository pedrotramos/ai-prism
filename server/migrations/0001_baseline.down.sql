-- 0001 baseline, rollback: drops every table the baseline creates.
--
-- DESTRUCTIVE: this deletes all chats, artifacts, templates, skills, the cost
-- ledger and the admin settings. It exists so a scratch or CI database can go
-- back to empty (`scripts/migrate.mjs down --to 0`) and the upgrade path can be
-- tested from zero; never run it on a database whose data you need.
--
-- Children before parents, and no CASCADE: an object this file does not know
-- about that depends on an app table makes the rollback fail instead of being
-- dropped silently. The sequences (BIGSERIAL) and indexes go with their tables.

DROP TABLE IF EXISTS chat_compactions;
DROP TABLE IF EXISTS chat_message_embeddings;
DROP TABLE IF EXISTS chat_tool_calls;
DROP TABLE IF EXISTS usage_ledger;
DROP TABLE IF EXISTS chat_images;
DROP TABLE IF EXISTS chat_documents;
DROP TABLE IF EXISTS chat_spreadsheets;
DROP TABLE IF EXISTS chat_decks;
DROP TABLE IF EXISTS chat_genie_conversations;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_sessions;
DROP TABLE IF EXISTS user_template_selection;
DROP TABLE IF EXISTS deck_templates;
DROP TABLE IF EXISTS app_admins;
DROP TABLE IF EXISTS model_catalog_overrides;
DROP TABLE IF EXISTS user_mcp_connections;
DROP TABLE IF EXISTS skills;
DROP TABLE IF EXISTS user_image_model_selection;
DROP TABLE IF EXISTS app_tool_policy;
DROP TABLE IF EXISTS app_mcp_catalog;

-- The baseline created the pgvector extension when it was missing. Drop it
-- only if nothing else uses it (RESTRICT) and this identity owns it; a shared
-- or platform-managed extension stays.
DO $$
BEGIN
  DROP EXTENSION IF EXISTS vector RESTRICT;
EXCEPTION
  WHEN dependent_objects_still_exist OR insufficient_privilege THEN
    RAISE NOTICE '0001 down: extension vector kept (%)', SQLERRM;
END $$;
