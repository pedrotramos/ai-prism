// startAgentScheduler (W4-4c): the timer, the claim loop, the run wiring and shutdown, with every database call
// injected (no Postgres, no gateway). The same code against a real Postgres is server/agentScheduler.pg.test.ts.
//
//   AC1  flag off: null, no timer, zero SQL (counted)
//   AC5  what the scheduler tells recordRunOutcome: permanent disables at once, transient counts, neutral neither
//   AC6  kick() after notifyAgentsChanged re-arms to the new earliest next_run_at, with no extra claim
//   AC7  stop() cancels in-flight runs as cancelled/shutdown, bounded
//   AC10 the scheduler hands executeAgentRun a renewLease that reaches the database function
import test from 'node:test'
import assert from 'node:assert/strict'
import { startAgentScheduler } from './index.ts'
import type { SchedulerDb } from './index.ts'
import { notifyAgentsChanged } from '../agents/events.ts'
import { nextOccurrence } from '../agents/schedule.ts'
import type { ClaimedRun, RunOutcome } from './run.ts'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const NOW = Date.parse('2026-11-22T12:00:00.000Z')
const ON = { AGENTS_ENABLED: '1' }
const DEF = { instructions: 'i', prompt: 'p', model: 'm', reasoningEffort: null, tools: [], schedule: { freq: 'hourly' as const, minute: 0, tz: 'UTC' }, lang: 'en' as const }
const RUN = (n: number): ClaimedRun => ({
  runId: String(n), agentId: String(100 + n), agentName: `agent-${n}`, ownerEmail: `o${n}@test.invalid`, trigger: 'schedule',
  slotAt: new Date(NOW - 1000).toISOString(), approvalHash: 'h', definition: DEF, instanceId: 'inst-1',
})
const OK: RunOutcome = { status: 'succeeded', errorCode: null, sessionId: '1', messageId: '2', costUsd: null, unpriced: false, toolNames: [] }
const failed = (code: string): RunOutcome => ({ ...OK, status: 'failed', errorCode: code })

// every injected function, counting its calls and recording its arguments
function fakeDb(over: Partial<SchedulerDb> = {}) {
  const calls = { claim: [] as any[], settings: 0, earliest: 0, renew: [] as any[], finish: [] as any[], record: [] as any[] }
  let earliest: Date | null = null
  // the claim is swappable after start (the scheduler copies the db object at start)
  const impl = { claim: (async () => ({ claimed: [], skipped: 0, locked: false })) as (o: any) => Promise<{ claimed: ClaimedRun[]; skipped: number; locked: boolean }> }
  const db: SchedulerDb = {
    readSettings: async () => (calls.settings++, { enabled: true, maxRunCostUsd: 1, approvalDays: 90 }),
    earliestNextRunAt: async () => (calls.earliest++, earliest),
    renewLease: async (...a) => (calls.renew.push(a), true),
    finishRun: async (...a) => (calls.finish.push(a), true),
    recordRunOutcome: async (...a) => void calls.record.push(a),
    ...over,
    claimRuns: async (o) => (calls.claim.push(o), impl.claim(o)),
  }
  if (over.claimRuns) impl.claim = over.claimRuns as typeof impl.claim
  return { db, calls, impl, setEarliest: (d: Date | null) => (earliest = d), total: () => calls.claim.length + calls.settings + calls.earliest + calls.renew.length + calls.finish.length + calls.record.length }
}

// a timer the test fires by hand
function fakeTimers() {
  type Timer = { fn: () => unknown; ms: number; cleared: boolean; unrefs: number }
  const armed: Timer[] = []
  return {
    armed,
    at: (i: number) => armed[i] as Timer,
    setTimer: (fn: () => unknown, ms: number) => {
      const t = { fn, ms, cleared: false, unrefs: 0, unref() { t.unrefs++; return t } }
      armed.push(t)
      return t
    },
    clearTimer: (h: unknown) => void ((h as { cleared: boolean }).cleared = true),
    live: () => armed.filter((t) => !t.cleared),
    last: () => armed[armed.length - 1] as Timer,
  }
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}
const start = (f: ReturnType<typeof fakeDb>, t: ReturnType<typeof fakeTimers>, o: Record<string, unknown> = {}) =>
  startAgentScheduler({ env: ON, instanceId: 'inst-1', now: () => NOW, setTimer: t.setTimer, clearTimer: t.clearTimer, log: quiet, db: f.db, ...o })

test('AC1 the flag off: null, no timer, zero SQL', () => {
  for (const env of [{}, { AGENTS_ENABLED: '0' }, { AGENTS_ENABLED: 'true' }, { AGENTS_ENABLED: '' }]) {
    const f = fakeDb()
    const t = fakeTimers()
    assert.equal(start(f, t, { env }), null)
    assert.equal(t.armed.length, 0)
    assert.equal(f.total(), 0)
  }
})

