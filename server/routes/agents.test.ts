// W4-4d: the owner's agent routes (/api/agents...). Identity is mocked and the data layer is an in-memory fake that
// follows the contract of server/db/agents.ts (owner-scoped: a row that is not the caller's is "not found"; an edit of
// the approval scope voids approval, as the aip_agents_guard trigger does). No Postgres, no workspace: the database
// rules themselves are proven against a real Postgres in server/db/agents.test.ts and server/agents.rls.test.ts.
//
//   AC1 env flag off -> every route 404 agents_disabled, except status
//   AC2 owner-only: B gets 404 on A's ids (never 403), the same answer as for an id that does not exist
//   AC4 stale revision -> 409; an edit inside the approval scope comes back draft and disabled
//   AC5 enable refused unless approved, unexpired and the setting is on; a success computes next_run_at
//   AC6 run-now -> 409 busy while a run is active; notifyAgentsChanged exactly once per queued run
//   AC8 agentsPerOwner enforced
//   Review focus: ownerEmail in a body is never trusted; error answers carry codes, never a thrown message;
//   every write route has a body-limit class.
//
//   node --test server/routes/agents.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import type { AddressInfo } from 'node:net'
import { authed } from './authed.ts'

import registerAgentRoutes from './agents.ts'
import { AgentsError } from '../db/agents.ts'
import type { AgentRow, AgentRunRow } from '../db/agents.ts'
import { AGENT_LIMITS } from '../agents/definition.ts'
import type { AgentDefinition, DefinitionContext } from '../agents/definition.ts'
import { nextOccurrence } from '../agents/schedule.ts'
import { JSON_ROUTE_LIMITS } from '../middleware/security.ts'

const A = 'ana@example.com'
const B = 'bruno@example.com'
const NOW = new Date('2026-11-18T12:00:00Z')
const FUTURE = '2027-02-01T00:00:00.000Z'
const PAST = '2026-10-01T00:00:00.000Z'

const CTX: DefinitionContext = {
  models: new Set(['model-a']),
  catalog: new Map([['main.tools.sales', { credentialClass: 'databricks' }]]),
}

const goodBody = (over: Record<string, unknown> = {}) => ({
  name: 'Weekly sales',
  description: 'Summarises last week',
  instructions: 'Be brief.',
  prompt: 'Summarise last week sales.',
  model: 'model-a',
  reasoningEffort: 'low',
  tools: ['web_search'],
  schedule: { freq: 'weekly', minute: 0, hour: 8, weekday: 1, tz: 'America/Sao_Paulo' },
  lang: 'en',
  ...over,
})

