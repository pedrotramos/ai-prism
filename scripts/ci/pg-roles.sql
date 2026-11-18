-- CI / local test fixture (W2-1): the app role the isolation suite connects as.
--
-- The CI Postgres user (and the `npm run local:up` one) is a SUPERUSER, and a
-- superuser skips row-level security entirely: a suite running db.js as it would
-- prove nothing about the policies. So the suite runs db.js as ai_prism_app, the
-- shape of the app's service principal on Lakebase: LOGIN, no SUPERUSER, no
-- BYPASSRLS, owns nothing. Its DML grants come from applyAppGrants
-- (server/db/grants.js), the same code `migrate.mjs grants` runs on a deploy.
--
-- Run by .github/workflows/ci.yml before the tests (psql -f), and by
-- server/isolation.test.js itself when the role is missing. Idempotent. The
-- password is the CI service's throwaway password, never a real credential.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_prism_app') THEN
    CREATE ROLE ai_prism_app LOGIN PASSWORD 'ai_prism';
  END IF;
  -- re-asserted on every run: the role must never gain a way around the policies
  ALTER ROLE ai_prism_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
END
$roles$;
