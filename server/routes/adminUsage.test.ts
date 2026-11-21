// GET /api/admin/usage/tools and PUT /api/admin/tool-prices/:key (N2): admin
// only, validated kind / period / price key, aggregates only (no e-mail, no
// session, nothing but counts and money, users as a keyed hash), the price
// editor audited and refreshing the price book. Identity is mocked and the
// database is a fake: no Postgres, no workspace. The policy itself is proven
// against a real Postgres in server/adminUsage.test.js.
//
//   node --test server/routes/adminUsage.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import type { AddressInfo } from 'node:net'
import { authed } from './authed.ts'

import registerAdminUsageRoutes, { parseToolKind, parsePriceKey, shapeToolUsage, TOOL_PRICE_PROVIDERS } from './adminUsage.ts'
import { auditHash } from '../audit.ts'

const ADMIN = 'admin@example.com'
const USER = 'user@example.com'
const TOKEN = 'fake-obo-token-not-a-secret'
const NOW = new Date('2026-11-18T12:00:00Z')
const EMAILS = ['ana@example.com', 'bruno@example.com']

function fakeAuth(req: Request, res: Response, next: NextFunction) {
  const email = req.headers['x-test-email'] as string
  if (!email) return res.status(401).json({ error: 'no identity' })
  authed(req).email = email
  authed(req).token = TOKEN
  next()
}
function fakeRequireAdmin(req: Request, res: Response, next: NextFunction) {
  if (authed(req).email === ADMIN) {
    authed(req).isAdmin = true
    return next()
  }
  res.status(403).json({ error: 'apenas administradores' })
}

const RAW = {
  totals: { calls: 10, pricedCalls: 6, unpricedCalls: 4, costUsd: 0.03 },
  byDay: [
    { day: '2026-11-17', calls: 4, unpricedCalls: 1, costUsd: 0.015 },
    { day: '2026-11-18', calls: 6, unpricedCalls: 3, costUsd: 0.015 },
  ],
  byProvider: [
    { provider: 'brave', calls: 6, unpricedCalls: 0, costUsd: 0.03 },
    { provider: 'databricks', calls: 4, unpricedCalls: 4, costUsd: 0 },
  ],
  topUsers: [
    { userEmail: EMAILS[0]!, calls: 7, costUsd: 0.02 },
    { userEmail: EMAILS[1]!, calls: 3, costUsd: 0.01 },
  ],
}

// the injected collaborators are typed loosely: each test hands in its own fake
type Dep = (...args: any[]) => any // any: test doubles with test-specific shapes
async function serve(over: { overrides?: Record<string, unknown>; raw?: unknown; deps?: Record<string, Dep | unknown> } = {}) {
  const calls: { aggregate: Array<{ email: string; token: string; args: unknown }>; setPrice: Array<{ email: string; key: string; per1kUsd: unknown; opts: unknown }>; refresh: unknown[] } = { aggregate: [], setPrice: [], refresh: [] }
  const overrides = over.overrides || { 'tool:web_search:brave': { priceIn: 5 }, 'tool:web_search': { priceIn: 2 } }
  const deps = {
    auth: fakeAuth,
    requireAdmin: fakeRequireAdmin,
    now: () => NOW,
    env: {},
    hash: (e: string) => `h2:${Buffer.from(e).toString('hex').slice(0, 12)}`,
    aggregate: async (email: string, token: string, args: unknown) => {
      calls.aggregate.push({ email, token, args })
      return over.raw || RAW
    },
    listToolPrices: async () => overrides,
    setToolPrice: async (email: string, token: string, key: string, per1kUsd: unknown, opts: unknown) => {
      calls.setPrice.push({ email, key, per1kUsd, opts })
    },
    refreshPrices: async (email: string, token: string) => {
      calls.refresh.push({ email })
    },
    ...over.deps,
  }
  const app = express()
  app.use(express.json())
  registerAdminUsageRoutes(app, deps as Parameters<typeof registerAdminUsageRoutes>[1])
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const hdr = (email: string, extra = {}) => ({ 'x-test-email': email, ...extra })
  return {
    calls,
    get: (p: string, email = ADMIN) => fetch(base + p, { headers: hdr(email) }),
    put: (p: string, body: unknown, email = ADMIN) =>
      fetch(base + p, { method: 'PUT', headers: hdr(email, { 'content-type': 'application/json' }), body: JSON.stringify(body) }),
    close: () => new Promise((r) => server.close(r)),
  }
}

// every key and every string/number anywhere in a JSON value
function* walk(v: unknown, keys: string[] = []): Generator<{ key: string | null; value: unknown }> {
  if (Array.isArray(v)) for (const x of v) yield* walk(x, keys)
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      yield { key: k, value: x }
      yield* walk(x, keys)
    }
  } else yield { key: null, value: v }
}

