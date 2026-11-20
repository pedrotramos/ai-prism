// F1: `migrate.mjs diag-grant`: create (if needed) the read-only diagnostic role of
// migration 0013 and grant it to an operator role. Run by the deploying identity.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownerRoleName } from './grants.js'

export const DIAG_ROLE = 'ai_prism_diag'
// The name is a constant. A scratch/test database may use ai_prism_diag_test_<a-z0-9>+ (never
// the owner role, never an app role), and only with LOCAL_DEV_MODE=1.
const TEST_ROLE_RE = /^ai_prism_diag_test_[a-z0-9]+$/
const IDENT_RE = /^[A-Za-z0-9_@.+-]{1,63}$/
const UP_SQL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0013_diag_role.up.sql')

export function diagRoleName(env = process.env) {
  const v = String(env.AI_PRISM_DIAG_ROLE || '').trim()
  if (!v) return DIAG_ROLE
  if (env.LOCAL_DEV_MODE !== '1' || !TEST_ROLE_RE.test(v)) {
    throw new Error('diag-grant: the diagnostic role name is fixed (ai_prism_diag); AI_PRISM_DIAG_ROLE is only honored on a test database (LOCAL_DEV_MODE=1 and ai_prism_diag_test_<a-z0-9>+)')
  }
  return v
}

const q = (n) => `"${String(n).replace(/"/g, '""')}"`

// Roles the diagnostic role must never reach, directly or through any membership chain: the
// app's service principal (DATABRICKS_CLIENT_ID), the owner role, and every role that holds
// DML on the session table (what applyAppGrants gives the app role).
async function appRoles(c, { env, owner, exclude }) {
  const r = await c.query(
    `SELECT rolname FROM pg_roles
      WHERE rolname <> $2 AND rolname !~ '^pg_'
        AND (rolname = ANY ($1::text[])
             OR has_table_privilege(oid, 'ai_prism.chat_sessions', 'INSERT')
             OR has_table_privilege(oid, 'ai_prism.chat_sessions', 'UPDATE')
             OR has_table_privilege(oid, 'ai_prism.chat_sessions', 'DELETE'))`,
    [[env.DATABRICKS_CLIENT_ID, owner].filter(Boolean), exclude]
  )
  return r.rows.map((x) => x.rolname)
}

// pg_auth_members closure: every role `name` is, directly or not, a member of (itself included).
const ANCESTORS = `
  WITH RECURSIVE anc(r) AS (
    SELECT oid FROM pg_roles WHERE rolname = $1
    UNION
    SELECT m.roleid FROM anc a JOIN pg_auth_members m ON m.member = a.r
  ) SELECT pg_get_userbyid(r) AS name FROM anc`

async function ancestors(c, name) {
  return new Set((await c.query(ANCESTORS, [name])).rows.map((x) => x.name))
}

// Why `target` may not get the diagnostic role, or null: it is, contains (is a parent group
// of) or is contained by (is a member of) an app role, in either direction.
export async function relatedToAppRole(c, target, { env = process.env, owner = ownerRoleName(env), diag = DIAG_ROLE } = {}) {
  const apps = await appRoles(c, { env, owner, exclude: diag })
  const up = await ancestors(c, target)
  for (const a of apps) {
    if (a === target) return `${target} is the app's service principal or an app-owned role (${a})`
    if (up.has(a)) return `${target} is a member of ${a}, an app role`
    if ((await ancestors(c, a)).has(target)) return `${a}, an app role, is a member of ${target}`
  }
  return null
}

export async function grantDiagRole(c, { role, env = process.env, owner = ownerRoleName(env), diag = diagRoleName(env) } = {}) {
  if (!IDENT_RE.test(String(role || ''))) throw new Error(`diag-grant: invalid role name ${JSON.stringify(role)}`)
  if ((await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rowCount === 0) throw new Error(`diag-grant: role ${role} does not exist`)
  if (role === diag) throw new Error(`diag-grant: ${role} is the diagnostic role itself`)
  const viaOwner = (
    await c.query(
      `SELECT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                       WHERE g.rolname = $1 AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND m.set_option) AS ok`,
      [owner]
    )
  ).rows[0].ok
  await c.query('BEGIN')
  try {
    await c.query(
      `SELECT set_config('ai_prism.diag_role', $1, true), set_config('ai_prism.owner_role', $2, true), set_config('ai_prism.use_owner_role', $3, true)`,
      [diag === DIAG_ROLE ? '' : diag, owner, viaOwner ? 'on' : 'off']
    )
    const why = await relatedToAppRole(c, role, { env, owner, diag })
    if (why) throw new Error(`diag-grant: refused: ${why}. The diagnostic role is for a human operator role that is unrelated to the app`)
    await c.query(fs.readFileSync(UP_SQL, 'utf8'))
    const ok = (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1 AND NOT rolbypassrls AND NOT rolsuper AND NOT rolcanlogin`, [diag])).rowCount
    if (!ok) throw new Error(`diag-grant: the diagnostic role ${diag} is missing (this identity cannot create roles) or is not a plain NOLOGIN role`)
    await c.query('SET LOCAL ROLE NONE')
    await c.query(`GRANT ${q(diag)} TO ${q(role)}`)
    // after the grant no app role may reach the diagnostic role (a group path the walk above missed)
    for (const a of await appRoles(c, { env, owner, exclude: diag })) {
      if ((await ancestors(c, a)).has(diag)) throw new Error(`diag-grant: refused: ${a}, an app role, would reach ${diag} through ${role}`)
    }
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  }
  return { diag, role }
}