// ---- the fake data layer ---------------------------------------------------------------------------------
type Row = AgentRow & { _runActive?: boolean }
function makeStore() {
  const rows = new Map<string, Row>()
  const calls: Array<{ fn: string; email: string; args: unknown[] }> = []
  let seq = 0
  const rec = (fn: string, email: string, ...args: unknown[]) => calls.push({ fn, email, args })
  const mine = (email: string, id: string) => {
    const r = rows.get(id)
    return r && r.ownerEmail === email ? r : null
  }
  const store = {
    calls,
    rows,
    settings: { enabled: true, maxRunCostUsd: 1, approvalDays: 90 },
    failWith: null as Error | null,
    approve(id: string, expiresAt = FUTURE) {
      const r = rows.get(id)!
      r.status = 'approved'
      r.approvalExpiresAt = expiresAt
    },
    async listAgents(email: string) {
      rec('listAgents', email)
      if (store.failWith) throw store.failWith
      return [...rows.values()].filter((r) => r.ownerEmail === email)
    },
    async getAgent(email: string, _t: unknown, id: string) {
      rec('getAgent', email, id)
      if (store.failWith) throw store.failWith
      const r = mine(email, id)
      return r ? { ...r } : null // a copy, as a real query returns: the route's "before" must not move with the update
    },
    async createAgent(email: string, _t: unknown, a: { name: string; description: string; definition: AgentDefinition }) {
      rec('createAgent', email, a)
      const n = [...rows.values()].filter((r) => r.ownerEmail === email).length
      if (n >= AGENT_LIMITS.agentsPerOwner) throw new AgentsError('agents_limit')
      const id = String(++seq)
      const row: Row = {
        id, ownerEmail: email, name: a.name, description: a.description, definition: a.definition, revision: 1, status: 'draft',
        approvalExpiresAt: null, decisionReason: null, enabled: false, nextRunAt: null, lastRunAt: null, consecutiveFailures: 0,
        disabledReason: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      }
      rows.set(id, row)
      return row
    },
    async updateAgent(email: string, _t: unknown, id: string, a: { name: string; description: string; definition: AgentDefinition }, o: { revision: number }) {
      rec('updateAgent', email, id, a, o)
      const r = mine(email, id)
      if (!r) return null
      if (r.revision !== o.revision) return 'conflict' as const
      const scopeChanged = JSON.stringify(r.definition) !== JSON.stringify(a.definition)
      Object.assign(r, { name: a.name, description: a.description, definition: a.definition, revision: r.revision + 1 })
      if (scopeChanged && (r.status === 'approved' || r.status === 'pending')) Object.assign(r, { status: 'draft', enabled: false, nextRunAt: null, approvalExpiresAt: null })
      return r
    },
    async deleteAgent(email: string, _t: unknown, id: string) {
      rec('deleteAgent', email, id)
      return mine(email, id) ? rows.delete(id) : false
    },
    async submitAgent(email: string, _t: unknown, id: string) {
      rec('submitAgent', email, id)
      const r = mine(email, id)
      if (!r || !['draft', 'rejected', 'revoked'].includes(r.status)) return null
      r.status = 'pending'
      return r
    },
    async setAgentEnabled(email: string, _t: unknown, id: string, enabled: boolean, nextRunAt: Date | null) {
      rec('setAgentEnabled', email, id, enabled, nextRunAt)
      const r = mine(email, id)
      if (!r) return null
      if (enabled && !(r.status === 'approved' && r.approvalExpiresAt && new Date(r.approvalExpiresAt) > NOW && nextRunAt)) return null
      r.enabled = enabled
      r.nextRunAt = enabled ? (nextRunAt as Date).toISOString() : null
      return r
    },
    async queueManualRun(email: string, _t: unknown, id: string) {
      rec('queueManualRun', email, id)
      const r = mine(email, id)
      if (!r || r.status !== 'approved' || !r.approvalExpiresAt || new Date(r.approvalExpiresAt) <= NOW) return null
      if (r._runActive) return 'busy' as const
      r._runActive = true
      const run: AgentRunRow = { id: '1', agentId: id, trigger: 'manual', slotAt: NOW.toISOString(), status: 'queued', errorCode: null, startedAt: null, finishedAt: null, sessionId: null, costUsd: null, unpriced: false, toolNames: [] }
      return run
    },
    async listAgentRuns(email: string, _t: unknown, id: string, o: { limit?: number; before?: string }) {
      rec('listAgentRuns', email, id, o)
      return [] as AgentRunRow[]
    },
    async readAgentSettings(email: string) {
      rec('readAgentSettings', email)
      if (store.failWith) throw store.failWith
      return store.settings
    },
  }
  return store
}

function fakeAuth(req: Request, res: Response, next: NextFunction) {
  const email = req.headers['x-test-email'] as string
  if (!email) return res.status(401).json({ error: 'no identity' })
  authed(req).email = email
  authed(req).token = 'fake-obo-token-not-a-secret'
  next()
}

async function serve(over: { env?: Record<string, string | undefined>; store?: ReturnType<typeof makeStore> } = {}) {
  const store = over.store || makeStore()
  const notified: number[] = []
  const env = over.env || { AGENTS_ENABLED: '1' }
  const app = express()
  app.use(express.json())
  registerAgentRoutes(app, { auth: fakeAuth, env, now: () => NOW, db: store, context: async () => CTX, notify: () => notified.push(1) } as Parameters<typeof registerAgentRoutes>[1])
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
  return { store, notified, call, env, close: () => new Promise((r) => server.close(r)) }
}

