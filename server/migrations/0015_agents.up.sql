-- 0015_agents (W4-4a): scheduled agents, part 1 of 6: the data model and what the database enforces.
--
-- agents      one saved, named turn recipe per row, owner-scoped. `definition` (jsonb) is the
--             APPROVAL SCOPE: instructions, prompt, model, reasoning effort, tools, schedule, language.
--             name and description are columns outside it (renaming never voids an approval).
-- agent_runs  one row per attempted occurrence (a scheduled slot or a manual "run now").
--
-- What the database enforces (no route may forget it; the trigger runs for every writer):
--   1. Without the admin flag the approval columns (status to approved/rejected/revoked, approval_*,
--      approved_*, decision_reason) cannot change; the owner may only move draft/rejected/revoked to pending.
--   2. Any change of `definition` on a pending or approved agent makes it a draft again, disabled, with the
--      approval cleared. The comparison is jsonb equality on the stored document, so no single statement
--      (UPDATE ... SET definition = ..., status = ...) can keep an approval across an edit.
--   3. An approval is of what is stored: approved_snapshot must equal definition, and only a pending agent
--      can be approved. An admin who is not the owner can change only the approval columns.
--   4. Under the scheduler identity only next_run_at, last_run_at, consecutive_failures, disabled_reason
--      and enabled (to false only) can change.
--   5. enabled can become true only while status = 'approved' and approval_expires_at is in the future.
--
-- Row-level security (ENABLE + FORCE, the same one-app-role model as 0003):
--   agents      aiag_owner (ALL, own rows); aiag_admin_read / aiag_admin_decide (admin flag + an identity);
--               aiag_sched_read / aiag_sched_update (scheduler identity, approved agents only)
--   agent_runs  aiar_owner_* (own rows; an insert only as a manual, queued run of her own approved agent),
--               aiar_admin_read, aiar_sched_* (select/insert/update; an insert only for the agent's own owner)
--   admin_audit aiau_sched_insert: the scheduler writes 'system' rows of kind agent.run.* and nothing else
-- The scheduler identity is: no user (app.user_email empty) AND app.scheduler = 'on'. It is set only by the
-- scheduler's own db module (W4-4c); every other table's policies ignore it, so it reads nothing else.
-- Every identity is read through NULLIF(..., ''): an empty identity matches no row, not even a row whose
-- owner column is ''.
--
-- ON DELETE: agent_runs.agent_id CASCADE (deleting an agent removes its history; the cascade is the
-- referential action and does not go through the policies); agent_runs.session_id SET NULL (retention
-- deleting the chat keeps the run row). There is no user table, so owner_email has no FK: an offboarded
-- owner's agents are voided by approval expiry or an admin revoke.
--
-- Policy names use the aiag_/aiar_/aiau_ prefixes so 0003's 'aip\_%' drop loop never touches them.
-- DDL only (after 0003 a migration never writes rows). Idempotent: CREATE ... IF NOT EXISTS, DROP POLICY
-- IF EXISTS + CREATE, CREATE OR REPLACE, DROP TRIGGER IF EXISTS + CREATE. Down: 0015_agents.down.sql.

CREATE TABLE IF NOT EXISTS ai_prism.agents (
  id BIGSERIAL PRIMARY KEY,
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'revoked')),
  approval_hash TEXT,
  approved_snapshot JSONB,
  approved_by_hash TEXT,
  approved_at TIMESTAMPTZ,
  approval_expires_at TIMESTAMPTZ,
  decision_reason TEXT CHECK (char_length(decision_reason) <= 500),
  enabled BOOLEAN NOT NULL DEFAULT false,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agents_enabled_requires_approval CHECK (NOT enabled OR (status = 'approved' AND approval_hash IS NOT NULL)),
  CONSTRAINT agents_approved_complete CHECK (
    status <> 'approved'
    OR (approval_hash IS NOT NULL AND approved_snapshot IS NOT NULL AND approved_by_hash IS NOT NULL
        AND approved_at IS NOT NULL AND approval_expires_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS agents_owner ON ai_prism.agents (owner_email);
CREATE INDEX IF NOT EXISTS agents_due ON ai_prism.agents (next_run_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS ai_prism.agent_runs (
  id BIGSERIAL PRIMARY KEY,
  agent_id BIGINT NOT NULL REFERENCES ai_prism.agents(id) ON DELETE CASCADE,
  owner_email TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  slot_at TIMESTAMPTZ NOT NULL,
  approval_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')),
  error_code TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  session_id BIGINT REFERENCES ai_prism.chat_sessions(id) ON DELETE SET NULL,
  message_id BIGINT,
  cost_usd NUMERIC(12, 6),
  unpriced BOOLEAN NOT NULL DEFAULT false,
  tool_names TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- at most one scheduled run per (agent, occurrence), whatever the number of app processes
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_slot ON ai_prism.agent_runs (agent_id, slot_at) WHERE trigger = 'schedule';
-- at most one active run per agent
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_active ON ai_prism.agent_runs (agent_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS agent_runs_lease ON ai_prism.agent_runs (lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS agent_runs_agent ON ai_prism.agent_runs (agent_id, created_at DESC);

-- The guard (BEFORE INSERT OR UPDATE). SECURITY INVOKER: it only reads the transaction's settings.
CREATE OR REPLACE FUNCTION ai_prism.aip_agents_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$
DECLARE
  me text := NULLIF(current_setting('app.user_email', true), '');
  adm boolean := coalesce(current_setting('app.is_admin', true), '') = 'on';
  sch boolean := coalesce(current_setting('app.scheduler', true), '') = 'on';
  -- the columns an approval decision writes
  decision_cols constant text[] := ARRAY['status', 'approval_hash', 'approved_snapshot', 'approved_by_hash',
    'approved_at', 'approval_expires_at', 'decision_reason'];
  -- what a decision, or a trigger-made void, may also touch
  admin_cols constant text[] := ARRAY['enabled', 'next_run_at', 'disabled_reason', 'updated_at'];
  sched_cols constant text[] := ARRAY['next_run_at', 'last_run_at', 'consecutive_failures', 'enabled', 'disabled_reason', 'updated_at'];
  old_j jsonb;
  new_j jsonb;
  nd jsonb;
  od jsonb;
  submit_ok boolean;
  decide_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- a new agent is a draft; only a no-user admin identity (a seed, a support fix) may insert any state
    IF NOT (adm AND me IS NULL) AND (NEW.status <> 'draft' OR NEW.enabled OR NEW.approval_hash IS NOT NULL
        OR NEW.approved_snapshot IS NOT NULL OR NEW.approved_by_hash IS NOT NULL OR NEW.approved_at IS NOT NULL
        OR NEW.approval_expires_at IS NOT NULL OR NEW.decision_reason IS NOT NULL) THEN
      RAISE EXCEPTION 'agents_guard: a new agent starts as a draft' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  old_j := to_jsonb(OLD);
  new_j := to_jsonb(NEW);

  -- (4) the scheduler identity: run bookkeeping only
  IF sch THEN
    IF (new_j - sched_cols) IS DISTINCT FROM (old_j - sched_cols) THEN
      RAISE EXCEPTION 'agents_guard: the scheduler may change run bookkeeping only' USING ERRCODE = '42501';
    END IF;
    IF NEW.enabled AND NOT OLD.enabled THEN
      RAISE EXCEPTION 'agents_guard: the scheduler may only disable an agent' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- (1) who may write the approval columns. A seed / support identity (admin flag, no user) is unrestricted.
  IF NOT (adm AND me IS NULL) THEN
    nd := (SELECT jsonb_object_agg(k, new_j -> k) FROM unnest(decision_cols) k);
    od := (SELECT jsonb_object_agg(k, old_j -> k) FROM unnest(decision_cols) k);
    IF nd IS DISTINCT FROM od THEN
      -- the owner submits: draft / rejected / revoked -> pending, no other decision column touched
      submit_ok := OLD.status IN ('draft', 'rejected', 'revoked') AND NEW.status = 'pending' AND (nd - 'status') = (od - 'status');
      -- an admin decides: approve or reject a pending agent, revoke an approved or pending one
      decide_ok := adm AND ((OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected'))
                            OR (OLD.status IN ('approved', 'pending') AND NEW.status = 'revoked'));
      IF NOT (submit_ok OR decide_ok) THEN
        RAISE EXCEPTION 'agents_guard: the approval columns are admin-only' USING ERRCODE = '42501';
      END IF;
    END IF;
    -- an admin acting on someone else's agent changes the decision columns and the schedule switch, nothing else
    IF adm AND OLD.owner_email IS DISTINCT FROM me THEN
      IF (new_j - decision_cols - admin_cols) IS DISTINCT FROM (old_j - decision_cols - admin_cols) THEN
        RAISE EXCEPTION 'agents_guard: an admin may change the approval columns only' USING ERRCODE = '42501';
      END IF;
      IF NEW.enabled AND NOT OLD.enabled THEN
        RAISE EXCEPTION 'agents_guard: only the owner switches a schedule on' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- (3) an approval is of what is stored, and only a pending agent is approved
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' AND NOT (adm AND me IS NULL) THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'agents_guard: only a pending agent can be approved' USING ERRCODE = '42501';
    END IF;
    IF NEW.approved_snapshot IS DISTINCT FROM NEW.definition OR NEW.approval_hash IS NULL OR NEW.approved_by_hash IS NULL
       OR NEW.approved_at IS NULL OR NEW.approval_expires_at IS NULL OR NEW.approval_expires_at <= now() THEN
      RAISE EXCEPTION 'agents_guard: an approval must carry the stored definition and a future expiry' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- (2) an edit of the approval scope voids the approval
  IF NEW.definition IS DISTINCT FROM OLD.definition AND OLD.status IN ('approved', 'pending') THEN
    NEW.status := 'draft';
    NEW.enabled := false;
    NEW.next_run_at := NULL;
    NEW.approval_hash := NULL;
    NEW.approved_snapshot := NULL;
    NEW.approved_by_hash := NULL;
    NEW.approved_at := NULL;
    NEW.approval_expires_at := NULL;
    NEW.decision_reason := NULL;
  END IF;

  -- (5) enabling needs an approved, unexpired agent (only the false -> true move is checked, so a lapsed approval
  -- never blocks the scheduler's own bookkeeping)
  IF NEW.enabled AND NOT OLD.enabled THEN
    IF NEW.status <> 'approved' OR NEW.approval_hash IS NULL OR NEW.approval_expires_at IS NULL OR NEW.approval_expires_at <= now() THEN
      RAISE EXCEPTION 'agents_guard: enabling needs an approved, unexpired agent' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS aip_agents_guard ON ai_prism.agents;
CREATE TRIGGER aip_agents_guard BEFORE INSERT OR UPDATE ON ai_prism.agents
  FOR EACH ROW EXECUTE FUNCTION ai_prism.aip_agents_guard();

-- ---- row-level security ------------------------------------------------------------

ALTER TABLE ai_prism.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_prism.agents FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_prism.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_prism.agent_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aiag_owner ON ai_prism.agents;
CREATE POLICY aiag_owner ON ai_prism.agents FOR ALL
  USING (owner_email = NULLIF(current_setting('app.user_email', true), ''))
  WITH CHECK (owner_email = NULLIF(current_setting('app.user_email', true), ''));

DROP POLICY IF EXISTS aiag_admin_read ON ai_prism.agents;
CREATE POLICY aiag_admin_read ON ai_prism.agents FOR SELECT
  USING (coalesce(current_setting('app.is_admin', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL);

DROP POLICY IF EXISTS aiag_admin_decide ON ai_prism.agents;
CREATE POLICY aiag_admin_decide ON ai_prism.agents FOR UPDATE
  USING (coalesce(current_setting('app.is_admin', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL)
  WITH CHECK (coalesce(current_setting('app.is_admin', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL);

DROP POLICY IF EXISTS aiag_sched_read ON ai_prism.agents;
CREATE POLICY aiag_sched_read ON ai_prism.agents FOR SELECT
  USING (coalesce(current_setting('app.scheduler', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NULL
         AND status = 'approved');

DROP POLICY IF EXISTS aiag_sched_update ON ai_prism.agents;
CREATE POLICY aiag_sched_update ON ai_prism.agents FOR UPDATE
  USING (coalesce(current_setting('app.scheduler', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NULL
         AND status = 'approved')
  WITH CHECK (coalesce(current_setting('app.scheduler', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NULL
              AND status = 'approved');

DROP POLICY IF EXISTS aiar_owner_select ON ai_prism.agent_runs;
CREATE POLICY aiar_owner_select ON ai_prism.agent_runs FOR SELECT
  USING (owner_email = NULLIF(current_setting('app.user_email', true), ''));

-- "Run now": a manual, queued run of her own approved, unexpired agent, naming a chat only if it is hers
DROP POLICY IF EXISTS aiar_owner_insert ON ai_prism.agent_runs;
CREATE POLICY aiar_owner_insert ON ai_prism.agent_runs FOR INSERT
  WITH CHECK (
    owner_email = NULLIF(current_setting('app.user_email', true), '')
    AND trigger = 'manual' AND status = 'queued'
    AND EXISTS (SELECT 1 FROM ai_prism.agents a
                 WHERE a.id = agent_runs.agent_id AND a.status = 'approved' AND a.approval_expires_at > now())
    AND (session_id IS NULL OR EXISTS (SELECT 1 FROM ai_prism.chat_sessions s WHERE s.id = agent_runs.session_id))
  );

DROP POLICY IF EXISTS aiar_owner_update ON ai_prism.agent_runs;
CREATE POLICY aiar_owner_update ON ai_prism.agent_runs FOR UPDATE
  USING (owner_email = NULLIF(current_setting('app.user_email', true), ''))
  WITH CHECK (
    owner_email = NULLIF(current_setting('app.user_email', true), '')
    AND (session_id IS NULL OR EXISTS (SELECT 1 FROM ai_prism.chat_sessions s WHERE s.id = agent_runs.session_id))
  );

DROP POLICY IF EXISTS aiar_admin_read ON ai_prism.agent_runs;
CREATE POLICY aiar_admin_read ON ai_prism.agent_runs FOR SELECT
  USING (coalesce(current_setting('app.is_admin', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL);

DROP POLICY IF EXISTS aiar_sched_select ON ai_prism.agent_runs;
CREATE POLICY aiar_sched_select ON ai_prism.agent_runs FOR SELECT
  USING (coalesce(current_setting('app.scheduler', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NULL);

DROP POLICY IF EXISTS aiar_sched_insert ON ai_prism.agent_runs;
CREATE POLICY aiar_sched_insert ON ai_prism.agent_runs FOR INSERT
  WITH CHECK (
    coalesce(current_setting('app.scheduler', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NULL
    AND EXISTS (SELECT 1 FROM ai_prism.agents a
                 WHERE a.id = agent_runs.agent_id AND a.status = 'approved' AND a.owner_email = agent_runs.owner_email)
  );

DROP POLICY IF EXISTS aiar_sched_update ON ai_prism.agent_runs;
CREATE POLICY aiar_sched_update ON ai_prism.agent_runs FOR UPDATE
  USING (coalesce(current_setting('app.scheduler', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NULL)
  WITH CHECK (coalesce(current_setting('app.scheduler', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NULL);

-- the scheduler's own audit rows (one at the start and one at the end of a run), and nothing else
DROP POLICY IF EXISTS aiau_sched_insert ON ai_prism.admin_audit;
CREATE POLICY aiau_sched_insert ON ai_prism.admin_audit FOR INSERT
  WITH CHECK (
    coalesce(current_setting('app.scheduler', true), '') = 'on' AND NULLIF(current_setting('app.user_email', true), '') IS NULL
    AND actor_hash = 'system' AND action LIKE 'agent.run.%'
  );
