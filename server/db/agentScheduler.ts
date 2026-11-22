// The agent scheduler's database side (W4-4c, design §1.4, §1.6, §1.8, §1.9; ADR-0018).
//
// Identity. The claim, the lease recovery and the per-agent bookkeeping run in a transaction with NO user identity
// (withTx('')) in which this module, and only this module, sets app.scheduler = 'on' with set_config(..., true): the
// flag ends with the transaction and never stays on a pooled connection (a lint test, server/scheduler/identity.lint.test.ts,
// keeps the string out of every other file). The policies of migration 0015 let that identity read approved agents,
// read and write agent_runs, and insert `system` audit rows of kind agent.run.*; it reads no other table. The two calls
// made on behalf of a running run (renewLease, finishRun) use the OWNER's identity instead, like the rest of the run.
//
// Claim. One transaction per tick: pg_try_advisory_xact_lock(APR4) (the transaction-level variant: COMMIT or ROLLBACK
// releases it, so a crashed claimer cannot leave it held on a pooled socket; a second claimer is told `locked` and
// never waits), then expired leases are failed, queued manual runs are taken, and due agents are claimed with
// FOR UPDATE SKIP LOCKED, one agent_runs row per slot (UNIQUE (agent_id, slot_at) is the backstop of the lock) and
// next_run_at advanced. The transaction ends BEFORE anything executes: a run never holds it.
//
// Time. Every decision (due, grace, lease expiry) compares against SQL `COALESCE($now, now())`: the caller's `now`
// (tests) or the database's own clock. This module never reads the process clock; the process clock only arms timers
// (server/scheduler/index.ts). JS arithmetic here is between two values that both came from the database.
//
// Codes only: an agent_runs.error_code, a disabled_reason and an audit row carry codes and ids, never a message.
import { withTx } from './pool.ts'
import type { DbClient } from './pool.ts'
import { recordAdminAction, SYSTEM_ACTOR } from '../audit.ts'
import type { AgentDefinition, AgentSchedule } from '../agents/definition.ts'
import { NEUTRAL_RUN_ERRORS } from '../scheduler/run.ts'
import type { ClaimedRun, RunOutcome } from '../scheduler/run.ts'

/** pg advisory lock key of the claim (retention uses 0x41505232 and 0x41505233, migrations 0x41505231) */
export const AGENT_SCHEDULER_LOCK_KEY = 0x41505234 // "APR4"
/** consecutive transient failures that disable a schedule (design §1.8) */
export const DEFAULT_FAILURE_THRESHOLD = 3
/** claim rounds per tick: a batch of skipped (missed, overlap) agents must not starve the ones behind it */
const MAX_CLAIM_ROUNDS = 50

type Raw = Record<string, any> // any: a pg row
type Now = { now?: Date | null }

// `$n` of the statements below is this expression: the caller's clock when given, else the database's
const NOW = (n: number) => `COALESCE($${n}::timestamptz, now())`
const nowParam = (o?: Now): string | null => (o?.now instanceof Date && Number.isFinite(o.now.getTime()) ? o.now.toISOString() : null)
const isId = (id: unknown): id is string => typeof id === 'string' && /^\d{1,18}$/.test(id)
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v))

/** The scheduler identity for the rest of this transaction. The only place app.scheduler is written. */
async function asScheduler(c: DbClient): Promise<void> {
  await c.query(`SELECT set_config('app.scheduler', 'on', true)`)
}

export interface ClaimOptions {
  instanceId: string
  /** this instance's free slots (runs it may start now) */
  limit: number
  /** the most runs running at once across every instance */
  globalCap: number
  leaseMs: number
  /** an occurrence missed by more than this becomes one skipped/missed row */
  graceMs: number
  now?: Date | null
  /** first occurrence strictly after `after` (server/agents/schedule.ts) */
  next: (s: AgentSchedule, after: Date) => Date
  /** consecutive transient failures that disable an agent whose lease expired (default 3) */
  failureThreshold?: number
}

