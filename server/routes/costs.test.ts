// GET /api/costs and /api/costs/meta: admin-only (403 for a signed-in
// non-admin), the admin's own OBO token on the warehouse, friendly codes for
// bad input and missing system-table grants, and the token never in a log line.
// Identity is mocked (x-test-email / x-forwarded-access-token); the statement
// executor is a fake warehouse; no database, no workspace.
//
//   node --test server/routes/costs.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import type { AddressInfo } from 'node:net'

import registerCostRoutes from './costs.ts'
import { setLogWriter } from '../log.ts'

const ADMIN = 'admin@example.com'
const USER = 'user@example.com'
const FAKE_TOKEN = 'fake-obo-token-not-a-secret'

// mocked identity: same shape auth.js leaves on req (email + OBO token)
function fakeAuth(req: Request, res: Response, next: NextFunction) {
  const email = req.headers['x-test-email']
  const token = req.headers['x-forwarded-access-token']
  if (!email || !token) return res.status(401).json({ error: 'no identity' })
  Object.assign(req, { email, token })
  next()
}
// same contract as middleware/requireAdmin.ts: 403 for a signed-in non-admin
function fakeRequireAdmin(req: Request, res: Response, next: NextFunction) {
  if ((req as Request & { email?: string }).email === ADMIN) return next()
  res.status(403).json({ error: 'admin_required', code: 'admin_required' })
}

type AgentNames = NonNullable<NonNullable<Parameters<typeof registerCostRoutes>[1]>['agentNames']>

async function serve({ exec, env = {}, agentNames }: { exec?: Exec; env?: Record<string, string>; agentNames?: AgentNames } = {}) {
  const app = express()
  registerCostRoutes(app, { auth: fakeAuth, requireAdmin: fakeRequireAdmin, exec, env, now: () => new Date('2026-11-18T12:00:00Z'), ...(agentNames ? { agentNames } : {}) })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const get = (path: string, email = ADMIN) =>
    fetch(base + path, { headers: { 'x-test-email': email, 'x-forwarded-access-token': FAKE_TOKEN } })
  return { get, close: () => new Promise((r) => server.close(r)) }
}

type Exec = NonNullable<Parameters<typeof registerCostRoutes>[1]>['exec']
type ExecCall = { token: string; statement: string; parameters: unknown; opts: unknown }

const okExec = (calls: ExecCall[] = []): Exec => async (token, statement, parameters, opts) => {
  calls.push({ token, statement, parameters, opts })
  return { columns: ['user_email', 'requests', 'total_tokens', 'dbus', 'usd'], rows: [['ana@example.com', '4', '1200', '0.5', '0.035']] }
}

test('non-admin: 403 on every costs route, and the warehouse is never called', async () => {
  const calls: ExecCall[] = []
  const s = await serve({ exec: okExec(calls) })
  try {
    for (const p of ['/api/costs?by=person', '/api/costs/meta']) {
      const res = await s.get(p, USER)
      assert.equal(res.status, 403, p)
    }
    assert.equal(calls.length, 0)
  } finally {
    await s.close()
  }
})

test('admin: 200 with rows, the admin OBO token goes to the warehouse', async () => {
  const calls: ExecCall[] = []
  const s = await serve({ exec: okExec(calls) })
  try {
    const res = await s.get('/api/costs?by=person&from=2026-10-01&to=2026-10-31')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const body = await res.json()
    assert.equal(body.by, 'person')
    assert.deepEqual(body.period, { from: '2026-10-01', to: '2026-10-31' })
    assert.deepEqual(body.rows, [{ user_email: 'ana@example.com', requests: 4, total_tokens: 1200, dbus: 0.5, usd: 0.035 }])
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.token, FAKE_TOKEN)
  } finally {
    await s.close()
  }
})

test('meta: tag keys and the default period, without a warehouse call', async () => {
  const calls: ExecCall[] = []
  const s = await serve({ exec: okExec(calls), env: { AI_PRISM_RESOURCE_TAGS: '{"cost_center":"1"}' } })
  try {
    const res = await s.get('/api/costs/meta')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.tagKeys, ['cost_center', 'ai_prism_app'])
    assert.deepEqual(body.breakdowns, ['resource', 'model', 'person', 'tag', 'day', 'agent'])
    assert.deepEqual(body.defaultPeriod, { from: '2026-10-20', to: '2026-11-18' })
    assert.equal(body.maxDays, 366)
    assert.equal(calls.length, 0)
  } finally {
    await s.close()
  }
})

