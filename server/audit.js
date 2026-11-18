// Admin audit trail (W2-5, migration 0007, threat model G8).
//
// Every admin mutation writes one admin_audit row INSIDE the transaction of the
// mutation (recordAdminAction(c, …) from the db function that changes the
// data), so a mutation can never commit without its row, nor a row without its
// mutation. A refused or no-op mutation (0 rows, RLS denial) writes nothing.
//
// The actor is stored as a hash (userHash: the first 12 hex of sha256 of the
// lowercased e-mail, the same value as `user_hash` in the request logs, so an
// incident can join the two), never as the e-mail. Targets that are a user
// principal are hashed the same way; details are redacted (no e-mails, tokens
// or SQL) and capped. The sweep writes as SYSTEM_ACTOR.
//
// The table is append-only for the app role: no UPDATE/DELETE policy, and the
// grants revoke those privileges too. Only admins read it (GET /api/admin/audit).
import { redact, userHash } from './log.js'

export const SYSTEM_ACTOR = 'system'
export const AUDIT_DETAILS_MAX_CHARS = 4000
const TARGET_MAX_CHARS = 200
const STRING_MAX_CHARS = 500

/** The stored actor: a hash of the e-mail, 'system' for the sweep. */
export function actorHash(email) {
  if (email === SYSTEM_ACTOR) return SYSTEM_ACTOR
  return userHash(email) || 'unknown'
}

/** An admin principal as an audit target: user e-mails hashed, group names kept. */
export function principalTarget(principal, kind) {
  return kind === 'group' ? `group:${String(principal).slice(0, TARGET_MAX_CHARS - 6)}` : `user:${userHash(principal) || 'unknown'}`
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
})