const create = async (s: Awaited<ReturnType<typeof serve>>, email = A, over: Record<string, unknown> = {}) => {
  const r = await s.call('POST', '/api/agents', email, goodBody(over))
  assert.equal(r.status, 201, r.text)
  return r.body as AgentRow
}

// ---- AC1 -------------------------------------------------------------------------------------------------
test('AC1: with AGENTS_ENABLED off every route answers 404 agents_disabled except status, and no query runs', async () => {
  const s = await serve({ env: {} })
  try {
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/agents'],
      ['POST', '/api/agents', goodBody()],
      ['GET', '/api/agents/1'],
      ['PATCH', '/api/agents/1', { revision: 1 }],
      ['DELETE', '/api/agents/1'],
      ['POST', '/api/agents/1/submit', {}],
      ['POST', '/api/agents/1/enable', {}],
      ['POST', '/api/agents/1/disable', {}],
      ['POST', '/api/agents/1/run', {}],
      ['GET', '/api/agents/1/runs'],
    ]
    for (const [m, p, b] of routes) {
      const r = await s.call(m, p, A, b)
      assert.equal(r.status, 404, `${m} ${p}`)
      assert.equal(r.body.code, 'agents_disabled', `${m} ${p}`)
      assert.equal(r.body.error, 'agents_disabled', `${m} ${p}`)
    }
    const st = await s.call('GET', '/api/agents/status', A)
    assert.equal(st.status, 200)
    assert.deepEqual(st.body, { enabled: false, reason: 'env_off' })
    assert.equal(s.store.calls.length, 0, 'the flag is checked before any query')
  } finally {
    await s.close()
  }
})

test('status: env on + setting off -> admin_off; both on -> enabled; needs a signed-in user', async () => {
  const s = await serve()
  try {
    s.store.settings.enabled = false
    assert.deepEqual((await s.call('GET', '/api/agents/status', A)).body, { enabled: false, reason: 'admin_off' })
    s.store.settings.enabled = true
    assert.deepEqual((await s.call('GET', '/api/agents/status', A)).body, { enabled: true })
    assert.equal((await s.call('GET', '/api/agents/status', null)).status, 401)
  } finally {
    await s.close()
  }
})

// ---- create / read / list ---------------------------------------------------------------------------------
test('create: 201 with the draft; the owner is the caller, never a body field; invalid input -> 400 with code and field', async () => {
  const s = await serve()
  try {
    const r = await s.call('POST', '/api/agents', A, goodBody({ ownerEmail: B, owner_email: B, status: 'approved', enabled: true, approval_hash: 'x' }))
    assert.equal(r.status, 201)
    assert.equal(r.body.ownerEmail, A)
    assert.equal(r.body.status, 'draft')
    assert.equal(r.body.enabled, false)
    assert.equal(s.store.calls.find((c) => c.fn === 'createAgent')!.email, A)
    assert.deepEqual(Object.keys((s.store.calls.find((c) => c.fn === 'createAgent')!.args[0] as object)).sort(), ['definition', 'description', 'name'])

    const bad = await s.call('POST', '/api/agents', A, goodBody({ model: 'nope' }))
    assert.equal(bad.status, 400)
    assert.deepEqual({ code: bad.body.code, field: bad.body.field, error: bad.body.error }, { code: 'model_not_in_catalog', field: 'model', error: 'model_not_in_catalog' })
    const freq = await s.call('POST', '/api/agents', A, goodBody({ schedule: { freq: 'every_5_minutes', minute: 0, tz: 'UTC' } }))
    assert.equal(freq.body.code, 'schedule_too_frequent')
    const mcp = await s.call('POST', '/api/agents', A, goodBody({ tools: ['mcp:main.tools.sales', 'mcp:main.tools.other'] }))
    assert.equal(mcp.body.code, 'mcp_not_in_catalog')
  } finally {
    await s.close()
  }
})

test('AC8: the 11th agent of an owner is refused with 409 agents_limit; another owner is not affected', async () => {
  const s = await serve()
  try {
    for (let i = 0; i < AGENT_LIMITS.agentsPerOwner; i++) await create(s, A, { name: `a${i}` })
    const r = await s.call('POST', '/api/agents', A, goodBody())
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'agents_limit')
    assert.equal((await s.call('POST', '/api/agents', B, goodBody())).status, 201)
  } finally {
    await s.close()
  }
})

