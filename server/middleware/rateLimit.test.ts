// Per-user token buckets: 120 API requests/min and 12 turns/min by default,
// keyed by the proxy-forwarded identity, 429 + Retry-After when empty.
//
//   node --test server/middleware/rateLimit.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Request, Response, NextFunction } from 'express'
import { rateLimit, tokenBucket, isTurnRequest } from './rateLimit.ts'

function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

interface FakeRes {
  headers: Record<string, string>
  statusCode: number
  body: { code?: string } | undefined
  setHeader(k: string, v: unknown): void
  status(c: number): FakeRes
  json(b: FakeRes['body']): FakeRes
}

function fakeRes(): FakeRes {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = String(v)
    },
    status(c) {
      this.statusCode = c
      return this
    },
    json(b) {
      this.body = b
      return this
    },
  }
}

function req(method: string, path: string, { email = 'ana@example.com' as string | null, ip = '10.0.0.1' } = {}) {
  const headers = email ? { 'x-forwarded-email': email } : {}
  return { method, path, originalUrl: path, headers, ip }
}

/** Runs one request through the middleware: 'next' when it passed, else the 429 response. */
function run(mw: (req: Request, res: Response, next: NextFunction) => unknown, r: ReturnType<typeof req>): FakeRes {
  const res = fakeRes()
  let passed = false
  // the fakes carry only what the middleware reads
  mw(r as unknown as Request, res as unknown as Response, () => {
    passed = true
  })
  // typed cast: the tests compare the result with 'next' (assert.equal) and read the 429 fields otherwise
  return (passed ? 'next' : res) as FakeRes
}

test('API: 120 requests in a minute pass, the 121st is 429 with Retry-After', () => {
  const clock = fakeClock()
  const mw = rateLimit({ env: {}, now: clock.now })
  for (let i = 0; i < 120; i++) assert.equal(run(mw, req('GET', '/api/sessions')), 'next', `request ${i + 1}`)
  const res = run(mw, req('GET', '/api/sessions'))
  assert.notEqual(res, 'next')
  assert.equal(res.statusCode, 429)
  assert.equal(res.body!.code, 'rate_limited')
  // one token refills every 0.5 s (120/min): the client is told to wait 1 s
  assert.equal(res.headers['retry-after'], '1')
})

test('API: the bucket refills with time', () => {
  const clock = fakeClock()
  const mw = rateLimit({ env: {}, now: clock.now })
  for (let i = 0; i < 120; i++) run(mw, req('GET', '/api/sessions'))
  assert.notEqual(run(mw, req('GET', '/api/sessions')), 'next')
  clock.advance(1000) // two tokens at 120/min
  assert.equal(run(mw, req('GET', '/api/sessions')), 'next')
})

test('turns: 12 per minute pass, the 13th is 429 with Retry-After', () => {
  const clock = fakeClock()
  const mw = rateLimit({ env: {}, now: clock.now })
  for (let i = 0; i < 12; i++) assert.equal(run(mw, req('POST', '/api/chat')), 'next', `turn ${i + 1}`)
  const res = run(mw, req('POST', '/api/sessions/7/continue'))
  assert.equal(res.statusCode, 429)
  assert.equal(res.body!.code, 'rate_limited')
  // 12/min = one token every 5 s
  assert.equal(res.headers['retry-after'], '5')
  // plain API calls still have their own (much larger) budget
  assert.equal(run(mw, req('GET', '/api/sessions')), 'next')
})

test('the key is the forwarded user: same IP, different users do not share a bucket', () => {
  const mw = rateLimit({ env: { RATE_LIMIT_TURNS_PER_MIN: '2' }, now: fakeClock().now })
  run(mw, req('POST', '/api/chat', { email: 'ana@example.com' }))
  run(mw, req('POST', '/api/chat', { email: 'ana@example.com' }))
  assert.equal(run(mw, req('POST', '/api/chat', { email: 'ana@example.com' })).statusCode, 429)
  assert.equal(run(mw, req('POST', '/api/chat', { email: 'bruno@example.com' })), 'next')
})

test('the key is the forwarded user: one user from several IPs shares one bucket (case-insensitive)', () => {
  const mw = rateLimit({ env: { RATE_LIMIT_TURNS_PER_MIN: '2' }, now: fakeClock().now })
  run(mw, req('POST', '/api/chat', { email: 'ana@example.com', ip: '10.0.0.1' }))
  run(mw, req('POST', '/api/chat', { email: 'Ana@Example.com', ip: '10.0.0.2' }))
  assert.equal(run(mw, req('POST', '/api/chat', { email: 'ana@example.com', ip: '10.0.0.3' })).statusCode, 429)
})

