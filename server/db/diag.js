// F1: `migrate.mjs diag-grant`: create (if needed) the read-only diagnostic role of
// migration 0013 and grant it to an operator role. Run by the deploying identity.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownerRoleName } from './grants.js'

export const DEFAULT_DIAG_ROLE = 'ai_prism_diag'
const IDENT_RE = /^[A-Za-z0-9_@.+-]{1,63}$/
const UP_SQL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0013_diag_role.up.sql')

export function diagRoleName(env = process.env) {
  return String(env.AI_PRISM_DIAG_ROLE || '').trim() || DEFAULT_DIAG_ROLE
}

const q = (n) => `"${String(n).replace(/"/g, '""')}"`

// Never the app's service principal: by name (DATABRICKS_CLIENT_ID) or by its grants
// (DML on the session table, which applyAppGrants gives it and nobody else needs).
export async function isAppRole(c, role, env = process.env) {
  if (env.DATABRICKS_CLIENT_ID && env.DATABRICKS_CLIENT_ID === role) return true
  const r = await c.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class k, aclexplode(k.relacl) a
        WHERE k.oid = to_regclass('ai_prism.chat_sessions') AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
          AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')) AS app`,
    [role]
  )
  return r.rows[0].app
}

export async function grantDiagRole(c, { role, env = process.env, owner = ownerRoleName(env), diag = diagRoleName(env) } = {}) {
  if (!IDENT_RE.test(String(role || ''))) throw new Error(`diag-grant: invalid role name ${JSON.stringify(role)}`)
  if (!IDENT_RE.test(diag)) throw new Error(`diag-grant: invalid diagnostic role name ${JSON.stringify(diag)}`)
  if ((await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rowCount === 0) throw new Error(`diag-grant: role ${role} does not exist`)
  if (await isAppRole(c, role, env)) throw new Error(`diag-grant: ${role} is the app's service principal (or holds its grants); it never gets the diagnostic role`)
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
      [diag, owner, viaOwner ? 'on' : 'off']
    )
    await c.query(fs.readFileSync(UP_SQL, 'utf8'))
    const ok = (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1 AND NOT rolbypassrls AND NOT rolsuper AND NOT rolcanlogin`, [diag])).rowCount
    if (!ok) throw new Error(`diag-grant: the diagnostic role ${diag} is missing (this identity cannot create roles) or is not a plain NOLOGIN role`)
    await c.query('SET LOCAL ROLE NONE')
    await c.query(`GRANT ${q(diag)} TO ${q(role)}`)
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  }
  return { diag, role }
}
