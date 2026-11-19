-- 0006_user_memories (rollback): drops user_memories and user_memory_state
-- with their policies and indexes. DATA LOSS: every user's saved and learned memories go with the
-- table; there is nothing to export them to. Needs the table owner. Idempotent.
DROP TABLE IF EXISTS ai_prism.user_memories;
DROP TABLE IF EXISTS ai_prism.user_memory_state;
