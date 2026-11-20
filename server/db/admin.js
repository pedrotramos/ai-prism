// Org settings and the admin audit trail (W2-5, migration 0007).
//
// app_settings is key → jsonb; an absent key is its default. Everyone reads it
// (org instructions go into every turn); writes need the admin flag, and each
// write records its admin_audit row in the same transaction. The audit list is
// admin-only (RLS: aip_admin_read) and pages newest first by id.
import { withTx } from './pool.js'
import { actorHash, decodeCursor, encodeCursor, recordAdminAction } from '../audit.js'

export const RETENTION_DAYS_MAX = 3650
export const ORG_INSTRUCTIONS_MAX_CHARS = 8000
export const AUDIT_PAGE_DEFAULT = 50
export const AUDIT_PAGE_MAX = 200

const KEYS = { retentionDays: 'retention_days', orgInstructions: 'org_instructions' }
const LAST_SWEEP_KEY = 'retention_last_sweep_at'

/**
 * { patch } with the validated fields, or { error }. retentionDays: integer 0
 * (off) or 1..3650. orgInstructions: string ≤ 8000 chars, trimmed ('' clears).
 */
export function validateSettingsPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' }
  const unknown = Object.keys(body).filter((k) => !(k in KEYS))
  if (unknown.length) return { error: `unknown setting(s): ${unknown.join(', ')}` }
  const patch = {}
  if ('retentionDays' in body) {
    const d = body.retentionDays
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > RETENTION_DAYS_MAX) {
      return { error: `retentionDays must be an integer, 0 (off) or 1..${RETENTION_DAYS_MAX}` }
    }
    patch.retentionDays = d
  }
  if ('orgInstructions' in body) {
    if (typeof body.orgInstructions !== 'string') return { error: 'orgInstructions must be a string' }
    const text = body.orgInstructions.trim()
    if (text.length > ORG_INSTRUCTIONS_MAX_CHARS) return { error: `orgInstructions must be at most ${ORG_INSTRUCTIONS_MAX_CHARS} characters` }
    patch.orgInstructions = text
  }
  if (!Object.keys(patch).length) return { error: 'nothing to update' }
  return { patch }
}

function shapeSettings(rows) {
  const by = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  const days = by[KEYS.retentionDays]
  return {
    retentionDays: Number.isInteger(days) && days >= 0 && days <= RETENTION_DAYS_MAX ? days : 0,
    orgInstructions: typeof by[KEYS.orgInstructions] === 'string' ? by[KEYS.orgInstructions] : '',
    retentionLastSweepAt: typeof by[LAST_SWEEP_KEY] === 'string' ? by[LAST_SWEEP_KEY] : null,
  }
}

/** Reads the settings on an open transaction (any identity may read them). */
export async function readAppSettings(c) {
  const r = await c.query(`SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`, [[...Object.values(KEYS), LAST_SWEEP_KEY]])
  return shapeSettings(r.rows)
}

export async function getAppSettings(userEmail, userToken) {
  return withTx(userEmail, userToken, (c) => readAppSettings(c))
}

/** Applies a validated patch and its audit row in one transaction (admin flag required by RLS). */
export async function updateAppSettings(userEmail, userToken, patch, { admin = false } = {}) {
  return withTx(
    userEmail,
    userToken,
    async (c) => {
      for (const [field, key] of Object.entries(KEYS)) {
        if (!(field in patch)) continue
        await c.query(
          `INSERT INTO app_settings (key, value, updated_by_hash, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_hash = EXCLUDED.updated_by_hash, updated_at = NOW()`,
          [key, JSON.stringify(patch[field]), actorHash(userEmail)]
        )
      }
      const details = {}
      if ('retentionDays' in patch) details.retentionDays = patch.retentionDays
      if ('orgInstructions' in patch) details.orgInstructionsChars = patch.orgInstructions.length
      await recordAdminAction(c, userEmail, { action: 'settings.update', target: 'app_settings', details })
      return readAppSettings(c)
    },
    { admin }
  )
}

/**
 * One page of the trail, newest first: { items, nextCursor }. `cursor` must be
 * valid (decodeCursor) or null. Needs the admin flag (non-admins see no rows).
 */
export async function listAdminAudit(userEmail, userToken, { cursor = null, limit = AUDIT_PAGE_DEFAULT } = {}, { admin = false } = {}) {
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || AUDIT_PAGE_DEFAULT, 1), AUDIT_PAGE_MAX)
  const after = cursor ? decodeCursor(cursor) : null
  if (cursor && !after) throw Object.assign(new Error('invalid cursor'), { code: 'BAD_CURSOR' })
  return withTx(
    userEmail,
    userToken,
    async (c) => {
      const r = await c.query(
        `SELECT id, at, actor_hash, action, target, details FROM admin_audit
          WHERE ($1::bigint IS NULL OR id < $1::bigint)
            AND action <> 'ephemeral.started' -- counted, not listed (W3-6)
          ORDER BY id DESC LIMIT $2`,
        [after ? after.id : null, n + 1]
      )
      const rows = r.rows.slice(0, n)
      const items = rows.map((x) => ({
        id: String(x.id),
        at: x.at,
        actorHash: x.actor_hash,
        action: x.action,
        target: x.target,
        details: x.details || {},
      }))
      const last = rows.at(-1)
      return { items, nextCursor: r.rows.length > n && last ? encodeCursor({ at: last.at, id: last.id }) : null }
    },
    { admin }
  )
}
