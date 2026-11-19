-- 0005_projects: projects shared by their members (W2-3, design D4).
--
-- projects          name, description, instructions; created_by = the creator,
--                   who becomes its first owner (trigger below)
-- project_members   (project, kind 'user' | 'group', principal, role). A user is
--                   an e-mail, a group a workspace (SCIM) group display name;
--                   both lowercased. Roles: owner > manage > view.
-- project_files     a project's sources: the extracted TEXT of an uploaded file
--                   (no bytes and no storage path: nothing to traverse)
-- chat_sessions.project_id   a chat inside a project (NULL = personal chat).
--                   Deleting a project deletes its chats (ON DELETE CASCADE).
--
-- Who is a member: ai_prism.aip_project_rank(project) = 3 owner, 2 manage,
-- 1 view, NULL for everybody else. It matches the transaction's identity, set by
-- server/db/pool.js withTx: app.user_email (a user row) or app.user_groups (a
-- JSON array of the caller's SCIM group names, resolved by server/access.js; on
-- any SCIM error the list is empty, so a group grants nothing: fail closed). No
-- identity ('' or unset) never matches, whatever groups are set. The admin flag
-- (app.is_admin) is NOT read anywhere here: app admins get no implicit access.
--
-- D4 on chats: a chat in a project is governed ONLY by the current project role.
--   - aipj_project_gate (RESTRICTIVE, so it ANDs with 0003's aip_owner): a chat
--     with a project_id is visible/writable only to members of that project.
--     Its creator keeps nothing after leaving. The retention sweep's
--     maintenance identity (0007) still sees it (expired chats are deleted).
--   - aipj_member_*: members read and post (viewers included): the session, its
--     messages, tool calls, compactions, Genie conversations, embeddings; a
--     member's own ledger / artifact rows may point at the shared chat.
--   Every session-family policy of 0003 checks the session through a subquery
--   on chat_sessions, which this gate filters too, so the gate reaches them all.
--   - trigger aipj_session_guard: user_email never changes; moving a chat OUT of
--     a project (or to another one) needs manage on the project it leaves.
--     Moving one IN needs the gate (member of the target) and, for a personal
--     chat, 0003's aip_owner (only its creator sees it).
--
-- Why project_members is ENABLE without FORCE: a policy on project_members that
-- reads project_members (to show members the whole roster) recurses. So the
-- membership lookup is a SECURITY DEFINER function owned by the table owner,
-- which the owner reads without policies; every other identity, the app role
-- included, is bound by the policies below. projects and project_files are
-- FORCE like every other app table. The function pins its search_path.
--
-- Prefix aipj_: 0003 re-creates 'aip\_%' policies and 0007 drops 'aipr\_%' ones
-- on chat_sessions, so neither touches these when re-run. Idempotent (IF NOT
-- EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS + CREATE). After 0003 a
-- migration is DDL only.

CREATE TABLE IF NOT EXISTS ai_prism.projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  instructions TEXT NOT NULL DEFAULT '' CHECK (length(instructions) <= 20000),
  created_by TEXT NOT NULL CHECK (created_by <> '' AND created_by = lower(created_by)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_prism.project_members (
  project_id BIGINT NOT NULL REFERENCES ai_prism.projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'group')),
  principal TEXT NOT NULL CHECK (principal <> '' AND principal = lower(principal) AND length(principal) <= 256),
  role TEXT NOT NULL CHECK (role IN ('owner', 'manage', 'view')),
  added_by TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, kind, principal)
);
CREATE INDEX IF NOT EXISTS idx_project_members_principal ON ai_prism.project_members (kind, principal);

CREATE TABLE IF NOT EXISTS ai_prism.project_files (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES ai_prism.projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name <> '' AND length(name) <= 255 AND strpos(name, '/') = 0 AND strpos(name, E'\\') = 0),
  mime TEXT,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  content_text TEXT NOT NULL,
  uploaded_by TEXT NOT NULL CHECK (uploaded_by <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_files_project ON ai_prism.project_files (project_id, id);

ALTER TABLE ai_prism.chat_sessions ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES ai_prism.projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_project ON ai_prism.chat_sessions (project_id, updated_at DESC) WHERE project_id IS NOT NULL;

-- the caller's SCIM groups (lowercased); '' / unset / anything but a JSON array of strings = none
CREATE OR REPLACE FUNCTION ai_prism.aip_my_groups() RETURNS text[]
  LANGUAGE plpgsql STABLE
  SET search_path = ai_prism, pg_temp
  AS $fn$
DECLARE
  raw text := NULLIF(current_setting('app.user_groups', true), '');
  doc jsonb;
  out text[];
BEGIN
  IF raw IS NULL THEN
    RETURN '{}';
  END IF;
  BEGIN
    doc := raw::jsonb;
  EXCEPTION WHEN others THEN
    RETURN '{}';
  END;
  IF jsonb_typeof(doc) <> 'array' THEN
    RETURN '{}';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(doc) e WHERE jsonb_typeof(e) <> 'string') THEN
    RETURN '{}';
  END IF;
  SELECT coalesce(array_agg(lower(x)), '{}') INTO out FROM jsonb_array_elements_text(doc) x WHERE x <> '';
  RETURN out;