/** Fails the runs whose lease has run out and counts each as a transient failure of its agent. Inside a scheduler tx. */
async function recoverIn(c: DbClient, now: string | null, failureThreshold: number): Promise<number> {
  const r = await c.query(
    `UPDATE agent_runs SET status = 'failed', error_code = 'lease_expired', finished_at = ${NOW(1)}
      WHERE status = 'running' AND lease_expires_at <= ${NOW(1)}
      RETURNING id::text, agent_id::text, trigger`,
    [now]
  )
  for (const row of r.rows) {
    await applyOutcome(c, row.agent_id, { status: 'failed', errorCode: 'lease_expired' }, { disable: false, failureThreshold, runId: row.id, trigger: row.trigger }, now)
  }
  return r.rows.length
}

/**
 * The agent's counters and the run's audit row, for one finished run. Success resets the failure counter; a transient
 * failure adds one and disables the schedule at the threshold; a permanent one (`disable`) disables it at once;
 * cost_cap and a cancellation count for nothing. Returns false when the scheduler cannot see the agent (revoked,
 * deleted): nothing is written then.
 */
async function applyOutcome(
  c: DbClient,
  agentId: string,
  out: Pick<RunOutcome, 'status' | 'errorCode'>,
  o: { disable: boolean; failureThreshold: number; runId?: string; trigger?: string },
  now: string | null
): Promise<boolean> {
  const success = out.status === 'succeeded'
  const neutral = out.status === 'cancelled' || (out.errorCode != null && NEUTRAL_RUN_ERRORS.has(out.errorCode))
  const counts = !success && !neutral
  const off = `($4::boolean OR ($3::boolean AND consecutive_failures + 1 >= $5::int))`
  const r = await c.query(
    `UPDATE agents SET
        last_run_at = ${NOW(7)},
        consecutive_failures = CASE WHEN $2::boolean THEN 0 WHEN $3::boolean THEN consecutive_failures + 1 ELSE consecutive_failures END,
        disabled_reason = CASE WHEN enabled AND ${off} THEN $6::text ELSE disabled_reason END,
        next_run_at = CASE WHEN ${off} THEN NULL ELSE next_run_at END,
        enabled = enabled AND NOT ${off}
      WHERE id = $1::bigint
      RETURNING enabled, consecutive_failures`,
    [agentId, success, counts, o.disable, o.failureThreshold, out.errorCode, now]
  )
  if (!r.rows[0]) return false
  await recordAdminAction(c, SYSTEM_ACTOR, {
    action: 'agent.run.finish',
    target: `agent:${agentId}`,
    details: { runId: o.runId ?? null, trigger: o.trigger ?? null, status: out.status, errorCode: out.errorCode, disabled: !r.rows[0].enabled },
  })
  return true
}

/**
 * One claim tick. Expired leases are failed first (counted as transient failures), queued manual runs are taken, then
 * the due agents, up to min(limit, globalCap - running) runs. Returns the runs to execute (their rows are already
 * `running` with this instance's lease), how many occurrences were written as skipped, and `locked` when another
 * claimer held the lock (nothing was done; the caller just tries again at its next wake-up).
 */
