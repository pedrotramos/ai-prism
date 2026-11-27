// Agent versions: the owner's and the administrator's routes (migration 0017). Identity is mocked and the data layers are
// in-memory fakes that follow the contract of server/db/agents.ts and server/db/agentVersions.ts (a row that is not the
// caller's is "not found"; a recipient reads only an approved version a share names). The database rules themselves are
// proven against a real Postgres in server/db/agentVersions.test.ts and server/agentVersions.rls.test.ts.
//
//   R1 env flag off -> every new route 404 agents_disabled, before any query
//   R2 history: owner-only, newest first, paged, bad query -> 400
//   R3 restore: saves the old content as a new version (origin restore), validated like a save; a stale or foreign id is 404/409
//   R4 duplicate: the owner copies her own version, a recipient copies the shared one; the copy is validated against HER catalogs
//   R5 shares: owner-only, body validated (version, kind, principal), the whole app needs no principal, the cap is a 409
//   R6 version approval: submit is the owner's, decisions are the admin's; stale / agent_pending are 409; no e-mail in answers
//   R7 shared-with-me is not read as an agent id
//
//   node --test server/routes/agents.versions.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import type { AddressInfo } from 'node:net'
import { authed } from './authed.ts'

import registerAgentRoutes from './agents.ts'
import registerAdminAgentRoutes from './adminAgents.ts'
import type { AgentRow } from '../db/agents.ts'
import type { AdminVersionRow, AgentVersionRow, ShareRow, SharedVersionRow, VersionOrigin } from '../db/agentVersions.ts'
import type { AgentDefinition, DefinitionContext } from '../agents/definition.ts'
import { AGENT_LIMITS } from '../agents/definition.ts'

const A = 'ana@example.com'
const B = 'bruno@example.com'
const ADMIN = 'boss@example.com'
const NOW = new Date('2026-11-18T12:00:00Z')
const CTX: DefinitionContext = { models: new Set(['model-a']), catalog: new Map() }

const DEF = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({ instructions: 'Be brief.', prompt: 'Summarise.', model: 'model-a', reasoningEffort: null, tools: ['web_search'], schedule: null, lang: 'en', ...over })
const body = (over: Record<string, unknown> = {}) => ({ name: 'Sales', description: 'd', ...DEF(), ...over })

