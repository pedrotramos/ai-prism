// W4-4d: the admin routes of scheduled agents (/api/admin/agents...). Identity is mocked and the data layer is a
// recording fake: the write rules (one audit row in the decision's transaction, the stale-hash check that writes
// nothing) live in decideAgent / writeAgentSettings and are proven against a real Postgres in
// server/db/agents.test.ts; here the ROUTE contract is pinned: who may call, what is validated, what is passed down.
//
//   AC1 env flag off -> 404 agents_disabled (an admin too)
//   AC3 admin routes need requireAdmin; every decision and settings change is ONE call to the audited data function
//   AC7 an approve with a stale hash -> 409 and the route does nothing else (no hint to the scheduler)
//   Review focus: the admin identity is the caller's (never a body field); error answers carry codes, not prose.
//
//   node --test server/routes/adminAgents.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import type { AddressInfo } from 'node:net'
import { authed } from './authed.ts'

import registerAdminAgentRoutes from './adminAgents.ts'
import { AgentsError } from '../db/agents.ts'
import type { AdminAgentRow } from '../db/agents.ts'
import { JSON_ROUTE_LIMITS } from '../middleware/security.ts'

const ADMIN = 'admin@example.com'
const USER = 'user@example.com'
const HASH = 'a'.repeat(64)

const agentRow = (over: Partial<AdminAgentRow> = {}): AdminAgentRow => ({
  id: '7', ownerEmail: USER, name: 'Weekly sales', description: '', revision: 3, status: 'pending', approvalExpiresAt: null, decisionReason: null,
  enabled: false, nextRunAt: null, lastRunAt: null, consecutiveFailures: 0, disabledReason: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
  definition: {
    instructions: '', prompt: 'p', model: 'm', reasoningEffort: null, lang: 'en', schedule: null,
    tools: ['web_search', 'genie_one', 'artifact:deck', 'mcp:main.tools.sales', 'generate_image'],
  },
  approvalHash: null, currentHash: HASH, ...over,
})

function makeDb() {
  const calls: Array<{ fn: string; email: string; args: unknown[] }> = []
  const rec = (fn: string, email: string, ...args: unknown[]) => calls.push({ fn, email, args })
  const db = {
    calls,
    result: agentRow() as AdminAgentRow | null | 'stale',
    throwWith: null as Error | null,
    settings: { enabled: false, maxRunCostUsd: 1, approvalDays: 90 },
    async listAgentsForReview(email: string, _t: unknown, o: unknown) {
      rec('listAgentsForReview', email, o)
      return [agentRow()]
    },
    async decideAgent(email: string, _t: unknown, id: string, d: unknown) {
      rec('decideAgent', email, id, d)
      if (db.throwWith) throw db.throwWith
      return db.result
    },
    async readAgentSettings(email: string) {
      rec('readAgentSettings', email)
      return db.settings
    },
    async writeAgentSettings(email: string, _t: unknown, s: unknown) {
      rec('writeAgentSettings', email, s)
      if (db.throwWith) throw db.throwWith
    },
  }
  return db
}

function fakeAuth(req: Request, res: Response, next: NextFunction) {
  const email = req.headers['x-test-email'] as string
  if (!email) return res.status(401).json({ error: 'no identity' })
  authed(req).email = email
  authed(req).token = 'fake-obo-token-not-a-secret'
  next()
}
// stands in for requireAdmin: the admin flag comes from here and from nowhere else
function fakeRequireAdmin(req: Request, res: Response, next: NextFunction) {
  if (authed(req).email === ADMIN) {
    authed(req).isAdmin = true
    return next()
  }
  res.status(403).json({ error: 'admin_required', code: 'admin_required' })
}

async function serve(over: { env?: Record<string, string | undefined> } = {}) {
  const db = makeDb()
  const notified: number[] = []
  const env = over.env || { AGENTS_ENABLED: '1' }
  const app = express()
  app.use(express.json())
  registerAdminAgentRoutes(app, { auth: fakeAuth, requireAdmin: fakeRequireAdmin, env, db, notify: () => notified.push(1) } as Parameters<typeof registerAdminAgentRoutes>[1])
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (method: string, p: string, email: string | null, body?: unknown) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(email ? { 'x-test-email': email } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null, text }
  }
  return { db, notified, call, close: () => new Promise((r) => server.close(r)) }
}

const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/api/admin/agents'],
  ['GET', '/api/admin/agents/settings'],
  ['PUT', '/api/admin/agents/settings', { enabled: true }],
  ['POST', '/api/admin/agents/7/approve', { expectedHash: HASH }],
  ['POST', '/api/admin/agents/7/reject', { reason: 'no' }],
  ['POST', '/api/admin/agents/7/revoke', {}],
]

test('AC1: with AGENTS_ENABLED off every admin route answers 404 agents_disabled, an admin too, and runs no query', async () => {
  const s = await serve({ env: {} })
  try {
    for (const email of [ADMIN, USER]) {
      for (const [m, p, b] of ROUTES) {
        const r = await s.call(m, p, email, b)
        assert.equal(r.status, 404, `${m} ${p} (${email})`)
        assert.deepEqual(r.body, { error: 'agents_disabled', code: 'agents_disabled' })
      }
    }
    assert.equal(s.db.calls.length, 0)
  } finally {
    await s.close()
  }
})

