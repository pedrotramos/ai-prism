-- 0013_diag_role: a read-only diagnostic role for operators (F1).
--
-- Diagnosing slow tools used to need an identity that bypasses row-level
-- security (docs/operations.md §6.7). ai_prism_diag is the least-privilege
-- path: a NOLOGIN role an operator is granted (`migrate.mjs diag-grant --role R`)
-- and enters with SET ROLE. It can read FOUR columns of ai_prism.chat_tool_calls
-- across all users (tool_name, status, duration_ms, created_at) and nothing else:
-- not arguments, result, message_id or call_id, no other app table, and no
-- SECURITY DEFINER helper.
--
--   role     ai_prism_diag NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT: bound by RLS like any role.
--            The name is a CONSTANT. Only a scratch/test database may name it differently, and
--            only as ai_prism_diag_test_<a-z0-9>+ (ai_prism.diag_role), which can never be the
--            owner role or an app role; anything else raises AIP05.
--   grants   USAGE on the schema + column-level SELECT (everything else it holds in ai_prism is
--            revoked first)
--   policy   aipd_diag_read, SELECT, permissive, TO the role only (USING true). It applies to
--            no other role, so the app role sees exactly what it saw before. The aipd_ prefix
--            stays out of the drop loops of 0003, 0005 (aipj_) and 0007 (aipr_ / aipa_)
--   execute  schema USAGE would let the role call the SECURITY DEFINER membership helpers
--            (aip_my_project_ids, aip_project_rank, ...) that PUBLIC may execute by default.
--            EXECUTE on every SECURITY DEFINER function of ai_prism is revoked from PUBLIC
--            and granted explicitly to the roles that already hold DML on chat_sessions (the
--            app role, the owner); applyAppGrants grants it to the app role from now on. A
--            later migration that adds such a function must do the same (a test enforces it)
--
-- The app's service principal is never a member (nothing in server/db/grants.js grants it;
-- `diag-grant` refuses it, the owner role and any role related to them through membership).
-- The role is a CLUSTER object: creating it needs CREATEROLE, which the app's SP does not
-- have. When the role is missing and this run cannot create it (the SP applying migrations
-- at boot), the migration applies WITHOUT it (NOTICE: the diagnostic path stays unavailable)
-- and `node scripts/migrate.mjs diag-grant --role R` (run by the deploying identity) then
-- creates the role and applies this same body.
--
-- A pre-existing role of that name is trusted only if it is a plain NOLOGIN role (no
-- superuser, BYPASSRLS, CREATEROLE, CREATEDB, REPLICATION), a member of nothing, owns
-- nothing, and holds no privilege outside ai_prism. Anything else raises AIP05 and the
-- migration fails closed. What it holds INSIDE ai_prism is revoked before the four columns
-- are granted.
--
-- Idempotent. Down: 0013_diag_role.down.sql (keeps the cluster role).
DO $up$
DECLARE
  guc text := nullif(current_setting('ai_prism.diag_role', true), '');
  diag text := 'ai_prism_diag';
  owner_role text := nullif(current_setting('ai_prism.owner_role', true), '');
  use_owner boolean := coalesce(current_setting('ai_prism.use_owner_role', true), 'off') = 'on' AND owner_role IS NOT NULL;
  r record;
  fn record;
  app record;
  diag_oid oid;
BEGIN
  IF guc IS NOT NULL THEN
    IF guc !~ '^ai_prism_diag_test_[a-z0-9]+$' THEN
      RAISE EXCEPTION 'ai_prism: ai_prism.diag_role % is not allowed (only ai_prism_diag_test_<a-z0-9>+ on a test database)', guc
        USING ERRCODE = 'AIP05';
    END IF;
    diag := guc;
  END IF;

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

  SELECT oid, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb, rolreplication INTO r FROM pg_roles WHERE rolname = diag;
  IF NOT FOUND THEN
    RAISE NOTICE 'ai_prism: role % does not exist and this identity cannot create it; migration 0013 applied without it (the diagnostic path is unavailable). Run `node scripts/migrate.mjs diag-grant --role <operator role>` as the deploying identity', diag;
    RETURN;
  END IF;
  diag_oid := r.oid;
  IF r.rolsuper OR r.rolbypassrls OR r.rolcanlogin OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication THEN
    RAISE EXCEPTION 'ai_prism: role % exists but is not a plain NOLOGIN role (superuser, BYPASSRLS, login, CREATEROLE, CREATEDB or REPLICATION); rename or fix it, then re-run', diag
      USING ERRCODE = 'AIP05';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = diag_oid) THEN
    RAISE EXCEPTION 'ai_prism: role % is a member of other roles; it must be a member of none', diag USING ERRCODE = 'AIP05';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relowner = diag_oid)
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = diag_oid)
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = diag_oid) THEN
    RAISE EXCEPTION 'ai_prism: role % owns objects in this database; it must own none', diag USING ERRCODE = 'AIP05';
  END IF;
  -- privileges outside ai_prism (tables, functions, schemas, the database, default ACLs)
  IF EXISTS (
       SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
        WHERE a.grantee = diag_oid AND c.relnamespace <> 'ai_prism'::regnamespace)
     OR EXISTS (
       SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
        WHERE a.grantee = diag_oid AND p.pronamespace <> 'ai_prism'::regnamespace)
     OR EXISTS (
       SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) a
        WHERE a.grantee = diag_oid AND n.oid <> 'ai_prism'::regnamespace)
     OR EXISTS (
       SELECT 1 FROM pg_database d, aclexplode(d.datacl) a
        WHERE a.grantee = diag_oid AND d.datname = current_database())
     OR EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a WHERE a.grantee = diag_oid) THEN
    RAISE EXCEPTION 'ai_prism: role % holds privileges outside the ai_prism schema; revoke them or rename the role, then re-run', diag
      USING ERRCODE = 'AIP05';
  END IF;

  -- inside ai_prism: it keeps nothing from before, then gets exactly the four columns
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ai_prism FROM %I', diag);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA ai_prism FROM %I', diag);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ai_prism FROM %I', diag);
  EXECUTE format('REVOKE ALL ON SCHEMA ai_prism FROM %I', diag);
  EXECUTE format('GRANT USAGE ON SCHEMA ai_prism TO %I', diag);
  EXECUTE format('GRANT SELECT (tool_name, status, duration_ms, created_at) ON ai_prism.chat_tool_calls TO %I', diag);
  DROP POLICY IF EXISTS aipd_diag_read ON ai_prism.chat_tool_calls;
  EXECUTE format('CREATE POLICY aipd_diag_read ON ai_prism.chat_tool_calls FOR SELECT TO %I USING (true)', diag);

  -- SECURITY DEFINER helpers: not callable through PUBLIC (see the header)
  FOR fn IN SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.pronamespace = 'ai_prism'::regnamespace AND p.prosecdef LOOP
    FOR app IN
      SELECT rolname FROM pg_roles
       WHERE rolname <> diag AND rolname !~ '^pg_' AND has_table_privilege(oid, 'ai_prism.chat_sessions', 'INSERT')
    LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn.sig, app.rolname);
    END LOOP;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn.sig);
  END LOOP;
END
$up$;
