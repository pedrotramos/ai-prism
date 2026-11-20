// Admin audit trail (W2-5, migration 0007, threat model G8).
//
// Every admin mutation writes one admin_audit row INSIDE the transaction of the
// mutation (recordAdminAction(c, …) from the db function that changes the
// data), so a mutation can never commit without its row, nor a row without its
// mutation. A refused or no-op mutation (0 rows, RLS denial) writes nothing.
//
// The actor is stored as a hash, never as the e-mail. Since W2-17 (2026-11-19)
// the hash is KEYED: 'h2:' + the first 12 hex of HMAC-SHA256(APP_AUDIT_HASH_KEY,
// lowercased e-mail), so a dictionary of plausible e-mails cannot reverse it
// without the app secret. Without the key (local dev, tests, a deployment that
// did not wire the secret) the legacy scheme stays: the first 12 hex of the
// unsalted sha256 (userHash, the `user_hash` of the request logs), no prefix,
// and ONE warning is logged at boot. Rows written before W2-17 are legacy rows
// and keep their value (no re-keying); the prefix tells the schemes apart.
// Targets that are a user principal are hashed the same way; details are
// redacted (no e-mails, tokens or SQL) and capped. The sweep writes as
// SYSTEM_ACTOR, the deploy's first-admin seed as BOOTSTRAP_ADDED_BY.
//
// The table is append-only for the app role: no UPDATE/DELETE policy, and the
// grants revoke those privileges too. Only admins read it (GET /api/admin/audit).
import { createHmac } from 'node:crypto'
import { logger, redact, userHash } from './log.js'

export const SYSTEM_ACTOR = 'system'
// app_admins.added_by of the deployer seeded by bundle/auto_config.py, and the
// actor of that grant's audit row (recordBootstrapAdminSeeds)
export const BOOTSTRAP_ADDED_BY = 'auto-config'
export const AUDIT_HASH_KEY_ENV = 'APP_AUDIT_HASH_KEY'
export const KEYED_HASH_PREFIX = 'h2:'
export const AUDIT_DETAILS_MAX_CHARS = 4000
const TARGET_MAX_CHARS = 200
const STRING_MAX_CHARS = 500

// Read once, at boot: the secret does not change under a running process.
const BOOT_KEY = normKey(process.env[AUDIT_HASH_KEY_ENV])

function normKey(v) {
  return typeof v === 'string' && v.trim() ? v : ''
}

/** The audit hash of an e-mail: keyed ('h2:…') with a key, legacy without; null without an e-mail. */
export function auditHash(email, { key = BOOT_KEY } = {}) {
  if (!email || typeof email !== 'string') return null
  const k = normKey(key)
  if (!k) return userHash(email)
  return KEYED_HASH_PREFIX + createHmac('sha256', k).update(email.trim().toLowerCase()).digest('hex').slice(0, 12)
}

let keyWarned = false
/** Logs, once per process, that the audit hash is not keyed. Never prints a key. */
export function warnIfNoAuditHashKey({ key = BOOT_KEY, log = logger } = {}) {
  if (keyWarned || normKey(key)) return false
  keyWarned = true
  log.warn(
    `${AUDIT_HASH_KEY_ENV} is not set: admin_audit actor hashes use the legacy unsalted scheme, ` +
      'reversible by dictionary. Wire the app secret (bundle/optional/audit-hash-key-secret.yml.example).'
  )
  return true
}
warnIfNoAuditHashKey()

/** The stored actor: a hash of the e-mail, 'system' for the sweep. */
export function actorHash(email, opts = {}) {
  if (email === SYSTEM_ACTOR) return SYSTEM_ACTOR
  return auditHash(email, opts) || 'unknown'
}

/** An admin principal as an audit target: user e-mails hashed, group names kept. */
export function principalTarget(principal, kind, opts = {}) {
  return kind === 'group' ? `group:${String(principal).slice(0, TARGET_MAX_CHARS - 6)}` : `user:${auditHash(principal, opts) || 'unknown'}`
}

/** Every target the same principal may carry: the current scheme first, then the legacy one. */
export function principalTargetCandidates(principal, kind, opts = {}) {
  const current = principalTarget(principal, kind, opts)
  const legacy = principalTarget(principal, kind, { key: '' })
  return current === legacy ? [current] : [current, legacy]
}

function clean(v, depth = 0) {
  if (v == null || typeof v === 'boolean') return v ?? null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') return redact(v).slice(0, STRING_MAX_CHARS)
  if (depth >= 3) return null
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1))
  if (typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v).slice(0, 30)) out[redact(k).slice(0, 60)] = clean(x, depth + 1)
    return out
  }
  return null
}

/** JSON-safe, redacted, capped details. Over the cap: a marker instead of a cut JSON. */
export function cleanDetails(details) {
  const out = clean(details && typeof details === 'object' ? details : {}) || {}
  const text = JSON.stringify(out)
  if (text.length <= AUDIT_DETAILS_MAX_CHARS) return out
  return { truncated: true, keys: Object.keys(out).slice(0, 30) }
}

/** Writes one audit row on `c` (the mutation's transaction). */
export async function recordAdminAction(c, actorEmail, { action, target = null, details = {} }) {
  await c.query(`INSERT INTO admin_audit (actor_hash, action, target, details) VALUES ($1, $2, $3, $4::jsonb)`, [
    actorHash(actorEmail),
    String(action),
    target == null ? null : redact(String(target)).slice(0, TARGET_MAX_CHARS),
    JSON.stringify(cleanDetails(details)),
  ])
}