test('AC3: a non-admin gets 403 on every admin route and nothing reaches the data layer', async () => {
  const s = await serve()
  try {
    for (const [m, p, b] of ROUTES) {
      const r = await s.call(m, p, USER, b)
      assert.equal(r.status, 403, `${m} ${p}`)
      assert.equal(typeof r.body?.code, 'string', `${m} ${p}: stable i18n code`)
      assert.equal(r.body.error, r.body.code, `${m} ${p}: code is the display key`)
    }
    for (const [m, p, b] of ROUTES) assert.equal((await s.call(m, p, null, b)).status, 401, `${m} ${p}`)
    assert.equal(s.db.calls.length, 0)
    assert.equal(s.notified.length, 0)
  } finally {
    await s.close()
  }
})

test('review queue: status filter validated; every agent carries its tools with the identity each runs as', async () => {
  const s = await serve()
  try {
    const r = await s.call('GET', '/api/admin/agents?status=pending', ADMIN)
    assert.equal(r.status, 200)
    assert.deepEqual(s.db.calls[0], { fn: 'listAgentsForReview', email: ADMIN, args: [{ status: 'pending' }] })
    const a = r.body.agents[0]
    assert.equal(a.currentHash, HASH)
    assert.equal(a.ownerEmail, USER)
    const by = Object.fromEntries(a.toolIdentities.map((t: { tool: string }) => [t.tool, t]))
    // every unattended tool runs as the app's service principal; the ones that read workspace data say so
    for (const t of a.toolIdentities) assert.equal(t.runsAs, 'app_service_principal', t.tool)
    assert.equal(by['genie_one'].readsWorkspaceData, true)
    assert.equal(by['mcp:main.tools.sales'].readsWorkspaceData, true)
    assert.equal(by['web_search'].readsWorkspaceData, false)
    assert.equal(by['artifact:deck'].readsWorkspaceData, false)
    assert.equal(by['generate_image'].readsWorkspaceData, false)
    assert.equal(a.toolIdentities.length, 5)

    await s.call('GET', '/api/admin/agents', ADMIN)
    assert.deepEqual(s.db.calls[1]!.args, [{}], 'no filter = every status')
    const bad = await s.call('GET', '/api/admin/agents?status=bogus', ADMIN)
    assert.deepEqual([bad.status, bad.body.code], [400, 'bad_status'])
    assert.equal(s.db.calls.length, 2)
  } finally {
    await s.close()
  }
})

test('approve: the admin is the caller; expectedHash is required; days is passed through; one decision call and one hint', async () => {
  const s = await serve()
  try {
    const none = await s.call('POST', '/api/admin/agents/7/approve', ADMIN, {})
    assert.deepEqual([none.status, none.body.code], [400, 'expected_hash_required'])
    for (const h of ['', 7, null, ['x']]) assert.equal((await s.call('POST', '/api/admin/agents/7/approve', ADMIN, { expectedHash: h })).body.code, 'expected_hash_required')
    assert.equal(s.db.calls.length, 0, 'invalid input never reaches the data layer')

    const r = await s.call('POST', '/api/admin/agents/7/approve', ADMIN, { expectedHash: HASH, days: 30, adminEmail: USER, admin: true, isAdmin: true })
    assert.equal(r.status, 200)
    assert.equal(r.body.id, '7')
    assert.equal(s.db.calls.length, 1)
    assert.deepEqual(s.db.calls[0], { fn: 'decideAgent', email: ADMIN, args: ['7', { decision: 'approve', expectedHash: HASH, days: 30 }] })
    assert.equal(s.notified.length, 1)

    for (const days of [0, 1.5, 'x', -2]) {
      const bad = await s.call('POST', '/api/admin/agents/7/approve', ADMIN, { expectedHash: HASH, days })
      assert.deepEqual([bad.status, bad.body.code], [400, 'invalid_days'], String(days))
    }
    assert.equal(s.db.calls.length, 1)
  } finally {
    await s.close()
  }
})

test('AC7: approve with a stale hash -> 409 stale; the route writes and signals nothing more', async () => {
  const s = await serve()
  try {
    s.db.result = 'stale'
    const r = await s.call('POST', '/api/admin/agents/7/approve', ADMIN, { expectedHash: 'b'.repeat(64) })
    assert.equal(r.status, 409)
    assert.deepEqual(r.body, { error: 'stale', code: 'stale' })
    assert.equal(s.db.calls.length, 1, 'one attempt, no retry, no second write')
    assert.equal(s.notified.length, 0)
  } finally {
    await s.close()
  }
})