test('list and get answer the caller\'s agents only', async () => {
  const s = await serve()
  try {
    const mine = await create(s, A)
    await create(s, B)
    const list = await s.call('GET', '/api/agents', A)
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.agents.map((a: AgentRow) => a.id), [mine.id])
    assert.equal(list.body.limits.agentsPerOwner, AGENT_LIMITS.agentsPerOwner)
    const one = await s.call('GET', `/api/agents/${mine.id}`, A)
    assert.equal(one.status, 200)
    assert.equal(one.body.id, mine.id)
  } finally {
    await s.close()
  }
})

// ---- AC2 -------------------------------------------------------------------------------------------------
test('AC2: B gets 404 not_found on A\'s id on every id route, identical to an id that does not exist, never 403', async () => {
  const s = await serve()
  try {
    const a = await create(s, A)
    s.store.approve(a.id)
    const routes: Array<[string, (id: string) => string, unknown?]> = [
      ['GET', (id) => `/api/agents/${id}`],
      ['PATCH', (id) => `/api/agents/${id}`, { revision: 1, name: 'x' }],
      ['DELETE', (id) => `/api/agents/${id}`],
      ['POST', (id) => `/api/agents/${id}/submit`, {}],
      ['POST', (id) => `/api/agents/${id}/enable`, {}],
      ['POST', (id) => `/api/agents/${id}/disable`, {}],
      ['POST', (id) => `/api/agents/${id}/run`, {}],
      ['GET', (id) => `/api/agents/${id}/runs`],
    ]
    for (const [m, path, body] of routes) {
      const theirs = await s.call(m, path(a.id), B, body)
      const missing = await s.call(m, path('987654'), B, body)
      assert.equal(theirs.status, 404, `${m} ${path(a.id)}`)
      assert.equal(theirs.body.code, 'not_found')
      assert.deepEqual(theirs.body, missing.body, 'no existence leak')
      assert.equal(theirs.status, missing.status)
    }
    assert.equal(s.store.rows.get(a.id)!.status, 'approved', 'A\'s agent is untouched')
    assert.equal(s.store.rows.get(a.id)!.name, 'Weekly sales')
    assert.equal(s.notified.length, 0, 'a refused call notifies nothing')
  } finally {
    await s.close()
  }
})

// ---- AC4 -------------------------------------------------------------------------------------------------
test('AC4: PATCH needs a revision; a stale one -> 409 conflict and nothing changes', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    const none = await s.call('PATCH', `/api/agents/${a.id}`, A, { name: 'x' })
    assert.equal(none.status, 400)
    assert.equal(none.body.code, 'revision_required')
    for (const rev of ['1', 1.5, -1, 0, null]) assert.equal((await s.call('PATCH', `/api/agents/${a.id}`, A, { revision: rev, name: 'x' })).body.code, 'revision_required', String(rev))
    const ok = await s.call('PATCH', `/api/agents/${a.id}`, A, { revision: 1, name: 'Renamed' })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.name, 'Renamed')
    assert.equal(ok.body.revision, 2)
    const stale = await s.call('PATCH', `/api/agents/${a.id}`, A, { revision: 1, name: 'Again' })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'conflict')
    assert.equal(s.store.rows.get(a.id)!.name, 'Renamed')
  } finally {
    await s.close()
  }
})

test('AC4: a partial PATCH merges onto the saved definition and is validated as a whole; ownerEmail in the body is ignored', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    const r = await s.call('PATCH', `/api/agents/${a.id}`, A, { revision: 1, prompt: 'New prompt', ownerEmail: B })
    assert.equal(r.status, 200)
    assert.equal(r.body.definition.prompt, 'New prompt')
    assert.equal(r.body.definition.model, 'model-a', 'untouched fields keep their saved value')
    assert.equal(r.body.ownerEmail, A)
    const bad = await s.call('PATCH', `/api/agents/${a.id}`, A, { revision: 2, model: 'nope' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.code, 'model_not_in_catalog')
    const clear = await s.call('PATCH', `/api/agents/${a.id}`, A, { revision: 2, schedule: null })
    assert.equal(clear.body.definition.schedule, null)
  } finally {
    await s.close()
  }
})

