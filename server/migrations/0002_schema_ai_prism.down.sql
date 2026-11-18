-- 0002_schema_ai_prism (rollback): every app table, with its sequences,
-- indexes and rows, goes back to `public`, and the emptied `ai_prism` schema is
-- dropped. Ownership stays with whoever owns the tables now (the owner role
-- after a hand-off): the release before W1-5 works with that, its SP keeps the
-- DML grants it was given. DROP SCHEMA is RESTRICT on purpose: anything else
-- left inside ai_prism stops the rollback instead of being deleted.
DO $down$
DECLARE
  app_tables text[] := ARRAY['app_admins', 'app_mcp_catalog', 'app_tool_policy', 'chat_compactions', 'chat_decks',
    'chat_documents', 'chat_genie_conversations', 'chat_images', 'chat_message_embeddings', 'chat_messages',
    'chat_sessions', 'chat_spreadsheets', 'chat_tool_calls', 'deck_templates', 'model_catalog_overrides',
    'schema_migrations', 'skills', 'usage_ledger', 'user_image_model_selection', 'user_mcp_connections',
    'user_template_selection'];
  t text;
  stuck text;
BEGIN
  IF to_regnamespace('ai_prism') IS NULL THEN
    RETURN;
  END IF;
  SELECT string_agg(format('%s (owner %s)', c.relname, pg_get_userbyid(c.relowner)), ', ' ORDER BY c.relname) INTO stuck
    FROM pg_class c
   WHERE c.relkind IN ('r', 'p') AND c.relnamespace = to_regnamespace('ai_prism') AND c.relname = ANY (app_tables)
     AND NOT pg_has_role(current_user, c.relowner, 'USAGE');
  IF stuck IS NOT NULL THEN
    RAISE EXCEPTION 'ai_prism schema: % cannot move % back to public', current_user, stuck
      USING ERRCODE = 'AIP02', HINT = 'run the rollback as the table owner (a member of the owner role)';
  END IF;
  FOREACH t IN ARRAY app_tables LOOP
    IF to_regclass(format('ai_prism.%I', t)) IS NOT NULL THEN
      IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
        RAISE EXCEPTION 'ai_prism schema: % exists in both public and ai_prism; resolve it by hand', t USING ERRCODE = 'AIP03';
      END IF;
      EXECUTE format('ALTER TABLE ai_prism.%I SET SCHEMA public', t);
    END IF;
  END LOOP;
  DROP SCHEMA ai_prism;
  SET LOCAL search_path TO public;
END
$down$;