test('parseToolKind: an allowlist (web_search today), nothing else', () => {
  assert.equal(parseToolKind('web_search'), 'web_search')
  for (const bad of [undefined, '', 'chat', 'WEB_SEARCH', 'web_search ', ['web_search'], 'web_search;drop', '%']) {
    assert.equal(parseToolKind(bad), null, JSON.stringify(bad))
  }
})

test('parsePriceKey: web_search or web_search:<known provider id>, nothing else', () => {
  assert.equal(parsePriceKey('web_search'), 'web_search')
  for (const p of TOOL_PRICE_PROVIDERS) assert.equal(parsePriceKey(`web_search:${p}`), `web_search:${p}`)
  for (const p of ['databricks', 'mcp', 'brave', 'tavily', 'searxng', 'firecrawl-mcp']) assert.ok(TOOL_PRICE_PROVIDERS.includes(p), p)
  for (const bad of ['', 'web_search:', 'web_search:evil', 'tool:web_search', 'chat', 'web_search:brave:x', 'web_search:BRAVE', undefined, 7]) {
    assert.equal(parsePriceKey(bad), null, JSON.stringify(bad))
  }
})

test('shapeToolUsage: users only as a hash, estimate = unpriced calls × price / 1000 (null without a price), prices of what was seen', () => {
  const out = shapeToolUsage(RAW, {
    kind: 'web_search',
    period: { from: '2026-11-01', to: '2026-11-18' },
    overrides: { 'tool:web_search:brave': { priceIn: 5 }, 'tool:web_search': { priceIn: 2 } },
    env: {},
    hash: (e) => `h:${(e as string).length}`,
  })
  assert.deepEqual(out.topUsers, [
    { userHash: 'h:15', calls: 7, costUsd: 0.02 },
    { userHash: 'h:17', calls: 3, costUsd: 0.01 },
  ])
  const brave = out.byProvider.find((p) => p.provider === 'brave')
  assert.equal(brave!.pricePer1k, 5)
  assert.equal(brave!.estimatedUnpricedUsd, 0)
  const dbx = out.byProvider.find((p) => p.provider === 'databricks')
  assert.equal(dbx!.pricePer1k, 2, 'the kind-wide override applies to a provider without its own')
  assert.equal(dbx!.estimatedUnpricedUsd, (4 * 2) / 1000)
  assert.equal(out.prices.web_search, 2)
  assert.equal(out.prices['web_search:brave'], 5)
  assert.equal(out.prices['web_search:databricks'], null, 'an override of its own: none')
})

test('shapeToolUsage: without any price an unpriced estimate is null, not zero', () => {
  const out = shapeToolUsage(RAW, { kind: 'web_search', period: { from: 'a', to: 'b' }, overrides: {}, env: {}, hash: () => 'h' })
  const dbx = out.byProvider.find((p) => p.provider === 'databricks')
  assert.equal(dbx!.pricePer1k, null)
  assert.equal(dbx!.estimatedUnpricedUsd, null)
  assert.equal(out.byProvider.find((p) => p.provider === 'brave')!.pricePer1k, 5, 'the seed price applies')
})

test('GET /api/admin/usage/tools: non-admin gets 403 and the database is never asked', async () => {
  const s = await serve()
  try {
    const r = await s.get('/api/admin/usage/tools?kind=web_search', USER)
    assert.equal(r.status, 403)
    assert.equal(s.calls.aggregate.length, 0)
  } finally {
    await s.close()
  }
})

test('GET /api/admin/usage/tools: 400 bad_kind and bad_period, with no query run', async () => {
  const s = await serve()
  try {
    for (const q of ['', '?kind=chat', '?kind=web_search&kind=chat']) {
      const r = await s.get(`/api/admin/usage/tools${q}`)
      assert.equal(r.status, 400, q)
      assert.equal((await r.json()).code, 'bad_kind', q)
    }
    for (const q of [
      'from=2026-11-01',
      'to=2026-11-01',
      'from=2026-11-10&to=2026-11-01',
      'from=2026-11-01&to=2026-11-19', // the future
      'from=2025-01-01&to=2026-11-18', // > 366 days
      'from=2026-02-30&to=2026-03-02',
      'from=garbage&to=2026-11-01',
    ]) {
      const r = await s.get(`/api/admin/usage/tools?kind=web_search&${q}`)
      assert.equal(r.status, 400, q)
      assert.equal((await r.json()).code, 'bad_period', q)
    }
    assert.equal(s.calls.aggregate.length, 0)
  } finally {
    await s.close()
  }
})

test('GET /api/admin/usage/tools: default period is the Costs page default (30 UTC days), the admin flag is asked for, no-store', async () => {
  const s = await serve()
  try {
    const r = await s.get('/api/admin/usage/tools?kind=web_search')
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('cache-control'), 'no-store')
    const body = await r.json()
    assert.deepEqual(body.period, { from: '2026-10-20', to: '2026-11-18' })
    assert.equal(body.kind, 'web_search')
    assert.deepEqual(s.calls.aggregate[0]!.args, { kind: 'web_search', from: '2026-10-20', to: '2026-11-18' })
    assert.equal(s.calls.aggregate[0]!.email, ADMIN)
  } finally {
    await s.close()
  }
})

