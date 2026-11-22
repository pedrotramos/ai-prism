// The agent scheduler (W4-4c, design §1.4, §1.8, §1.9; ADR-0018): the timer, the claim loop and the run wiring.
//
// Every app process runs one (when AGENTS_ENABLED=1). A tick asks the database for work in ONE short claim
// transaction (server/db/agentScheduler.ts: advisory xact lock, expired leases failed, due slots turned into `running`
// rows with a lease), the transaction commits, and only then do the claimed runs execute through executeAgentRun with
// the lease heartbeat wired (renewLease). The outcome is written as the owner (finishRun, guarded by the lease holder)
// and the agent's failure counter and auto-disable are applied (recordRunOutcome). Two processes claim the same slot
// at most once, and a process that dies leaves a run that the next tick of any process fails as lease_expired; it is
// never run again.
//
// The timer: armed for min(earliest next_run_at, now + max sleep) and unref'd, so it never keeps the process alive.
// `kick()` (and the in-process notifyAgentsChanged signal from the routes) only RE-ARMS it; it never claims on its own.
// The process clock arms timers and nothing else: what is due, late or expired is decided by the database's clock.
import { claimRuns, earliestNextRunAt, finishRun, recordRunOutcome, renewLease, DEFAULT_FAILURE_THRESHOLD } from '../db/agentScheduler.ts'
import { readAgentSettings } from '../db/agents.ts'
import { onAgentsChanged } from '../agents/events.ts'
import { nextOccurrence } from '../agents/schedule.ts'
import { withSpan } from '../telemetry.ts'
import { logger } from '../log.ts'
import { executeAgentRun, PERMANENT_RUN_ERRORS } from './run.ts'
import type { ClaimedRun, RunOutcome } from './run.ts'

type Logger = { info(msg: string, fields?: Record<string, unknown>): unknown; warn(msg: string, fields?: Record<string, unknown>): unknown }

/** Every database call the scheduler makes, so a test can count or replace them. */
export interface SchedulerDb {
  readSettings: () => Promise<{ enabled: boolean; maxRunCostUsd: number; approvalDays: number }>
  claimRuns: typeof claimRuns
  earliestNextRunAt: typeof earliestNextRunAt
  renewLease: typeof renewLease
  finishRun: typeof finishRun
  recordRunOutcome: typeof recordRunOutcome
}