type Ver = AgentVersionRow
function makeStores() {
  const agents = new Map<string, AgentRow>()
  const versions: Ver[] = []
  const shares: Array<ShareRow & { agentId: string }> = []
  const calls: Array<{ fn: string; args: unknown[] }> = []
  const rec = (fn: string, ...args: unknown[]) => calls.push({ fn, args })
  let seq = 0
  const add = (a: AgentRow, origin: VersionOrigin | null = null) =>
    versions.push({ agentId: a.id, version: a.revision, ownerEmail: a.ownerEmail, name: a.name, description: a.description, definition: a.definition, createdBy: a.ownerEmail, createdAt: NOW.toISOString(), origin, status: 'draft', decisionReason: null, approvedAt: null, hash: `h${a.id}-${a.revision}`, isHead: true, shares: [] })
  const mine = (email: string, id: string) => (agents.get(id)?.ownerEmail === email ? (agents.get(id) as AgentRow) : null)
  const db = {
    async listAgents() { return [] as AgentRow[] },
    async getAgent(email: string, _t: unknown, id: string) { const r = mine(email, id); return r ? { ...r } : null },
    async createAgent(email: string, _t: unknown, a: { name: string; description: string; definition: AgentDefinition }, origin: VersionOrigin | null = null) {
      rec('createAgent', email, a, origin)
      const id = String(++seq)
      const row = { id, ownerEmail: email, name: a.name, description: a.description, definition: a.definition, revision: 1, status: 'draft', approvalExpiresAt: null, decisionReason: null, enabled: false, nextRunAt: null, lastRunAt: null, consecutiveFailures: 0, disabledReason: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } as AgentRow
      agents.set(id, row)
      add(row, origin)
      return row
    },
    async updateAgent(email: string, _t: unknown, id: string, a: { name: string; description: string; definition: AgentDefinition }, o: { revision: number; origin?: VersionOrigin | null }) {
      rec('updateAgent', email, id, a, o)
      const r = mine(email, id)
      if (!r) return null
      if (r.revision !== o.revision) return 'conflict' as const
      if (JSON.stringify([r.name, r.description, r.definition]) === JSON.stringify([a.name, a.description, a.definition])) return r
      Object.assign(r, { name: a.name, description: a.description, definition: a.definition, revision: r.revision + 1 })
      add(r, o.origin ?? null)
      return r
    },
    async deleteAgent() { return false },
    async submitAgent() { return null },
    async setAgentEnabled() { return null },
    async queueManualRun() { return null },
    async listAgentRuns() { return [] as never[] },
    async readAgentSettings() { return { enabled: true, maxRunCostUsd: 1, approvalDays: 90 } },
  }
  const sharedTo = (email: string): SharedVersionRow[] =>
    versions
      .filter((v) => v.status === 'approved' && v.ownerEmail !== email && shares.some((s) => s.agentId === v.agentId && s.version === v.version && (s.kind === 'app' || (s.kind === 'user' && s.principal === email))))
      .map((v) => ({ agentId: v.agentId, version: v.version, ownerEmail: v.ownerEmail, name: v.name, description: v.description, definition: v.definition, approvedAt: v.approvedAt }))
  const ver = {
    async listAgentVersions(email: string, _t: unknown, id: string, o: { limit?: number; before?: number } = {}) {
      rec('listAgentVersions', email, id, o)
      if (!mine(email, id)) return null
      const all = versions.filter((v) => v.agentId === id).sort((a, b) => b.version - a.version).filter((v) => o.before === undefined || v.version < o.before)
      const limit = o.limit ?? 30
      return { versions: all.slice(0, limit).map((v) => ({ ...v, isHead: v.version === agents.get(id)?.revision })), hasMore: all.length > limit }
    },
    async getVersionForUse(email: string, _t: unknown, id: string, version: number | null): Promise<SharedVersionRow | null> {
      const own = versions.filter((v) => v.agentId === id && v.ownerEmail === email)
      const pool: SharedVersionRow[] = [...own, ...sharedTo(email).filter((s) => s.agentId === id)].map((v) => ({ agentId: v.agentId, version: v.version, ownerEmail: v.ownerEmail, name: v.name, description: v.description, definition: v.definition, approvedAt: v.approvedAt }))
      const hit = pool.filter((v) => version === null || v.version === version).sort((a, b) => b.version - a.version)[0]
      return hit ?? null
    },
    async listSharedWithMe(email: string) { return sharedTo(email) },
    async submitAgentVersion(email: string, _t: unknown, id: string, version: number) {
      const v = versions.find((x) => x.agentId === id && x.version === version && x.ownerEmail === email)
      if (!v || !['draft', 'rejected', 'revoked'].includes(v.status)) return null
      v.status = 'pending'
      return v
    },
    async listAgentShares(email: string, _t: unknown, id: string) { return mine(email, id) ? shares.filter((s) => s.agentId === id) : null },
    async upsertAgentShare(email: string, _t: unknown, id: string, s: { version: number; kind: 'user' | 'group' | 'app'; principal: string }) {
      rec('upsertAgentShare', email, id, s)
      if (!mine(email, id)) return null
      if (!versions.some((v) => v.agentId === id && v.version === s.version)) return 'no_version' as const
      if (shares.filter((x) => x.agentId === id).length >= AGENT_LIMITS.sharesPerAgent) return 'limit' as const
      const row = { agentId: id, kind: s.kind, principal: s.principal, version: s.version, createdAt: NOW.toISOString() }
      shares.push(row)
      return row
    },
    async removeAgentShare(email: string, _t: unknown, id: string, kind: string, principal: string) {
      rec('removeAgentShare', email, id, kind, principal)
      const i = shares.findIndex((s) => s.agentId === id && s.kind === kind && s.principal === principal)
      if (!mine(email, id) || i < 0) return false
      shares.splice(i, 1)
      return true
    },
  }
  const adminVer = {
    decisions: [] as unknown[],
    async listVersionsForReview(_e: string, _t: unknown, o: { status?: string }) {
      return versions.filter((v) => !o.status || v.status === o.status).map((v) => ({ ...v, currentHash: v.hash, agentStatus: 'draft', previous: null })) as unknown as AdminVersionRow[]
    },
    async decideAgentVersion(_e: string, _t: unknown, id: string, version: number, d: { decision: string; expectedHash: string; reason?: string }) {
      adminVer.decisions.push({ id, version, ...d })
      const v = versions.find((x) => x.agentId === id && x.version === version)
      if (!v) return null
      if (id === 'head-pending') return 'agent_pending' as const
      if (d.decision === 'approve' && d.expectedHash !== v.hash) return 'stale' as const
      if (d.decision === 'approve' && v.status !== 'pending') return 'stale' as const
      v.status = d.decision === 'approve' ? 'approved' : d.decision === 'reject' ? 'rejected' : 'revoked'
      if (d.decision === 'approve') v.approvedAt = NOW.toISOString()
      return { ...v, currentHash: v.hash, agentStatus: 'draft', previous: null } as unknown as AdminVersionRow
    },
  }
  return { agents, versions, shares, calls, db, ver, adminVer }
}