// ---- the deploy's first-admin seed -------------------------------------------------
// bundle/auto_config.py seeds the deployer into app_admins (added_by
// BOOTSTRAP_ADDED_BY) BEFORE the app is published: on a first install neither
// the ai_prism schema nor admin_audit (migration 0007) exist yet, and the job
// does not hold the audit key. So the app records that grant here, right after
// its migrations (db.js ensureSchema), in a transaction with the admin flag and
// no user identity. Idempotent: one row per (principal, granted_at; a NULL
// created_at counts as one value), whatever
// hash scheme an earlier boot used; a deployer removed and seeded again by a
// later deploy is a new grant, so a new row. Before 0007 exists: nothing (the
// next boot writes it). The advisory lock keeps two booting instances from
// writing the same row twice. Returns the number of rows written.
const BOOTSTRAP_AUDIT_LOCK = 0x41495052_0817 // 'AIPR' + W2-17

function workspaceHost(env = process.env) {
  const raw = String(env.DATABRICKS_HOST || '').trim()
  if (!raw) return null
  try {
    return new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).host
  } catch {
    return null
  }
}

export async function recordBootstrapAdminSeeds(c, { key = BOOT_KEY, env = process.env } = {}) {
  const t = await c.query(`SELECT to_regclass('admin_audit') AS t`)
  if (!t.rows[0]?.t) return 0
  await c.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_AUDIT_LOCK])
  const seeds = await c.query(
    `SELECT principal, kind, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS granted_at
       FROM app_admins WHERE added_by = $1 ORDER BY created_at, principal`,
    [BOOTSTRAP_ADDED_BY]
  )
  let written = 0
  for (const s of seeds.rows) {
    const kind = s.kind === 'group' ? 'group' : 'user'
    const targets = principalTargetCandidates(s.principal, kind, { key })
    const seen = await c.query(
      `SELECT 1 FROM admin_audit WHERE action = 'admins.add' AND actor_hash = $1 AND target = ANY($2::text[])
          AND (details->>'granted_at') IS NOT DISTINCT FROM $3 LIMIT 1`,
      [BOOTSTRAP_ADDED_BY, targets, s.granted_at]
    )
    if (seen.rows.length) continue
    await c.query(`INSERT INTO admin_audit (actor_hash, action, target, details) VALUES ($1, 'admins.add', $2, $3::jsonb)`, [
      BOOTSTRAP_ADDED_BY,
      targets[0].slice(0, TARGET_MAX_CHARS),
      JSON.stringify(cleanDetails({ source: BOOTSTRAP_ADDED_BY, kind, granted_at: s.granted_at, host: workspaceHost(env) })),
    ])
    written++
  }
  return written
}

// ---- keyset cursor of GET /api/admin/audit ---------------------------------------
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

/** Opaque cursor for the row after which the next page starts. */
export function encodeCursor({ at, id }) {
  const iso = at instanceof Date ? at.toISOString() : new Date(at).toISOString()
  return Buffer.from(JSON.stringify({ at: iso, id: String(id) })).toString('base64url')
}

/** { at, id } or null when the cursor is not one of ours. */
export function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 200) return null
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!v || typeof v.at !== 'string' || !ISO_RE.test(v.at) || Number.isNaN(Date.parse(v.at))) return null
    if (typeof v.id !== 'string' || !/^\d{1,19}$/.test(v.id)) return null
    return { at: v.at, id: v.id }
  } catch {
    return null
  }
}

// ---- which admin routes mutate, and what they record ---------------------------------
// Every route behind requireAdmin that is not a plain read is listed here with
// the action(s) its db function records (null = no mutation). Routes where an
// admin can change org-wide rows without requireAdmin (global templates and
// skills) are listed too. server/settingsAudit.test.js fails when an admin
// route is missing, and proves each action is written in the mutation's
// transaction.
export const ADMIN_MUTATION_ROUTES = Object.freeze({
  'POST /api/admins': 'admins.add',
  'DELETE /api/admins/:principal': 'admins.remove',
  'PUT /api/admin/mcp-catalog/:name': 'mcp_catalog.upsert',
  'DELETE /api/admin/mcp-catalog/:name': 'mcp_catalog.delete',
  'POST /api/admin/mcp-catalog/inspect': null, // read-only probe of a service
  'POST /api/admin/web-search/verify': null, // probe: one search against the named chain entry; writes a usage row only, no setting
  'PUT /api/admin/tool-policy/:key': 'tool_policy.set',
  'POST /api/deck-templates/:id/scope': 'template.scope',
  'PATCH /api/deck-templates/:id': ['template.update'], // only when the row is global
  'DELETE /api/deck-templates/:id': ['template.delete'], // only when the row is global
  'PUT /api/admin/model-endpoints/:endpointId': 'model_endpoints.upsert',
  'PUT /api/admin/model-endpoints-order': 'model_endpoints.reorder',
  // a GET that writes: the first-open seed and the one-time stale-price cleanup
  'GET /api/admin/model-endpoints': ['model_endpoints.seed', 'model_endpoints.clear_prices'],
  'POST /api/skills': ['skill.upsert'], // only for scope 'global'
  'PUT /api/skills/:id': ['skill.upsert'],
  'POST /api/skills/upload': ['skill.upsert'],
  'DELETE /api/skills/:id': ['skill.delete'],
  'PUT /api/admin/settings': 'settings.update',
  'PUT /api/admin/tool-prices/:key': 'tool_price.set',
})
