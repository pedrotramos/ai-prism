// executeAgentRun (W4-4b): from a claimed run to an outcome, every dependency injected (no database, no gateway).
// The turn itself is covered by server/turnHeadless.test.ts; here: readiness, admission, the §1.8 code mapping,
// the timeout / cost cap / shutdown / lease-lost stops, and that no message text ever reaches the outcome.
import test from 'node:test'
import assert from 'node:assert/strict'
import { executeAgentRun, runSessionTitle, PERMANENT_RUN_ERRORS, TRANSIENT_RUN_ERRORS, NEUTRAL_RUN_ERRORS, UNPRICED_TOKEN_CAP } from './run.ts'
import type { ClaimedRun, RunDeps } from './run.ts'
import { approvalHash } from '../agents/definition.ts'
import type { AgentDefinition } from '../agents/definition.ts'
import { currentRunAs } from '../runIdentity.ts'
import { currentUsageTags, recordUsage } from '../usage.ts'
import type { HeadlessTurnInput, HeadlessTurnResult } from '../turn.ts'

// an id no real session has: the usage rows of these unit tests (no database in the loop) can never attach to one
const NO_SESSION = '9007199254740000'
const SECRET = 'SECRET-TEXT-FROM-A-TOOL with a row of customer data'
const DEF: AgentDefinition = {
  instructions: 'Seja breve.',
  prompt: 'Resuma as vendas de ontem.',
  model: 'databricks-claude-sonnet-5-5',
  reasoningEffort: null,
  tools: ['genie_one', 'mcp:acme.tools.ok'],
  schedule: { freq: 'daily', minute: 30, hour: 8, tz: 'America/Sao_Paulo' },
  lang: 'pt',
}
const HASH = approvalHash(DEF)
const RUN: ClaimedRun = { runId: '42', agentId: '7', agentName: 'Vendas', ownerEmail: 'owner@test.invalid', trigger: 'schedule', slotAt: '2026-11-21T11:30:00.000Z', approvalHash: HASH, definition: DEF, instanceId: 'i-1' }
const FUTURE = new Date(Date.now() + 86_400_000).toISOString()
const OK_TURN: HeadlessTurnResult = { status: 'ok', messageId: '900', finishReason: 'stop', stoppedEarly: null, toolNames: ['ask_genie_one'], errorCode: null }

interface Spy {
  deps: Partial<RunDeps>
  calls: { sessions: number; messages: number; turns: HeadlessTurnInput[]; runAs: (string | null)[] }
}
function spy(over: Partial<RunDeps> = {}): Spy {
  const calls: Spy['calls'] = { sessions: 0, messages: 0, turns: [], runAs: [] }
  const deps: Partial<RunDeps> = {
    spToken: async () => 'sp-token',
    readAgent: async () => ({ status: 'approved', approvalExpiresAt: FUTURE, definition: DEF }),
    admissionContext: async () => ({ toolPolicy: {}, catalog: new Map([['acme.tools.ok', { credentialClass: 'databricks' }]]) }),
    modelAllowed: async () => true,
    createSession: async () => (calls.sessions++, NO_SESSION),
    addUserMessage: async () => void calls.messages++,
    runTurn: async (input) => {
      calls.turns.push(input)
      calls.runAs.push(currentRunAs())
      return OK_TURN
    },
    ...over,
  }
  return { deps, calls }
}
const exec = (s: Spy, o: Partial<{ signal: AbortSignal; maxRunCostUsd: number; timeoutMs: number }> = {}, run: ClaimedRun = RUN) =>
  executeAgentRun(run, { signal: new AbortController().signal, maxRunCostUsd: 1, timeoutMs: 5000, deps: s.deps, ...o })

