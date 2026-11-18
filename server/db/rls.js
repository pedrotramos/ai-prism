// Row-level security (W2-1, migration 0003): which app table gets which policy.
//
// The app connects as ONE Postgres role for every user (the app's service
// principal: not the table owner, no BYPASSRLS). Every app table has ENABLE +
// FORCE ROW LEVEL SECURITY, and withTx (server/db/pool.js) sets, per
// transaction, app.user_email (the signed-in user) and app.is_admin ('on' only
// for a write an admin route asked for). No setting = no rows.
//
//   direct   user_email = app.user_email                        (read and write; a
//            write that references a session also needs that session to be the caller's)
//   session  the row's chat_sessions row is the caller's        (EXISTS … chat_sessions)
//   message  the row's chat_messages row is in a caller session (EXISTS … messages ⋈ sessions)
//   mixed    read own OR scope = 'global'; write own (scope 'user') OR (scope 'global' AND admin)
//   global   read all; write only with app.is_admin = 'on'
//
// schema_migrations has no RLS (no user data; the app role can only SELECT it).
// Kept equal to the lists in 0003_rls.{up,down}.sql and to APP_TABLES
// (server/db/grants.js) by server/rls.test.js.

export const RLS_DIRECT_TABLES = Object.freeze([
  'chat_sessions',
  'chat_decks',
  'chat_spreadsheets',
  'chat_documents',
  'chat_images',
  'usage_ledger',
  'user_mcp_connections',
  'user_template_selection',
  'user_image_model_selection',
])

export const RLS_SESSION_TABLES = Object.freeze([
  'chat_messages',
  'chat_genie_conversations',
  'chat_compactions',
  'chat_message_embeddings',
])

export const RLS_MESSAGE_TABLES = Object.freeze(['chat_tool_calls'])

export const RLS_PER_USER_TABLES = Object.freeze([...RLS_DIRECT_TABLES, ...RLS_SESSION_TABLES, ...RLS_MESSAGE_TABLES])

export const RLS_MIXED_TABLES = Object.freeze(['deck_templates', 'skills'])

export const RLS_GLOBAL_ADMIN_TABLES = Object.freeze(['app_admins', 'app_mcp_catalog', 'app_tool_policy', 'model_catalog_overrides'])

export const RLS_TABLES = Object.freeze([...RLS_PER_USER_TABLES, ...RLS_MIXED_TABLES, ...RLS_GLOBAL_ADMIN_TABLES])