test('AC4: an edit inside the approval scope returns the agent as draft and disabled; a rename keeps the approval', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    s.store.approve(a.id)
    s.store.rows.get(a.id)!.enabled = true
    const rename = await s.call('PATCH', `/api/agents/${a.id}`, A, { revision: 1, name: 'Just a new name', description: 'd' })
    assert.equal(rename.body.status, 'approved')
    assert.equal(rename.body.enabled, true)
    const edit = await s.call('PATCH', `/api/agents/${a.id}`, A, { revision: 2, instructions: 'Different instructions' })
    assert.equal(edit.status, 200)
    assert.equal(edit.body.status, 'draft')
    assert.equal(edit.body.enabled, false)
    assert.equal(edit.body.nextRunAt, null)
    assert.equal(s.notified.length, 1, 'the schedule changed under the scheduler: one hint')
  } finally {
    await s.close()
  }
})

test('delete: 204 and gone; a second delete is 404', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    assert.equal((await s.call('DELETE', `/api/agents/${a.id}`, A)).status, 204)
    assert.equal((await s.call('DELETE', `/api/agents/${a.id}`, A)).status, 404)
    assert.equal((await s.call('GET', `/api/agents/${a.id}`, A)).status, 404)
  } finally {
    await s.close()
  }
})

// ---- submit ----------------------------------------------------------------------------------------------
test('submit: draft -> pending; an agent that is not draft/rejected/revoked -> 409 bad_state', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    const r = await s.call('POST', `/api/agents/${a.id}/submit`, A, {})
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'pending')
    const again = await s.call('POST', `/api/agents/${a.id}/submit`, A, {})
    assert.equal(again.status, 409)
    assert.equal(again.body.code, 'bad_state')
  } finally {
    await s.close()
  }
})

// ---- AC5 -------------------------------------------------------------------------------------------------
test('AC5: enable is refused unless approved, unexpired, scheduled and the admin setting is on', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    const enable = () => s.call('POST', `/api/agents/${a.id}/enable`, A, {})
    let r = await enable()
    assert.deepEqual([r.status, r.body.code], [409, 'not_approved'], 'a draft')
    s.store.rows.get(a.id)!.status = 'pending'
    assert.equal((await enable()).body.code, 'not_approved', 'pending')

    s.store.approve(a.id, PAST)
    r = await enable()
    assert.deepEqual([r.status, r.body.code], [409, 'approval_expired'])

    s.store.approve(a.id)
    s.store.settings.enabled = false
    r = await enable()
    assert.deepEqual([r.status, r.body.code], [409, 'agents_setting_off'])
    s.store.settings.enabled = true

    s.store.rows.get(a.id)!.definition = { ...s.store.rows.get(a.id)!.definition, schedule: null }
    r = await enable()
    assert.deepEqual([r.status, r.body.code], [409, 'no_schedule'])
    assert.equal(s.store.rows.get(a.id)!.enabled, false, 'every refusal left the agent disabled')
    assert.equal(s.notified.length, 0)
  } finally {
    await s.close()
  }
})

test('AC5: a successful enable stores next_run_at = the next occurrence after now, and hints the scheduler once', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    s.store.approve(a.id)
    const r = await s.call('POST', `/api/agents/${a.id}/enable`, A, {})
    assert.equal(r.status, 200)
    assert.equal(r.body.enabled, true)
    const expected = nextOccurrence(a.definition.schedule!, NOW).toISOString()
    assert.equal(r.body.nextRunAt, expected)
    assert.ok(new Date(r.body.nextRunAt) > NOW)
    assert.equal(s.notified.length, 1)
    const off = await s.call('POST', `/api/agents/${a.id}/disable`, A, {})
    assert.equal(off.status, 200)
    assert.equal(off.body.enabled, false)
    assert.equal(off.body.nextRunAt, null)
    assert.equal(s.notified.length, 2)
  } finally {
    await s.close()
  }
})

