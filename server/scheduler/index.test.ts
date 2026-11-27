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
import { noteAgentsActivity, notifyAgentsChanged } from '../agents/events.ts'
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
  assert.equal(t.last().ms, 15_000, 'the boot wake-up is the first delay: 15 s')
  await t.last().fn()
  await settle()
  assert.equal(f.calls.claim.length, 0, 'no claim while the setting is off')
  assert.equal(t.last().ms, 6 * 3600_000, 'it sleeps the max sleep (6 h)')
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
  assert.ok(t.last().ms <= 6 * 3600_000)
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
    assert.equal(f.calls.record.length, 0, 'the bookkeeping rides in finishRun (one transaction), never a second write')
    const out = f.calls.finish[0][3]
    const b = f.calls.finish[0][4].bookkeeping
    assert.equal(b.agentId, '101')
    assert.equal(out.errorCode, outcome.errorCode)
    assert.equal(b.disable, disable, `${outcome.errorCode ?? 'ok'}: disable=${disable}`)
    assert.equal(b.failureThreshold, 3)
    assert.equal(b.trigger, 'schedule')
    await s.stop()
  }
})

test('AC5 a stale holder (finishRun false) does not touch the agent: the recovery already counted the failure', async () => {
  let finishCalls = 0
  const f = fakeDb({ claimRuns: async () => ({ claimed: [RUN(1)], skipped: 0, locked: false }), finishRun: async () => (finishCalls++, false) })
  const t = fakeTimers()
  const s = start(f, t, { execute: async () => OK })!
  await t.at(0).fn()
  await settle()
  assert.equal(f.calls.record.length, 0)
  assert.equal(finishCalls, 1, 'finishRun false is the whole story: it wrote nothing, so there is nothing to retry')
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

// ---- sleep until the next due run (the Lakebase pool scales to zero in between) -----------------------------------
test('sleeps until the next due run: one database read per wake-up, none while it sleeps', async () => {
  const f = fakeDb()
  const t = fakeTimers()
  f.setEarliest(new Date(NOW + 4 * 3600_000 + 90_000)) // the next run is 4 h 1.5 min away
  const s = start(f, t)!
  await t.at(0).fn() // the boot wake-up
  await settle()
  assert.equal(t.last().ms, 4 * 3600_000 + 90_000, 'armed for the due time itself, not for a poll interval')
  assert.deepEqual([f.calls.settings, f.calls.claim.length, f.calls.earliest], [1, 1, 1], 'one wake-up = one settings read, one claim, one earliest read')
  assert.equal(t.live().length, 1, 'a single timer is live: nothing polls in between')
  // the timer fires at the due time: the claim runs once more, then it sleeps again
  f.setEarliest(new Date(NOW + 28 * 3600_000))
  await t.last().fn()
  await settle()
  assert.deepEqual([f.calls.settings, f.calls.claim.length, f.calls.earliest], [2, 2, 2])
  assert.equal(t.last().ms, 6 * 3600_000, 'next due run is 28 h away: re-check at the 6 h cap')
  await s.stop()
})

test('with nothing scheduled it still sleeps 6 h, never the old 15 min', async () => {
  const f = fakeDb()
  const t = fakeTimers()
  const s = start(f, t)!
  await t.at(0).fn()
  await settle()
  assert.equal(t.last().ms, 6 * 3600_000)
  assert.equal(f.calls.earliest, 1)
  await s.stop()
})

test('AI_PRISM_SCHEDULER_MAX_SLEEP_MS sets the cap, wins over the legacy name, and a bad value falls back', async () => {
  const cap = async (env: Record<string, string>) => {
    const f = fakeDb()
    const t = fakeTimers()
    const s = start(f, t, { env: { ...ON, ...env } })!
    await t.at(0).fn()
    await settle()
    const ms = t.last().ms
    await s.stop()
    return ms
  }
  assert.equal(await cap({ AI_PRISM_SCHEDULER_MAX_SLEEP_MS: '1800000' }), 1_800_000)
  assert.equal(await cap({ AGENT_SCHEDULER_MAX_SLEEP_MS: '300000' }), 300_000, 'the legacy name still works')
  assert.equal(await cap({ AI_PRISM_SCHEDULER_MAX_SLEEP_MS: '1800000', AGENT_SCHEDULER_MAX_SLEEP_MS: '300000' }), 1_800_000, 'the new name wins')
  assert.equal(await cap({ AI_PRISM_SCHEDULER_MAX_SLEEP_MS: 'soon' }), 6 * 3600_000, 'not a number: the default')
  assert.equal(await cap({ AI_PRISM_SCHEDULER_MAX_SLEEP_MS: '10' }), 6 * 3600_000, 'under 1 s: the default')
  assert.equal(await cap({ AI_PRISM_SCHEDULER_MAX_SLEEP_MS: String(48 * 3600_000) }), 6 * 3600_000, 'over 24 h: the default')
})

test('a schedule approved while it sleeps wakes it at once: the new due time replaces the 6 h sleep', async () => {
  const f = fakeDb()
  const t = fakeTimers()
  const s = start(f, t)!
  await t.at(0).fn()
  await settle()
  assert.equal(t.last().ms, 6 * 3600_000, 'asleep with nothing to do')
  const asleep = t.last()
  // the admin approves an agent whose next run is in 90 s; the route signals this process
  f.setEarliest(new Date(NOW + 90_000))
  notifyAgentsChanged()
  await settle()
  assert.equal(asleep.cleared, true, 'the 6 h timer is cancelled')
  assert.equal(t.last().ms, 90_000)
  assert.equal(t.live().length, 1)
  assert.equal(f.calls.claim.length, 1, 'the signal re-arms; only the timer claims')
  await s.stop()
})

test('a read failure while re-arming retries in a minute, not after the whole 6 h', async () => {
  const f = fakeDb()
  const t = fakeTimers()
  const s = start(f, t, { db: { ...f.db, earliestNextRunAt: async () => { throw new Error('lakebase waking up') } } })!
  await t.at(0).fn()
  await settle()
  assert.equal(t.last().ms, 60_000)
  await s.stop()
})

// ---- a signal that lands while a tick is running is never lost ----------------------------------------------------
// the tick's settings read is held open; the admin turns agents on meanwhile (the route notifies), then the old read
// returns what it saw before (`enabled=false`, or a failure)
async function lateSignal(release: 'off' | 'fail') {
  const f = fakeDb()
  const t = fakeTimers()
  let answer!: (v: { enabled: boolean; maxRunCostUsd: number; approvalDays: number }) => void
  let reject!: (e: Error) => void
  const held = new Promise<{ enabled: boolean; maxRunCostUsd: number; approvalDays: number }>((res, rej) => ((answer = res), (reject = rej)))
  const s = start(f, t, { db: { ...f.db, readSettings: () => held } })!
  const boot = t.at(0).fn() // the tick begins and waits on its settings read
  await settle()
  f.setEarliest(new Date(NOW + 90_000)) // an approved schedule due in 90 s, enabled by the admin during the tick
  notifyAgentsChanged()
  await settle()
  assert.equal(t.last().ms, 90_000, 'the signal armed the new due time')
  if (release === 'off') answer({ enabled: false, maxRunCostUsd: 1, approvalDays: 90 })
  else reject(new Error('lakebase waking up'))
  await boot
  await settle()
  return { f, t, s }
}

test('a signal during a tick whose settings read said "off" is not overwritten by the 6 h sleep', async () => {
  const { t, s } = await lateSignal('off')
  assert.equal(t.last().ms, 90_000, 'the late tick re-planned from the database instead of arming 6 h')
  assert.equal(t.live().length, 1)
  assert.ok(t.armed.every((a) => a.ms < 6 * 3600_000), 'a 6 h timer was never armed after the signal')
  await s.stop()
})

test('a signal during a tick that then fails is not overwritten by the 60 s retry', async () => {
  const { t, s } = await lateSignal('fail')
  assert.equal(t.last().ms, 90_000)
  assert.equal(t.live().length, 1)
  await s.stop()
})

test('with no signal, the tick that read "off" still sleeps the whole 6 h (the re-plan is only for a poke)', async () => {
  const f = fakeDb({ readSettings: async () => ({ enabled: false, maxRunCostUsd: 1, approvalDays: 90 }) })
  const t = fakeTimers()
  const s = start(f, t)!
  await t.at(0).fn()
  await settle()
  assert.equal(f.calls.earliest, 0, 'no schedule read while the switch is off')
  assert.equal(t.last().ms, 6 * 3600_000)
  await s.stop()
})

// ---- request activity: another replica's change is seen without a poll -------------------------------------------
test('request activity re-reads the schedules at most every 5 minutes, so a slot saved elsewhere is seen', async () => {
  const f = fakeDb()
  const t = fakeTimers()
  let clock = NOW
  const s = start(f, t, { now: () => clock })!
  await t.at(0).fn()
  await settle()
  assert.equal(t.last().ms, 6 * 3600_000, 'asleep with nothing due')
  assert.equal(f.calls.earliest, 1)
  // another replica saved a schedule due in 20 min; this process hears nothing
  f.setEarliest(new Date(NOW + 20 * 60_000))
  clock = NOW + 4 * 60_000
  noteAgentsActivity()
  await settle()
  assert.equal(f.calls.earliest, 1, 'a request 4 min after the last look is a no-op')
  assert.equal(t.last().ms, 6 * 3600_000)
  clock = NOW + 5 * 60_000
  noteAgentsActivity()
  await settle()
  assert.equal(f.calls.earliest, 2, 'a request 5 min after the last look re-reads')
  assert.equal(t.last().ms, 15 * 60_000, 're-armed to the slot the other replica saved')
  noteAgentsActivity()
  noteAgentsActivity()
  await settle()
  assert.equal(f.calls.earliest, 2, 'a burst of requests re-reads once')
  assert.equal(f.calls.claim.length, 1, 'activity only re-plans; it never claims')
  await s.stop()
})

test('request activity during a tick is ignored, and after stop() nothing listens', async () => {
  const f = fakeDb()
  const t = fakeTimers()
  let clock = NOW
  let release!: () => void
  const held = new Promise<void>((res) => (release = res))
  const s = start(f, t, {
    now: () => clock,
    db: { ...f.db, readSettings: async () => (await held, { enabled: true, maxRunCostUsd: 1, approvalDays: 90 }) },
  })!
  const running = t.at(0).fn()
  await settle()
  clock = NOW + 10 * 60_000
  noteAgentsActivity()
  await settle()
  assert.equal(f.calls.earliest, 0, 'no re-read while a tick runs')
  release()
  await running
  await settle()
  await s.stop()
  const armed = t.armed.length
  clock = NOW + 60 * 60_000
  noteAgentsActivity()
  await settle()
  assert.equal(t.armed.length, armed, 'a stopped scheduler arms nothing')
})

test('AC6 never sleeps past the max sleep, and a notification during a tick does not start a second claim', async () => {
  const f = fakeDb()
  const t = fakeTimers()
  f.setEarliest(new Date(NOW + 20 * 3600_000))
  const s = start(f, t)!
  await t.at(0).fn()
  await settle()
  assert.equal(t.last().ms, 6 * 3600_000, 'capped at 6 h')
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
  for (const c of f.calls.finish) assert.equal(c[4].bookkeeping.disable, false, 'a shutdown never disables the schedule')
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

test('the global cap stays 4 when per-process concurrency is 5 (and the process never runs more than the cap)', async () => {
  const f = fakeDb()
  const t = fakeTimers()
  const s = start(f, t, { env: { ...ON, AGENTS_MAX_CONCURRENT_RUNS: '5' } })!
  await t.at(0).fn()
  await settle()
  assert.equal(f.calls.claim[0].globalCap, 4)
  assert.equal(f.calls.claim[0].limit, 4, 'concurrency is clamped to the cap')
  await s.stop()
})

test('a permanent outcome and its bookkeeping are written together, and a failed write is retried, never lost', async () => {
  let attempts = 0
  const seenArgs: any[] = []
  const f = fakeDb({
    claimRuns: async () => ({ claimed: [RUN(1)], skipped: 0, locked: false }),
    finishRun: async (...a) => {
      seenArgs.push(a)
      if (++attempts === 1) throw new Error('temporary database failure')
      return true
    },
  })
  const t = fakeTimers()
  const s = start(f, t, { execute: async () => failed('approval_expired') })!
  await t.at(0).fn()
  await settle()
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(attempts, 2, 'retried once and succeeded')
  assert.equal(seenArgs[1][4].bookkeeping.disable, true, 'the permanent code still disables, in the same write')
  assert.equal(f.calls.record.length, 0)
  await s.stop()
})