function fakeAuth(req: Request, res: Response, next: NextFunction) {
  const email = req.headers['x-test-email'] as string
  if (!email) return res.status(401).json({ error: 'no identity' })
  authed(req).email = email
  authed(req).token = 'fake-obo-token-not-a-secret'
  next()
}
const fakeAdmin = (req: Request, res: Response, next: NextFunction) => (req.headers['x-test-admin'] === '1' ? next() : res.status(403).json({ error: 'admin_required' }))

async function serve(over: { env?: Record<string, string | undefined> } = {}) {
  const stores = makeStores()
  const app = express()
  app.use(express.json())
  const env = over.env || { AGENTS_ENABLED: '1' }
  registerAgentRoutes(app, { auth: fakeAuth, env, now: () => NOW, db: stores.db, versions: stores.ver, context: async () => CTX, notify: () => {} } as Parameters<typeof registerAgentRoutes>[1])
  registerAdminAgentRoutes(app, { auth: fakeAuth, requireAdmin: fakeAdmin, env, versions: stores.adminVer } as Parameters<typeof registerAdminAgentRoutes>[1])
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (method: string, p: string, email: string | null, b?: unknown, admin = false) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(email ? { 'x-test-email': email } : {}), ...(admin ? { 'x-test-admin': '1' } : {}), ...(b !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: b === undefined ? undefined : JSON.stringify(b),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null, text }
  }
  return { ...stores, call, close: () => new Promise((r) => server.close(r)) }
}
type Served = Awaited<ReturnType<typeof serve>>

const create = async (s: Served, email = A, over: Record<string, unknown> = {}) => {
  const r = await s.call('POST', '/api/agents', email, body(over))
  assert.equal(r.status, 201, r.text)
  return r.body as AgentRow
}
const edit = async (s: Served, id: string, revision: number, over: Record<string, unknown>, email = A) => {
  const r = await s.call('PATCH', `/api/agents/${id}`, email, { revision, ...over })
  assert.equal(r.status, 200, r.text)
  return r.body as AgentRow
}

