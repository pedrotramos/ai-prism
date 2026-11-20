-- 0009_project_context (rollback): drops the trigger, its function and both columns.
-- DATA LOSS: every stored sent_by (who wrote each message) and context_tokens (a cache of
-- a count that is recomputed on read) goes with the columns. Needs the table owner. Idempotent.
DROP TRIGGER IF EXISTS aipj_message_sent_by ON ai_prism.chat_messages;
DROP FUNCTION IF EXISTS ai_prism.aipj_message_sent_by();
ALTER TABLE ai_prism.chat_messages DROP COLUMN IF EXISTS sent_by;
ALTER TABLE ai_prism.project_files DROP CONSTRAINT IF EXISTS project_files_context_tokens_check;
ALTER TABLE ai_prism.project_files DROP COLUMN IF EXISTS context_tokens;