test('AC1 the env on, the admin setting off: a timer that reads the setting and never claims', async () => {
  const f = fakeDb({ readSettings: async () => ({ enabled: false, maxRunCostUsd: 1, approvalDays: 90 }) })
  const t = fakeTimers()
  const s = start(f, t)!
  assert.ok(s)
  assert.equal(t.live().length, 1)
  assert.equal(t.last().ms, 60_000, 'the first delay is 60 s')
  await t.last().fn()
  await settle()
  assert.equal(f.calls.claim.length, 0, 'no claim while the setting is off')
  assert.equal(t.last().ms, 15 * 60_000, 'it sleeps the max sleep')
  await s.stop()
})

test('timers are unref\'d and the defaults are the brief\'s', async () => {
  const f = fakeDb()
  const t = fakeTimers()
  const s = start(f, t)!
  assert.equal(t.at(0).unrefs, 1, 'the first timer is unref\'d')
  await t.at(0).fn()
  await settle()
  const o = f.calls.claim[0]
  assert.equal(o.instanceId, 'inst-1')
  assert.equal(o.limit, 2, 'concurrency 2')
  assert.equal(o.globalCap, 4)
  assert.equal(o.leaseMs, 120_000)
  assert.equal(o.graceMs, 60 * 60_000)
  assert.equal(o.next, nextOccurrence)
  assert.equal(o.now, undefined, 'no process clock reaches the due comparison (the database\'s now() decides)')
  for (const a of t.armed) assert.equal(a.unrefs, 1, 'every timer is unref\'d')
  await s.stop()
})

test('the env overrides the concurrency, the run timeout and the max sleep', async () => {
  const f = fakeDb()
  const t = fakeTimers()
  const seen: any[] = []
  const s = start(f, t, {
    env: { ...ON, AGENTS_MAX_CONCURRENT_RUNS: '3', AGENT_RUN_TIMEOUT_MS: '90000', AGENT_SCHEDULER_MAX_SLEEP_MS: '300000' },
    execute: async (_run: ClaimedRun, o: any) => (seen.push(o), OK),
  })!
  f.impl.claim = async () => ({ claimed: [RUN(1)], skipped: 0, locked: false })
  await t.at(0).fn()
  await settle()
  assert.equal(f.calls.claim[0].limit, 3)
  assert.equal(seen[0].timeoutMs, 90_000)
  assert.equal(t.last().ms, 300_000, 'idle re-arm at the configured max sleep')
  await s.stop()
})

test('a claim failure is logged, never thrown, and the timer is re-armed', async () => {
  const f = fakeDb({ claimRuns: async () => { throw new Error('db down') } })
  const t = fakeTimers()
  const warnings: string[] = []
  const s = start(f, t, { log: { ...quiet, warn: (m: string) => warnings.push(m) } })!
  await t.at(0).fn()
  await settle()
  assert.equal(warnings.length, 1)
  assert.equal(t.live().length, 1, 'one live timer')
  assert.ok(t.last().ms <= 15 * 60_000)
  await s.stop()
})

test('AC5 what the scheduler records: permanent disables at once, the rest does not', async () => {
  const cases: [RunOutcome, boolean][] = [
    [OK, false],
    [failed('approval_expired'), true],
    [failed('approval_changed'), true],
    [failed('tool_not_admitted'), true],
    [failed('model_not_allowed'), true],
    [failed('sp_model_denied'), true],
    [failed('sp_no_user_credentials'), true],
    [failed('sp_permission_denied'), true],
    [failed('timeout'), false],
    [failed('gateway_error'), false],
    [failed('lease_lost'), false],
    [failed('db_error'), false],
    [failed('cost_cap'), false],
    [{ ...OK, status: 'cancelled', errorCode: 'shutdown' }, false],
  ]
  for (const [outcome, disable] of cases) {
    const f = fakeDb({ claimRuns: async () => ({ claimed: [RUN(1)], skipped: 0, locked: false }) })
    const t = fakeTimers()
    const s = start(f, t, { execute: async () => outcome })!
    await t.at(0).fn()
    await settle()
    assert.equal(f.calls.finish.length, 1, `${outcome.errorCode}: finished once`)
    assert.deepEqual(f.calls.finish[0].slice(0, 3), ['o1@test.invalid', '1', 'inst-1'])
    assert.equal(f.calls.record.length, 1)
    const [agentId, out, opts] = f.calls.record[0]
    assert.equal(agentId, '101')
    assert.equal(out.errorCode, outcome.errorCode)
    assert.equal(opts.disable, disable, `${outcome.errorCode ?? 'ok'}: disable=${disable}`)
    assert.equal(opts.failureThreshold, 3)
    assert.equal(opts.runId, '1')
    await s.stop()
  }
})

