// Editable cross-conversation memory (W2-4, migration 0006): the data layer.
//
// Every function runs inside withTx with the caller's identity, so RLS
// (aip_owner on user_memories) limits it to the caller's rows; the WHERE
// user_email clauses stay as defence in depth. The admin kill-switch
// (app_tool_policy key 'memory' = false) is read IN THE SAME transaction as the
// memory rows — one round trip per turn for the injection read, no cache, so an
// admin's "off" applies to the very next turn on every instance.
//
// Memory content is personal data: nothing here logs it.
import { withTx } from './pool.js'

export const MEMORY_POLICY_KEY = 'memory'
export const SENSITIVE_CATEGORIES = Object.freeze(['health', 'politics', 'religion', 'personal_finance'])
export const MEMORY_CATEGORIES = Object.freeze(['preference', 'profile', 'work', 'project', 'other', ...SENSITIVE_CATEGORIES])
export const MEMORY_PER_USER_MAX = 200

/** A refusal the routes map to a status: disabled (403), duplicate / limit (409). */
export class MemoryError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

const isSensitive = (category) => SENSITIVE_CATEGORIES.includes(category)

// enabled unless an admin stored an explicit false (a missing row = default on)
const ENABLED_SQL = `NOT EXISTS (SELECT 1 FROM app_tool_policy WHERE tool_key = '${MEMORY_POLICY_KEY}' AND enabled = false)`

async function enabledIn(c) {
  return (await c.query(`SELECT ${ENABLED_SQL} AS enabled`)).rows[0].enabled === true
}

function shape(r) {
  return {
    id: String(r.id),
    content: r.content,
    category: r.category,
    sensitive: isSensitive(r.category),
    sensitiveOptIn: !!r.sensitive_opt_in,
    source: r.source,
    sessionId: r.session_id == null ? null : String(r.session_id),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  }
}

const COLS = 'id, content, category, sensitive_opt_in, source, session_id, created_at, updated_at'

/** Whether memory is on for the org (the kill-switch). */
export async function memoryEnabled(userEmail, userToken) {
  return withTx(userEmail, userToken, (c) => enabledIn(c))
}

/** { enabled, items } — items is [] when the kill-switch is off (nothing is read). */
export async function listMemories(userEmail, userToken) {
  return withTx(userEmail, userToken, async (c) => {
    if (!(await enabledIn(c))) return { enabled: false, items: [] }
    const r = await c.query(`SELECT ${COLS} FROM user_memories WHERE user_email = $1 ORDER BY updated_at DESC, id DESC`, [userEmail])
    return { enabled: true, items: r.rows.map(shape) }
  })
}

/**
 * The entries a turn may see, newest first, or null when the kill-switch is
 * off. One statement: the policy check and the sensitive opt-in gate are in
 * the WHERE clause, so a sensitive row without consent never leaves the
 * database for a prompt (server/memory.js filters again before rendering).
 */