test('R1 with AGENTS_ENABLED off the new routes answer 404 agents_disabled and run no query', async () => {
  const s = await serve({ env: {} })
  try {
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/agents/shared-with-me'],
      ['GET', '/api/agents/1/versions'],
      ['POST', '/api/agents/1/versions/1/restore', {}],
      ['POST', '/api/agents/1/versions/1/submit', {}],
      ['POST', '/api/agents/1/duplicate', {}],
      ['GET', '/api/agents/1/shares'],
      ['POST', '/api/agents/1/shares', { version: 1, kind: 'app' }],
      ['DELETE', '/api/agents/1/shares/app/*'],
    ]
    for (const [m, p, b] of routes) {
      const r = await s.call(m, p, A, b)
      assert.equal(r.status, 404, `${m} ${p}`)
      assert.equal(r.body.code, 'agents_disabled')
    }
    for (const [m, p, b] of [['GET', '/api/admin/agent-versions'], ['POST', '/api/admin/agent-versions/1/1/approve', { expectedHash: 'x' }]] as Array<[string, string, unknown?]>) {
      const r = await s.call(m, p, A, b, true)
      assert.equal(r.status, 404, `${m} ${p}`)
    }
    assert.equal(s.calls.length, 0, 'no data function was called')
  } finally {
    await s.close()
  }
})

test('R2 history: owner-only, newest first, paged; a bad query is 400', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    await edit(s, a.id, 1, { prompt: 'two' })
    await edit(s, a.id, 2, { prompt: 'three' })
    const all = await s.call('GET', `/api/agents/${a.id}/versions`, A)
    assert.equal(all.status, 200)
    assert.deepEqual(all.body.versions.map((v: Ver) => v.version), [3, 2, 1])
    assert.equal(all.body.hasMore, false)
    const page = await s.call('GET', `/api/agents/${a.id}/versions?limit=2`, A)
    assert.deepEqual(page.body.versions.map((v: Ver) => v.version), [3, 2])
    assert.equal(page.body.hasMore, true)
    assert.deepEqual((await s.call('GET', `/api/agents/${a.id}/versions?limit=2&before=2`, A)).body.versions.map((v: Ver) => v.version), [1])
    for (const q of ['before=0', 'before=x', 'limit=0', 'limit=abc', 'before=-1']) assert.equal((await s.call('GET', `/api/agents/${a.id}/versions?${q}`, A)).status, 400, q)
    const foreign = await s.call('GET', `/api/agents/${a.id}/versions`, B)
    assert.equal(foreign.status, 404, 'B: the same answer as for an id that does not exist')
    assert.deepEqual(foreign.body, (await s.call('GET', '/api/agents/9999/versions', B)).body)
  } finally {
    await s.close()
  }
})

test('R3 restore saves the old content as a new version, validated like a save', async () => {
  const s = await serve()
  try {
    const a = await create(s, A, { prompt: 'original' })
    await edit(s, a.id, 1, { prompt: 'edited' })
    const r = await s.call('POST', `/api/agents/${a.id}/versions/1/restore`, A, {})
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.revision, 3)
    assert.equal(r.body.definition.prompt, 'original')
    assert.deepEqual(s.versions.find((v) => v.agentId === a.id && v.version === 3)?.origin, { kind: 'restore', agentId: a.id, version: 1 })
    assert.equal(s.versions.filter((v) => v.agentId === a.id).length, 3, 'the history grew, nothing was rewritten')
    // what is already current is not a new version
    assert.equal((await s.call('POST', `/api/agents/${a.id}/versions/3/restore`, A, {})).body.revision, 3)
    // a body cannot smuggle an owner, status or content
    const smuggle = await s.call('POST', `/api/agents/${a.id}/versions/2/restore`, A, { ownerEmail: B, status: 'approved', prompt: 'evil' })
    assert.equal(smuggle.body.definition.prompt, 'edited')
    assert.equal(smuggle.body.ownerEmail, A)
    // the old content must still be valid today: a model that left the catalog cannot come back
    s.versions.find((v) => v.agentId === a.id && v.version === 1)!.definition = DEF({ model: 'gone' })
    const gone = await s.call('POST', `/api/agents/${a.id}/versions/1/restore`, A, {})
    assert.equal(gone.status, 400)
    assert.equal(gone.body.code, 'model_not_in_catalog')
    assert.equal((await s.call('POST', `/api/agents/${a.id}/versions/99/restore`, A, {})).status, 404)
    assert.equal((await s.call('POST', `/api/agents/${a.id}/versions/0/restore`, A, {})).status, 400)
    assert.equal((await s.call('POST', `/api/agents/${a.id}/versions/1/restore`, B, {})).status, 404, 'not B\'s')
  } finally {
    await s.close()
  }
})