test('AC5 a stale holder (finishRun false) does not touch the agent: the recovery already counted the failure', async () => {
  const f = fakeDb({ claimRuns: async () => ({ claimed: [RUN(1)], skipped: 0, locked: false }), finishRun: async () => false })
  const t = fakeTimers()
  const s = start(f, t, { execute: async () => OK })!
  await t.at(0).fn()
  await settle()
  assert.equal(f.calls.record.length, 0)
  await s.stop()
})

test('a run that throws out of execute still ends as a coded failure, never an unhandled rejection', async () => {
  const f = fakeDb({ claimRuns: async () => ({ claimed: [RUN(1)], skipped: 0, locked: false }) })
  const t = fakeTimers()
  const s = start(f, t, { execute: async () => { throw new Error('SECRET text from a tool') } })!
  await t.at(0).fn()
  await settle()
  assert.equal(f.calls.finish.length, 1)
  const out = f.calls.finish[0][3] as RunOutcome
  assert.equal(out.status, 'failed')
  assert.match(out.errorCode ?? '', /^[a-z_]+$/, 'a code, never the message')
  assert.doesNotMatch(JSON.stringify(f.calls.finish), /SECRET/)
  await s.stop()
})

test('concurrency: the claim asks only for the free slots', async () => {
  const release: (() => void)[] = []
  let n = 0
  const f = fakeDb({ claimRuns: async (o) => ({ claimed: o.limit > 0 ? [RUN(++n)] : [], skipped: 0, locked: false }) })
  const t = fakeTimers()
  const s = start(f, t, { concurrency: 2, execute: () => new Promise<RunOutcome>((res) => release.push(() => res(OK))) })!
  await t.at(0).fn()
  await settle()
  await t.last().fn()
  await settle()
  await t.last().fn()
  await settle()
  assert.deepEqual(f.calls.claim.map((c) => c.limit), [2, 1, 0], 'two running → no free slot (it still claims, to recover expired leases)')
  release.forEach((r) => r())
  await settle()
  await s.stop()
})

test('AC6 kick() after notifyAgentsChanged re-arms to the new earliest next_run_at, with no extra claim', async () => {
  const f = fakeDb()
  const t = fakeTimers()
  f.setEarliest(new Date(NOW + 10 * 60_000))
  const s = start(f, t)!
  await t.at(0).fn()
  await settle()
  assert.equal(f.calls.claim.length, 1)
  assert.equal(t.last().ms, 10 * 60_000, 're-armed at the earliest next_run_at')
  // an owner enables a schedule due in 2 minutes: the route notifies, this process re-arms
  f.setEarliest(new Date(NOW + 2 * 60_000))
  const before = t.live().length
  notifyAgentsChanged()
  await settle()
  assert.equal(t.last().ms, 2 * 60_000)
  assert.equal(t.live().length, before, 'the previous timer was cleared, still one live timer')
  assert.equal(f.calls.claim.length, 1, 'no claim: nothing is due')
  // the explicit kick does the same
  f.setEarliest(new Date(NOW + 5 * 60_000))
  s.kick()
  await settle()
  assert.equal(t.last().ms, 5 * 60_000)
  assert.equal(f.calls.claim.length, 1)
  // something due now (a queued manual run): the timer fires at once and claims
  f.setEarliest(new Date(NOW - 5_000))
  notifyAgentsChanged()
  await settle()
  assert.ok(t.last().ms <= 250, `due → a near-zero delay (got ${t.last().ms})`)
  assert.equal(f.calls.claim.length, 1, 'still no claim until the timer fires')
  await t.last().fn()
  await settle()
  assert.equal(f.calls.claim.length, 2)
  await s.stop()
})

test('AC6 never sleeps past the max sleep, and a notification during a tick does not start a second claim', async () => {
  const f = fakeDb()
  const t = fakeTimers()
  f.setEarliest(new Date(NOW + 6 * 3600_000))
  const s = start(f, t)!
  await t.at(0).fn()
  await settle()
  assert.equal(t.last().ms, 15 * 60_000, 'capped at 15 min')
  let release!: () => void
  f.impl.claim = async () => (await new Promise<void>((r) => (release = r)), { claimed: [], skipped: 0, locked: false })
  const p = t.last().fn()
  await settle()
  notifyAgentsChanged()
  s.kick()
  await settle()
  assert.equal(f.calls.claim.length, 2, 'one claim in flight, none added by the signals')
  release()
  await p
  await settle()
  assert.equal(t.live().length, 1)
  await s.stop()
})