export async function claimRuns(o: ClaimOptions): Promise<{ claimed: ClaimedRun[]; skipped: number; locked: boolean }> {
  const now = nowParam(o)
  const threshold = o.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
  return withTx('', null, async (c: DbClient) => {
    await asScheduler(c)
    const lock = await c.query(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [AGENT_SCHEDULER_LOCK_KEY])
    if (!lock.rows[0].ok) return { claimed: [], skipped: 0, locked: true }

    await recoverIn(c, now, threshold)
    // the database's "now", read once: the same instant for every slot decision of this tick
    const at = (await c.query(`SELECT ${NOW(1)} AS now`, [now])).rows[0].now as Date
    const claimed: ClaimedRun[] = []
    let skipped = 0

    // a queued manual run whose agent is no longer approved under the same hash can never start: close it, so it
    // does not hold the agent's one active slot
    const dead = await c.query(
      `UPDATE agent_runs r SET status = 'skipped', error_code = 'approval_changed', finished_at = ${NOW(1)}
        WHERE r.status = 'queued' AND r.trigger = 'manual'
          AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = r.agent_id AND a.status = 'approved' AND a.approval_hash = r.approval_hash)
        RETURNING r.id::text, r.agent_id::text`,
      [now]
    )
    for (const row of dead.rows) {
      skipped++
      await recordAdminAction(c, SYSTEM_ACTOR, { action: 'agent.run.skip', target: `agent:${row.agent_id}`, details: { runId: row.id, trigger: 'manual', reason: 'approval_changed' } })
    }

    const running = (await c.query(`SELECT count(*)::int AS n FROM agent_runs WHERE status = 'running'`)).rows[0].n as number
    let room = Math.max(0, Math.min(Math.floor(o.limit), Math.floor(o.globalCap) - running))

    const lease = `${NOW(1)} + make_interval(secs => $2::double precision / 1000)`
    // ---- queued manual runs ("run now"): the oldest first ----
    if (room > 0) {
      const taken = await c.query(
        `WITH picked AS (
           SELECT r.id FROM agent_runs r WHERE r.status = 'queued' AND r.trigger = 'manual'
            ORDER BY r.id FOR UPDATE SKIP LOCKED LIMIT $4
         )
         UPDATE agent_runs r SET status = 'running', lease_owner = $3, lease_expires_at = ${lease}, started_at = ${NOW(1)}
           FROM picked WHERE r.id = picked.id
         RETURNING r.id::text AS run_id, r.agent_id::text, r.owner_email, r.slot_at, r.approval_hash, r.trigger`,
        [now, o.leaseMs, o.instanceId, room]
      )
      claimed.push(...(await withAgents(c, taken.rows, o.instanceId)))
      room -= taken.rows.length
      for (const row of taken.rows) {
        await recordAdminAction(c, SYSTEM_ACTOR, { action: 'agent.run.start', target: `agent:${row.agent_id}`, details: { runId: row.run_id, trigger: 'manual', slotAt: iso(row.slot_at) } })
      }
    }

    // ---- due agents ----
    for (let round = 0; room > 0 && round < MAX_CLAIM_ROUNDS; round++) {
      const due = await c.query(
        `SELECT a.id::text AS id, a.owner_email, a.name, a.approval_hash, a.approved_snapshot, a.next_run_at
           FROM agents a
          WHERE a.enabled AND a.status = 'approved' AND a.next_run_at <= ${NOW(1)}
          ORDER BY a.next_run_at, a.id
          FOR UPDATE OF a SKIP LOCKED LIMIT $2`,
        [now, room]
      )
      if (!due.rows.length) break
      for (const a of due.rows) {
        const slot = a.next_run_at as Date
        const def = a.approved_snapshot as AgentDefinition
        let nextAt: Date
        try {
          if (!def?.schedule) throw new Error('no schedule')
          nextAt = o.next(def.schedule, at)
          if (!(nextAt instanceof Date) || !Number.isFinite(nextAt.getTime())) throw new Error('no next occurrence')
        } catch {
          // a schedule the code cannot compute never comes due: stop it, with a code the owner sees
          await c.query(`UPDATE agents SET enabled = false, next_run_at = NULL, disabled_reason = 'invalid_schedule' WHERE id = $1::bigint`, [a.id])
          await recordAdminAction(c, SYSTEM_ACTOR, { action: 'agent.run.skip', target: `agent:${a.id}`, details: { trigger: 'schedule', reason: 'invalid_schedule' } })
          skipped++
          continue
        }
        const skip = async (reason: 'missed' | 'overlap') => {
          const r = await c.query(
            `INSERT INTO agent_runs (agent_id, owner_email, trigger, slot_at, approval_hash, status, error_code, started_at, finished_at)
             VALUES ($1::bigint, $2, 'schedule', $3::timestamptz, $4, 'skipped', $5, ${NOW(6)}, ${NOW(6)})
             ON CONFLICT DO NOTHING RETURNING id::text`,
            [a.id, a.owner_email, slot, a.approval_hash, reason, now]
          )
          if (r.rows[0]) {
            skipped++
            await recordAdminAction(c, SYSTEM_ACTOR, { action: 'agent.run.skip', target: `agent:${a.id}`, details: { runId: r.rows[0].id, trigger: 'schedule', reason, slotAt: iso(slot) } })
          }
        }
        if (at.getTime() - slot.getTime() > o.graceMs) {
          await skip('missed')
        } else if ((await c.query(`SELECT 1 FROM agent_runs WHERE agent_id = $1::bigint AND status IN ('queued', 'running') LIMIT 1`, [a.id])).rows.length) {
          await skip('overlap')
        } else {
          const r = await c.query(
            `INSERT INTO agent_runs (agent_id, owner_email, trigger, slot_at, approval_hash, status, lease_owner, lease_expires_at, started_at)
             VALUES ($1::bigint, $2, 'schedule', $3::timestamptz, $4, 'running', $5, ${NOW(6)} + make_interval(secs => $7::double precision / 1000), ${NOW(6)})
             ON CONFLICT DO NOTHING RETURNING id::text`,
            [a.id, a.owner_email, slot, a.approval_hash, o.instanceId, now, o.leaseMs]
          )
          // no row: the slot (or an active run) is already taken: the constraint won, there is nothing to execute
          if (r.rows[0]) {
            room--
            claimed.push({
              runId: r.rows[0].id,
              agentId: a.id,
              agentName: a.name,
              ownerEmail: a.owner_email,
              trigger: 'schedule',
              slotAt: iso(slot),
              approvalHash: a.approval_hash,
              definition: def,
              instanceId: o.instanceId,
            })
            await recordAdminAction(c, SYSTEM_ACTOR, { action: 'agent.run.start', target: `agent:${a.id}`, details: { runId: r.rows[0].id, trigger: 'schedule', slotAt: iso(slot) } })
          }
        }
        // N missed occurrences collapse into this one: the next slot counts from now, never from the old slot
        await c.query(`UPDATE agents SET next_run_at = $2::timestamptz WHERE id = $1::bigint`, [a.id, nextAt])
      }
    }
    return { claimed, skipped, locked: false }
  })
}