test('the happy path: one session, the approved prompt as the user message, the turn as the SP, an outcome of codes and ids', async () => {
  const s = spy()
  const out = await exec(s)
  assert.deepEqual(out, { status: 'succeeded', errorCode: null, sessionId: NO_SESSION, messageId: '900', costUsd: null, unpriced: false, toolNames: ['ask_genie_one'] })
  assert.equal(s.calls.sessions, 1)
  assert.equal(s.calls.messages, 1)
  const [turn] = s.calls.turns
  assert.equal(turn!.email, RUN.ownerEmail)
  assert.equal(turn!.token, 'sp-token')
  assert.equal(turn!.sessionId, NO_SESSION)
  assert.equal(turn!.userText, DEF.prompt)
  assert.deepEqual(turn!.opts, { model: DEF.model, systemPrompt: DEF.instructions, reasoningEffort: null, toolRefs: ['genie-one', 'mcp-external:acme.tools.ok'], lang: 'pt' })
  assert.deepEqual(s.calls.runAs, ['app_sp'], 'the whole run is an app_sp run')
})

test('the turn runs in the run\'s usage scope: tags carry the agent and run ids', async () => {
  let tags: unknown = 'unset'
  const s = spy({ runTurn: async () => ((tags = currentUsageTags()), OK_TURN) })
  await exec(s)
  assert.deepEqual(tags, { ai_prism_run_kind: 'scheduled', ai_prism_agent_id: '7', ai_prism_agent_run_id: '42' })
})

test('AC8: the code of every failure is one of the §1.8 vocabulary, and no message text is ever stored', async () => {
  const cases: [string, Partial<RunDeps>, string][] = [
    ['no SP token', { spToken: async () => null }, 'sp_unavailable'],
    ['agent row gone', { readAgent: async () => null }, 'approval_changed'],
    ['revoked', { readAgent: async () => ({ status: 'revoked', approvalExpiresAt: FUTURE, definition: DEF }) }, 'approval_changed'],
    ['expired', { readAgent: async () => ({ status: 'approved', approvalExpiresAt: new Date(Date.now() - 1000).toISOString(), definition: DEF }) }, 'approval_expired'],
    ['live definition moved', { readAgent: async () => ({ status: 'approved', approvalExpiresAt: FUTURE, definition: { ...DEF, prompt: 'outra coisa' } }) }, 'approval_changed'],
    ['model left the catalog', { modelAllowed: async () => false }, 'model_not_allowed'],
    ['tool refused today', { admissionContext: async () => ({ toolPolicy: {}, catalog: new Map([['acme.tools.ok', { credentialClass: 'per_user' }]]) }) }, 'tool_not_admitted'],
    ['readiness read fails', { readAgent: async () => { throw new Error(SECRET) } }, 'db_error'],
    ['personal credential', { runTurn: async () => { throw Object.assign(new Error(SECRET), { code: 'sp_no_user_credentials' }) } }, 'sp_no_user_credentials'],
    ['sql state', { runTurn: async () => { throw Object.assign(new Error(SECRET), { code: '08006' }) } }, 'db_error'],
    ['permission denied', { runTurn: async () => { throw new Error(`${SECRET} PERMISSION_DENIED`) } }, 'sp_permission_denied'],
    ['unknown throw', { runTurn: async () => { throw new Error(SECRET) } }, 'gateway_error'],
    ['unknown code', { runTurn: async () => { throw Object.assign(new Error(SECRET), { code: 'ECONNRESET_X' }) } }, 'gateway_error'],
    ['turn error result', { runTurn: async () => ({ ...OK_TURN, status: 'error', errorCode: 'sp_model_denied' }) }, 'sp_model_denied'],
    ['turn error with a stray code', { runTurn: async () => ({ ...OK_TURN, status: 'error', errorCode: SECRET }) }, 'gateway_error'],
  ]
  for (const [name, over, code] of cases) {
    const out = await exec(spy(over))
    assert.equal(out.status, 'failed', name)
    assert.equal(out.errorCode, code, name)
    assert.ok(!JSON.stringify(out).includes('SECRET'), `${name}: no message text in the outcome`)
    assert.ok(PERMANENT_RUN_ERRORS.has(code) || TRANSIENT_RUN_ERRORS.has(code) || NEUTRAL_RUN_ERRORS.has(code), `${code} is in the vocabulary`)
  }
})