export async function loadInjectableMemories(userEmail, userToken, limit = 10) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT ${ENABLED_SQL} AS enabled,
              (SELECT coalesce(json_agg(m ORDER BY m.updated_at DESC, m.id DESC), '[]'::json)
                 FROM (SELECT ${COLS} FROM user_memories
                        WHERE user_email = $1 AND (category <> ALL($2::text[]) OR sensitive_opt_in)
                        ORDER BY updated_at DESC, id DESC LIMIT $3) m) AS items`,
      [userEmail, SENSITIVE_CATEGORIES, Math.max(1, Math.min(Number(limit) || 10, 50))]
    )
    const row = r.rows[0]
    if (row.enabled !== true) return null
    return (row.items || []).map(shape)
  })
}

async function countMine(c, userEmail) {
  return (await c.query(`SELECT count(*)::int AS n FROM user_memories WHERE user_email = $1`, [userEmail])).rows[0].n
}

/** Creates one user-typed entry; throws MemoryError disabled | limit | duplicate. */
export async function createMemory(userEmail, userToken, { content, category = 'other', sensitiveOptIn = false }) {
  return withTx(userEmail, userToken, async (c) => {
    if (!(await enabledIn(c))) throw new MemoryError('disabled')
    if ((await countMine(c, userEmail)) >= MEMORY_PER_USER_MAX) throw new MemoryError('limit')
    const r = await c.query(
      `INSERT INTO user_memories (user_email, content, category, sensitive_opt_in, source)
       VALUES ($1, $2, $3, $4, 'user')
       ON CONFLICT (user_email, md5(lower(btrim(content)))) DO NOTHING
       RETURNING ${COLS}`,
      [userEmail, content, category, isSensitive(category) && sensitiveOptIn === true]
    )
    if (!r.rows.length) throw new MemoryError('duplicate')
    return shape(r.rows[0])
  })
}

/**
 * Applies a validated patch to one of the caller's entries; null when it is not
 * theirs (or does not exist). A category change resets the opt-in unless the
 * same patch grants it for the new (sensitive) category; the opt-in is never
 * stored on a non-sensitive entry.
 */
export async function updateMemory(userEmail, userToken, id, patch) {
  return withTx(userEmail, userToken, async (c) => {
    if (!(await enabledIn(c))) throw new MemoryError('disabled')
    const cur = (await c.query(`SELECT ${COLS} FROM user_memories WHERE id = $1 AND user_email = $2 FOR UPDATE`, [id, userEmail])).rows[0]
    if (!cur) return null
    const content = 'content' in patch ? patch.content : cur.content
    const category = 'category' in patch ? patch.category : cur.category
    let optIn = 'sensitiveOptIn' in patch ? patch.sensitiveOptIn === true : 'category' in patch && patch.category !== cur.category ? false : !!cur.sensitive_opt_in
    if (!isSensitive(category)) optIn = false
    try {
      const r = await c.query(
        `UPDATE user_memories SET content = $3, category = $4, sensitive_opt_in = $5, updated_at = NOW()
          WHERE id = $1 AND user_email = $2 RETURNING ${COLS}`,
        [id, userEmail, content, category, optIn]
      )
      return r.rows[0] ? shape(r.rows[0]) : null
    } catch (e) {
      if (e.code === '23505') throw new MemoryError('duplicate')
      throw e
    }
  })
}

/** Deletes one of the caller's entries (works with the kill-switch off: erasure is always possible). */
export async function deleteMemory(userEmail, userToken, id) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(`DELETE FROM user_memories WHERE id = $1 AND user_email = $2`, [id, userEmail])
    return r.rowCount > 0
  })
}

/** "Forget everything": deletes all of the caller's entries; returns the count. */
export async function deleteAllMemories(userEmail, userToken) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(`DELETE FROM user_memories WHERE user_email = $1`, [userEmail])
    return r.rowCount
  })
}

/**
 * Stores what extraction learned from one turn (already filtered: no sensitive
 * category). Re-checks the kill-switch and the per-user cap in the same
 * transaction; a known fact is skipped. Returns how many rows were written.
 */
export async function saveExtractedMemories(userEmail, userToken, sessionId, items) {
  if (!Array.isArray(items) || !items.length) return 0
  return withTx(userEmail, userToken, async (c) => {
    if (!(await enabledIn(c))) return 0
    let room = MEMORY_PER_USER_MAX - (await countMine(c, userEmail))
    let written = 0
    for (const it of items) {
      if (room <= 0) break
      if (isSensitive(it.category)) continue // never, even if a caller forgot to filter
      const r = await c.query(
        `INSERT INTO user_memories (user_email, content, category, source, session_id)
         VALUES ($1, $2, $3, 'extracted', $4)
         ON CONFLICT (user_email, md5(lower(btrim(content)))) DO NOTHING`,
        [userEmail, it.content, it.category, sessionId == null ? null : sessionId]
      )
      written += r.rowCount
      room -= r.rowCount
    }
    return written
  })
}
