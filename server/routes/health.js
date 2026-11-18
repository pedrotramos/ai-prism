// GET /api/health: does this process answer, and does the database?
//
// 200 { status:'ok', db:'ok', version, commit, uptime_s } when `SELECT 1`
// answers within HEALTH_DB_TIMEOUT_MS; otherwise 503 { status:'degraded' } (the
// reason goes to the log, never to the response).
//
// The check uses the same pool and identity rule as every other query
// (withClient as the caller; behind `auth` like /api/keepalive) and can never
// hold a connection hostage: the query carries a 2 s query_timeout, the probe
// answers at the 2 s bound whatever the pool does, and at most one check is in
// flight per process: probes that arrive while one is pending join it instead
// of opening more connections against a database that is already slow.
//
// AppKit's own GET /health (process liveness only) stays as it is.
import fs from 'node:fs'
import { auth } from '../middleware/index.js'
import { withClient } from '../db.js'
import { logger } from '../log.js'

export const HEALTH_DB_TIMEOUT_MS = 2000

// package.json sits at the app root, one level above both server/ (dev) and
// server-dist/ (bundled): resolved from the working directory the app runs in.
// (In the CJS bundle import.meta.url is undefined: that candidate just fails.)
function readVersion() {
  for (const p of [() => new URL('../../package.json', import.meta.url), () => `${process.cwd()}/package.json`]) {
    try {
      const v = JSON.parse(fs.readFileSync(p(), 'utf8')).version
      if (v) return v
    } catch {
      // next candidate
    }
  }
  return null
}

/** `SELECT 1` as the caller, through the shared pool path, with the 2 s bound. */
export function dbPing({ withClient: wc = withClient, timeoutMs = HEALTH_DB_TIMEOUT_MS } = {}) {
  return (req) => wc(req.email, req.token, (c) => c.query({ text: 'SELECT 1', query_timeout: timeoutMs }))
}

export function createHealthHandler({ ping = dbPing(), timeoutMs = HEALTH_DB_TIMEOUT_MS, env = process.env } = {}) {
  const version = readVersion()
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