test('R4 duplicate: the owner copies her version, a recipient copies the shared one, both validated against the caller', async () => {
  const s = await serve()
  try {
    const a = await create(s, A, { prompt: 'one' })
    await edit(s, a.id, 1, { prompt: 'two' })
    const own = await s.call('POST', `/api/agents/${a.id}/duplicate`, A, { version: 1, name: 'My copy' })
    assert.equal(own.status, 201, own.text)
    assert.equal(own.body.name, 'My copy')
    assert.equal(own.body.definition.prompt, 'one')
    assert.equal(own.body.status, 'draft')
    assert.deepEqual(s.versions.find((v) => v.agentId === own.body.id)?.origin, { kind: 'duplicate', agentId: a.id, version: 1 })
    const head = await s.call('POST', `/api/agents/${a.id}/duplicate`, A, {})
    assert.equal(head.body.name, 'Sales (copy)')
    assert.equal(head.body.definition.prompt, 'two', 'no version: the current one')
    assert.equal((await s.call('POST', `/api/agents/${a.id}/duplicate`, A, { name: 'x'.repeat(200) })).body.name.length, AGENT_LIMITS.nameMax)
    for (const v of ['1', 0, -1, 1.5]) assert.equal((await s.call('POST', `/api/agents/${a.id}/duplicate`, A, { version: v })).status, 400, String(v))
    // B holds no share: not found, whatever the version
    assert.equal((await s.call('POST', `/api/agents/${a.id}/duplicate`, B, { version: 1 })).status, 404)
    // approve v1 and share it with B: B copies exactly that version, and the origin says it was shared
    const v1 = s.versions.find((v) => v.agentId === a.id && v.version === 1)!
    v1.status = 'approved'
    s.shares.push({ agentId: a.id, kind: 'user', principal: B, version: 1, createdAt: NOW.toISOString() })
    const theirs = await s.call('POST', `/api/agents/${a.id}/duplicate`, B, {})
    assert.equal(theirs.status, 201, theirs.text)
    assert.equal(theirs.body.ownerEmail, B)
    assert.equal(theirs.body.definition.prompt, 'one', 'the shared version, not the owner\'s newer one')
    assert.deepEqual(s.versions.find((v) => v.agentId === theirs.body.id)?.origin, { kind: 'shared', agentId: a.id, version: 1 })
    assert.equal((await s.call('POST', `/api/agents/${a.id}/duplicate`, B, { version: 2 })).status, 404, 'v2 is not shared with B')
    // the copy goes through B's catalogs: a model B's catalog lacks refuses it
    v1.definition = DEF({ model: 'not-for-b' })
    assert.equal((await s.call('POST', `/api/agents/${a.id}/duplicate`, B, {})).body.code, 'model_not_in_catalog')
  } finally {
    await s.close()
  }
})