// the agent rows (name, approved snapshot) of manual runs just taken, shaped as ClaimedRuns
async function withAgents(c: DbClient, runs: Raw[], instanceId: string): Promise<ClaimedRun[]> {
  if (!runs.length) return []
  const ids = [...new Set(runs.map((r) => r.agent_id))]
  const agents = (await c.query(`SELECT id::text AS id, name, approved_snapshot FROM agents WHERE id = ANY($1::bigint[])`, [ids])).rows
  const byId = new Map(agents.map((a: Raw) => [a.id, a]))
  const out: ClaimedRun[] = []
  for (const r of runs) {
    const a = byId.get(r.agent_id)
    if (!a) continue
    out.push({
      runId: r.run_id,
      agentId: r.agent_id,
      agentName: a.name,
      ownerEmail: r.owner_email,
      trigger: r.trigger,
      slotAt: iso(r.slot_at),
      approvalHash: r.approval_hash,
      definition: a.approved_snapshot as AgentDefinition,
      instanceId,
    })
  }
  return out
}

/**
 * Fails every run whose lease has expired (`failed/lease_expired`, never re-run) and counts it as a transient failure
 * of its agent. claimRuns does the same at the start of every tick; this is the same step on its own. Returns how many.
 */
export async function recoverExpiredLeases(o: Now & { failureThreshold?: number } = {}): Promise<number> {
  const now = nowParam(o)
  return withTx('', null, async (c: DbClient) => {
    await asScheduler(c)
    return recoverIn(c, now, o.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD)
  })
}

/**
 * When the scheduler next has something to do: the earliest next_run_at of an enabled agent, "now" while a manual run
 * is queued, and the earliest live lease (so an expired holder is recovered one tick after expiry, not one max-sleep
 * later). null = nothing to wait for.
 */
export async function earliestNextRunAt(o: Now = {}): Promise<Date | null> {
  const now = nowParam(o)
  return withTx('', null, async (c: DbClient) => {
    await asScheduler(c)
    const r = await c.query(
      `SELECT LEAST(
         (SELECT min(next_run_at) FROM agents WHERE enabled AND status = 'approved'),
         (SELECT ${NOW(1)} WHERE EXISTS (SELECT 1 FROM agent_runs WHERE status = 'queued' AND trigger = 'manual')),
         (SELECT min(lease_expires_at) FROM agent_runs WHERE status = 'running')
       ) AS at`,
      [now]
    )
    return (r.rows[0].at as Date | null) ?? null
  })
}

