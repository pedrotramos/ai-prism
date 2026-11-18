-- 0002_schema_ai_prism: the app's tables leave `public` for a dedicated
-- `ai_prism` schema, so the app's service principal can be granted exactly the
-- app tables and nothing in `public` (least privilege; threat model G2).
--
-- Moves the 20 tables of 0001_baseline and schema_migrations itself.
-- ALTER TABLE … SET SCHEMA carries each table's indexes (the HNSW vector index
-- included), constraints, owned sequences (the BIGSERIAL ids), ACLs and rows;
-- foreign keys follow the tables by OID. pgvector stays in `public`: the app
-- connects with search_path `ai_prism, public` (server/db/pool.js).
--
-- Ownership. Moving a table needs its owner, and deployed databases have MIXED
-- ownership (the SP owns most tables, the deploying identity owns app_admins).
-- When the runner (server/db/migrate.js) can act as the owner role prepared by
-- the deploy (server/db/grants.js, "hand-off"), it says so through
-- ai_prism.use_owner_role = 'on' and runs this file as that role: the session
-- identity first hands ITS OWN app tables to the owner role, then the owner
-- role moves everything. Without the hand-off, a table this identity cannot
-- own stops the migration with SQLSTATE AIP02 before anything changed; the
-- runner logs it and the app keeps running on `public` (same search path).
--
-- Idempotent: tables already in ai_prism are skipped. Released files are
-- frozen (checksummed): put any change in a new migration.
DO $up$
DECLARE
  app_tables text[] := ARRAY['app_admins', 'app_mcp_catalog', 'app_tool_policy', 'chat_compactions', 'chat_decks',
    'chat_documents', 'chat_genie_conversations', 'chat_images', 'chat_message_embeddings', 'chat_messages',
    'chat_sessions', 'chat_spreadsheets', 'chat_tool_calls', 'deck_templates', 'model_catalog_overrides',
    'schema_migrations', 'skills', 'usage_ledger', 'user_image_model_selection', 'user_mcp_connections',
    'user_template_selection'];
  owner_role text := nullif(current_setting('ai_prism.owner_role', true), '');
  use_owner boolean := coalesce(current_setting('ai_prism.use_owner_role', true), 'off') = 'on' AND owner_role IS NOT NULL;
  rel record;
  t text;
  stuck text;
BEGIN
  IF use_owner THEN
    -- as the session identity: give the owner role the app tables it owns
    SET LOCAL ROLE NONE;
    FOR rel IN
      SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'ai_prism') AND c.relname = ANY (app_tables)
         AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = session_user)
    LOOP
      EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', rel.nspname, rel.relname, owner_role);
    END LOOP;
    EXECUTE format('SET LOCAL ROLE %I', owner_role);
  END IF;

  SELECT string_agg(format('%s (owner %s)', c.relname, pg_get_userbyid(c.relowner)), ', ' ORDER BY c.relname) INTO stuck
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public' AND c.relname = ANY (app_tables)
     AND NOT pg_has_role(current_user, c.relowner, 'USAGE');
  IF stuck IS NOT NULL THEN
    RAISE EXCEPTION 'ai_prism schema: ownership not normalized; % cannot move %', current_user, stuck
      USING ERRCODE = 'AIP02',
            HINT = 'run `node scripts/migrate.mjs prepare --role <app role>` (the deploy auto-config does it) as the database owner, then retry';
  END IF;

  CREATE SCHEMA IF NOT EXISTS ai_prism;
  FOREACH t IN ARRAY app_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      IF to_regclass(format('ai_prism.%I', t)) IS NOT NULL THEN
        RAISE EXCEPTION 'ai_prism schema: % exists in both public and ai_prism; resolve it by hand', t USING ERRCODE = 'AIP03';
      END IF;
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA ai_prism', t);
    END IF;
  END LOOP;

  -- the rest of this transaction (the runner's schema_migrations row) sees the moved table
  SET LOCAL search_path TO ai_prism, public;
END
$up$;