END
$fn$;

-- 3 owner, 2 manage, 1 view, NULL = not a member (no identity: always NULL)
CREATE OR REPLACE FUNCTION ai_prism.aip_project_rank(pid bigint) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ai_prism, pg_temp
  AS $fn$
    SELECT max(CASE m.role WHEN 'owner' THEN 3 WHEN 'manage' THEN 2 WHEN 'view' THEN 1 END)
      FROM ai_prism.project_members m,
           (SELECT lower(NULLIF(current_setting('app.user_email', true), '')) AS me) i
     WHERE m.project_id = pid
       AND i.me IS NOT NULL
       AND ((m.kind = 'user' AND m.principal = i.me)
         OR (m.kind = 'group' AND m.principal = ANY (ai_prism.aip_my_groups())))
  $fn$;

-- the creator of a project is its first owner (the app role cannot insert that
-- row itself before it is a member; the definer can)
CREATE OR REPLACE FUNCTION ai_prism.aipj_project_owner_row() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = ai_prism, pg_temp
  AS $fn$
BEGIN
  INSERT INTO ai_prism.project_members (project_id, kind, principal, role, added_by)
  VALUES (NEW.id, 'user', NEW.created_by, 'owner', NEW.created_by)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION ai_prism.aipj_session_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ai_prism, pg_temp
  AS $fn$
BEGIN
  IF NEW.user_email IS DISTINCT FROM OLD.user_email THEN
    RAISE EXCEPTION 'chat_sessions.user_email cannot change' USING ERRCODE = '42501';
  END IF;
  IF OLD.project_id IS NOT NULL AND NEW.project_id IS DISTINCT FROM OLD.project_id
     AND coalesce(ai_prism.aip_project_rank(OLD.project_id), 0) < 2 THEN
    RAISE EXCEPTION 'moving a chat out of a project needs the manage role on it' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS aipj_project_owner_row ON ai_prism.projects;
CREATE TRIGGER aipj_project_owner_row AFTER INSERT ON ai_prism.projects
  FOR EACH ROW EXECUTE FUNCTION ai_prism.aipj_project_owner_row();
DROP TRIGGER IF EXISTS aipj_session_guard ON ai_prism.chat_sessions;
CREATE TRIGGER aipj_session_guard BEFORE UPDATE ON ai_prism.chat_sessions
  FOR EACH ROW EXECUTE FUNCTION ai_prism.aipj_session_guard();