test('GET /api/admin/usage/tools: the response carries counts and money, and no e-mail anywhere', async () => {
  const s = await serve()
  try {
    const r = await s.get('/api/admin/usage/tools?kind=web_search&from=2026-11-01&to=2026-11-18')
    const text = await r.text()
    const body = JSON.parse(text)
    assert.deepEqual(Object.keys(body).sort(), ['byDay', 'byProvider', 'kind', 'period', 'prices', 'topUsers', 'totals'])
    assert.deepEqual(Object.keys(body.topUsers[0]).sort(), ['calls', 'costUsd', 'userHash'])
    for (const { key, value } of walk(body)) {
      assert.ok(!/email|session|message|prompt/i.test(key || ''), `no such key: ${key}`)
      if (typeof value === 'string') {
        assert.ok(!value.includes('@'), `no e-mail in a value: ${value}`)
        for (const e of EMAILS) assert.ok(!value.includes(e))
      }
    }
    for (const e of EMAILS) assert.ok(!text.includes(e), 'the raw text has no e-mail')
    assert.ok(body.topUsers.every((u: { userHash: string }) => /^h2:/.test(u.userHash)))
  } finally {
    await s.close()
  }
})

test('the default hash is the audit hash: keyed h2: with a key', () => {
  assert.match(auditHash('ana@example.com', { key: 'k' }) as string, /^h2:[0-9a-f]{12}$/)
})

test('an unexpected failure is a 500 internal_error without the message', async () => {
  const s = await serve({
    deps: {
      aggregate: async () => {
        throw new Error('boom ana@example.com')
      },
    },
  })
  try {
    const r = await s.get('/api/admin/usage/tools?kind=web_search')
    assert.equal(r.status, 500)
    const t = await r.text()
    assert.deepEqual(JSON.parse(t), { code: 'internal_error' })
    assert.ok(!t.includes('ana@example.com'))
  } finally {
    await s.close()
  }
})

test('PUT /api/admin/tool-prices/:key: non-admin 403, nothing written', async () => {
  const s = await serve()
  try {
    const r = await s.put('/api/admin/tool-prices/web_search', { per1kUsd: 5 }, USER)
    assert.equal(r.status, 403)
    assert.equal(s.calls.setPrice.length, 0)
  } finally {
    await s.close()
  }
})

test('PUT /api/admin/tool-prices/:key: the key is an allowlist (400 bad_key), the price a number 0..1000 or null (400 bad_price)', async () => {
  const s = await serve()
  try {
    for (const k of ['chat', 'web_search%3Aevil', 'tool%3Aweb_search', 'web_search%3A', 'web_search%3Abrave%3Ax']) {
      const r = await s.put(`/api/admin/tool-prices/${k}`, { per1kUsd: 5 })
      assert.equal(r.status, 400, k)
      assert.equal((await r.json()).code, 'bad_key', k)
    }
    for (const body of [{}, { per1kUsd: -1 }, { per1kUsd: 1000.01 }, { per1kUsd: '5' }, { per1kUsd: true }, { per1kUsd: [] }]) {
      const r = await s.put('/api/admin/tool-prices/web_search', body)
      assert.equal(r.status, 400, JSON.stringify(body))
      assert.equal((await r.json()).code, 'bad_price', JSON.stringify(body))
    }
    assert.equal(s.calls.setPrice.length, 0)
  } finally {
    await s.close()
  }
})

test('PUT /api/admin/tool-prices/:key: sets (0 and 1000 included) or clears (null), as admin, then refreshes the price book', async () => {
  const s = await serve()
  try {
    for (const [key, enc, v] of [
      ['web_search', 'web_search', 5],
      ['web_search:brave', 'web_search%3Abrave', 0],
      ['web_search:tavily', 'web_search:tavily', 1000],
      ['web_search', 'web_search', null],
    ]) {
      const r = await s.put(`/api/admin/tool-prices/${enc}`, { per1kUsd: v })
      assert.equal(r.status, 200, key as string)
      assert.deepEqual(await r.json(), { ok: true })
      assert.equal(r.headers.get('cache-control'), 'no-store')
    }
    assert.deepEqual(
      s.calls.setPrice.map((c) => [c.key, c.per1kUsd, c.opts]),
      [
        ['web_search', 5, { admin: true }],
        ['web_search:brave', 0, { admin: true }],
        ['web_search:tavily', 1000, { admin: true }],
        ['web_search', null, { admin: true }],
      ]
    )
    assert.equal(s.calls.refresh.length, 4)
  } finally {
    await s.close()
  }
})
