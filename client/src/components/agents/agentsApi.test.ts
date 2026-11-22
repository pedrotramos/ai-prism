// W4-4e: the thin fetch layer of the Agents UI (status fails closed; errors keep status + code; no raw text).
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { agentsApi, AgentsApiError, fetchAgentsStatus } from './agentsApi.ts'

const real = globalThis.fetch
let calls: { method: string; url: string; body: unknown }[] = []
const mock = (answer: (url: string, method: string) => { status?: number; body?: unknown } | 'throw') => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method || 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const a = answer(url, method)
    if (a === 'throw') throw new TypeError('Failed to fetch')
    return new Response(a.status === 204 ? null : JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}
beforeEach(() => { calls = [] })
afterEach(() => { globalThis.fetch = real })

test('AC1: status fails closed — off, an error, a 404, a network failure and a malformed body all read as "not enabled"', async () => {
  mock(() => ({ body: { enabled: true } }))
  assert.equal(await fetchAgentsStatus(), true)
  mock(() => ({ body: { enabled: false, reason: 'admin_off' } }))
  assert.equal(await fetchAgentsStatus(), false)
  mock(() => ({ status: 404, body: { code: 'agents_disabled' } }))
  assert.equal(await fetchAgentsStatus(), false)
  mock(() => ({ status: 500, body: { enabled: true } }))
  assert.equal(await fetchAgentsStatus(), false)
  mock(() => 'throw')
  assert.equal(await fetchAgentsStatus(), false)
  mock(() => ({ body: { enabled: 'yes' } }))
  assert.equal(await fetchAgentsStatus(), false)
})

test('a failure keeps status and the stable code; the server text is never used', async () => {
  mock(() => ({ status: 409, body: { error: 'agents_limit', code: 'agents_limit', detail: 'password authentication failed for user' } }))
  await assert.rejects(agentsApi.create({} as never), (e: unknown) => e instanceof AgentsApiError && e.status === 409 && e.code === 'agents_limit' && !/password/.test(e.message))
  mock(() => ({ status: 500, body: { error: 'relation "agents" does not exist' } }))
  await assert.rejects(agentsApi.list(), (e: unknown) => e instanceof AgentsApiError && e.status === 500 && e.code === 'internal_error')
  mock(() => 'throw')
  await assert.rejects(agentsApi.list(), (e: unknown) => e instanceof AgentsApiError && e.code === 'network' && e.status === 0)
})

test('the calls hit the documented routes with the documented bodies', async () => {
  mock((url, m) => (m === 'DELETE' ? { status: 204 } : { body: { agents: [], runs: [], run: {}, agent: {}, kinds: [], mcp: [] } }))
  await agentsApi.list()
  await agentsApi.create({ name: 'x' } as never)
  await agentsApi.update('7', { name: 'y' } as never, 3)
  await agentsApi.remove('7')
  await agentsApi.submit('7')
  await agentsApi.enable('7')
  await agentsApi.disable('7')
  await agentsApi.run('7')
  await agentsApi.runs('7', { before: '40', limit: 20 })
  await agentsApi.toolOptions()
  await agentsApi.previewSchedule({ freq: 'daily', minute: 0, hour: 8, tz: 'UTC' }, 'pt')
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      'GET /api/agents', 'POST /api/agents', 'PATCH /api/agents/7', 'DELETE /api/agents/7', 'POST /api/agents/7/submit', 'POST /api/agents/7/enable',
      'POST /api/agents/7/disable', 'POST /api/agents/7/run', 'GET /api/agents/7/runs?before=40&limit=20', 'GET /api/agents/tool-options', 'POST /api/agents/schedule-preview',
    ],
  )
  assert.deepEqual(calls[2]!.body, { name: 'y', revision: 3 })
  assert.deepEqual(calls[10]!.body, { schedule: { freq: 'daily', minute: 0, hour: 8, tz: 'UTC' }, lang: 'pt' })
})

test('admin calls: queue, approve with the hash the admin saw, reject with a reason, revoke, settings', async () => {
  mock(() => ({ body: { agents: [], enabled: true } }))
  await agentsApi.admin.list('pending')
  await agentsApi.admin.approve('7', { expectedHash: 'h', days: 30 })
  await agentsApi.admin.reject('7', 'too broad')
  await agentsApi.admin.revoke('7', 'left the team')
  await agentsApi.admin.settings()
  await agentsApi.admin.saveSettings({ enabled: true, approvalDays: 60 })
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    'GET /api/admin/agents?status=pending', 'POST /api/admin/agents/7/approve', 'POST /api/admin/agents/7/reject', 'POST /api/admin/agents/7/revoke', 'GET /api/admin/agents/settings', 'PUT /api/admin/agents/settings',
  ])
  assert.deepEqual(calls[1]!.body, { expectedHash: 'h', days: 30 })
  assert.deepEqual(calls[2]!.body, { reason: 'too broad' })
  assert.deepEqual(calls[3]!.body, { reason: 'left the team' })
  assert.deepEqual(calls[5]!.body, { enabled: true, approvalDays: 60 })
})

test('tool options fail closed: a failed load rejects (the picker then offers nothing) and never returns a partial list', async () => {
  mock(() => ({ status: 500, body: { error: 'internal_error', code: 'internal_error' } }))
  await assert.rejects(agentsApi.toolOptions(), (e: unknown) => e instanceof AgentsApiError && e.code === 'internal_error')
  mock(() => ({ body: { kinds: 'nope', mcp: 7 } }))
  await assert.rejects(agentsApi.toolOptions(), (e: unknown) => e instanceof AgentsApiError)
  mock(() => ({ body: { kinds: ['web_search'], mcp: [{ ref: 'mcp:a.b.c', name: 'C' }] } }))
  assert.deepEqual(await agentsApi.toolOptions(), { kinds: ['web_search'], mcp: [{ ref: 'mcp:a.b.c', name: 'C' }] })
})
