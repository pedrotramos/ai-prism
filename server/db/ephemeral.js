// Temporary (ephemeral) chats (W3-6, migration 0011): the data layer.
//
// A temporary chat is a normal chat while it is open and leaves no trace after:
// no embeddings, no memory extraction, not searchable, deleted when the user
// leaves it (the client calls DELETE /api/sessions/:id) and by the retention
// sweep once idle for EPHEMERAL_IDLE_MS (server/retention.js).
//
// Audit is COUNT ONLY: starting one writes a single admin_audit row in the
// transaction that creates the session, with no session id, user, title or
// content (RLS policy aipe_started_insert accepts nothing else). Admins read
// the count; nothing in this module can return a session id or a title.
import { withTx } from './pool.js'

export const EPHEMERAL_STARTED_ACTION = 'ephemeral.started'
// the sweep's idle rule; the database policy (aip_session_swept) floors it at 24 h
export const EPHEMERAL_IDLE_MS = 24 * 60 * 60 * 1000

/** Inside the transaction that inserts an ephemeral session: the count-only audit row. */
export async function recordEphemeralStarted(c) {
  await c.query(`INSERT INTO admin_audit (actor_hash, action, target, details) VALUES ('system', $1, NULL, '{}'::jsonb)`, [
    EPHEMERAL_STARTED_ACTION,
  ])
}

/**
 * Whether the caller's session is a temporary chat. A session the caller cannot
 * see answers false (nothing to protect there, nothing to learn about it).
 * Callers that gate a write on this FAIL CLOSED: a throw means "do not write".
 */
export async function isEphemeralSession(userEmail, userToken, sessionId) {
  if (sessionId == null || !/^\d{1,18}$/.test(String(sessionId))) return false
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT ephemeral FROM chat_sessions WHERE id = $1`, [sessionId])
    return r.rows[0]?.ephemeral === true
  })
}

/**
 * How many temporary chats were started: { total, last24h, last7d }. Counts only
 * (admin_audit rows of one action); needs the admin flag, else all zero.
 */
export async function countEphemeralChats(userEmail, userToken, { admin = false } = {}) {
  return withTx(
    userEmail,
    userToken,
    async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS total,
                (count(*) FILTER (WHERE at >= now() - interval '24 hours'))::int AS last24h,
                (count(*) FILTER (WHERE at >= now() - interval '7 days'))::int AS last7d
           FROM admin_audit WHERE action = $1`,
        [EPHEMERAL_STARTED_ACTION]
      )
      const x = r.rows[0]
      return { total: x.total, last24h: x.last24h, last7d: x.last7d }
    },
    { admin }
  )
}