test('R5 shares: owner-only, validated body, the whole app takes no principal, the cap is a 409', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    const ok = await s.call('POST', `/api/agents/${a.id}/shares`, A, { version: 1, kind: 'user', principal: ' Bruno@Example.com ' })
    assert.equal(ok.status, 201, ok.text)
    assert.equal(ok.body.principal, 'bruno@example.com', 'normalised')
    assert.equal((await s.call('POST', `/api/agents/${a.id}/shares`, A, { version: 1, kind: 'group', principal: 'Finance-Team' })).body.principal, 'finance-team')
    const app = await s.call('POST', `/api/agents/${a.id}/shares`, A, { version: 1, kind: 'app', principal: 'ignored' })
    assert.equal(app.body.principal, '*')
    assert.deepEqual((await s.call('GET', `/api/agents/${a.id}/shares`, A)).body.shares.map((x: ShareRow) => x.kind), ['user', 'group', 'app'])
    const bad: Array<[unknown, string]> = [
      [{ kind: 'user', principal: 'b@x.test' }, 'invalid_version'],
      [{ version: 0, kind: 'user', principal: 'b@x.test' }, 'invalid_version'],
      [{ version: '1', kind: 'user', principal: 'b@x.test' }, 'invalid_version'],
      [{ version: 1, kind: 'role', principal: 'b@x.test' }, 'invalid_kind'],
      [{ version: 1, kind: 'user', principal: 'not-an-email' }, 'invalid_principal'],
      [{ version: 1, kind: 'user' }, 'invalid_principal'],
      [{ version: 1, kind: 'group', principal: '' }, 'invalid_principal'],
      [{ version: 1, kind: 'group', principal: 'a\u0000b' }, 'invalid_principal'],
    ]
    for (const [b, code] of bad) {
      const r = await s.call('POST', `/api/agents/${a.id}/shares`, A, b)
      assert.equal(r.status, 400, JSON.stringify(b))
      assert.equal(r.body.code, code, JSON.stringify(b))
    }
    assert.equal((await s.call('POST', `/api/agents/${a.id}/shares`, A, { version: 9, kind: 'app' })).status, 404, 'no such version')
    assert.equal((await s.call('POST', `/api/agents/${a.id}/shares`, B, { version: 1, kind: 'app' })).status, 404, 'not B\'s agent')
    assert.equal((await s.call('GET', `/api/agents/${a.id}/shares`, B)).status, 404)
    // remove
    assert.equal((await s.call('DELETE', `/api/agents/${a.id}/shares/user/${encodeURIComponent('Bruno@Example.com')}`, A)).status, 204)
    assert.equal((await s.call('DELETE', `/api/agents/${a.id}/shares/user/bruno%40example.com`, A)).status, 404, 'already gone')
    assert.equal((await s.call('DELETE', `/api/agents/${a.id}/shares/app/%2A`, A)).status, 204)
    assert.equal((await s.call('DELETE', `/api/agents/${a.id}/shares/role/x`, A)).status, 400)
    // the cap
    for (let i = 0; i < AGENT_LIMITS.sharesPerAgent; i++) s.shares.push({ agentId: a.id, kind: 'user', principal: `u${i}@x.test`, version: 1, createdAt: NOW.toISOString() })
    const over = await s.call('POST', `/api/agents/${a.id}/shares`, A, { version: 1, kind: 'user', principal: 'late@x.test' })
    assert.equal(over.status, 409)
    assert.equal(over.body.code, 'shares_limit')
  } finally {
    await s.close()
  }
})