test('AC8: model-provided tool names cannot place message text in a stored outcome', async () => {
  const marker = 'qa-message-text-marker'
  const out = await exec(spy({ runTurn: async () => ({ ...OK_TURN, toolNames: [marker, 'ask_genie_one', 'mcp_acme_tools_ok__do_thing', `mcp_${marker}`, 'create_document'] }) }))
  assert.ok(!JSON.stringify(out).includes(marker), 'the outcome must contain only server-approved tool identifiers')
  assert.deepEqual(out.toolNames, ['ask_genie_one', 'mcp_acme_tools_ok__do_thing', 'create_document'])
})

test('AC8: a connection failure while the run touches the database maps to db_error, from any step', async () => {
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })
  for (const [name, over] of [
    ['createSession', { createSession: async () => { throw refused() } }],
    ['addUserMessage', { addUserMessage: async () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) } }],
    ['admissionContext', { admissionContext: async () => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) } }],
    ['pool message only', { createSession: async () => { throw new Error('Connection terminated unexpectedly') } }],
  ] as [string, Partial<RunDeps>][]) {
    const out = await exec(spy(over))
    assert.equal(out.errorCode, 'db_error', name)
  }
})

test('a refused run creates no session and calls no model', async () => {
  const s = spy({ modelAllowed: async () => false })
  await exec(s)
  assert.equal(s.calls.sessions, 0)
  assert.equal(s.calls.turns.length, 0)
})

test('the three code sets are disjoint', () => {
  for (const c of PERMANENT_RUN_ERRORS) assert.ok(!TRANSIENT_RUN_ERRORS.has(c) && !NEUTRAL_RUN_ERRORS.has(c), c)
  for (const c of TRANSIENT_RUN_ERRORS) assert.ok(!NEUTRAL_RUN_ERRORS.has(c), c)
  assert.deepEqual([...PERMANENT_RUN_ERRORS].sort(), ['approval_changed', 'approval_expired', 'model_not_allowed', 'sp_model_denied', 'sp_no_user_credentials', 'sp_permission_denied', 'tool_not_admitted'])
})

test('timeout: the turn is aborted and the run fails as timeout', async () => {
  const s = spy({
    runTurn: (input) =>
      new Promise((resolve) => input.signal.addEventListener('abort', () => resolve({ ...OK_TURN, status: 'aborted', messageId: '901' }), { once: true })),
  })
  const out = await exec(s, { timeoutMs: 20 })
  assert.equal(out.status, 'failed')
  assert.equal(out.errorCode, 'timeout')
  assert.equal(out.messageId, '901', 'the partial answer is still reported')
})

test('shutdown: an outer abort cancels the run (cancelled/shutdown), a lease_lost abort fails it', async () => {
  const hang = (input: HeadlessTurnInput) => new Promise<HeadlessTurnResult>((resolve) => input.signal.addEventListener('abort', () => resolve({ ...OK_TURN, status: 'aborted' }), { once: true }))
  const a = new AbortController()
  const p = exec(spy({ runTurn: hang }), { signal: a.signal })
  setTimeout(() => a.abort('shutdown'), 10)
  assert.deepEqual({ ...(await p), costUsd: null }, { status: 'cancelled', errorCode: 'shutdown', sessionId: NO_SESSION, messageId: '900', costUsd: null, unpriced: false, toolNames: ['ask_genie_one'] })
  const b = new AbortController()
  const q = exec(spy({ runTurn: hang }), { signal: b.signal })
  setTimeout(() => b.abort('lease_lost'), 10)
  const lost = await q
  assert.equal(lost.status, 'failed')
  assert.equal(lost.errorCode, 'lease_lost')
  // already aborted before it starts: nothing is created
  const c = new AbortController()
  c.abort('shutdown')
  const s = spy()
  assert.equal((await exec(s, { signal: c.signal })).errorCode, 'shutdown')
  assert.equal(s.calls.sessions, 0)
})