test('bad input: 400 with a code; injection attempts never reach the warehouse', async () => {
  const calls: ExecCall[] = []
  const s = await serve({ exec: okExec(calls) })
  try {
    const cases: Array<[string, string]> = [
      ['/api/costs?by=nope', 'bad_breakdown'],
      ['/api/costs?by=model&by=model', 'bad_breakdown'],
      ["/api/costs?by=person&from=2026-10-01'%20OR%201=1--&to=2026-10-31", 'bad_period'],
      ['/api/costs?by=person&from=2026-10-31&to=2026-10-01', 'bad_period'],
      ["/api/costs?by=tag&tag=x']%20OR%201=1--", 'bad_tag'],
      ['/api/costs?by=person&from=2026-10-01&from=2026-10-02&to=2026-10-31', 'bad_period'],
    ]
    for (const [p, code] of cases) {
      const res = await s.get(p)
      assert.equal(res.status, 400, p)
      assert.equal((await res.json()).code, code, p)
    }
    assert.equal(calls.length, 0)
  } finally {
    await s.close()
  }
})

test('no SELECT on the system tables: 403 no_access (a friendly state), not a 500', async () => {
  const s = await serve({
    exec: async () => {
      throw new Error('[INSUFFICIENT_PERMISSIONS] Insufficient privileges: User does not have USE SCHEMA on Schema system.billing.')
    },
  })
  try {
    const res = await s.get('/api/costs?by=resource')
    assert.equal(res.status, 403)
    assert.deepEqual(await res.json(), { code: 'no_access' })
  } finally {
    await s.close()
  }
})

test('a failing warehouse: 502 query_failed; the OBO token is never logged', async () => {
  const lines: string[] = []
  setLogWriter((line) => lines.push(String(line)))
  const s = await serve({
    exec: async (token: string) => {
      throw new Error(`upstream exploded while using ${token}`)
    },
  })
  try {
    const res = await s.get('/api/costs?by=model')
    assert.equal(res.status, 502)
    const body = await res.json()
    assert.equal(body.code, 'query_failed')
    assert.ok(!JSON.stringify(body).includes(FAKE_TOKEN), 'token in the response')
    assert.ok(lines.length > 0, 'the failure is logged')
    assert.ok(!lines.some((l) => l.includes(FAKE_TOKEN)), 'token in a log line')
  } finally {
    setLogWriter(null)
    await s.close()
  }
})

test('per day: rows by resource type, the day as text', async () => {
  const s = await serve({
    exec: async () => ({ columns: ['day', 'product', 'dbus', 'usd'], rows: [['2026-10-01', 'MODEL_SERVING', '1', '0.2'], ['2026-10-01', 'SQL', '0.5', '0.1']] }),
  })
  try {
    const res = await s.get('/api/costs?by=day&from=2026-10-01&to=2026-10-31')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.columns, ['day', 'product', 'dbus', 'usd'])
    assert.deepEqual(body.rows[1], { day: '2026-10-01', product: 'SQL', dbus: 0.5, usd: 0.1 })
    assert.equal(body.totals.usd, 0.3)
  } finally {
    await s.close()
  }
})

test('per agent: the names come from the database with the admin session, never from the warehouse', async () => {
  const seen: Array<{ email: string; token: string; ids: string[] }> = []
  const s = await serve({
    exec: async () => ({ columns: ['agent_id', 'requests', 'total_tokens', 'dbus', 'usd'], rows: [['7', '3', '900', '0.2', '0.05'], [null, '9', '4000', '1', '0.4']] }),
    agentNames: async (email, token, ids) => (seen.push({ email, token, ids }), new Map([['7', 'Weekly sales']])),
  })
  try {
    const res = await s.get('/api/costs?by=agent&from=2026-10-01&to=2026-10-31')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.rows.map((r: { agent_name: string | null }) => r.agent_name), ['Weekly sales', null])
    assert.deepEqual(seen, [{ email: ADMIN, token: FAKE_TOKEN, ids: ['7'] }])
    // a non-admin never reaches the names lookup
    assert.equal((await s.get('/api/costs?by=agent', USER)).status, 403)
    assert.equal(seen.length, 1)
  } finally {
    await s.close()
  }
})
