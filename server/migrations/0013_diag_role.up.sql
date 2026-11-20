-- 0013_diag_role: a read-only diagnostic role for operators (F1, round-3 shape: docs/adr).
--
-- Diagnosing slow tools used to need an identity that bypasses row-level security
-- (docs/operations.md §6.7). ai_prism_diag is the least-privilege path: a NOLOGIN role an
-- operator is granted (`migrate.mjs diag-grant --role R`, WITH INHERIT FALSE, SET TRUE) and
-- enters with SET ROLE. It reads FOUR columns of tool calls across all users (tool_name,
-- status, duration_ms, created_at) and nothing else.
--
--   no ai_prism   the role has NO usage on the ai_prism schema, so it can name nothing there:
--                 no table, no SECURITY DEFINER helper, present or future
--   the view      ai_prism_diag.chat_tool_calls: a security_invoker view of the four columns, in
--                 its own schema (the only schema the role can use). The role also holds the
--                 column grant on the base table, because a security_invoker view checks the
--                 caller's privileges and RLS on it (the view lacks `arguments`; so does the grant)
--   aipd_diag_read   permissive, SELECT, TO the role, USING (true). Literally `true`: the planner
--                 folds the table's other permissive policies (an EXISTS over other tables the
--                 role cannot read) to true. A non-constant expression here would make the role
--                 fail on those tables
--   aipd_diag_guard  RESTRICTIVE, SELECT, TO the role: a session whose LOGIN identity (session_user)
--                 writes tool calls (the app SP), is a member of the table owner (the owner role,
--                 the deploying identity) or is a superuser sees 0 rows through the role, however
--                 it got there (SET ROLE or any inheritance path). Role grants cannot be vetoed
--                 inside PostgreSQL, so membership is NOT the boundary; this policy is. diag-grant's
--                 membership checks are only an early, readable error
--   allow-list    after the grants, pg_shdepend (what DROP ROLE consults) must show exactly the
--                 objects above for the role; anything else raises AIP05 naming the object
--
-- Names: ai_prism_diag is a CONSTANT. Only a scratch/test database may use
-- ai_prism_diag_test_<a-z0-9>+ (ai_prism.diag_role); anything else raises AIP05.
-- The role is a CLUSTER object; creating it needs CREATEROLE, which the app's SP lacks. If it is
-- missing and cannot be created (the SP applying migrations at boot) the migration applies WITHOUT
-- it (NOTICE: the diagnostic path is unavailable) and `migrate.mjs diag-grant` (deploying identity)
-- creates it and applies this same body.
--
-- A pre-existing role is normalized INSIDE ai_prism (everything it held there is revoked first; that
-- tightening is one-way and the down does not restore it) and refused (AIP05) if it is not a plain
-- NOLOGIN role, is a member of other roles, or holds/owns anything else.
-- This migration never changes the ACL of an object it did not create.
-- Needs PostgreSQL >= 15 (security_invoker); diag-grant needs >= 16 (WITH INHERIT FALSE).
--
-- Idempotent. Down: 0013_diag_role.down.sql (keeps the cluster role).
DO $up$
DECLARE
  guc text := nullif(current_setting('ai_prism.diag_role', true), '');
  diag text := 'ai_prism_diag';
  owner_role text := nullif(current_setting('ai_prism.owner_role', true), '');
  use_owner boolean := coalesce(current_setting('ai_prism.use_owner_role', true), 'off') = 'on' AND owner_role IS NOT NULL;
  r record;
  s record;
  diag_oid oid;
  tbl_owner text;
  bad text;
  this_db oid := (SELECT oid FROM pg_database WHERE datname = current_database());
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

  SELECT pg_get_userbyid(relowner) INTO tbl_owner FROM pg_class WHERE oid = 'ai_prism.chat_tool_calls'::regclass;

  -- 1. inside ai_prism it keeps nothing from before, and has no usage on the schema
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ai_prism FROM %I', diag);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA ai_prism FROM %I', diag);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ai_prism FROM %I', diag);
  EXECUTE format('REVOKE ALL ON SCHEMA ai_prism FROM %I', diag);

  -- 2. its own schema: ours or fail closed
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ai_prism_diag') THEN
    IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'ai_prism_diag') <> tbl_owner THEN
      RAISE EXCEPTION 'ai_prism: schema ai_prism_diag exists with another owner' USING ERRCODE = 'AIP05';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'ai_prism_diag'::regnamespace AND NOT (relname = 'chat_tool_calls' AND relkind = 'v'))
       OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'ai_prism_diag'::regnamespace) THEN
      RAISE EXCEPTION 'ai_prism: schema ai_prism_diag holds objects other than the chat_tool_calls view' USING ERRCODE = 'AIP05';
    END IF;
  ELSE
    EXECUTE format('CREATE SCHEMA ai_prism_diag AUTHORIZATION %I', tbl_owner);
  END IF;

  -- 3. the view
  DROP VIEW IF EXISTS ai_prism_diag.chat_tool_calls;
  CREATE VIEW ai_prism_diag.chat_tool_calls WITH (security_invoker = true) AS
    SELECT tool_name, status, duration_ms, created_at FROM ai_prism.chat_tool_calls;
  EXECUTE format('ALTER VIEW ai_prism_diag.chat_tool_calls OWNER TO %I', tbl_owner);
  REVOKE ALL ON ai_prism_diag.chat_tool_calls FROM PUBLIC;

  -- 4. grants, normalized first
  EXECUTE format('REVOKE ALL ON SCHEMA ai_prism_diag FROM %I', diag);
  EXECUTE format('REVOKE ALL ON ai_prism_diag.chat_tool_calls FROM %I', diag);
  EXECUTE format('GRANT USAGE ON SCHEMA ai_prism_diag TO %I', diag);
  EXECUTE format('GRANT SELECT ON ai_prism_diag.chat_tool_calls TO %I', diag);
  EXECUTE format('GRANT SELECT (tool_name, status, duration_ms, created_at) ON ai_prism.chat_tool_calls TO %I', diag);

  -- 5. policies
  DROP POLICY IF EXISTS aipd_diag_read ON ai_prism.chat_tool_calls;
  DROP POLICY IF EXISTS aipd_diag_guard ON ai_prism.chat_tool_calls;
  EXECUTE format('CREATE POLICY aipd_diag_read ON ai_prism.chat_tool_calls FOR SELECT TO %I USING (true)', diag);
  EXECUTE format($f$CREATE POLICY aipd_diag_guard ON ai_prism.chat_tool_calls AS RESTRICTIVE FOR SELECT TO %I
    USING ((SELECT NOT pg_has_role(session_user, c.relowner, 'MEMBER')
                AND NOT has_table_privilege(session_user, c.oid, 'INSERT, UPDATE, DELETE')
              FROM pg_catalog.pg_class c WHERE c.oid = 'ai_prism.chat_tool_calls'::regclass))$f$, diag);

  -- 6. exhaustive check: everything the role depends on (pg_shdepend, as DROP ROLE sees it) in this
  --    database or the shared catalogs must be in the allow-list above
  SELECT string_agg(pg_describe_object(d.classid, d.objid, d.objsubid) || ' [' || d.deptype::text || ']', '; ') INTO bad
    FROM pg_shdepend d
   WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = diag_oid AND d.dbid IN (0, this_db)
     AND NOT (
       (d.classid = 'pg_namespace'::regclass AND d.objid = 'ai_prism_diag'::regnamespace AND d.objsubid = 0 AND d.deptype = 'a')
       OR (d.classid = 'pg_class'::regclass AND d.objid = 'ai_prism_diag.chat_tool_calls'::regclass AND d.objsubid = 0 AND d.deptype = 'a')
       OR (d.classid = 'pg_class'::regclass AND d.objid = 'ai_prism.chat_tool_calls'::regclass AND d.deptype = 'a'
           AND d.objsubid IN (SELECT attnum FROM pg_attribute WHERE attrelid = 'ai_prism.chat_tool_calls'::regclass
                               AND attname IN ('tool_name', 'status', 'duration_ms', 'created_at')))
       OR (d.classid = 'pg_policy'::regclass AND d.deptype = 'r'
           AND d.objid IN (SELECT oid FROM pg_policy WHERE polrelid = 'ai_prism.chat_tool_calls'::regclass AND polname IN ('aipd_diag_read', 'aipd_diag_guard')))
     );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ai_prism: role % holds or owns more than the diagnostic path allows: %; revoke it, or rename the role, then re-run', diag, bad
      USING ERRCODE = 'AIP05';
  END IF;
END
$up$;
