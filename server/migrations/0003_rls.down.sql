-- 0003_rls (rollback): every aip_* policy is dropped and row-level security is
-- switched off (NO FORCE, DISABLE) on the app tables, which leaves isolation to
-- the WHERE clauses of the queries, as before W2-1. Needs the table owner.
-- Idempotent.
DO $down$
DECLARE
  app_tables text[] := ARRAY['chat_sessions', 'chat_decks', 'chat_spreadsheets', 'chat_documents', 'chat_images',
    'usage_ledger', 'user_mcp_connections', 'user_template_selection', 'user_image_model_selection',
    'chat_messages', 'chat_genie_conversations', 'chat_compactions', 'chat_message_embeddings', 'chat_tool_calls',
    'deck_templates', 'skills', 'app_admins', 'app_mcp_catalog', 'app_tool_policy', 'model_catalog_overrides'];
  t text;
  p record;
BEGIN
  FOREACH t IN ARRAY app_tables LOOP
    IF to_regclass(format('ai_prism.%I', t)) IS NULL THEN
      CONTINUE;
    END IF;
    FOR p IN SELECT polname FROM pg_policy WHERE polrelid = format('ai_prism.%I', t)::regclass AND polname LIKE 'aip\_%' LOOP
      EXECUTE format('DROP POLICY %I ON ai_prism.%I', p.polname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE ai_prism.%I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE ai_prism.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$down$;