// ---- AC6 -------------------------------------------------------------------------------------------------
test('AC6: run-now queues one run (202) and notifies once; while it is active -> 409 busy and no notification', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    const early = await s.call('POST', `/api/agents/${a.id}/run`, A, {})
    assert.deepEqual([early.status, early.body.code], [409, 'not_approved'])
    assert.equal(s.notified.length, 0)

    s.store.approve(a.id)
    const first = await s.call('POST', `/api/agents/${a.id}/run`, A, {})
    assert.equal(first.status, 202)
    assert.equal(first.body.run.status, 'queued')
    assert.equal(first.body.run.trigger, 'manual')
    assert.equal(s.notified.length, 1, 'exactly one notifyAgentsChanged')
    const second = await s.call('POST', `/api/agents/${a.id}/run`, A, {})
    assert.deepEqual([second.status, second.body.code], [409, 'busy'])
    assert.equal(s.notified.length, 1, 'busy notifies nothing')
  } finally {
    await s.close()
  }
})

test('run-now is refused while the admin setting is off', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    s.store.approve(a.id)
    s.store.settings.enabled = false
    const r = await s.call('POST', `/api/agents/${a.id}/run`, A, {})
    assert.deepEqual([r.status, r.body.code], [409, 'agents_setting_off'])
    assert.equal(s.store.calls.some((c) => c.fn === 'queueManualRun'), false)
  } finally {
    await s.close()
  }
})

// ---- run history -----------------------------------------------------------------------------------------
test('runs: before and limit are parsed and passed through; garbage -> 400 bad_query', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    const r = await s.call('GET', `/api/agents/${a.id}/runs?before=77&limit=5`, A)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { runs: [] })
    assert.deepEqual(s.store.calls.find((c) => c.fn === 'listAgentRuns')!.args.slice(1), [{ limit: 5, before: '77' }])
    for (const q of ['before=abc', 'before=1;drop', 'limit=0', 'limit=-3', 'limit=x', 'limit=1.5']) {
      const bad = await s.call('GET', `/api/agents/${a.id}/runs?${q}`, A)
      assert.deepEqual([bad.status, bad.body.code], [400, 'bad_query'], q)
    }
  } finally {
    await s.close()
  }
})

// ---- errors ----------------------------------------------------------------------------------------------
test('a data-layer failure answers 500 internal_error with no message text', async () => {
  const s = await serve()
  try {
    s.store.failWith = new Error('relation "agents" connection secret=hunter2')
    for (const [m, p] of [['GET', '/api/agents'], ['GET', '/api/agents/1']] as const) {
      const r = await s.call(m, p, A)
      assert.equal(r.status, 500)
      assert.deepEqual(r.body, { error: 'internal_error', code: 'internal_error' })
      assert.ok(!r.text.includes('hunter2'))
    }
  } finally {
    await s.close()
  }
})

test('every answer carries the same code as `error`, a stable key and never prose', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    const samples = [
      await s.call('POST', '/api/agents', A, goodBody({ model: 'x' })),
      await s.call('GET', '/api/agents/99', A),
      await s.call('PATCH', `/api/agents/${a.id}`, A, { name: 'x' }),
      await s.call('POST', `/api/agents/${a.id}/enable`, A, {}),
    ]
    for (const r of samples) {
      assert.match(r.body.code, /^[a-z][a-z0-9_]*$/)
      assert.equal(r.body.error, r.body.code)
    }
  } finally {
    await s.close()
  }
})

// ---- body-limit class ------------------------------------------------------------------------------------
test('every state-changing agent route has a body-limit class (small JSON = default)', () => {
  const want = [
    'POST /api/agents',
    'PATCH /api/agents/:id',
    'DELETE /api/agents/:id',
    'POST /api/agents/:id/submit',
    'POST /api/agents/:id/enable',
    'POST /api/agents/:id/disable',
    'POST /api/agents/:id/run',
  ]
  for (const w of want) {
    const hit = JSON_ROUTE_LIMITS.find((r: { method: string; path: string }) => `${r.method} ${r.path}` === w)
    assert.ok(hit, `${w} has an entry`)
    assert.equal(hit.class, 'default', w)
  }
})