test('an unknown agent id -> 404 not_found on every decision', async () => {
  const s = await serve()
  try {
    s.db.result = null
    for (const [p, b] of [['approve', { expectedHash: HASH }], ['reject', { reason: 'no' }], ['revoke', {}]] as const) {
      const r = await s.call('POST', `/api/admin/agents/99/${p}`, ADMIN, b)
      assert.deepEqual([r.status, r.body.code], [404, 'not_found'], p)
    }
    assert.equal(s.notified.length, 0)
  } finally {
    await s.close()
  }
})

test('reject needs a reason; revoke takes an optional one; each is one decision call with the caller as the admin', async () => {
  const s = await serve()
  try {
    for (const reason of [undefined, '', '   ', 5]) {
      const r = await s.call('POST', '/api/admin/agents/7/reject', ADMIN, reason === undefined ? {} : { reason })
      assert.deepEqual([r.status, r.body.code], [400, 'reason_required'])
    }
    assert.equal(s.db.calls.length, 0)
    const rej = await s.call('POST', '/api/admin/agents/7/reject', ADMIN, { reason: 'Reads data it should not' })
    assert.equal(rej.status, 200)
    assert.deepEqual(s.db.calls[0], { fn: 'decideAgent', email: ADMIN, args: ['7', { decision: 'reject', expectedHash: '', reason: 'Reads data it should not' }] })
    const rev = await s.call('POST', '/api/admin/agents/7/revoke', ADMIN, {})
    assert.equal(rev.status, 200)
    assert.deepEqual(s.db.calls[1], { fn: 'decideAgent', email: ADMIN, args: ['7', { decision: 'revoke', expectedHash: '' }] })
    const rev2 = await s.call('POST', '/api/admin/agents/7/revoke', ADMIN, { reason: 'owner left', expectedHash: HASH })
    assert.equal(rev2.status, 200)
    assert.deepEqual(s.db.calls[2]!.args, ['7', { decision: 'revoke', expectedHash: HASH, reason: 'owner left' }])
    assert.equal(s.notified.length, 3, 'a decision can move the earliest due time: one hint each')
  } finally {
    await s.close()
  }
})

test('settings: GET reads the three values; PUT validates, writes ONCE through the audited function and hints the scheduler', async () => {
  const s = await serve()
  try {
    const g = await s.call('GET', '/api/admin/agents/settings', ADMIN)
    assert.deepEqual(g.body, { enabled: false, maxRunCostUsd: 1, approvalDays: 90, ranges: { maxRunCostUsd: [0.05, 50], approvalDays: [1, 365] } })
    const p = await s.call('PUT', '/api/admin/agents/settings', ADMIN, { enabled: true, maxRunCostUsd: 2.5 })
    assert.equal(p.status, 200)
    assert.equal(p.body.enabled, false, 'the answer is what is stored (the fake keeps its own state)')
    const writes = s.db.calls.filter((c) => c.fn === 'writeAgentSettings')
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0], { fn: 'writeAgentSettings', email: ADMIN, args: [{ enabled: true, maxRunCostUsd: 2.5 }] })
    assert.equal(s.notified.length, 1)
  } finally {
    await s.close()
  }
})

test('settings: an empty body, an unknown key or a wrong type -> 400 and nothing is written; an out-of-range value -> 400 invalid_setting', async () => {
  const s = await serve()
  try {
    for (const body of [{}, { nope: 1 }, { enabled: 'yes' }, { approvalDays: '30' }, { maxRunCostUsd: null }, [1]]) {
      const r = await s.call('PUT', '/api/admin/agents/settings', ADMIN, body)
      assert.deepEqual([r.status, r.body.code], [400, 'invalid_setting'], JSON.stringify(body))
    }
    assert.equal(s.db.calls.filter((c) => c.fn === 'writeAgentSettings').length, 0)
    s.db.throwWith = new AgentsError('invalid_setting', 'approvalDays')
    const r = await s.call('PUT', '/api/admin/agents/settings', ADMIN, { approvalDays: 9999 })
    assert.deepEqual([r.status, r.body.code], [400, 'invalid_setting'])
    assert.ok(!r.text.includes('approvalDays'), 'the thrown detail is not echoed')
    assert.equal(s.notified.length, 0)
  } finally {
    await s.close()
  }
})

test('a data-layer failure answers 500 internal_error with no message text', async () => {
  const s = await serve()
  try {
    s.db.throwWith = new Error('password authentication failed for user "x"')
    const r = await s.call('POST', '/api/admin/agents/7/approve', ADMIN, { expectedHash: HASH })
    assert.equal(r.status, 500)
    assert.deepEqual(r.body, { error: 'internal_error', code: 'internal_error' })
  } finally {
    await s.close()
  }
})

test('every state-changing admin route has a body-limit class (small JSON = default)', () => {
  for (const w of ['PUT /api/admin/agents/settings', 'POST /api/admin/agents/:id/approve', 'POST /api/admin/agents/:id/reject', 'POST /api/admin/agents/:id/revoke']) {
    const hit = JSON_ROUTE_LIMITS.find((r: { method: string; path: string }) => `${r.method} ${r.path}` === w)
    assert.ok(hit, `${w} has an entry`)
    assert.equal(hit.class, 'default', w)
  }
})