export interface AgentSchedulerOptions {
  env?: Record<string, string | undefined>
  instanceId?: string
  now?: () => number
  setTimer?: (fn: () => unknown, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  maxSleepMs?: number
  firstDelayMs?: number
  concurrency?: number
  globalCap?: number
  leaseMs?: number
  heartbeatMs?: number
  graceMs?: number
  timeoutMs?: number
  failureThreshold?: number
  execute?: typeof executeAgentRun
  log?: Logger
  /** the longest stop() waits for in-flight runs to settle (default 10 s) */
  stopTimeoutMs?: number
  /** database seam (tests) */
  db?: Partial<SchedulerDb>
}

export const SCHEDULER_DEFAULTS = Object.freeze({
  maxSleepMs: 15 * 60_000,
  firstDelayMs: 60_000,
  concurrency: 2,
  globalCap: 4,
  leaseMs: 120_000,
  heartbeatMs: 30_000,
  graceMs: 60 * 60_000,
  timeoutMs: 10 * 60_000,
  failureThreshold: DEFAULT_FAILURE_THRESHOLD,
  stopTimeoutMs: 10_000,
})
/** a due schedule fires after this much, never in a hot loop */
const MIN_REARM_MS = 250
/** after a failed tick, and while every slot is busy: look again soon, never after the whole max sleep */
const RETRY_MS = 60_000
const BUSY_RECHECK_MS = 30_000

const intFrom = (v: string | undefined, min: number, max: number): number | undefined => {
  const n = Number(v)
  return v !== undefined && v !== '' && Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

/** A run that threw out of executeAgentRun: a code, never the message. */
const CRASHED: RunOutcome = { status: 'failed', errorCode: 'gateway_error', sessionId: null, messageId: null, costUsd: null, unpriced: false, toolNames: [] }

/**
 * null unless env.AGENTS_ENABLED === '1' (no timer, no SQL). Timers are unref'd. With the env on and the admin's
 * setting (app_settings.agents_enabled) off, the timer only reads that setting at each wake-up, so an admin switching
 * it on needs no restart. stop(): no new claims, aborts in-flight runs (they finish as cancelled/'shutdown'), and
 * resolves when they settle (bounded, 10 s by default).
 */
export function startAgentScheduler(o: AgentSchedulerOptions = {}): { stop(): Promise<void>; kick(): void } | null {
  const env = o.env ?? process.env
  if (env.AGENTS_ENABLED !== '1') return null

  const D = SCHEDULER_DEFAULTS
  const now = o.now ?? (() => Date.now())
  const setTimer = o.setTimer ?? ((fn: () => unknown, ms: number) => setTimeout(fn, ms))
  const clearTimer = o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const log = o.log ?? logger
  const execute = o.execute ?? executeAgentRun
  const instanceId = o.instanceId ?? `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  const maxSleepMs = o.maxSleepMs ?? intFrom(env.AGENT_SCHEDULER_MAX_SLEEP_MS, 1000, 24 * 3600_000) ?? D.maxSleepMs
  const firstDelayMs = o.firstDelayMs ?? D.firstDelayMs
  const concurrency = o.concurrency ?? intFrom(env.AGENTS_MAX_CONCURRENT_RUNS, 1, 20) ?? D.concurrency
  const globalCap = o.globalCap ?? Math.max(D.globalCap, concurrency)
  const leaseMs = o.leaseMs ?? D.leaseMs
  const heartbeatMs = o.heartbeatMs ?? D.heartbeatMs
  const graceMs = o.graceMs ?? D.graceMs
  const timeoutMs = o.timeoutMs ?? intFrom(env.AGENT_RUN_TIMEOUT_MS, 1000, 3600_000) ?? D.timeoutMs
  const failureThreshold = o.failureThreshold ?? D.failureThreshold
  const stopTimeoutMs = o.stopTimeoutMs ?? D.stopTimeoutMs
  const db: SchedulerDb = {
    readSettings: () => readAgentSettings('', null),
    claimRuns,
    earliestNextRunAt,
    renewLease,
    finishRun,
    recordRunOutcome,
    ...o.db,
  }

  let stopped = false
  let handle: unknown = null
  let generation = 0 // a re-arm that lost the race to a newer one drops its result
  let ticking: Promise<void> | null = null
  const inflight = new Map<string, { controller: AbortController; done: Promise<void> }>()

  const disarm = () => {
    if (handle !== null) clearTimer(handle)
    handle = null
  }
  const arm = (ms: number) => {
    disarm()
    if (stopped) return
    const h = setTimer(() => void tick(), Math.max(0, Math.round(ms)))
    ;(h as { unref?: () => unknown } | null)?.unref?.()
    handle = h
  }

  // arms the timer for the earliest thing to do (capped at the max sleep); a read failure retries soon
  async function rearm(): Promise<void> {
    if (stopped) return
    const mine = ++generation
    let ms: number
    if (inflight.size >= concurrency) {
      ms = Math.min(maxSleepMs, BUSY_RECHECK_MS) // every slot busy: a finishing run re-arms sooner
    } else {
      try {
        const at = await db.earliestNextRunAt()
        if (mine !== generation || stopped) return
        ms = at ? Math.min(maxSleepMs, Math.max(MIN_REARM_MS, at.getTime() - now())) : maxSleepMs
      } catch (e) {
        if (mine !== generation || stopped) return
        log.warn('agent scheduler: could not read the next run time', { err: e })
        ms = Math.min(maxSleepMs, RETRY_MS)
      }
    }
    if (mine !== generation) return
    arm(ms)
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (ticking) return ticking // one claim at a time in this process
    ticking = (async () => {
      let next: 'rearm' | number = 'rearm'
      try {
        const settings = await db.readSettings()
        if (stopped) return
        if (!settings.enabled) {
          next = maxSleepMs // the admin's switch is off: nothing to claim, look again later
        } else {
          const limit = Math.max(0, concurrency - inflight.size)
          const r = await withSpan('agent.claim', {}, async (span) => {
            const res = await db.claimRuns({ instanceId, limit, globalCap, leaseMs, graceMs, next: nextOccurrence, failureThreshold })
            span.setAttribute('claimed', res.claimed.length)
            span.setAttribute('skipped', res.skipped)
            span.setAttribute('locked', res.locked)
            return res
          })
          if (r.claimed.length || r.skipped) log.info(`agent scheduler: claimed ${r.claimed.length}, skipped ${r.skipped}`, { claimed: r.claimed.length, skipped: r.skipped })
          for (const run of r.claimed) startRun(run, settings.maxRunCostUsd)
        }
      } catch (e) {
        log.warn('agent scheduler: tick failed', { err: e })
        next = Math.min(maxSleepMs, RETRY_MS)
      } finally {
        ticking = null
      }
      if (typeof next === 'number') {
        generation++
        arm(next)
      } else {
        await rearm()
      }
    })()
    return ticking
  }

  // One claimed run, to the end: execute, write the outcome as the owner, apply the agent's bookkeeping.
  function startRun(run: ClaimedRun, maxRunCostUsd: number) {
    const controller = new AbortController()
    if (stopped) controller.abort('shutdown') // claimed while stop() landed: it ends as cancelled, never left running
    const done = (async () => {
      let out: RunOutcome
      try {
        out = await withSpan('agent.run', { 'agent.id': run.agentId, 'run.id': run.runId, trigger: run.trigger }, async (span) => {
          const res = await execute(run, {
            signal: controller.signal,
            maxRunCostUsd,
            timeoutMs,
            deps: { renewLease: (r: ClaimedRun) => db.renewLease(r.ownerEmail, r.runId, instanceId, leaseMs), heartbeatMs },
          })
          span.setAttribute('status', res.status)
          if (res.errorCode) span.setAttribute('error_code', res.errorCode)
          return res
        })
      } catch (e) {
        log.warn('agent scheduler: a run threw', { agent_id: run.agentId, run_id: run.runId, err: e })
        out = CRASHED
      }
      try {
        const written = await db.finishRun(run.ownerEmail, run.runId, instanceId, out)
        if (!written) {
          // the lease was recovered (or the agent deleted) while this holder ran: the recovery already counted the failure
          log.warn('agent scheduler: run finished after losing its lease', { agent_id: run.agentId, run_id: run.runId })
          return
        }
        const disable = out.errorCode != null && PERMANENT_RUN_ERRORS.has(out.errorCode)
        await db.recordRunOutcome(run.agentId, out, { disable, failureThreshold, runId: run.runId, trigger: run.trigger })
        log.info(`agent scheduler: run ${out.status}`, { agent_id: run.agentId, run_id: run.runId, status: out.status, error_code: out.errorCode, disabled: disable })
      } catch (e) {
        // the row stays `running` until its lease runs out; the next tick of any process fails it as lease_expired
        log.warn('agent scheduler: could not record a run outcome', { agent_id: run.agentId, run_id: run.runId, err: e })
      }
    })()
    inflight.set(run.runId, { controller, done })
    void done.finally(() => {
      inflight.delete(run.runId)
      if (!stopped) void rearm() // a slot is free again
    })
  }

  const offChanged = onAgentsChanged(() => kick())
  function kick(): void {
    if (stopped) return
    void rearm()
  }

  arm(firstDelayMs)

  return {
    kick,
    async stop() {
      if (stopped) return
      stopped = true
      generation++
      disarm()
      offChanged()
      for (const r of inflight.values()) r.controller.abort('shutdown')
      // in-flight runs and a claim that was mid-flight (its runs start already aborted) settle within one bound
      const deadline = Date.now() + stopTimeoutMs
      for (let pass = 0; pass < 2; pass++) {
        const pending = [ticking, ...[...inflight.values()].map((r) => r.done)].filter((p): p is Promise<void> => p != null)
        if (!pending.length) break
        let bound: ReturnType<typeof setTimeout> | undefined
        const timedOut = new Promise<'timeout'>((res) => (bound = setTimeout(() => res('timeout'), Math.max(0, deadline - Date.now()))))
        const r = await Promise.race([Promise.allSettled(pending).then(() => 'settled' as const), timedOut])
        if (bound) clearTimeout(bound)
        if (r === 'timeout') break
      }
    },
  }
}
