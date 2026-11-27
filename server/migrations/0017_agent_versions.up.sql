-- 0017_agent_versions: immutable agent versions, per-version sharing approval and the audiences a version is shared with.
--
-- agent_versions  one row per SAVE of an agent: the name, description and `definition` (jsonb) exactly as they were saved.
--                 The row never changes afterwards; only its approval columns do. `definition` is the payload a version
--                 carries (today the recipe of 0015; a later flow graph rides in the same column). version = the agent's
--                 `revision` at that save, so the two numbers never drift: the PATCH that bumps agents.revision inserts
--                 the version row in the same transaction. A legacy agent (saved before this migration) gets its row
--                 for the current revision the first time its owner opens the history (the app does it: after 0003 a
--                 migration never writes rows), so history starts at the version where this migration became live.
-- agent_shares    who a version is shared with: a user, a workspace group or the whole app, each pinned to ONE version
--                 (re-sharing a principal moves the pin). A share is inert until that version is approved.
--
-- What the database enforces (the trigger runs for every writer, so no route can forget it):
--   1. A version is immutable. Everything but status / approved_by_hash / approved_at / decision_reason is frozen: an UPDATE
--      that touches name, description, definition, origin, owner, number or creator raises, for every identity.
--   2. Versions are numbered in increasing order per agent (an insert at or below the highest number raises).
--   3. A new version starts as a draft (only a no-user admin identity, a seed or a support fix, may insert any state).
--   4. The approval columns follow the rules of 0015: the owner moves draft/rejected/revoked to pending; an admin moves
--      pending to approved or rejected and approved or pending to revoked. No one else changes them.
--   An approval is of what is stored, and what is stored cannot change: that is why an approval needs no expiry or hash
--   column here (the admin's expectedHash is still compared by the app, so the admin approves the bytes he saw).
--
-- The 0015 rules for SCHEDULING (agents.status, approved_snapshot, the guard trigger) are untouched: editing the head
-- still voids the agent's scheduling approval, and a run still uses approved_snapshot. This migration adds a second,
-- independent approval, of a version for SHARING, which is why sharing never lets anybody run the owner's agent: a
-- recipient reads the approved version and may copy it; running it is the owner's, under the owner's approval.
--
-- Row-level security (ENABLE + FORCE, the one-app-role model of 0003; prefixes aiav_ / aias_ keep 0003's 'aip\_%' loop away):
--   agent_versions  aiav_owner_select / _insert / _update (own rows; an insert only for her own agent), aiav_admin_read,
--                   aiav_admin_decide (admin flag + an identity), aiav_shared_read (an APPROVED version that a share row
--                   pins for the caller: by user, by group through aip_my_groups(), or the whole app for any identity)
--   agent_shares    aias_owner (ALL, own rows, of her own agent), aias_admin_read (the review screen shows the audience),
--                   aias_recipient_read (a row addressed to the caller: the subquery inside aiav_shared_read runs under
--                   the caller's own policies, so without this one no recipient could ever read a version)
-- No DELETE policy on agent_versions: history is removed only by the cascade of deleting its agent.
-- The scheduler identity of 0015 (no user) matches none of these policies: it reads no version and no share.
--
-- DDL only (after 0003 a migration never writes rows). Idempotent: CREATE ... IF NOT EXISTS, DROP POLICY IF EXISTS +
-- CREATE, CREATE OR REPLACE, DROP TRIGGER IF EXISTS + CREATE. Down: 0017_agent_versions.down.sql.

CREATE TABLE IF NOT EXISTS ai_prism.agent_versions (
  id BIGSERIAL PRIMARY KEY,
  agent_id BIGINT NOT NULL REFERENCES ai_prism.agents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- where the content came from when it was not typed in: {kind: 'restore' | 'duplicate' | 'shared', agentId, version}
  origin JSONB CHECK (origin IS NULL OR jsonb_typeof(origin) = 'object'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'revoked')),
  approved_by_hash TEXT,
  approved_at TIMESTAMPTZ,
  decision_reason TEXT CHECK (char_length(decision_reason) <= 500),
  CONSTRAINT agent_versions_unique UNIQUE (agent_id, version),
  CONSTRAINT agent_versions_approved_complete CHECK (status <> 'approved' OR (approved_by_hash IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS agent_versions_owner ON ai_prism.agent_versions (owner_email, agent_id);
CREATE INDEX IF NOT EXISTS agent_versions_pending ON ai_prism.agent_versions (created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS ai_prism.agent_shares (
  id BIGSERIAL PRIMARY KEY,
  agent_id BIGINT NOT NULL,
  version INTEGER NOT NULL,
  owner_email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'group', 'app')),
  -- lowercased email or group name; '*' for the whole app
  principal TEXT NOT NULL CHECK (char_length(principal) BETWEEN 1 AND 256 AND principal = lower(principal)),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_shares_app_star CHECK ((kind = 'app') = (principal = '*')),
  CONSTRAINT agent_shares_unique UNIQUE (agent_id, kind, principal),
  -- a share pins a version that exists, and goes away with it (and with the agent)
  CONSTRAINT agent_shares_version_fk FOREIGN KEY (agent_id, version) REFERENCES ai_prism.agent_versions (agent_id, version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS agent_shares_principal ON ai_prism.agent_shares (kind, principal);
CREATE INDEX IF NOT EXISTS agent_shares_owner ON ai_prism.agent_shares (owner_email, agent_id);

-- The guard (BEFORE INSERT OR UPDATE). SECURITY INVOKER: it only reads the transaction's settings and the version table.
CREATE OR REPLACE FUNCTION ai_prism.aip_agent_versions_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$
DECLARE
  me text := NULLIF(current_setting('app.user_email', true), '');
  adm boolean := coalesce(current_setting('app.is_admin', true), '') = 'on';
  approval_cols constant text[] := ARRAY['status', 'approved_by_hash', 'approved_at', 'decision_reason'];
  old_j jsonb;
  new_j jsonb;
  nd jsonb;
  od jsonb;
  submit_ok boolean;
  decide_ok boolean;
  top int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT (adm AND me IS NULL) AND (NEW.status <> 'draft' OR NEW.approved_by_hash IS NOT NULL OR NEW.approved_at IS NOT NULL
        OR NEW.decision_reason IS NOT NULL) THEN
      RAISE EXCEPTION 'agent_versions_guard: a new version starts as a draft' USING ERRCODE = '42501';
    END IF;
    SELECT max(v.version) INTO top FROM ai_prism.agent_versions v WHERE v.agent_id = NEW.agent_id;
    IF top IS NOT NULL AND NEW.version <= top THEN
      RAISE EXCEPTION 'agent_versions_guard: versions are numbered in increasing order' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  old_j := to_jsonb(OLD);
  new_j := to_jsonb(NEW);

  -- (1) immutable: everything but the approval columns
  IF (new_j - approval_cols) IS DISTINCT FROM (old_j - approval_cols) THEN
    RAISE EXCEPTION 'agent_versions_guard: a saved version cannot change' USING ERRCODE = '42501';
  END IF;

  -- (4) who may write the approval columns (a seed / support identity, admin flag and no user, is unrestricted)
  IF NOT (adm AND me IS NULL) THEN
    nd := (SELECT jsonb_object_agg(k, new_j -> k) FROM unnest(approval_cols) k);
    od := (SELECT jsonb_object_agg(k, old_j -> k) FROM unnest(approval_cols) k);
    IF nd IS DISTINCT FROM od THEN
      submit_ok := OLD.status IN ('draft', 'rejected', 'revoked') AND NEW.status = 'pending' AND (nd - 'status') = (od - 'status');
      decide_ok := adm AND ((OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected'))
                            OR (OLD.status IN ('approved', 'pending') AND NEW.status = 'revoked'));
      IF NOT (submit_ok OR decide_ok) THEN
        RAISE EXCEPTION 'agent_versions_guard: the approval columns are admin-only' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS aip_agent_versions_guard ON ai_prism.agent_versions;
CREATE TRIGGER aip_agent_versions_guard BEFORE INSERT OR UPDATE ON ai_prism.agent_versions
  FOR EACH ROW EXECUTE FUNCTION ai_prism.aip_agent_versions_guard();

-- ---- row-level security ------------------------------------------------------------

ALTER TABLE ai_prism.agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_prism.agent_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_prism.agent_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_prism.agent_shares FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aiav_owner_select ON ai_prism.agent_versions;
CREATE POLICY aiav_owner_select ON ai_prism.agent_versions FOR SELECT
  USING (owner_email = NULLIF(current_setting('app.user_email', true), ''));

DROP POLICY IF EXISTS aiav_owner_insert ON ai_prism.agent_versions;
CREATE POLICY aiav_owner_insert ON ai_prism.agent_versions FOR INSERT
  WITH CHECK (
    owner_email = NULLIF(current_setting('app.user_email', true), '')
    AND created_by = owner_email
    AND EXISTS (SELECT 1 FROM ai_prism.agents a WHERE a.id = agent_versions.agent_id AND a.owner_email = agent_versions.owner_email)
  );

DROP POLICY IF EXISTS aiav_owner_update ON ai_prism.agent_versions;
CREATE POLICY aiav_owner_update ON ai_prism.agent_versions FOR UPDATE
  USING (owner_email = NULLIF(current_setting('app.user_email', true), ''))
  WITH CHECK (owner_email = NULLIF(current_setting('app.user_email', true), ''));

DROP POLICY IF EXISTS aiav_admin_read ON ai_prism.agent_versions;
CREATE POLICY aiav_admin_read ON ai_prism.agent_versions FOR SELECT
  USING (coalesce(current_setting('app.is_admin', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL);

DROP POLICY IF EXISTS aiav_admin_decide ON ai_prism.agent_versions;
CREATE POLICY aiav_admin_decide ON ai_prism.agent_versions FOR UPDATE
  USING (coalesce(current_setting('app.is_admin', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL)
  WITH CHECK (coalesce(current_setting('app.is_admin', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL);

-- a recipient reads an APPROVED version that a share pins for her: by user, by group, or the whole app (any identity)
DROP POLICY IF EXISTS aiav_shared_read ON ai_prism.agent_versions;
CREATE POLICY aiav_shared_read ON ai_prism.agent_versions FOR SELECT
  USING (
    status = 'approved'
    AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM ai_prism.agent_shares s
       WHERE s.agent_id = agent_versions.agent_id AND s.version = agent_versions.version
         AND (s.kind = 'app'
              OR (s.kind = 'user' AND s.principal = lower(NULLIF(current_setting('app.user_email', true), '')))
              OR (s.kind = 'group' AND s.principal = ANY (ai_prism.aip_my_groups())))
    )
  );

DROP POLICY IF EXISTS aias_owner ON ai_prism.agent_shares;
CREATE POLICY aias_owner ON ai_prism.agent_shares FOR ALL
  USING (owner_email = NULLIF(current_setting('app.user_email', true), ''))
  WITH CHECK (
    owner_email = NULLIF(current_setting('app.user_email', true), '')
    AND created_by = owner_email
    AND EXISTS (SELECT 1 FROM ai_prism.agents a WHERE a.id = agent_shares.agent_id AND a.owner_email = agent_shares.owner_email)
  );

DROP POLICY IF EXISTS aias_admin_read ON ai_prism.agent_shares;
CREATE POLICY aias_admin_read ON ai_prism.agent_shares FOR SELECT
  USING (coalesce(current_setting('app.is_admin', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL);

-- the rows addressed to the caller (and nobody else's), so aiav_shared_read can see them
DROP POLICY IF EXISTS aias_recipient_read ON ai_prism.agent_shares;
CREATE POLICY aias_recipient_read ON ai_prism.agent_shares FOR SELECT
  USING (
    NULLIF(current_setting('app.user_email', true), '') IS NOT NULL
    AND (kind = 'app'
         OR (kind = 'user' AND principal = lower(NULLIF(current_setting('app.user_email', true), '')))
         OR (kind = 'group' AND principal = ANY (ai_prism.aip_my_groups())))
  );
