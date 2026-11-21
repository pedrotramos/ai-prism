// GET /api/health: does this process answer, and does the database?
//
// 200 { status:'ok', db:'ok', version, commit, uptime_s } when `SELECT 1`
// answers within HEALTH_DB_TIMEOUT_MS; otherwise 503 { status:'degraded' } (the
// reason goes to the log, never to the response).
//
// The check uses the same pool and identity rule as every other query
// (withTx as the caller; behind `auth` like /api/keepalive) and can never
// hold a connection hostage: Postgres itself aborts the query at 2 s (see
// dbPing), the probe answers at the 2 s bound whatever the pool does, and at
// most one check is in
// flight per process: probes that arrive while one is pending join it instead
// of opening more connections against a database that is already slow.
//
// AppKit's own GET /health (process liveness only) stays as it is; it carries
// x-request-id too (server/appkit.js). `version` is server/version.js.
import { auth } from '../middleware/index.ts'
import { withTx } from '../db.ts'
import { logger } from '../log.ts'
import { APP_VERSION } from '../version.js'

export const HEALTH_DB_TIMEOUT_MS = 2000

/**
 * `SELECT 1` as the caller, through the shared pool path, bounded by the SERVER.
 *
 * A client-side timeout alone (pg's query_timeout) only stops waiting: Postgres
 * keeps running the statement, so the connection goes back to the pool still
 * busy and the next query on it waits behind the abandoned one. So the statement
 * carries its own `SET LOCAL statement_timeout`: Postgres aborts it at the bound
 * (57014) and the connection is free again. It runs inside withTx (the caller's
 * transaction, W2-1), so the setting ends with that transaction (on success and
 * on the abort, which rolls it back) and never leaks onto the pooled session. query_timeout stays as a
 * backstop for a server that does not answer at all.
 */
export function dbPing({ withTx: wc = withTx, timeoutMs = HEALTH_DB_TIMEOUT_MS } = {}) {
  const ms = Math.max(1, Math.floor(timeoutMs))
  const query = { text: `SET LOCAL statement_timeout = ${ms}; SELECT 1`, query_timeout: ms + 1000 }
  return (req) => wc(req.email, req.token, (c) => c.query({ ...query }))
}

export function createHealthHandler({ ping = dbPing(), timeoutMs = HEALTH_DB_TIMEOUT_MS, env = process.env } = {}) {
  const version = APP_VERSION
  let inflight = null

  function check(req) {
    if (!inflight) {
      inflight = Promise.resolve()
        .then(() => ping(req))
        .finally(() => {
          inflight = null
        })
      // a rejection that lands after every waiter timed out is still handled
      inflight.catch(() => {})
    }
    let timer
    const bound = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`database did not answer within ${timeoutMs} ms`)), timeoutMs)
    })
    return Promise.race([inflight, bound]).finally(() => clearTimeout(timer))
  }

  return async function healthHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store')
    try {
      await check(req)
    } catch (err) {
      logger.warn('health: database check failed', { err })
      return res.status(503).json({ status: 'degraded' })
    }
    res.json({
      status: 'ok',
      db: 'ok',
      version,
      commit: env.AI_PRISM_COMMIT || null,
      uptime_s: Math.floor(process.uptime()),
    })
  }
}

export default function registerHealthRoutes(app) {
  app.get('/api/health', auth, createHealthHandler())
}