test('without a forwarded identity the IP is the key', () => {
  const mw = rateLimit({ env: { RATE_LIMIT_TURNS_PER_MIN: '1' }, now: fakeClock().now })
  assert.equal(run(mw, req('POST', '/api/chat', { email: null, ip: '10.0.0.1' })), 'next')
  assert.equal(run(mw, req('POST', '/api/chat', { email: null, ip: '10.0.0.1' })).statusCode, 429)
  assert.equal(run(mw, req('POST', '/api/chat', { email: null, ip: '10.0.0.2' })), 'next')
})

test('env override: RATE_LIMIT_API_PER_MIN and RATE_LIMIT_TURNS_PER_MIN', () => {
  const mw = rateLimit({ env: { RATE_LIMIT_API_PER_MIN: '5', RATE_LIMIT_TURNS_PER_MIN: '3' }, now: fakeClock().now })
  for (let i = 0; i < 3; i++) assert.equal(run(mw, req('POST', '/api/chat')), 'next')
  assert.equal(run(mw, req('POST', '/api/chat')).statusCode, 429) // 4th turn (4th API call)
  assert.equal(run(mw, req('GET', '/api/sessions')), 'next') // 5th API call
  assert.equal(run(mw, req('GET', '/api/sessions')).statusCode, 429) // 6th API call
})

test('env override: 0 turns the limit off', () => {
  const mw = rateLimit({ env: { RATE_LIMIT_API_PER_MIN: '0', RATE_LIMIT_TURNS_PER_MIN: '0' }, now: fakeClock().now })
  for (let i = 0; i < 500; i++) assert.equal(run(mw, req('POST', '/api/chat')), 'next')
})

test('an invalid env value falls back to the default', () => {
  const mw = rateLimit({ env: { RATE_LIMIT_TURNS_PER_MIN: 'lots' }, now: fakeClock().now })
  for (let i = 0; i < 12; i++) assert.equal(run(mw, req('POST', '/api/chat')), 'next')
  assert.equal(run(mw, req('POST', '/api/chat')).statusCode, 429)
})

test('only /api is limited (the SPA and its assets are not)', () => {
  const mw = rateLimit({ env: { RATE_LIMIT_API_PER_MIN: '1' }, now: fakeClock().now })
  for (let i = 0; i < 5; i++) assert.equal(run(mw, req('GET', '/assets/index.js')), 'next')
  assert.equal(run(mw, req('GET', '/api/me')), 'next')
  assert.equal(run(mw, req('GET', '/api/me')).statusCode, 429)
  // Express routes case-insensitively: /API/me reaches the same handler, so it counts too
  assert.equal(run(mw, req('GET', '/API/me')).statusCode, 429)
})

test('the CSP report endpoint is not charged to the user API budget', () => {
  const mw = rateLimit({ env: { RATE_LIMIT_API_PER_MIN: '1' }, now: fakeClock().now })
  for (let i = 0; i < 5; i++) assert.equal(run(mw, req('POST', '/api/csp-report')), 'next')
  assert.equal(run(mw, req('GET', '/api/me')), 'next')
})

test('isTurnRequest: the routes that start a model call', () => {
  for (const p of [
    '/api/chat',
    '/api/sessions/12/continue',
    '/api/sessions/12/messages/34/regenerate',
    '/api/sessions/12/compact',
    '/api/decks/5/tweak',
    '/api/spreadsheets/5/tweak',
    '/api/documents/5/tweak',
    '/api/chat/',
  ]) {
    assert.equal(isTurnRequest({ method: 'POST', path: p }), true, p)
  }
  for (const [m, p] of [
    ['GET', '/api/chat'],
    ['POST', '/api/sessions/12/messages/34/edit'],
    ['PATCH', '/api/decks/5'],
    ['POST', '/api/decks/5/export-html'],
    ['POST', '/api/chats'],
  ]) {
    assert.equal(isTurnRequest({ method: m, path: p }), false, `${m} ${p}`)
  }
})

test('tokenBucket: memory stays bounded under many distinct keys', () => {
  const clock = fakeClock()
  const b = tokenBucket({ perMinute: 10, now: clock.now, maxKeys: 100 })
  for (let i = 0; i < 1000; i++) b.take(`k${i}`)
  assert.ok(b.size() <= 100, `size ${b.size()}`)
})