test('R6 version approval: the owner submits, an admin decides, stale and agent_pending are 409', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    await edit(s, a.id, 1, { prompt: 'two' })
    assert.equal((await s.call('POST', `/api/agents/${a.id}/versions/1/submit`, A, {})).body.status, 'pending')
    assert.equal((await s.call('POST', `/api/agents/${a.id}/versions/1/submit`, A, {})).status, 409, 'already pending')
    assert.equal((await s.call('POST', `/api/agents/${a.id}/versions/2/submit`, B, {})).status, 404, 'not B\'s: not found')
    assert.equal((await s.call('POST', `/api/agents/${a.id}/versions/x/submit`, A, {})).status, 400)
    const id = a.id
    // admin routes: a non-admin is refused before anything runs
    assert.equal((await s.call('GET', '/api/admin/agent-versions', A)).status, 403)
    assert.equal((await s.call('POST', `/api/admin/agent-versions/${id}/1/approve`, A, { expectedHash: 'x' })).status, 403)
    assert.equal(s.adminVer.decisions.length, 0)
    const queue = await s.call('GET', '/api/admin/agent-versions?status=pending', ADMIN, undefined, true)
    assert.equal(queue.status, 200)
    assert.deepEqual(queue.body.versions.map((v: Ver) => [v.agentId, v.version]), [[id, 1]])
    assert.deepEqual(queue.body.versions[0].toolIdentities, [{ tool: 'web_search', runsAs: 'app_service_principal', readsWorkspaceData: false }])
    assert.equal((await s.call('GET', '/api/admin/agent-versions?status=bogus', ADMIN, undefined, true)).status, 400)
    // approve needs the hash the admin saw
    assert.equal((await s.call('POST', `/api/admin/agent-versions/${id}/1/approve`, ADMIN, {}, true)).body.code, 'expected_hash_required')
    const stale = await s.call('POST', `/api/admin/agent-versions/${id}/1/approve`, ADMIN, { expectedHash: 'wrong' }, true)
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'stale')
    const hash = s.versions.find((v) => v.agentId === id && v.version === 1)!.hash
    const ok = await s.call('POST', `/api/admin/agent-versions/${id}/1/approve`, ADMIN, { expectedHash: hash }, true)
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.body.status, 'approved')
    assert.ok(!JSON.stringify(ok.body).includes(ADMIN), 'no admin e-mail in the answer')
    // reject needs a reason; revoke does not
    assert.equal((await s.call('POST', `/api/admin/agent-versions/${id}/2/reject`, ADMIN, {}, true)).body.code, 'reason_required')
    const revoked = await s.call('POST', `/api/admin/agent-versions/${id}/1/revoke`, ADMIN, {}, true)
    assert.equal(revoked.body.status, 'revoked')
    assert.equal((await s.call('POST', `/api/admin/agent-versions/${id}/abc/revoke`, ADMIN, {}, true)).status, 400)
    assert.equal((await s.call('POST', `/api/admin/agent-versions/${id}/9/revoke`, ADMIN, {}, true)).status, 404)
    // the head of a pending agent is decided on the agent card
    s.versions.push({ ...s.versions[0]!, agentId: 'head-pending', version: 1, status: 'pending' })
    const pend = await s.call('POST', '/api/admin/agent-versions/head-pending/1/approve', ADMIN, { expectedHash: 'x' }, true)
    assert.equal(pend.status, 409)
    assert.equal(pend.body.code, 'agent_pending')
  } finally {
    await s.close()
  }
})

test('R7 shared-with-me is its own route (not an agent id) and lists only what is shared with the caller', async () => {
  const s = await serve()
  try {
    const a = await create(s)
    const v = s.versions.find((x) => x.agentId === a.id)!
    v.status = 'approved'
    s.shares.push({ agentId: a.id, kind: 'user', principal: B, version: 1, createdAt: NOW.toISOString() })
    const mineB = await s.call('GET', '/api/agents/shared-with-me', B)
    assert.equal(mineB.status, 200)
    assert.deepEqual(mineB.body.agents.map((x: SharedVersionRow) => [x.agentId, x.version, x.ownerEmail]), [[a.id, 1, A]])
    assert.deepEqual((await s.call('GET', '/api/agents/shared-with-me', 'cleo@example.com')).body.agents, [])
    assert.deepEqual((await s.call('GET', '/api/agents/shared-with-me', A)).body.agents, [], 'the owner\'s own agent is not "shared with her"')
    assert.equal((await s.call('GET', '/api/agents/shared-with-me', null)).status, 401)
  } finally {
    await s.close()
  }
})
