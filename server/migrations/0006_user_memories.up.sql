-- 0006_user_memories: editable cross-conversation memory (W2-4).
--
-- user_memories  one row per remembered fact of ONE user: content (1..500
--                chars), category, the per-entry sensitive opt-in, where it
--                came from ('user' = typed by the user, 'extracted' = learned
--                by server/memory.js after a turn) and, for an extracted row,
--                the conversation it came from (SET NULL when that conversation
--                is deleted: the memory is cross-conversation and outlives it).
--
-- Sensitive categories (health, politics, religion, personal_finance) are never
-- written by extraction (server/memory.js drops them); a user may store one and
-- it is injected into a prompt only while sensitive_opt_in is true on that row.
-- The CHECK keeps the flag false on every non-sensitive row, so moving an entry
-- between categories can never carry a stale consent.
--
-- RLS (the "direct" family of 0003): a row is visible and writable only when
-- user_email is the transaction's app.user_email (NULLIF '' → nobody); a row
-- that points at a session also needs that session to be VISIBLE to the caller
-- under chat_sessions' own RLS (the caller's chat, or a project chat she is a
-- member of, 0005): a member's memory may cite the shared chat it came from,
-- never a chat she cannot see.
-- Admins get nothing extra: memory is personal data, not org data.
--
-- user_memory_state  one row per user who ever used "forget everything":
--                forgot_at is stamped by that delete, in the same transaction,
--                under the row lock. A background extraction carries the time
--                its turn read the memory (the database clock), and its save
--                takes the same row lock and writes nothing when a forget
--                happened at or after that time (minus a small skew margin).
--                Durable, so a forget on one app instance also stops an
--                extraction pending on another.
--
-- The admin kill-switch is app_tool_policy key 'memory' (no row here).
--
-- Idempotent: CREATE ... IF NOT EXISTS, DROP POLICY IF EXISTS + CREATE,
-- ENABLE / FORCE are no-ops when already set. DDL only (after 0003, FORCE RLS
-- binds the owner, so a migration seeds no rows).

CREATE TABLE IF NOT EXISTS ai_prism.user_memories (
  id BIGSERIAL PRIMARY KEY,
  user_email TEXT NOT NULL,
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 500),
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('preference', 'profile', 'work', 'project', 'other', 'health', 'politics', 'religion', 'personal_finance')),
  sensitive_opt_in BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'extracted')),
  session_id BIGINT REFERENCES ai_prism.chat_sessions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_memories_opt_in_sensitive_only
    CHECK (NOT sensitive_opt_in OR category IN ('health', 'politics', 'religion', 'personal_finance'))
);

-- the listing and the injection read: newest first per user
CREATE INDEX IF NOT EXISTS idx_user_memories_user_updated ON ai_prism.user_memories (user_email, updated_at DESC);
-- one copy of a fact per user (case- and edge-space-insensitive): extraction
-- re-learning a known fact is a no-op (ON CONFLICT DO NOTHING), a typed
-- duplicate is a 409
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_memories_user_content ON ai_prism.user_memories (user_email, md5(lower(btrim(content))));

CREATE TABLE IF NOT EXISTS ai_prism.user_memory_state (
  user_email TEXT PRIMARY KEY,
  forgot_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $up$
DECLARE
  me constant text := 'NULLIF(current_setting(''app.user_email'', true), '''')';
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS aip_owner ON ai_prism.user_memories';
  EXECUTE format(
    'CREATE POLICY aip_owner ON ai_prism.user_memories FOR ALL USING (user_email = %s) '
    'WITH CHECK (user_email = %s AND (session_id IS NULL OR EXISTS (SELECT 1 FROM ai_prism.chat_sessions s '
    'WHERE s.id = user_memories.session_id)))',
    me, me
  );
  EXECUTE 'DROP POLICY IF EXISTS aip_owner ON ai_prism.user_memory_state';
  EXECUTE format('CREATE POLICY aip_owner ON ai_prism.user_memory_state FOR ALL USING (user_email = %s) WITH CHECK (user_email = %s)', me, me);
END
$up$;

ALTER TABLE ai_prism.user_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_prism.user_memories FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_prism.user_memory_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_prism.user_memory_state FORCE ROW LEVEL SECURITY;
