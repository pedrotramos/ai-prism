// Least privilege for the app's service principal, and the owner hand-off that
// lets migration 0002 move a database with MIXED table ownership.
//
// Why a hand-off: on a deployed app the SP created most tables on its first
// request, while the deploying identity created app_admins (bundle/auto_config.py
// seeds the first admin before the app ever runs). ALTER TABLE … SET SCHEMA needs
// the owner of each table, and neither identity can give its tables to the other
// (neither is a member of the other's role, and no one administers the SP role).
// So both hand their tables to a neutral NOLOGIN role, the "owner role":
//
//   1. prepare  (deploying identity, before the new code is published;
//                bundle/auto_config.py or `migrate.mjs prepare`): create the owner
//                role, become its member, give it CREATE on the database and on
//                public, hand it the deployer's app tables, and give the SP a
//                TEMPORARY membership in it.
//   2. 0002     (the SP at boot, through server/db/migrate.js): hand the SP's app
//                tables to the owner role, then as the owner role create
//                ai_prism and move every app table into it.
//   3. grants   (deploying identity, after the smoke; `migrate.mjs grants`, also
//                run by `migrate.mjs up --role`): USAGE + DML on the app
//                tables/sequences, SELECT on schema_migrations, default
//                privileges for later tables, no explicit grant on public, and
//                the SP's membership in the owner role revoked.
//
// After step 3 the SP owns nothing and is no member of the owner: it cannot
// DROP/ALTER app tables or create objects (threat model G2, privilege half).
// Steps 1 and 3 are idempotent and run on every deploy (a later migration may
// need the hand-off again).

// Every table 0002 moves: the 20 tables of 0001_baseline plus schema_migrations.
// Kept equal to the ARRAY[...] in 0002 up/down by server/schemaAiPrism.test.js.
export const APP_TABLES = Object.freeze([
  'app_admins',
  'app_mcp_catalog',
  'app_tool_policy',
  'chat_compactions',
  'chat_decks',
  'chat_documents',
  'chat_genie_conversations',
  'chat_images',
  'chat_message_embeddings',
  'chat_messages',
  'chat_sessions',
  'chat_spreadsheets',
  'chat_tool_calls',
  'deck_templates',
  'model_catalog_overrides',
  'schema_migrations',
  'skills',
  'usage_ledger',
  'user_image_model_selection',
  'user_mcp_connections',
  'user_template_selection',
])

export const DEFAULT_OWNER_ROLE = 'ai_prism_owner'

/**
 * The owner role name: ai_prism_owner. AI_PRISM_OWNER_ROLE overrides it for
 * tests and scratch databases only: bundle/auto_config.py creates the role
 * under the fixed name (_OWNER_ROLE), so a deployment must not change it.
 */
export function ownerRoleName(env = process.env) {
  const v = String(env.AI_PRISM_OWNER_ROLE || '').trim()
  return v || DEFAULT_OWNER_ROLE
}

const IDENT_RE = /^[A-Za-z0-9_@.+-]{1,63}$/
function checkRoleName(kind, name) {
  if (!name || !IDENT_RE.test(name)) throw new Error(`grants: invalid ${kind} role name ${JSON.stringify(name)}`)
  return name
}
const q = (name) => `"${name.replace(/"/g, '""')}"`

// Step 1, as ONE statement so bundle/auto_config.py (Python, psycopg2) runs the
// very same text: the Python copy is compared byte for byte by a test. Inputs
// come from two transaction-local settings, ai_prism.app_role and
// ai_prism.owner_role. Idempotent.
export const PREPARE_HANDOFF_SQL = `DO $prepare$
DECLARE
  owner_role text := coalesce(nullif(current_setting('ai_prism.owner_role', true), ''), 'ai_prism_owner');
  app_role text := nullif(current_setting('ai_prism.app_role', true), '');
  app_tables text[] := ARRAY['app_admins', 'app_mcp_catalog', 'app_tool_policy', 'chat_compactions', 'chat_decks',
    'chat_documents', 'chat_genie_conversations', 'chat_images', 'chat_message_embeddings', 'chat_messages',
    'chat_sessions', 'chat_spreadsheets', 'chat_tool_calls', 'deck_templates', 'model_catalog_overrides',
    'schema_migrations', 'skills', 'usage_ledger', 'user_image_model_selection', 'user_mcp_connections',
    'user_template_selection'];
  t record;
BEGIN
  IF app_role IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE EXCEPTION 'prepare: the app role % does not exist (create it first: databricks_create_role)', coalesce(app_role, '(unset)')
      USING ERRCODE = '42704';
  END IF;
  IF app_role = current_user THEN
    RAISE EXCEPTION 'prepare: run it as the database owner, not as the app role %', app_role USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = owner_role) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN', owner_role);
  END IF;
  EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', owner_role);
  EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', current_database(), owner_role);
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA public TO %I', owner_role);
  FOR t IN
    SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'ai_prism') AND c.relname = ANY (app_tables)
       AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', t.nspname, t.relname, owner_role);
  END LOOP;
  EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET TRUE', owner_role, app_role);
END
$prepare$;
`

