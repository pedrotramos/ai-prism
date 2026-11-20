-- 0009_project_context (N1a, ADR-0013/0014): what a project chat needs to carry its
-- project into the turn, and to say who wrote each message.
--   project_files.context_tokens  conservative token count of the extracted text,
--                                 written at upload (NULL for older rows: counted lazily
--                                 on read, no data migration).
--   chat_messages.sent_by         the author of a row, stamped by the database from the
--                                 transaction identity (app.user_email) by a BEFORE INSERT
--                                 trigger, so every insert path is covered and a client
--                                 value is always overwritten. NULL for legacy rows and
--                                 for writes without an identity (maintenance).
-- DDL only. Needs the table owner. Idempotent.
ALTER TABLE ai_prism.project_files ADD COLUMN IF NOT EXISTS context_tokens INT;
DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_files_context_tokens_check' AND conrelid = 'ai_prism.project_files'::regclass) THEN
    ALTER TABLE ai_prism.project_files ADD CONSTRAINT project_files_context_tokens_check CHECK (context_tokens IS NULL OR context_tokens >= 0);
  END IF;
END
$c$;

ALTER TABLE ai_prism.chat_messages ADD COLUMN IF NOT EXISTS sent_by TEXT;

CREATE OR REPLACE FUNCTION ai_prism.aipj_message_sent_by() RETURNS trigger
LANGUAGE plpgsql SET search_path = ai_prism, pg_temp AS $f$
BEGIN
  NEW.sent_by := NULLIF(current_setting('app.user_email', true), '');
  RETURN NEW;
END
$f$;

DROP TRIGGER IF EXISTS aipj_message_sent_by ON ai_prism.chat_messages;
CREATE TRIGGER aipj_message_sent_by BEFORE INSERT ON ai_prism.chat_messages
  FOR EACH ROW EXECUTE FUNCTION ai_prism.aipj_message_sent_by();
