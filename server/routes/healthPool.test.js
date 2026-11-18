// /api/health against a real Postgres pool (QA round 1, blocking issue 1): a
// health check that times out must not leave its pooled connection busy with
// the abandoned query, and must not leave any session setting behind.
//
// Needs a local Postgres (the `npm run local:up` database by default, or PG*
// variables); without one the suite is skipped, like server/isolation.test.js.
//
//   node --test server/routes/healthPool.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import pg from 'pg'

import { createHealthHandler, dbPing } from './health.js'

const env = process.env
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const opts = {
  host: env.PGHOST || '127.0.0.1',
  port: Number(env.PGPORT || 55432),
  user: env.PGUSER || 'ai_prism',
  password: env.PGPASSWORD || 'ai_prism',
  database: env.PGDATABASE || 'ai_prism',
  ssl: false,
  connectionTimeoutMillis: 2000,
}

async function skipReason() {
  if (!LOCAL_HOSTS.has(opts.host) && env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${opts.host} is not local`
  const c = new pg.Client(opts)
  try {
    await c.connect()
    return null
  } catch (e) {
    return `no Postgres at ${opts.host}:${opts.port} (${e.code || e.message}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}
const SKIP = await skipReason()

// one pooled slot, the same acquire/release shape as server/db/pool.js withPool
const pool = SKIP ? null : new pg.Pool({ ...opts, max: 1 })
after(async () => {
  await pool?.end()
})
async function withPool(_email, _token, fn) {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}
// the database is slow: the probe statement sleeps 2 s. Everything else the
// health check sends (its own bound, if any) reaches the server unchanged.
async function withSlowPool(email, token, fn) {
  return withPool(email, token, (client) =>
    fn({ query: (q) => client.query({ ...q, text: String(q.text).replace(/SELECT 1\b/, 'SELECT pg_sleep(2)') }) })
  )
}

async function serve(handler) {
  const app = express()
  app.get('/api/health', (req, _res, next) => {
    req.email = 'probe@example.com'
    req.token = 'tok'
    next()
  }, handler)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  return { url: `http://127.0.0.1:${server.address().port}/api/health`, close: () => new Promise((r) => server.close(r)) }
}

async function timed(fn) {
  const t0 = performance.now()
  const out = await fn()
  return { out, ms: performance.now() - t0 }
}

test('a timed-out health check frees its pooled connection at the bound', { skip: SKIP || false }, async () => {
  const s = await serve(createHealthHandler({ ping: dbPing({ withTx: withSlowPool, timeoutMs: 300 }), timeoutMs: 300, env: {} }))
  try {
    const probe = await timed(() => fetch(s.url))
    assert.equal(probe.out.status, 503)
    assert.deepEqual(await probe.out.json(), { status: 'degraded' })
    assert.ok(probe.ms < 1000, `health answered after ${Math.round(probe.ms)} ms`)
    // the only pool slot must not still be running the abandoned pg_sleep(2)
    const next = await timed(() => withPool(null, null, (c) => c.query('SELECT 1 AS ok')))
    assert.equal(next.out.rows[0].ok, 1)
    assert.ok(next.ms < 250, `the next query waited ${Math.round(next.ms)} ms for the abandoned health query`)
  } finally {
    await s.close()
  }
})

test('the health bound does not leak onto the pooled session (timeout and success)', { skip: SKIP || false }, async () => {
  await dbPing({ withTx: withSlowPool, timeoutMs: 200 })({ email: 'p', token: 't' }).catch(() => {})
  assert.equal((await withPool(null, null, (c) => c.query('SHOW statement_timeout'))).rows[0].statement_timeout, '0')
  await dbPing({ withTx: withPool, timeoutMs: 2000 })({ email: 'p', token: 't' })
  assert.equal((await withPool(null, null, (c) => c.query('SHOW statement_timeout'))).rows[0].statement_timeout, '0')
})

test('a healthy database still answers 200 through the real pool', { skip: SKIP || false }, async () => {
  const s = await serve(createHealthHandler({ ping: dbPing({ withTx: withPool }), env: {} }))
  try {
    const r = await fetch(s.url)
    assert.equal(r.status, 200)
    assert.equal((await r.json()).db, 'ok')
  } finally {
    await s.close()
  }
})