// Step 2, first half, run by server/db/migrate.js as the SESSION identity (no
// SET ROLE) before any pending migration when it acts through the owner role:
// this identity's app tables go to the owner role, so every migration (the
// repair run of the idempotent 0001 included, whose ALTER TABLE … IF NOT EXISTS
// still needs the table's owner) finds them owned by the role it runs as.
// Reads ai_prism.owner_role. Idempotent; a no-op when this identity owns none.
export const HAND_OVER_SESSION_TABLES_SQL = `DO $handover$
DECLARE
  owner_role text := nullif(current_setting('ai_prism.owner_role', true), '');
  app_tables text[] := ARRAY['app_admins', 'app_mcp_catalog', 'app_tool_policy', 'chat_compactions', 'chat_decks',
    'chat_documents', 'chat_genie_conversations', 'chat_images', 'chat_message_embeddings', 'chat_messages',
    'chat_sessions', 'chat_spreadsheets', 'chat_tool_calls', 'deck_templates', 'model_catalog_overrides',
    'schema_migrations', 'skills', 'usage_ledger', 'user_image_model_selection', 'user_mcp_connections',
    'user_template_selection'];
  t record;
BEGIN
  IF owner_role IS NULL THEN
    RETURN;
  END IF;
  FOR t IN
    SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'ai_prism') AND c.relname = ANY (app_tables)
       AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = session_user)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', t.nspname, t.relname, owner_role);
  END LOOP;
END
$handover$;
`

/** Step 1 (see the module header). Runs in its own transaction on `c`. */
export async function prepareOwnerHandoff(c, { role, owner, env = process.env } = {}) {
  checkRoleName('app', role)
  const ownerRole = checkRoleName('owner', owner || ownerRoleName(env))
  await c.query('BEGIN')
  try {
    await c.query(`SELECT set_config('ai_prism.app_role', $1, true), set_config('ai_prism.owner_role', $2, true)`, [
      role,
      ownerRole,
    ])
    await c.query(PREPARE_HANDOFF_SQL)
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  }
  return { owner: ownerRole }
}

async function one(c, sql, params) {
  return (await c.query(sql, params)).rows[0]
}

/**
 * Step 3 (see the module header): the app role's least-privilege grants on
 * ai_prism, idempotent. Refuses to touch anything before 0002 has created the
 * schema. Returns { revokedHandoff, defaultPrivileges }.
 */
export async function applyAppGrants(c, { role, owner, env = process.env, log = console } = {}) {
  checkRoleName('app', role)
  const ownerRole = checkRoleName('owner', owner || ownerRoleName(env))
  const facts = await one(
    c,
    `SELECT current_user AS me, current_database() AS db,
            EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS role_exists,
            to_regnamespace('ai_prism') IS NOT NULL AS schema_exists,
            (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
              WHERE c.relnamespace = to_regnamespace('ai_prism') AND c.relname = 'chat_sessions') AS table_owner`,
    [role]
  )
  if (!facts.role_exists) throw new Error(`grants: the app role ${role} does not exist`)
  if (facts.me === role) throw new Error(`grants: connected as the app role ${role}; run it as the table owner`)
  if (!facts.schema_exists || !facts.table_owner) {
    throw new Error(
      'grants: the ai_prism schema is not there yet (migration 0002 not applied); ' +
        'run `node scripts/migrate.mjs up` (or let the app apply it on its first request) and then grants again'
    )
  }
  const r = q(role)
  await c.query('BEGIN')
  try {
    await c.query(`GRANT USAGE ON SCHEMA ai_prism TO ${r}`)
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ai_prism TO ${r}`)
    // the runner reads the applied versions at boot; it never writes them as the app role
    await c.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ai_prism.schema_migrations FROM ${r}`)
    await c.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ai_prism TO ${r}`)
    // nothing explicit left on public: the old per-request grants (ensureSpGrants)
    // and bundle/auto_config.py gave USAGE + CREATE there. The vector type still
    // resolves through PUBLIC's USAGE, which is never touched.
    await c.query(`REVOKE ALL ON SCHEMA public FROM ${r}`)
    // bundle/auto_config.py before W1-5 also gave it CREATE on the database
    // (CREATE SCHEMA); the owner role keeps its own (prepare)
    await c.query(`REVOKE CREATE ON DATABASE ${q(facts.db)} FROM ${r}`)
    await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${r}`)
    await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${r}`)
    // tables a later migration creates (as the table owner) come with the same DML
    const canSetOwner = await one(c, `SELECT pg_has_role(current_user, $1, 'SET') AS ok`, [facts.table_owner])
    let defaultPrivileges = false
    if (canSetOwner.ok) {
      const o = q(facts.table_owner)
      await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA ai_prism GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${r}`)
      await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA ai_prism GRANT USAGE, SELECT ON SEQUENCES TO ${r}`)
      defaultPrivileges = true
    } else {
      log.warn(`grants: cannot set default privileges for ${facts.table_owner} (not a member); later tables need another grants run`)
    }
    // close the hand-off: the SP keeps DML only. REVOKE needs ADMIN on the
    // owner role, which the identity that ran prepare (it created the role) has;
    // another identity cannot close it and is told so instead of failing the grants.
    const member = await one(
      c,
      `SELECT EXISTS (SELECT 1 FROM pg_auth_members m
                        JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
                       WHERE g.rolname = $1 AND u.rolname = $2) AS yes,
              EXISTS (SELECT 1 FROM pg_auth_members m
                        JOIN pg_roles g ON g.oid = m.roleid
                       WHERE g.rolname = $1 AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                         AND m.admin_option) AS admin`,
      [ownerRole, role]
    )
    let revokedHandoff = false
    if (member.yes && member.admin) {
      await c.query(`REVOKE ${q(ownerRole)} FROM ${r}`)
      revokedHandoff = true
    } else if (member.yes) {
      log.warn(
        `grants: ${role} is still a member of ${ownerRole} (the owner hand-off) and ${facts.me} has no ADMIN on it; ` +
          'run grants as the identity that ran prepare (the deploying identity)'
      )
    }
    await c.query('COMMIT')
    return { revokedHandoff, handoffOpen: member.yes && !revokedHandoff, defaultPrivileges }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  }
}
