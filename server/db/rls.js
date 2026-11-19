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
//   settings (0007) app_settings: read all; write with the admin flag, except the
//            retention sweep's own stamp (maintenance identity, server/retention.js)
//   audit    (0007) admin_audit: read and insert with the admin flag (the sweep
//            inserts its own 'system' rows); no update/delete policy (append-only)
// 0007 also adds the sweep's aipr_* policies on chat_sessions / chat_images.
// memory   (0006) user_memories, user_memory_state: direct (own rows; a memory's
//          session must be the caller's)
//
// schema_migrations has no RLS (no user data; the app role can only SELECT it).
// Kept equal to the lists in 0003_rls.{up,down}.sql (and 0007 for the tables it
// creates) and to APP_TABLES (server/db/grants.js) by server/rls.test.js.

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

// created with their policies by 0007_settings_audit (not in 0003, not in 0002's APP_TABLES)
export const RLS_SETTINGS_TABLES = Object.freeze(['app_settings'])
export const RLS_AUDIT_TABLES = Object.freeze(['admin_audit'])
export const RLS_0007_TABLES = Object.freeze([...RLS_SETTINGS_TABLES, ...RLS_AUDIT_TABLES])

// created with its policy by 0006_user_memories (direct family: own rows only)
export const RLS_0006_TABLES = Object.freeze(['user_memories', 'user_memory_state'])

export const RLS_TABLES = Object.freeze([...RLS_PER_USER_TABLES, ...RLS_MIXED_TABLES, ...RLS_GLOBAL_ADMIN_TABLES, ...RLS_0006_TABLES, ...RLS_0007_TABLES])
