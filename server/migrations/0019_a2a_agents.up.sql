-- 0019_a2a_agents: A2A 1.0 remote agents callable from chat as tools, with per-user OAuth.
--
-- a2a_agents          the ORG catalog of remote agents an admin registered: card URL, how a call authenticates
--                     (auth_strategy), the card summary the host served WITHOUT a credential and the outcome of the
--                     admin's configuration check. Everybody with an identity reads it (the chat offers the enabled
--                     agents as tools); only an admin (app.is_admin = 'on') writes it. It holds NO secret: a call always
--                     uses the signed-in user's own credential (their Databricks token, or their own OAuth login).
-- a2a_oauth_tokens    one row per (user, OAuth provider): the user's own tokens for an external identity provider,
--                     AES-256-GCM sealed by the app (A2A_TOKEN_ENC_KEY) with the row identity as AAD, so a ciphertext
--                     copied to another row does not open. Owner-only RLS (the "direct" family of 0003), no admin read:
--                     the admin gets nothing of another user's connection, not even the ciphertext.
-- chat_tool_calls.auth the descriptor of a tool call that stopped for the user's authorization (kind, id, name, provider,
--                     reason). It carries no token and no URL beyond the Databricks sign-in page of an MCP service;
--                     the chat renders the "Authorize" card from it and keeps it with the call when the chat is reopened.
--
-- strategies: 'databricks-obo' (the user's Databricks token, sent only to this workspace's hosts and Apps),
--             'oauth2-user' (authorization code + PKCE at an admin-configured provider, A2A_OAUTH_PROVIDERS),
--             'none' (no credential; only for a host the admin allowed in A2A_ALLOWED_HOSTS).
--
-- Policy names use the aip_ prefix of 0003 (aip_read / aip_admin_* / aip_owner), so a re-run of 0003's drop loop is the
-- only thing that touches them. Idempotent: CREATE ... IF NOT EXISTS, DROP POLICY IF EXISTS + CREATE, ENABLE / FORCE are
-- no-ops when already set. DDL only (after 0003 FORCE RLS binds the owner, so a migration seeds no rows).
-- Down: 0019_a2a_agents.down.sql.

CREATE TABLE IF NOT EXISTS ai_prism.a2a_agents (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9_]{0,39}$'),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  card_url TEXT NOT NULL CHECK (char_length(card_url) BETWEEN 1 AND 2000),
  app_name TEXT NOT NULL DEFAULT '' CHECK (char_length(app_name) <= 63),
  auth_strategy TEXT NOT NULL CHECK (auth_strategy IN ('databricks-obo', 'oauth2-user', 'none')),
  auth_provider TEXT CHECK (auth_provider IS NULL OR auth_provider ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  card JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(card) = 'object' AND pg_column_size(card) <= 65536),
  card_public BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  config_status TEXT NOT NULL DEFAULT 'unknown' CHECK (config_status IN ('ok', 'card_requires_auth', 'invalid_card', 'unavailable', 'unknown')),
  config_error TEXT CHECK (config_error IS NULL OR char_length(config_error) <= 500),
  config_checked_at TIMESTAMPTZ,
  added_by_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT a2a_agents_provider_matches_strategy CHECK ((auth_strategy = 'oauth2-user') = (auth_provider IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_agents_slug ON ai_prism.a2a_agents (slug);
CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_agents_card_url ON ai_prism.a2a_agents (card_url);

CREATE TABLE IF NOT EXISTS ai_prism.a2a_oauth_tokens (
  user_email TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (provider_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  id_token_enc TEXT,
  expires_at TIMESTAMPTZ,
  scope TEXT NOT NULL DEFAULT '' CHECK (char_length(scope) <= 2000),
  idp_email_verified BOOLEAN NOT NULL DEFAULT false,
  external_subject_hmac TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_email, provider_id)
);

ALTER TABLE ai_prism.chat_tool_calls ADD COLUMN IF NOT EXISTS auth JSONB;
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_prism.chat_tool_calls'::regclass AND conname = 'chat_tool_calls_auth_shape') THEN
    ALTER TABLE ai_prism.chat_tool_calls
      ADD CONSTRAINT chat_tool_calls_auth_shape CHECK (auth IS NULL OR (jsonb_typeof(auth) = 'object' AND pg_column_size(auth) <= 4096));
  END IF;
END
$mig$;

DO $up$
DECLARE
  me constant text := 'NULLIF(current_setting(''app.user_email'', true), '''')';
  is_admin constant text := '(coalesce(current_setting(''app.is_admin'', true), '''') = ''on'')';
BEGIN
  -- the catalog: any identity reads, only the admin flag writes (the "global" family of 0003)
  EXECUTE 'DROP POLICY IF EXISTS aip_read ON ai_prism.a2a_agents';
  EXECUTE 'DROP POLICY IF EXISTS aip_admin_insert ON ai_prism.a2a_agents';
  EXECUTE 'DROP POLICY IF EXISTS aip_admin_update ON ai_prism.a2a_agents';
  EXECUTE 'DROP POLICY IF EXISTS aip_admin_delete ON ai_prism.a2a_agents';
  EXECUTE format('CREATE POLICY aip_read ON ai_prism.a2a_agents FOR SELECT USING (%s IS NOT NULL)', me);
  EXECUTE format('CREATE POLICY aip_admin_insert ON ai_prism.a2a_agents FOR INSERT WITH CHECK (%s)', is_admin);
  EXECUTE format('CREATE POLICY aip_admin_update ON ai_prism.a2a_agents FOR UPDATE USING (%s) WITH CHECK (%s)', is_admin, is_admin);
  EXECUTE format('CREATE POLICY aip_admin_delete ON ai_prism.a2a_agents FOR DELETE USING (%s)', is_admin);
  -- the user's own tokens: owner only
  EXECUTE 'DROP POLICY IF EXISTS aip_owner ON ai_prism.a2a_oauth_tokens';
  EXECUTE format('CREATE POLICY aip_owner ON ai_prism.a2a_oauth_tokens FOR ALL USING (user_email = %s) WITH CHECK (user_email = %s)', me, me);
END
$up$;

ALTER TABLE ai_prism.a2a_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_prism.a2a_agents FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_prism.a2a_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_prism.a2a_oauth_tokens FORCE ROW LEVEL SECURITY;
