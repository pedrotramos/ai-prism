-- 0007_settings_audit: org settings (retention, org instructions), the admin
-- audit trail, and the maintenance identity of the retention sweep (W2-5).
--
-- app_settings   key → jsonb value. Keys: retention_days (0 = off, 1..3650),
--                org_instructions (text), retention_last_sweep_at (ISO time of
--                the last sweep, written by the sweep). An absent key is the
--                default (retention off, no instructions): no seed row, because
--                after 0003 a migration is DDL only (FORCE RLS binds the owner).
--                RLS: everyone reads (org instructions go into every turn);
--                writes need app.is_admin = 'on', except the sweep's own stamp.
-- admin_audit    append-only trail of admin mutations: at, actor_hash (a hash,
--                never the e-mail; 'system' for the sweep), action, target,
--                details. RLS: only admins read; inserts need the admin flag
--                (or the maintenance identity, for 'retention.*' rows as
--                'system'); there is NO update or delete policy, so the app role
--                cannot change or remove a row whatever flags it sets (and
--                server/db/grants.js also revokes UPDATE/DELETE/TRUNCATE).
--
-- Maintenance identity (server/retention.js only): the sweep runs a transaction
-- with NO user identity (app.user_email '') and sets app.maintenance = 'on'
-- with set_config(..., true), so the flag ends with that transaction. The
-- aipr_* policies below give that identity exactly what the sweep needs and no
-- more: SELECT + DELETE on chat_sessions and SELECT on chat_images (the volume
-- paths), SELECT on the messages, decks, spreadsheets and documents of those
-- sessions (so the sweep can see whether any of them is recent), and only for
-- sessions whose updated_at is older than retention_days (nothing when off).
-- Last activity is the newest of the session's updated_at, its messages'
-- created_at and its artifacts' updated_at: server/retention.js deletes a
-- session only when all of them are older than the cutoff.
-- Every other row of a deleted session goes by ON DELETE CASCADE (usage_ledger:
-- SET NULL, the cost rows stay), and foreign-key actions are not subject to RLS.
-- A transaction that carries a user identity never matches: withTx always sets
-- app.user_email for a request, so a request can never use the flag.
--
-- The aipr_ prefix keeps these policies out of 0003's 'aip\_%' drop loop, so
-- re-running 0003 leaves them alone. Idempotent: CREATE ... IF NOT EXISTS,
-- CREATE OR REPLACE, DROP POLICY IF EXISTS + CREATE, ENABLE/FORCE are no-ops.