test('AC7 stop(): no new claims, in-flight runs end as cancelled/shutdown, the timer and the listener are gone', async () => {
  const f = fakeDb({ claimRuns: async () => ({ claimed: [RUN(1), RUN(2)], skipped: 0, locked: false }) })
  const t = fakeTimers()
  let aborted = 0
  const s = start(f, t, {
    execute: (_run: ClaimedRun, o: { signal: AbortSignal }) =>
      new Promise<RunOutcome>((res) =>
        o.signal.addEventListener('abort', () => {
          aborted++
          assert.equal(o.signal.reason, 'shutdown')
          res({ ...OK, status: 'cancelled', errorCode: 'shutdown' })
        })
      ),
  })!
  await t.at(0).fn()
  await settle()
  const started = Date.now()
  await s.stop()
  assert.ok(Date.now() - started < 1000)
  assert.equal(aborted, 2)
  assert.equal(f.calls.finish.length, 2)
  for (const c of f.calls.finish) {
    assert.equal(c[3].status, 'cancelled')
    assert.equal(c[3].errorCode, 'shutdown')
  }
  for (const r of f.calls.record) assert.equal(r[2].disable, false, 'a shutdown never disables the schedule')
  assert.equal(t.live().length, 0, 'no live timer')
  const claims = f.calls.claim.length
  notifyAgentsChanged()
  s.kick()
  await settle()
  assert.equal(f.calls.claim.length, claims)
  assert.equal(t.live().length, 0, 'a signal after stop() arms nothing')
  await s.stop() // idempotent
})

test('AC7 stop() is bounded when a run ignores the abort', async () => {
  const f = fakeDb({ claimRuns: async () => ({ claimed: [RUN(1)], skipped: 0, locked: false }) })
  const t = fakeTimers()
  const s = start(f, t, { stopTimeoutMs: 40, execute: () => new Promise<RunOutcome>(() => {}) })!
  await t.at(0).fn()
  await settle()
  const started = Date.now()
  await s.stop()
  const took = Date.now() - started
  assert.ok(took >= 30 && took < 1000, `bounded wait (${took} ms)`)
})

test('a claim already in flight when stop() lands never starts its runs', async () => {
  let release!: () => void
  const f = fakeDb({ claimRuns: async () => (await new Promise<void>((r) => (release = r)), { claimed: [RUN(1)], skipped: 0, locked: false }) })
  const t = fakeTimers()
  let executed = 0
  const s = start(f, t, { execute: async (_r: ClaimedRun, o: { signal: AbortSignal }) => (executed++, o.signal.aborted ? { ...OK, status: 'cancelled' as const, errorCode: 'shutdown' } : OK) })!
  const tick = t.at(0).fn()
  await settle()
  const stopping = s.stop()
  release()
  await tick
  await stopping
  const out = f.calls.finish[0]?.[3] as RunOutcome | undefined
  assert.ok(out, 'the claimed row is finished, never left running')
  assert.equal(out.errorCode, 'shutdown')
  assert.equal(out.status, 'cancelled')
})

test('AC10 the scheduler hands executeAgentRun a renewLease that reaches the database function', async () => {
  const f = fakeDb({ claimRuns: async () => ({ claimed: [RUN(7)], skipped: 0, locked: false }) })
  const t = fakeTimers()
  let seen: any
  const s = start(f, t, {
    leaseMs: 90_000,
    heartbeatMs: 12_345,
    execute: async (run: ClaimedRun, o: any) => {
      seen = o
      assert.equal(typeof o.deps?.renewLease, 'function', 'renewLease is passed')
      assert.equal(o.deps.heartbeatMs, 12_345)
      assert.equal(await o.deps.renewLease(run), true)
      return OK
    },
  })!
  await t.at(0).fn()
  await settle()
  assert.ok(seen)
  assert.deepEqual(f.calls.renew, [['o7@test.invalid', '7', 'inst-1', 90_000]])
  assert.equal(seen.maxRunCostUsd, 1, 'the admin\'s per-run cap')
  assert.ok(seen.signal instanceof AbortSignal)
  await s.stop()
})

test('the per-run cost cap is the admin setting read at the tick', async () => {
  const f = fakeDb({
    readSettings: async () => ({ enabled: true, maxRunCostUsd: 2.5, approvalDays: 90 }),
    claimRuns: async () => ({ claimed: [RUN(1)], skipped: 0, locked: false }),
  })
  const t = fakeTimers()
  let cap = 0
  const s = start(f, t, { execute: async (_r: ClaimedRun, o: { maxRunCostUsd: number }) => ((cap = o.maxRunCostUsd), OK) })!
  await t.at(0).fn()
  await settle()
  assert.equal(cap, 2.5)
  await s.stop()
})