test('cost cap: priced rows past the cap abort the turn; the outcome carries the spend and is neither permanent nor transient', async () => {
  const s = spy({
    runTurn: async (input) => {
      // the turn records usage inside the run's scope; 1M tokens of a priced model is well past $0.05
      recordUsage('chat', 'databricks-claude-sonnet-5-5', { prompt_tokens: 1_000_000, completion_tokens: 0 })
      assert.ok(input.signal.aborted, 'the cap aborted the turn at the next boundary')
      return { ...OK_TURN, status: 'aborted' }
    },
  })
  const out = await exec(s, { maxRunCostUsd: 0.05 })
  assert.equal(out.status, 'failed')
  assert.equal(out.errorCode, 'cost_cap')
  assert.ok(out.costUsd! > 0.05)
  assert.equal(out.unpriced, false)
  assert.ok(NEUTRAL_RUN_ERRORS.has('cost_cap'))
})

test('cost cap on an unpriced model: capped by tokens, flagged unpriced, no cost', async () => {
  const s = spy({
    runTurn: async (input) => {
      recordUsage('chat', 'totally-unknown-model', { prompt_tokens: UNPRICED_TOKEN_CAP / 2, completion_tokens: 1 })
      assert.ok(!input.signal.aborted, 'under the token cap')
      recordUsage('chat', 'totally-unknown-model', { prompt_tokens: UNPRICED_TOKEN_CAP, completion_tokens: 1 })
      assert.ok(input.signal.aborted)
      return { ...OK_TURN, status: 'aborted' }
    },
  })
  const out = await exec(s, { maxRunCostUsd: 1000 })
  assert.equal(out.errorCode, 'cost_cap')
  assert.equal(out.unpriced, true)
  assert.equal(out.costUsd, null)
})

test('a turn that finishes within the cap reports its cost and succeeds', async () => {
  const s = spy({
    runTurn: async () => {
      recordUsage('chat', 'databricks-claude-sonnet-5-5', { prompt_tokens: 1000, completion_tokens: 100 })
      return OK_TURN
    },
  })
  const out = await exec(s, { maxRunCostUsd: 5 })
  assert.equal(out.status, 'succeeded')
  assert.ok(out.costUsd! > 0 && out.costUsd! < 0.1)
})

test('lease heartbeat: two misses in a row stop the run as lease_lost; a success resets the count', async () => {
  const hang = (input: HeadlessTurnInput) => new Promise<HeadlessTurnResult>((resolve) => input.signal.addEventListener('abort', () => resolve({ ...OK_TURN, status: 'aborted' }), { once: true }))
  let beats = 0
  const lost = await exec(spy({ runTurn: hang, heartbeatMs: 5, renewLease: async () => (beats++, false) }))
  assert.equal(lost.errorCode, 'lease_lost')
  assert.ok(beats >= 2)
  // alternating miss/ok never reaches two in a row: the run is stopped by the timeout instead
  let n = 0
  const flaky = await exec(spy({ runTurn: hang, heartbeatMs: 5, renewLease: async () => n++ % 2 === 1 }), { timeoutMs: 80 })
  assert.equal(flaky.errorCode, 'timeout')
  // a throwing renewal counts as a miss
  const thrown = await exec(spy({ runTurn: hang, heartbeatMs: 5, renewLease: async () => { throw new Error(SECRET) } }))
  assert.equal(thrown.errorCode, 'lease_lost')
  assert.ok(!JSON.stringify(thrown).includes('SECRET'))
})

test('runSessionTitle: name, slot time in the schedule zone, and the zone', () => {
  assert.equal(runSessionTitle('Vendas', '2026-11-21T11:30:00.000Z', 'America/Sao_Paulo'), 'Vendas · 2026-11-21 08:30 (America/Sao_Paulo)')
  assert.equal(runSessionTitle('Vendas', '2026-11-21T11:30:00.000Z', undefined), 'Vendas · 2026-11-21 11:30 (UTC)')
  assert.equal(runSessionTitle('Vendas', '2026-11-21T11:30:00.000Z', 'Not/AZone'), 'Vendas · 2026-11-21 11:30 (UTC)')
})
