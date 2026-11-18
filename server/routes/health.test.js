// GET /api/health: 200 {status, db:'ok', version, commit, uptime_s} when a
// `SELECT 1` answers within 2 s, else 503 {status:'degraded'}. A slow database
// is faked; the probe must answer at the 2 s bound, and concurrent probes share
// one in-flight check instead of stacking connections.
//
//   node --test server/routes/health.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import express from 'express'

import { createHealthHandler, dbPing, HEALTH_DB_TIMEOUT_MS } from './health.js'

const PKG = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

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

test('the database bound is 2 s', () => {
  assert.equal(HEALTH_DB_TIMEOUT_MS, 2000)
})

test('healthy database: 200 with exactly status, db, version, commit, uptime_s', async () => {
  const s = await serve(createHealthHandler({ ping: async () => {}, env: { AI_PRISM_COMMIT: 'abc1234' } }))
  try {
    const res = await fetch(s.url)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(Object.keys(body).sort(), ['commit', 'db', 'status', 'uptime_s', 'version'])
    assert.equal(body.status, 'ok')
    assert.equal(body.db, 'ok')
    assert.equal(body.version, PKG.version)
    assert.equal(body.commit, 'abc1234')
    assert.ok(Number.isInteger(body.uptime_s) && body.uptime_s >= 0)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  } finally {
    await s.close()
  }
})

test('no commit configured: commit is null', async () => {
  const s = await serve(createHealthHandler({ ping: async () => {}, env: {} }))
  try {
    assert.equal((await (await fetch(s.url)).json()).commit, null)
  } finally {
    await s.close()
  }
})

test('failing database: 503 with exactly {status:"degraded"}', async () => {
  const s = await serve(createHealthHandler({ ping: async () => { throw new Error('ECONNREFUSED ana@example.com') }, env: {} }))
  try {
    const res = await fetch(s.url)
    assert.equal(res.status, 503)
    assert.deepEqual(await res.json(), { status: 'degraded' })
  } finally {
    await s.close()
  }
})

test('slow database: 503 at the 2 s bound, not later', async () => {
  const s = await serve(createHealthHandler({ ping: () => new Promise(() => {}), env: {} }))
  try {
    const t0 = Date.now()
    const res = await fetch(s.url)
    const elapsed = Date.now() - t0
    assert.equal(res.status, 503)
    assert.deepEqual(await res.json(), { status: 'degraded' })
    assert.ok(elapsed >= 1900, `answered after ${elapsed} ms, before the bound`)
    assert.ok(elapsed < 3000, `answered after ${elapsed} ms, past the bound`)
  } finally {
    await s.close()
  }
})

test('concurrent probes against a slow database share one check', async () => {
  let calls = 0
  let release
  // the first check hangs until released; any later one answers at once
  const ping = () => {
    calls++
    return calls === 1 ? new Promise((r) => (release = r)) : Promise.resolve()
  }
  const s = await serve(createHealthHandler({ ping, env: {}, timeoutMs: 100 }))
  try {
    const [a, b, c] = await Promise.all([fetch(s.url), fetch(s.url), fetch(s.url)])
    assert.deepEqual([a.status, b.status, c.status], [503, 503, 503])
    // the hung check is still in flight: a new probe joins it, no new connection
    assert.equal((await fetch(s.url)).status, 503)
    assert.equal(calls, 1)
    // once it settles, the next probe runs a fresh check
    release()
    await new Promise((r) => setImmediate(r))
    assert.equal((await fetch(s.url)).status, 200)
    assert.equal(calls, 2)
  } finally {
    await s.close()
  }
})

test('dbPing: SELECT 1 bounded server-side at 2 s, as the caller, on the shared pool path', async () => {
  const seen = []
  const fakeClient = { query: async (q) => (seen.push(q), { rows: [{ '?column?': 1 }] }) }
  const ping = dbPing({ withTx: async (email, token, fn) => (seen.push([email, token]), fn(fakeClient)) })
  await ping({ email: 'probe@example.com', token: 'tok' })
  // the server aborts the statement at the bound (SET LOCAL: gone with the
  // implicit transaction); query_timeout is only a client-side backstop
  assert.deepEqual(seen, [['probe@example.com', 'tok'], { text: 'SET LOCAL statement_timeout = 2000; SELECT 1', query_timeout: 3000 }])
})