CREATE TABLE IF NOT EXISTS ai_prism.app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_prism.admin_audit (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
-- the audit page reads newest first by id (keyset cursor on the primary key)

-- the maintenance identity: no user, and the flag set by the sweep's transaction
CREATE OR REPLACE FUNCTION ai_prism.aip_maintenance() RETURNS boolean
  LANGUAGE sql STABLE
  AS $fn$
    SELECT NULLIF(current_setting('app.user_email', true), '') IS NULL
       AND coalesce(current_setting('app.maintenance', true), '') = 'on'
  $fn$;

-- now() - retention_days, or NULL when retention is off/unset/invalid (then
-- "updated_at < cutoff" is never true and nothing is ever expired)
CREATE OR REPLACE FUNCTION ai_prism.aip_retention_cutoff() RETURNS timestamptz
  LANGUAGE sql STABLE
  AS $fn$
    SELECT CASE WHEN d BETWEEN 1 AND 3650 THEN now() - make_interval(days => d) END
      FROM (
        SELECT CASE WHEN jsonb_typeof(value) = 'number' AND (value #>> '{}') ~ '^[0-9]{1,4}$'
                    THEN (value #>> '{}')::int END AS d
          FROM ai_prism.app_settings WHERE key = 'retention_days'
      ) s
  $fn$;

DO $up$
DECLARE
  is_admin constant text := '(coalesce(current_setting(''app.is_admin'', true), '''') = ''on'')';
  p record;
  t text;
BEGIN
  FOR p IN SELECT polname, polrelid::regclass::text AS t FROM pg_policy
            WHERE polrelid IN ('ai_prism.app_settings'::regclass, 'ai_prism.admin_audit'::regclass)
               OR (polrelid IN ('ai_prism.chat_sessions'::regclass, 'ai_prism.chat_images'::regclass, 'ai_prism.chat_messages'::regclass,
                                'ai_prism.chat_decks'::regclass, 'ai_prism.chat_spreadsheets'::regclass, 'ai_prism.chat_documents'::regclass)
                   AND polname LIKE 'aipr\_%') LOOP
    EXECUTE format('DROP POLICY %I ON %s', p.polname, p.t);
  END LOOP;

  -- app_settings: read all; write with the admin flag; the sweep stamps its run
  EXECUTE 'CREATE POLICY aip_read ON ai_prism.app_settings FOR SELECT USING (true)';
  EXECUTE format('CREATE POLICY aip_admin_insert ON ai_prism.app_settings FOR INSERT WITH CHECK %s', is_admin);
  EXECUTE format('CREATE POLICY aip_admin_update ON ai_prism.app_settings FOR UPDATE USING %s WITH CHECK %s', is_admin, is_admin);
  EXECUTE format('CREATE POLICY aip_admin_delete ON ai_prism.app_settings FOR DELETE USING %s', is_admin);
  EXECUTE 'CREATE POLICY aipr_maint_stamp_insert ON ai_prism.app_settings FOR INSERT '
    'WITH CHECK (ai_prism.aip_maintenance() AND key = ''retention_last_sweep_at'')';
  EXECUTE 'CREATE POLICY aipr_maint_stamp_update ON ai_prism.app_settings FOR UPDATE '
    'USING (ai_prism.aip_maintenance() AND key = ''retention_last_sweep_at'') '
    'WITH CHECK (ai_prism.aip_maintenance() AND key = ''retention_last_sweep_at'')';

  -- admin_audit: admins read and insert; the sweep inserts its own 'system' rows; no update/delete
  EXECUTE format('CREATE POLICY aip_admin_read ON ai_prism.admin_audit FOR SELECT USING %s', is_admin);
  EXECUTE format('CREATE POLICY aip_admin_insert ON ai_prism.admin_audit FOR INSERT WITH CHECK %s', is_admin);
  EXECUTE 'CREATE POLICY aipr_maint_insert ON ai_prism.admin_audit FOR INSERT '
    'WITH CHECK (ai_prism.aip_maintenance() AND actor_hash = ''system'' AND action LIKE ''retention.%'')';

  -- the sweep: expired sessions only, and the image paths of those sessions
  EXECUTE 'CREATE POLICY aipr_maint_read ON ai_prism.chat_sessions FOR SELECT '
    'USING (ai_prism.aip_maintenance() AND updated_at < ai_prism.aip_retention_cutoff())';
  EXECUTE 'CREATE POLICY aipr_maint_delete ON ai_prism.chat_sessions FOR DELETE '
    'USING (ai_prism.aip_maintenance() AND updated_at < ai_prism.aip_retention_cutoff())';
  FOREACH t IN ARRAY ARRAY['chat_images', 'chat_messages', 'chat_decks', 'chat_spreadsheets', 'chat_documents'] LOOP
    EXECUTE format('CREATE POLICY aipr_maint_read ON ai_prism.%I FOR SELECT '
      'USING (ai_prism.aip_maintenance() AND EXISTS (SELECT 1 FROM ai_prism.chat_sessions s '
      'WHERE s.id = %I.session_id AND s.updated_at < ai_prism.aip_retention_cutoff()))', t, t);
  END LOOP;

  EXECUTE 'ALTER TABLE ai_prism.app_settings ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE ai_prism.app_settings FORCE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE ai_prism.admin_audit ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE ai_prism.admin_audit FORCE ROW LEVEL SECURITY';
END
$up$;
