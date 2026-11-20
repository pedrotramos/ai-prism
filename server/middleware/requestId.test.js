// Request id: every response of the app carries `x-request-id`, an incoming
// value is honoured (when it is a sane id), and each /api request writes one
// access log line carrying that id.
//
// Runs against the real app (APPKIT_BOOT=1: no listener of its own, no database
// touched by these routes).
//
//   node --test server/middleware/requestId.test.js
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

process.env.APPKIT_BOOT = '1'
process.env.LOCAL_DEV_MODE = '1'

const { app } = await import('../index.js')
const { setLogWriter } = await import('../log.ts')

let server
let base
const lines = []
let prevWriter
before(async () => {
  prevWriter = setLogWriter((l) => lines.push(l))
  server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  setLogWriter(prevWriter)
  await new Promise((r) => server.close(r))
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('a response without an incoming id gets a fresh uuid', async () => {
  const res = await fetch(`${base}/api/no-such-route`)
  await res.arrayBuffer()
  assert.match(res.headers.get('x-request-id') || '', UUID)
})

test('two requests get two different ids', async () => {
  const a = await fetch(`${base}/api/no-such-route`)
  const b = await fetch(`${base}/api/no-such-route`)
  await a.arrayBuffer()
  await b.arrayBuffer()
  assert.notEqual(a.headers.get('x-request-id'), b.headers.get('x-request-id'))
})

test('an incoming x-request-id is honoured', async () => {
  const res = await fetch(`${base}/api/no-such-route`, { headers: { 'x-request-id': 'edge-abc-123' } })
  await res.arrayBuffer()
  assert.equal(res.headers.get('x-request-id'), 'edge-abc-123')
})

test('an unsafe incoming id is replaced, not echoed', async () => {
  const res = await fetch(`${base}/api/no-such-route`, { headers: { 'x-request-id': 'x'.repeat(300) } })
  await res.arrayBuffer()
  assert.match(res.headers.get('x-request-id') || '', UUID)
  const res2 = await fetch(`${base}/api/no-such-route`, { headers: { 'x-request-id': '<script>alert(1)</script>' } })
  await res2.arrayBuffer()
  assert.match(res2.headers.get('x-request-id') || '', UUID)
})

test('an early-refused request (CSRF 403) still carries the id', async () => {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json', 'x-request-id': 'csrf-probe-1' },
    body: '{}',
  })
  await res.arrayBuffer()
  assert.equal(res.status, 403)
  assert.equal(res.headers.get('x-request-id'), 'csrf-probe-1')
})

test('each /api request writes one access line with its id, route, status and duration', async () => {
  lines.length = 0
  const res = await fetch(`${base}/api/no-such-route?q=secret`, { headers: { 'x-request-id': 'access-1' } })
  await res.arrayBuffer()
  // the line is written on 'finish', which can land just after the client sees the body
  for (let i = 0; i < 50 && !lines.some((l) => l.includes('access-1')); i++) await new Promise((r) => setTimeout(r, 10))
  const mine = lines.map((l) => JSON.parse(l)).filter((o) => o.request_id === 'access-1')
  assert.equal(mine.length, 1)
  const o = mine[0]
  assert.equal(o.status, res.status)
  assert.equal(typeof o.duration_ms, 'number')
  assert.ok(o.duration_ms >= 0)
  assert.equal(o.route, 'GET /api/no-such-route')
  assert.ok(!JSON.stringify(o).includes('secret'), 'the query string is not logged')
})