/** The lease heartbeat, as the run's owner. False when the run is no longer this holder's (recovered, finished, deleted). */
export async function renewLease(ownerEmail: string, runId: string, instanceId: string, leaseMs: number, o: Now = {}): Promise<boolean> {
  if (!isId(runId)) return false
  const now = nowParam(o)
  return withTx(ownerEmail, null, async (c: DbClient) => {
    const r = await c.query(
      `UPDATE agent_runs SET lease_expires_at = ${NOW(5)} + make_interval(secs => $4::double precision / 1000)
        WHERE id = $1::bigint AND owner_email = $2 AND lease_owner = $3 AND status = 'running'`,
      [runId, ownerEmail, instanceId, leaseMs, now]
    )
    return (r.rowCount ?? 0) > 0
  })
}

/** What finishRun applies to the agent in the same transaction as the run's terminal row. */
export interface RunBookkeeping {
  agentId: string
  /** a permanent code: disable the schedule at once */
  disable: boolean
  failureThreshold: number
  trigger?: string
}

/**
 * Writes the run's outcome, as the owner, only while this instance still holds the run: a holder whose lease was
 * recovered (failed/lease_expired) gets false and writes NOTHING (no row, no counter, no audit). Codes and ids only.
 *
 * With `o.bookkeeping` the agent's side (failure counter, auto-disable, next_run_at, the agent.run.finish audit row)
 * commits in the SAME transaction, so a run is never terminal without its bookkeeping. The guarded UPDATE of the run
 * row runs under the owner's identity (the first statement, as before); only after it matched does the transaction
 * switch to the scheduler identity (no user, app.scheduler on, both transaction-local) for the agent and the audit
 * row, which the owner identity may not write. The switch happens here and nowhere else.
 */
export async function finishRun(
  ownerEmail: string,
  runId: string,
  instanceId: string,
  out: RunOutcome,
  o: Now & { bookkeeping?: RunBookkeeping } = {}
): Promise<boolean> {
  if (!isId(runId)) return false
  const now = nowParam(o)
  return withTx(ownerEmail, null, async (c: DbClient) => {
    const r = await c.query(
      `UPDATE agent_runs SET status = $4, error_code = $5, finished_at = ${NOW(11)}, lease_expires_at = NULL,
              session_id = $6::bigint, message_id = $7::bigint, cost_usd = $8::numeric, unpriced = $9, tool_names = $10::text[]
        WHERE id = $1::bigint AND owner_email = $2 AND lease_owner = $3 AND status = 'running'`,
      [runId, ownerEmail, instanceId, out.status, out.errorCode, out.sessionId, out.messageId, out.costUsd, out.unpriced === true, out.toolNames ?? [], now]
    )
    if ((r.rowCount ?? 0) === 0) return false
    const b = o.bookkeeping
    if (b && isId(b.agentId)) {
      await c.query(`SELECT set_config('app.user_email', '', true)`)
      await asScheduler(c)
      await applyOutcome(c, b.agentId, out, { disable: b.disable, failureThreshold: b.failureThreshold, runId, trigger: b.trigger }, now)
    }
    return true
  })
}

/**
 * The agent's bookkeeping after a run: last_run_at, the failure counter, auto-disable (design §1.8), and the
 * `agent.run.finish` audit row, as the scheduler identity. `disable` = a permanent code (disable at once); transient
 * failures count toward `failureThreshold`; a success resets the counter; cost_cap and cancellations count for nothing.
 */
export async function recordRunOutcome(
  agentId: string,
  out: RunOutcome,
  o: { disable: boolean; failureThreshold: number; runId?: string; trigger?: string; now?: Date | null }
): Promise<void> {
  if (!isId(agentId)) return
  const now = nowParam(o)
  await withTx('', null, async (c: DbClient) => {
    await asScheduler(c)
    await applyOutcome(c, agentId, out, o, now)
  })
}