DO $up$
DECLARE
  me constant text := 'lower(NULLIF(current_setting(''app.user_email'', true), ''''))';
  maint constant text := '(NULLIF(current_setting(''app.user_email'', true), '''') IS NULL '
    'AND coalesce(current_setting(''app.maintenance'', true), '''') = ''on'')';
  -- the session behind a row is a project chat the caller is a member of
  member_of_session constant text := 'EXISTS (SELECT 1 FROM ai_prism.chat_sessions s WHERE s.id = %I.session_id '
    'AND s.project_id IS NOT NULL AND ai_prism.aip_project_rank(s.project_id) IS NOT NULL)';
  session_tables text[] := ARRAY['chat_messages', 'chat_genie_conversations', 'chat_compactions', 'chat_message_embeddings'];
  -- per-user rows that may point at a shared chat: the caller's own row, in a chat she is a member of
  owned_tables text[] := ARRAY['usage_ledger', 'chat_decks', 'chat_spreadsheets', 'chat_documents', 'chat_images'];
  p record;
  t text;
  own text;
BEGIN
  FOR p IN SELECT polname, polrelid::regclass::text AS t FROM pg_policy
            WHERE polname LIKE 'aipj\_%'
              AND polrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'ai_prism'::regnamespace) LOOP
    EXECUTE format('DROP POLICY %I ON %s', p.polname, p.t);
  END LOOP;

  -- projects: members read; the caller creates as herself; manage+ edits; the owner deletes
  EXECUTE 'CREATE POLICY aipj_read ON ai_prism.projects FOR SELECT USING (ai_prism.aip_project_rank(id) IS NOT NULL)';
  EXECUTE format('CREATE POLICY aipj_insert ON ai_prism.projects FOR INSERT WITH CHECK (created_by = %s)', me);
  EXECUTE 'CREATE POLICY aipj_update ON ai_prism.projects FOR UPDATE '
    'USING (ai_prism.aip_project_rank(id) >= 2) WITH CHECK (ai_prism.aip_project_rank(id) >= 2)';
  EXECUTE 'CREATE POLICY aipj_delete ON ai_prism.projects FOR DELETE USING (ai_prism.aip_project_rank(id) = 3)';

  -- project_members: members see the roster; manage+ writes non-owner rows; only an
  -- owner writes owner rows; anyone may remove her own row (leave)
  own := '(ai_prism.aip_project_rank(project_id) >= 2 AND (role <> ''owner'' OR ai_prism.aip_project_rank(project_id) = 3))';
  EXECUTE 'CREATE POLICY aipj_read ON ai_prism.project_members FOR SELECT USING (ai_prism.aip_project_rank(project_id) IS NOT NULL)';
  EXECUTE format('CREATE POLICY aipj_insert ON ai_prism.project_members FOR INSERT WITH CHECK %s', own);
  EXECUTE format('CREATE POLICY aipj_update ON ai_prism.project_members FOR UPDATE USING %s WITH CHECK %s', own, own);
  EXECUTE format('CREATE POLICY aipj_delete ON ai_prism.project_members FOR DELETE USING (%s OR (kind = ''user'' AND principal = %s))', own, me);

  -- project_files: members read; manage+ uploads (as herself) and deletes; no update
  EXECUTE 'CREATE POLICY aipj_read ON ai_prism.project_files FOR SELECT USING (ai_prism.aip_project_rank(project_id) IS NOT NULL)';
  EXECUTE format('CREATE POLICY aipj_insert ON ai_prism.project_files FOR INSERT '
    'WITH CHECK (ai_prism.aip_project_rank(project_id) >= 2 AND uploaded_by = %s)', me);
  EXECUTE 'CREATE POLICY aipj_delete ON ai_prism.project_files FOR DELETE USING (ai_prism.aip_project_rank(project_id) >= 2)';

  -- chat_sessions: the gate (restrictive) and the members' read / write
  EXECUTE format('CREATE POLICY aipj_project_gate ON ai_prism.chat_sessions AS RESTRICTIVE FOR ALL '
    'USING (project_id IS NULL OR ai_prism.aip_project_rank(project_id) IS NOT NULL OR %s) '
    'WITH CHECK (project_id IS NULL OR ai_prism.aip_project_rank(project_id) IS NOT NULL)', maint);
  EXECUTE 'CREATE POLICY aipj_member_read ON ai_prism.chat_sessions FOR SELECT '
    'USING (project_id IS NOT NULL AND ai_prism.aip_project_rank(project_id) IS NOT NULL)';
  -- the new row may leave the project (project_id NULL): the guard trigger then
  -- requires manage on the project it leaves, and it stays its creator's chat
  EXECUTE 'CREATE POLICY aipj_member_update ON ai_prism.chat_sessions FOR UPDATE '
    'USING (project_id IS NOT NULL AND ai_prism.aip_project_rank(project_id) IS NOT NULL) '
    'WITH CHECK (project_id IS NULL OR ai_prism.aip_project_rank(project_id) IS NOT NULL)';

  FOREACH t IN ARRAY session_tables LOOP
    EXECUTE format('CREATE POLICY aipj_member_read ON ai_prism.%I FOR SELECT USING (' || member_of_session || ')', t, t);
    EXECUTE format('CREATE POLICY aipj_member_insert ON ai_prism.%I FOR INSERT WITH CHECK (' || member_of_session || ')', t, t);
    EXECUTE format('CREATE POLICY aipj_member_update ON ai_prism.%I FOR UPDATE USING (' || member_of_session || ') '
      'WITH CHECK (' || member_of_session || ')', t, t, t);
  END LOOP;

  -- chat_tool_calls hang off a message
  own := 'EXISTS (SELECT 1 FROM ai_prism.chat_messages m JOIN ai_prism.chat_sessions s ON s.id = m.session_id '
    'WHERE m.id = chat_tool_calls.message_id AND s.project_id IS NOT NULL AND ai_prism.aip_project_rank(s.project_id) IS NOT NULL)';
  EXECUTE format('CREATE POLICY aipj_member_read ON ai_prism.chat_tool_calls FOR SELECT USING (%s)', own);
  EXECUTE format('CREATE POLICY aipj_member_insert ON ai_prism.chat_tool_calls FOR INSERT WITH CHECK (%s)', own);

  FOREACH t IN ARRAY owned_tables LOOP
    EXECUTE format('CREATE POLICY aipj_member_insert ON ai_prism.%I FOR INSERT WITH CHECK (user_email = NULLIF(current_setting(''app.user_email'', true), '''') AND ' || member_of_session || ')', t, t);
  END LOOP;

  EXECUTE 'ALTER TABLE ai_prism.projects ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE ai_prism.projects FORCE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE ai_prism.project_files ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE ai_prism.project_files FORCE ROW LEVEL SECURITY';
  -- see the header: bound for every role but the owner, whose definer function reads it
  EXECUTE 'ALTER TABLE ai_prism.project_members ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE ai_prism.project_members NO FORCE ROW LEVEL SECURITY';
END
$up$;
