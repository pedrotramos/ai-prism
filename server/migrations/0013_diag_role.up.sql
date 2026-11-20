-- 0013_diag_role: a read-only diagnostic role for operators (F1).
--
-- Diagnosing slow tools used to need an identity that bypasses row-level
-- security (docs/operations.md §6.7). ai_prism_diag is the least-privilege
-- path: a NOLOGIN role an operator is granted (`migrate.mjs diag-grant --role R`)
-- and enters with SET ROLE. It can read FOUR columns of ai_prism.chat_tool_calls
-- across all users (tool_name, status, duration_ms, created_at) and nothing else:
-- not arguments, result, message_id or call_id, and no other app table.
--
--   role     NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT: it is bound by RLS like any role
--   grants   USAGE on the schema + column-level SELECT (the table-level privilege is revoked first)
--   policy   aipd_diag_read, SELECT, permissive, TO the role only (USING true). It applies to
--            no other role, so the app role sees exactly what it saw before. The aipd_ prefix
--            stays out of the drop loops of 0003 ('aip\_%' excluded by their own lists),
--            0005 (aipj_) and 0007 (aipr_ / aipa_)
--
-- The app's service principal is never a member (nothing in server/db/grants.js grants
-- it; `diag-grant` refuses it). The role is a CLUSTER object: creating it needs CREATEROLE,
-- which the app's SP does not have. When the role is missing and this run cannot create it
-- (the SP applying migrations at boot), the migration applies WITHOUT it and says so in a
-- NOTICE; `node scripts/migrate.mjs diag-grant --role R` (run by the deploying identity)
-- then creates the role and applies this same body. An existing role of that name that
-- can log in, is a superuser or bypasses RLS is not ours: it is left alone (WARNING).
--
-- The name is ai_prism.diag_role (default ai_prism_diag); override only on scratch/test
-- databases, as for the owner role.
--
-- Idempotent. Down: 0013_diag_role.down.sql (keeps the cluster role).
DO $up$
DECLARE
  diag text := coalesce(nullif(current_setting('ai_prism.diag_role', true), ''), 'ai_prism_diag');
  owner_role text := nullif(current_setting('ai_prism.owner_role', true), '');
  use_owner boolean := coalesce(current_setting('ai_prism.use_owner_role', true), 'off') = 'on' AND owner_role IS NOT NULL;
  r record;
BEGIN
  IF use_owner THEN
    -- creating a role needs the session identity's privileges, not the owner role's
    SET LOCAL ROLE NONE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = diag) THEN
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE', diag);
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
      WHEN duplicate_object THEN NULL;
    END;
  END IF;
  IF use_owner THEN
    EXECUTE format('SET LOCAL ROLE %I', owner_role);
  END IF;

  SELECT rolsuper, rolbypassrls, rolcanlogin INTO r FROM pg_roles WHERE rolname = diag;
  IF NOT FOUND THEN
    RAISE NOTICE 'ai_prism: role % does not exist and this identity cannot create it; migration 0013 applied without it. Run `node scripts/migrate.mjs diag-grant --role <operator role>` as the deploying identity', diag;
    RETURN;
  END IF;
  IF r.rolsuper OR r.rolbypassrls OR r.rolcanlogin THEN
    RAISE WARNING 'ai_prism: role % exists but can log in, is a superuser or bypasses RLS; it is not the diagnostic role and migration 0013 leaves it alone', diag;
    RETURN;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA ai_prism TO %I', diag);
  EXECUTE format('REVOKE ALL ON ai_prism.chat_tool_calls FROM %I', diag);
  EXECUTE format('GRANT SELECT (tool_name, status, duration_ms, created_at) ON ai_prism.chat_tool_calls TO %I', diag);
  DROP POLICY IF EXISTS aipd_diag_read ON ai_prism.chat_tool_calls;
  EXECUTE format('CREATE POLICY aipd_diag_read ON ai_prism.chat_tool_calls FOR SELECT TO %I USING (true)', diag);
END
$up$;
