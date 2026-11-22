// The agent scheduler's database side and the scheduler itself against a real Postgres (W4-4c, design §1.4, §1.8, §1.9).
//
//   AC2  two claimers on one database over 50 fake slots: one run per slot, no overlap, operation counts asserted
//   AC3  a holder that stops heartbeating is failed/lease_expired once and never re-run; finishRun from it is false
//   AC4  missed by more than the grace: one skipped/missed and next_run_at from now; within the grace: one run
//   AC5  permanent codes disable at once; 3 transient failures disable; a success resets the counter
//   AC7  stop() cancels an in-flight run as cancelled/shutdown (the real database, the real heartbeat)
//   AC9  every statement takes $now and uses the database's now() when null
//   AC10 startAgentScheduler -> executeAgentRun -> the real renewLease: a lost lease stops the run, end to end
//
// db.ts connects as ai_prism_app (scripts/ci/pg-roles.sql): no SUPERUSER, no BYPASSRLS, so the policies bind.
// Same harness as server/isolation.test.js, on a scratch database of its own. No local Postgres with pgvector -> skipped.
//
//   node --test server/agentScheduler.pg.test.ts
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { approvalHash } from './agents/definition.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
env.LOCAL_DEV_MODE ||= '1'
env.LOCAL_PGVECTOR = '1'
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET
const ADMIN_DB = env.PGDATABASE || 'ai_prism'
const SUPERUSER = env.PGUSER
const APP_ROLE = env.ISOLATION_APP_ROLE || 'ai_prism_app'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const SCRATCH = `w44c_${stamp}`
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

const conn = (database: string) => ({ host: env.PGHOST, port: Number(env.PGPORT), user: SUPERUSER, password: env.PGPASSWORD, database, ssl: false, connectionTimeoutMillis: 2000 })

async function skipReason(): Promise<string | null> {
  if (!LOCAL_HOSTS.has(env.PGHOST!) && env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${env.PGHOST} is not local`
  const c = new pg.Client(conn(ADMIN_DB))
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    return ext.rows.length ? null : 'pgvector is not installed on this Postgres'
  } catch (e) {
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${(e as { code?: string }).code}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}
const SKIP = await skipReason()
const skip = SKIP || false

let raw: pg.Client // the superuser, on the scratch database: fixtures and raw checks, past RLS
let sched: typeof import('./db/agentScheduler.ts')
let agentsDb: typeof import('./db/agents.ts')
let indexMod: typeof import('./scheduler/index.ts')
let runMod: typeof import('./scheduler/run.ts')
let nextOccurrence: typeof import('./agents/schedule.ts').nextOccurrence

async function setup() {
  const adm = new pg.Client(conn(ADMIN_DB))
  await adm.connect()
  try {
    const hasRole = await adm.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])
    if (!hasRole.rows.length && APP_ROLE === 'ai_prism_app') await adm.query(fs.readFileSync(path.join(HERE, '..', 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
    await adm.query(`CREATE DATABASE ${SCRATCH}`)
  } finally {
    await adm.end()
  }
  raw = new pg.Client(conn(SCRATCH))
  await raw.connect()
  await raw.query(`CREATE EXTENSION IF NOT EXISTS vector`)
  const { migrateUp } = await import('./db/migrate.ts')
  const { applyAppGrants } = await import('./db/grants.ts')
  await migrateUp(raw, { log: { log() {}, warn() {} } })
  await applyAppGrants(raw, { role: APP_ROLE, log: { log() {}, warn() {} } })
  env.PGDATABASE = SCRATCH
  env.PGUSER = APP_ROLE
  sched = await import('./db/agentScheduler.ts')
  agentsDb = await import('./db/agents.ts')
  indexMod = await import('./scheduler/index.ts')
  runMod = await import('./scheduler/run.ts')
  nextOccurrence = (await import('./agents/schedule.ts')).nextOccurrence
}
if (!SKIP) await setup()

after(async () => {
  if (SKIP) return
  await raw?.end().catch(() => {})
  // the pools of db.ts hold connections to the scratch database
  const adm = new pg.Client(conn(ADMIN_DB))
  await adm.connect().catch(() => {})
  await adm.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${SCRATCH}' AND pid <> pg_backend_pid()`).catch(() => {})
  await adm.query(`DROP DATABASE IF EXISTS ${SCRATCH}`).catch(() => {})
  await adm.end().catch(() => {})
})

const DEF = { instructions: 'i', prompt: 'p', model: 'm', reasoningEffort: null, tools: [], schedule: { freq: 'hourly', minute: 0, tz: 'UTC' }, lang: 'en' }
const HOUR = 3600_000
const MIN = 60_000
let seq = 0
const owner = () => `sched-${stamp}-${++seq}@test.invalid`

// An approved, enabled agent due at `dueInMs` from the database's now() (negative = already due).
async function seedAgent(o: { owner?: string; dueInMs?: number; enabled?: boolean; schedule?: unknown; failures?: number } = {}): Promise<{ id: string; owner: string }> {
  const email = o.owner ?? owner()
  const def = { ...DEF, ...(o.schedule !== undefined ? { schedule: o.schedule } : {}) }
  await raw.query(`SELECT set_config('app.is_admin', 'on', false)`)
  const r = await raw.query(
    `INSERT INTO agents (owner_email, name, definition, status, approval_hash, approved_snapshot, approved_by_hash, approved_at, approval_expires_at, enabled, next_run_at, consecutive_failures)
     VALUES ($1, $2, $3::jsonb, 'approved', $4, $3::jsonb, 'h2:admin', now(), now() + interval '30 days', $5, now() + ($6 || ' milliseconds')::interval, $7) RETURNING id::text`,
    [email, `agent-${seq}`, JSON.stringify(def), approvalHash(def as any), o.enabled ?? true, String(o.dueInMs ?? -MIN), o.failures ?? 0]
  )
  return { id: r.rows[0].id, owner: email }
}
const q = async (sql: string, params: unknown[] = []) => (await raw.query(sql, params)).rows
const runsOf = (agentId: string) => q(`SELECT * FROM agent_runs WHERE agent_id = $1 ORDER BY id`, [agentId])
const agentRow = async (id: string) => (await q(`SELECT * FROM agents WHERE id = $1`, [id]))[0]
const clean = () => q(`DELETE FROM agents`) // cascades to agent_runs
const CLAIM = { instanceId: 'inst-A', limit: 100, globalCap: 1000, leaseMs: 120_000, graceMs: 60 * MIN, now: null as Date | null }
const claim = (o: Partial<typeof CLAIM> = {}) => sched.claimRuns({ ...CLAIM, ...o, next: nextOccurrence })
const OUT = { status: 'succeeded', errorCode: null, sessionId: null, messageId: null, costUsd: null, unpriced: false, toolNames: [] } as import('./scheduler/run.ts').RunOutcome

test('the lock key and the identity: advisory XACT lock "APR4", app.scheduler set only inside a transaction', { skip }, () => {
  assert.equal(sched.AGENT_SCHEDULER_LOCK_KEY, 0x41505234)
  const src = fs.readFileSync(path.join(HERE, 'db', 'agentScheduler.ts'), 'utf8')
  assert.match(src, /pg_try_advisory_xact_lock/)
  assert.doesNotMatch(src, /pg_(try_)?advisory_lock\(/, 'never the session-level lock on a pooled socket')
  assert.doesNotMatch(src, /pg_advisory_unlock/)
})

test('AC2 two claimers over 50 slots: one run per slot, none twice, work counted', { skip }, async () => {
  await clean()
  const agents: { id: string; owner: string }[] = []
  for (let i = 0; i < 50; i++) agents.push(await seedAgent({ dueInMs: -5 * MIN })) // one at a time: they share one client
  let productive = 0 // claims that got the lock and took runs: bounded by the work, not by timing
  let locked = 0 // claims turned away by the other claimer: how often is timing, not work
  const mine: { A: string[]; B: string[] } = { A: [], B: [] }
  async function loop(name: 'A' | 'B') {
    for (let idle = 0; idle < 3; ) {
      const r = await claim({ instanceId: `inst-${name}`, limit: 7 })
      if (r.locked) locked++
      else if (r.claimed.length) productive++
      for (const c of r.claimed) mine[name].push(c.runId)
      idle = !r.locked && r.claimed.length === 0 ? idle + 1 : 0
      if (r.locked) await new Promise((res) => setImmediate(res)) // yield so the lock holder can commit; no timed wait
    }
  }
  await Promise.all([loop('A'), loop('B')])
  const all = [...mine.A, ...mine.B]
  assert.equal(all.length, 50, 'every slot claimed')
  assert.equal(new Set(all).size, 50, 'no run claimed twice')
  const rows = await q(`SELECT agent_id, status, lease_owner, trigger FROM agent_runs`)
  assert.equal(rows.length, 50)
  assert.equal(new Set(rows.map((r) => r.agent_id)).size, 50, 'one run per agent slot')
  for (const r of rows) assert.deepEqual([r.status, r.trigger], ['running', 'schedule'])
  assert.deepEqual(new Set(rows.map((r) => r.lease_owner)), new Set(['inst-A', 'inst-B'].filter((i) => mine[i.slice(-1) as 'A' | 'B'].length)))
  // an idle claim costs one read pass and writes nothing
  const before = (await q(`SELECT count(*)::int n FROM agent_runs`))[0].n
  assert.deepEqual(await claim(), { claimed: [], skipped: 0, locked: false })
  assert.equal((await q(`SELECT count(*)::int n FROM agent_runs`))[0].n, before)
  // 50 runs at 7 per claim: no more than 8 claims took any (the empty and the locked ones, which depend on timing, do nothing)
  assert.ok(productive <= Math.ceil(50 / 7), `claims that took runs are bounded by the work (${productive} productive, ${locked} locked)`)
  // every agent advanced to a future slot
  const due = await q(`SELECT count(*)::int n FROM agents WHERE next_run_at <= now()`)
  assert.equal(due[0].n, 0)
  // the second hour: finish them all, both claimers again, one more run each, never two for a slot
  await q(`UPDATE agent_runs SET status = 'succeeded', finished_at = now()`)
  const later = new Date(Date.now() + 2 * HOUR)
  const second = await Promise.all([claim({ instanceId: 'inst-A', now: later, limit: 30, graceMs: 3 * HOUR }), claim({ instanceId: 'inst-B', now: later, limit: 30, graceMs: 3 * HOUR })])
  let got = second.flatMap((r) => r.claimed).length
  for (let i = 0; i < 5 && got < 50; i++) got += (await claim({ now: later, graceMs: 3 * HOUR })).claimed.length
  assert.equal(got, 50)
  const slots = await q(`SELECT agent_id, slot_at, count(*)::int n FROM agent_runs GROUP BY 1, 2 HAVING count(*) > 1`)
  assert.equal(slots.length, 0, 'UNIQUE (agent_id, slot_at) held')
  assert.equal((await q(`SELECT count(*)::int n FROM agent_runs`))[0].n, 100)
  assert.equal(agents.length, 50)
})

test('claim: an agent with an active run is skipped as overlap, never run twice', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: -MIN })
  assert.equal((await claim()).claimed.length, 1)
  await q(`UPDATE agents SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [a.id]) // due again while the first still runs
  const r = await claim()
  assert.equal(r.claimed.length, 0)
  assert.equal(r.skipped, 1)
  const rows = await runsOf(a.id)
  assert.deepEqual(rows.map((x) => [x.status, x.error_code]), [['running', null], ['skipped', 'overlap']])
  assert.ok((await agentRow(a.id)).next_run_at > new Date(), 'next_run_at advanced')
})

test('claim: the limit and the global cap bound the running runs across instances', { skip }, async () => {
  await clean()
  for (let i = 0; i < 6; i++) await seedAgent({ dueInMs: -MIN })
  assert.equal((await claim({ limit: 2, globalCap: 4 })).claimed.length, 2)
  assert.equal((await claim({ limit: 5, globalCap: 4, instanceId: 'inst-B' })).claimed.length, 2, 'the cap of 4 counts the other instance\'s runs')
  assert.equal((await claim({ limit: 5, globalCap: 4 })).claimed.length, 0)
  assert.equal((await q(`SELECT count(*)::int n FROM agents WHERE next_run_at <= now()`))[0].n, 2, 'the agents left over stay due, untouched')
  assert.equal((await claim({ limit: 0, globalCap: 99 })).claimed.length, 0, 'a zero limit claims nothing')
})

test('claim: the ClaimedRun carries the approved snapshot, hash, owner, slot and lease', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: -2 * MIN })
  const slot = (await agentRow(a.id)).next_run_at as Date
  const { claimed } = await claim({ instanceId: 'inst-Z' })
  assert.equal(claimed.length, 1)
  const c = claimed[0]!
  assert.deepEqual([c.agentId, c.ownerEmail, c.trigger, c.instanceId, c.slotAt], [a.id, a.owner, 'schedule', 'inst-Z', slot.toISOString()])
  assert.equal(c.approvalHash, approvalHash(DEF as any))
  assert.deepEqual(c.definition, DEF)
  assert.equal(c.agentName.startsWith('agent-'), true)
  const [row] = await runsOf(a.id)
  assert.equal(String(row.id), c.runId)
  assert.ok(row.lease_expires_at > new Date(Date.now() + 100_000) && row.lease_expires_at < new Date(Date.now() + 130_000), 'a lease of ~120 s')
  assert.ok(row.started_at)
  // one audit row at the start, codes and ids only
  const audit = await q(`SELECT actor_hash, action, target, details FROM admin_audit WHERE action = 'agent.run.start' AND target = $1`, [`agent:${a.id}`])
  assert.equal(audit.length, 1)
  assert.equal(audit[0].actor_hash, 'system')
  assert.doesNotMatch(JSON.stringify(audit[0]), /@|prompt|instructions/)
})

test('claim: a manual queued run is taken under its stored hash; one whose agent is no longer approved is skipped', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: HOUR })
  const queued = await agentsDb.queueManualRun(a.owner, null, a.id)
  assert.ok(queued && queued !== 'busy')
  assert.ok((await sched.earliestNextRunAt())!.getTime() <= Date.now(), 'a queued run makes the earliest time "now"')
  const r = await claim()
  assert.equal(r.claimed.length, 1)
  assert.equal(r.claimed[0]!.trigger, 'manual')
  assert.equal(r.claimed[0]!.runId, (queued as { id: string }).id)
  assert.deepEqual(r.claimed[0]!.definition, DEF)
  assert.equal((await runsOf(a.id))[0].status, 'running')
  assert.ok((await agentRow(a.id)).next_run_at > new Date(Date.now() + 30 * MIN), 'a manual run does not move the schedule')
  // revoked meanwhile: the queued run can never start, and never blocks the agent
  await clean()
  const b = await seedAgent({ dueInMs: HOUR })
  await agentsDb.queueManualRun(b.owner, null, b.id)
  await raw.query(`SELECT set_config('app.is_admin', 'on', false)`)
  await q(`UPDATE agents SET status = 'revoked', enabled = false, next_run_at = NULL, approval_hash = NULL, approved_snapshot = NULL, approved_by_hash = NULL, approved_at = NULL, approval_expires_at = NULL WHERE id = $1`, [b.id])
  assert.equal((await claim()).claimed.length, 0)
  const [row] = await runsOf(b.id)
  assert.deepEqual([row.status, row.error_code], ['skipped', 'approval_changed'])
})

test('AC3 a holder that stops heartbeating: failed/lease_expired once, never re-run, finishRun and renewLease from it are false', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: -MIN })
  const { claimed } = await claim({ instanceId: 'inst-dead', leaseMs: 120_000 })
  const run = claimed[0]!
  const t0 = Date.now()
  // inside the lease: nothing to recover; a heartbeat moves the lease
  assert.equal(await sched.recoverExpiredLeases({ now: new Date(t0 + 60_000) }), 0)
  assert.equal(await sched.renewLease(run.ownerEmail, run.runId, 'inst-dead', 120_000, { now: new Date(t0 + 100_000) }), true)
  assert.equal(await sched.recoverExpiredLeases({ now: new Date(t0 + 150_000) }), 0, 'the heartbeat at +100 s moved the lease to +220 s')
  // the holder dies: one tick after expiry the run is failed
  const after = new Date(t0 + 221_000)
  assert.equal(await sched.recoverExpiredLeases({ now: after }), 1)
  const [row] = await runsOf(a.id)
  assert.deepEqual([row.status, row.error_code], ['failed', 'lease_expired'])
  assert.ok(row.finished_at)
  assert.equal(await sched.recoverExpiredLeases({ now: after }), 0, 'once')
  // never re-run: not by the next claim, not by a claim at any later time for the same slot
  // (a LATER slot may legitimately be due at `after` when the clock is near an hour boundary: only this slot counts)
  const r = await claim({ now: after, graceMs: 3 * HOUR })
  assert.ok(!r.claimed.some((c) => c.slotAt === run.slotAt), 'the failed slot is not claimed again')
  assert.equal((await runsOf(a.id)).filter((x) => x.slot_at.toISOString() === run.slotAt).length, 1, 'one row for the slot')
  // the stale holder cannot overwrite the recovered row, nor revive the lease
  assert.equal(await sched.finishRun(run.ownerEmail, run.runId, 'inst-dead', OUT), false)
  assert.equal(await sched.renewLease(run.ownerEmail, run.runId, 'inst-dead', 120_000), false)
  assert.equal((await runsOf(a.id))[0].status, 'failed')
  // a lease_expired failure counts toward the consecutive failures (transient)
  assert.equal((await agentRow(a.id)).consecutive_failures, 1)
  const audit = await q(`SELECT details FROM admin_audit WHERE action = 'agent.run.finish' AND target = $1`, [`agent:${a.id}`])
  assert.equal(audit.length, 1)
  assert.equal(audit[0].details.errorCode, 'lease_expired')
})

test('AC3 the claim itself recovers expired leases (one tick after expiry, no separate job)', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: -MIN })
  await claim({ instanceId: 'inst-dead', leaseMs: 1000 })
  const r = await claim({ now: new Date(Date.now() + 5000) })
  assert.equal(r.claimed.length, 0)
  assert.deepEqual((await runsOf(a.id)).map((x) => [x.status, x.error_code]), [['failed', 'lease_expired']])
})

test('AC3 three expired leases in a row disable the agent (transient failures count)', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: -MIN, failures: 2 })
  await claim({ leaseMs: 1000 })
  assert.equal(await sched.recoverExpiredLeases({ now: new Date(Date.now() + 5000), failureThreshold: 3 }), 1)
  const row = await agentRow(a.id)
  assert.equal(row.enabled, false)
  assert.equal(row.next_run_at, null)
  assert.equal(row.disabled_reason, 'lease_expired')
})

test('AC4 missed by more than the grace: exactly one skipped/missed, next_run_at from now; within the grace: exactly one run', { skip }, async () => {
  await clean()
  const late = await seedAgent({ dueInMs: -61 * MIN })
  const r = await claim({ graceMs: 60 * MIN })
  assert.equal(r.claimed.length, 0)
  assert.equal(r.skipped, 1)
  const rows = await runsOf(late.id)
  assert.deepEqual(rows.map((x) => [x.status, x.error_code, x.trigger]), [['skipped', 'missed', 'schedule']])
  const next = (await agentRow(late.id)).next_run_at as Date
  assert.ok(next > new Date() && next <= new Date(Date.now() + HOUR + MIN), 'the next hourly slot after now')
  assert.deepEqual(await claim(), { claimed: [], skipped: 0, locked: false }, 'nothing more')
  assert.equal((await runsOf(late.id)).length, 1)

  await clean()
  const ok = await seedAgent({ dueInMs: -59 * MIN })
  const slot = (await agentRow(ok.id)).next_run_at as Date
  const r2 = await claim({ graceMs: 60 * MIN })
  assert.equal(r2.claimed.length, 1)
  assert.equal(r2.skipped, 0)
  assert.equal(r2.claimed[0]!.slotAt, slot.toISOString(), 'the run keeps the slot it was due at')
  assert.equal((await runsOf(ok.id)).length, 1)
  assert.ok((await agentRow(ok.id)).next_run_at > new Date(), 'N missed slots collapse into this one run')
})

test('AC4 a schedule the code cannot compute disables the agent with a code, never throws out of the claim', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: -MIN, schedule: { freq: 'daily', minute: 0, hour: 3, tz: 'Not/AZone' } })
  const r = await claim()
  assert.equal(r.claimed.length, 0)
  const row = await agentRow(a.id)
  assert.equal(row.enabled, false)
  assert.equal(row.disabled_reason, 'invalid_schedule')
})

test('AC5 permanent codes disable at once; 3 transient failures disable; a success resets the counter; neutral ones neither', { skip }, async () => {
  await clean()
  const perm = await seedAgent()
  await sched.recordRunOutcome(perm.id, { ...OUT, status: 'failed', errorCode: 'approval_expired' }, { disable: true, failureThreshold: 3 })
  let row = await agentRow(perm.id)
  assert.deepEqual([row.enabled, row.next_run_at, row.disabled_reason], [false, null, 'approval_expired'])
  assert.ok(row.last_run_at)

  const t = await seedAgent()
  const fail = (code: string) => sched.recordRunOutcome(t.id, { ...OUT, status: 'failed', errorCode: code }, { disable: false, failureThreshold: 3 })
  await fail('timeout')
  await fail('gateway_error')
  row = await agentRow(t.id)
  assert.deepEqual([row.enabled, row.consecutive_failures], [true, 2])
  await sched.recordRunOutcome(t.id, OUT, { disable: false, failureThreshold: 3 })
  row = await agentRow(t.id)
  assert.deepEqual([row.enabled, row.consecutive_failures], [true, 0], 'a success resets the counter')
  await fail('timeout')
  await fail('db_error')
  assert.equal((await agentRow(t.id)).enabled, true, 'two since the reset')
  await sched.recordRunOutcome(t.id, { ...OUT, status: 'failed', errorCode: 'cost_cap' }, { disable: false, failureThreshold: 3 })
  await sched.recordRunOutcome(t.id, { ...OUT, status: 'cancelled', errorCode: 'shutdown' }, { disable: false, failureThreshold: 3 })
  row = await agentRow(t.id)
  assert.deepEqual([row.enabled, row.consecutive_failures], [true, 2], 'cost_cap and shutdown count for nothing')
  await fail('lease_lost')
  row = await agentRow(t.id)
  assert.deepEqual([row.enabled, row.next_run_at, row.consecutive_failures, row.disabled_reason], [false, null, 3, 'lease_lost'], 'the third disables, with the last code')

  // the audit rows: one per outcome, codes and ids only, never a message
  const audit = await q(`SELECT actor_hash, details FROM admin_audit WHERE action = 'agent.run.finish' AND target = $1`, [`agent:${t.id}`])
  assert.equal(audit.length, 8)
  for (const a of audit) {
    assert.equal(a.actor_hash, 'system')
    assert.doesNotMatch(JSON.stringify(a.details), /@/)
  }
})

test('AC5 a stale outcome for an agent the scheduler cannot see (revoked) is a no-op, not an error', { skip }, async () => {
  await clean()
  const a = await seedAgent()
  await raw.query(`SELECT set_config('app.is_admin', 'on', false)`)
  await q(`UPDATE agents SET status = 'revoked', enabled = false, next_run_at = NULL, approval_hash = NULL, approved_snapshot = NULL, approved_by_hash = NULL, approved_at = NULL, approval_expires_at = NULL WHERE id = $1`, [a.id])
  await sched.recordRunOutcome(a.id, { ...OUT, status: 'failed', errorCode: 'timeout' }, { disable: false, failureThreshold: 3 })
  assert.equal((await agentRow(a.id)).consecutive_failures, 0)
})

test('finishRun writes the outcome as the owner, guarded by the lease holder', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: -MIN })
  const run = (await claim({ instanceId: 'inst-1' })).claimed[0]!
  const sess = (await q(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 't', 'm') RETURNING id::text`, [a.owner]))[0].id
  assert.equal(await sched.finishRun('someone-else@test.invalid', run.runId, 'inst-1', OUT), false, 'not the owner')
  assert.equal(await sched.finishRun(a.owner, run.runId, 'inst-2', OUT), false, 'not the holder')
  assert.equal((await runsOf(a.id))[0].status, 'running')
  const out = { ...OUT, sessionId: sess, costUsd: 0.0123, unpriced: true, toolNames: ['ask_genie_one'] }
  assert.equal(await sched.finishRun(a.owner, run.runId, 'inst-1', out), true)
  const [row] = await runsOf(a.id)
  assert.deepEqual([row.status, row.error_code, String(row.session_id), Number(row.cost_usd), row.unpriced, row.tool_names], ['succeeded', null, sess, 0.0123, true, ['ask_genie_one']])
  assert.ok(row.finished_at)
  assert.equal(await sched.finishRun(a.owner, run.runId, 'inst-1', OUT), false, 'a finished run is not finished twice')
})

test('AC9 every statement takes $now and falls back to the database now() when null', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: 24 * HOUR })
  const future = new Date(Date.now() + 24 * HOUR + 10 * MIN)
  assert.equal((await claim({ now: null })).claimed.length, 0, 'null: the database clock; not due')
  const r = await claim({ now: future })
  assert.equal(r.claimed.length, 1, '$now decides what is due')
  const run = r.claimed[0]!
  const [row] = await runsOf(a.id)
  assert.ok(Math.abs(row.lease_expires_at.getTime() - (future.getTime() + 120_000)) < 1000, 'the lease is $now + leaseMs')
  assert.ok((await agentRow(a.id)).next_run_at > future, 'next_run_at counts from $now')
  assert.ok(Math.abs((await sched.earliestNextRunAt({ now: future }))!.getTime() - (future.getTime() + 120_000)) < 1000, 'the live lease is the earliest thing to wake for')
  assert.equal(await sched.renewLease(run.ownerEmail, run.runId, 'inst-A', 120_000, { now: new Date(future.getTime() + 60_000) }), true)
  assert.ok(Math.abs((await runsOf(a.id))[0].lease_expires_at.getTime() - (future.getTime() + 180_000)) < 1000)
  assert.equal(await sched.recoverExpiredLeases({ now: null }), 0, 'null: the database clock; the lease is in the future')
  assert.equal(await sched.recoverExpiredLeases({ now: new Date(future.getTime() + 10 * MIN) }), 1)
  await sched.recordRunOutcome(a.id, OUT, { disable: false, failureThreshold: 3, now: future })
  assert.ok(Math.abs((await agentRow(a.id)).last_run_at.getTime() - future.getTime()) < 1000, 'last_run_at is $now')
})

test('earliestNextRunAt: the soonest of the enabled schedules, queued manual runs and live leases', { skip }, async () => {
  await clean()
  assert.equal(await sched.earliestNextRunAt(), null)
  await seedAgent({ dueInMs: 3 * HOUR })
  const soon = await seedAgent({ dueInMs: 20 * MIN })
  await seedAgent({ dueInMs: MIN, enabled: false }) // a disabled agent never wakes the timer
  const e = (await sched.earliestNextRunAt())!
  const want = (await agentRow(soon.id)).next_run_at as Date
  assert.equal(e.getTime(), want.getTime())
})

// ---- the scheduler itself, with the real database functions ------------------------------------------------------

async function until<T>(fn: () => Promise<T | null | false | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for the condition')
    await new Promise((r) => setTimeout(r, 15))
  }
}

// executeAgentRun with every external dependency stubbed except the one under test: the lease heartbeat the scheduler passes
function runnerWith(turn: (signal: AbortSignal) => Promise<import('./turn.ts').HeadlessTurnResult>) {
  const seen: { started: boolean; aborted: boolean } = { started: false, aborted: false }
  const future = new Date(Date.now() + 86_400_000).toISOString()
  const execute: typeof runMod.executeAgentRun = (run, o) =>
    runMod.executeAgentRun(run, {
      ...o,
      deps: {
        spToken: async () => 'sp-token',
        readAgent: async () => ({ status: 'approved', approvalExpiresAt: future, definition: run.definition }),
        admissionContext: async () => ({ toolPolicy: {}, catalog: new Map() }),
        modelAllowed: async () => true,
        createSession: async (email: string) => String((await q(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 't', 'm') RETURNING id`, [email]))[0].id),
        addUserMessage: async () => {},
        runTurn: async (input) => {
          seen.started = true
          input.signal.addEventListener('abort', () => (seen.aborted = true))
          return turn(input.signal)
        },
        ...o.deps, // what the scheduler passes (renewLease, heartbeatMs) wins: that is the wiring under test
      },
    })
  return { execute, seen }
}
// the admin's switch (app_settings.agents_enabled): the scheduler reads it at every tick
const enableFeature = () =>
  q(`INSERT INTO app_settings (key, value, updated_by_hash) VALUES ('agents_enabled', 'true'::jsonb, 'test') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`)
const holdUntilAbort = (signal: AbortSignal) =>
  new Promise<import('./turn.ts').HeadlessTurnResult>((res) =>
    signal.addEventListener('abort', () => res({ status: 'aborted', messageId: null, finishReason: null, stoppedEarly: null, toolNames: [], errorCode: null }))
  )

test('AC10 end to end: the scheduler\'s heartbeat renews the real lease, and a lost lease stops the run', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: -MIN })
  await enableFeature()
  const { execute, seen } = runnerWith(holdUntilAbort)
  const s = indexMod.startAgentScheduler({ env: { AGENTS_ENABLED: '1' }, instanceId: 'inst-e2e', firstDelayMs: 5, maxSleepMs: 60_000, leaseMs: 5000, heartbeatMs: 40, execute, log: quiet })!
  try {
    await until(async () => seen.started) // the turn is in flight
    const first = (await runsOf(a.id))[0]
    assert.equal(first.status, 'running')
    const lease0 = first.lease_expires_at as Date
    // the heartbeat reaches the database: the lease moves forward without anyone else touching it
    const moved = await until(async () => ((await runsOf(a.id))[0].lease_expires_at as Date) > lease0 && (await runsOf(a.id))[0])
    assert.equal(moved.lease_owner, 'inst-e2e')
    // another process recovers the lease: the next heartbeats are refused, twice in a row -> the run is aborted
    await q(`UPDATE agent_runs SET lease_owner = 'inst-other' WHERE agent_id = $1`, [a.id])
    await until(async () => seen.aborted)
  } finally {
    await s.stop() // settles every in-flight run: the stale holder has attempted (and been refused) its finish by now
  }
  {
    const [row] = await runsOf(a.id)
    assert.deepEqual([row.status, row.lease_owner, row.error_code], ['running', 'inst-other', null], 'the stale holder cannot overwrite the row it lost')
    const ag = await agentRow(a.id)
    assert.equal(ag.consecutive_failures, 0, 'and its bookkeeping was not written either')
  }
})

test('AC7 end to end: stop() cancels an in-flight run as cancelled/shutdown, within 10 s, and the agent stays enabled', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: -MIN })
  await enableFeature()
  const { execute, seen } = runnerWith(holdUntilAbort)
  const s = indexMod.startAgentScheduler({ env: { AGENTS_ENABLED: '1' }, instanceId: 'inst-stop', firstDelayMs: 5, maxSleepMs: 60_000, heartbeatMs: 1000, execute, log: quiet })!
  await until(async () => seen.started) // the turn is in flight
  const started = Date.now()
  await s.stop()
  assert.ok(Date.now() - started < 10_000)
  assert.equal(seen.aborted, true)
  const [row] = await runsOf(a.id)
  assert.deepEqual([row.status, row.error_code], ['cancelled', 'shutdown'])
  const ag = await agentRow(a.id)
  assert.deepEqual([ag.enabled, ag.consecutive_failures], [true, 0])
})

test('end to end: a due agent runs once, its outcome is written and the schedule advances', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: -MIN })
  await enableFeature()
  const { execute } = runnerWith(async () => ({ status: 'ok', messageId: null, finishReason: 'stop', stoppedEarly: null, toolNames: [], errorCode: null }))
  const s = indexMod.startAgentScheduler({ env: { AGENTS_ENABLED: '1' }, instanceId: 'inst-ok', firstDelayMs: 5, maxSleepMs: 60_000, execute, log: quiet })!
  try {
    const done = await until(async () => (await runsOf(a.id)).find((r) => r.status === 'succeeded'))
    assert.equal(done.error_code, null)
    assert.ok(done.session_id, 'the run\'s chat')
    await until(async () => (await agentRow(a.id)).last_run_at)
    const ag = await agentRow(a.id)
    assert.deepEqual([ag.enabled, ag.consecutive_failures], [true, 0])
    assert.ok(ag.next_run_at > new Date())
    assert.equal((await runsOf(a.id)).length, 1)
    assert.equal((await q(`SELECT 1 FROM admin_audit WHERE action = 'agent.run.finish' AND target = $1`, [`agent:${a.id}`])).length, 1)
  } finally {
    await s.stop()
  }
})

test('finishRun with bookkeeping: the terminal row, the counter, the disable and the audit row commit together', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: -MIN })
  const run = (await claim({ instanceId: 'inst-1' })).claimed[0]!
  const out = { ...OUT, status: 'failed', errorCode: 'approval_expired' } as import('./scheduler/run.ts').RunOutcome
  assert.equal(await sched.finishRun(a.owner, run.runId, 'inst-1', out, { bookkeeping: { agentId: a.id, disable: true, failureThreshold: 3, trigger: 'schedule' } }), true)
  const [row] = await runsOf(a.id)
  assert.deepEqual([row.status, row.error_code], ['failed', 'approval_expired'])
  const ag = await agentRow(a.id)
  assert.deepEqual([ag.enabled, ag.next_run_at, ag.disabled_reason], [false, null, 'approval_expired'])
  assert.equal((await q(`SELECT 1 FROM admin_audit WHERE action = 'agent.run.finish' AND target = $1`, [`agent:${a.id}`])).length, 1)
})

test('finishRun with bookkeeping: a failure in the agent side rolls the run row back too (nothing half-written)', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: -MIN })
  const run = (await claim({ instanceId: 'inst-1' })).claimed[0]!
  const out = { ...OUT, status: 'failed', errorCode: 'timeout' } as import('./scheduler/run.ts').RunOutcome
  await assert.rejects(sched.finishRun(a.owner, run.runId, 'inst-1', out, { bookkeeping: { agentId: a.id, disable: false, failureThreshold: Number.NaN } }))
  const [row] = await runsOf(a.id)
  assert.equal(row.status, 'running', 'the run is still the holder\'s: it can finish again')
  assert.equal((await agentRow(a.id)).consecutive_failures, 0)
  assert.equal((await q(`SELECT 1 FROM admin_audit WHERE action = 'agent.run.finish' AND target = $1`, [`agent:${a.id}`])).length, 0)
  assert.equal(await sched.finishRun(a.owner, run.runId, 'inst-1', out, { bookkeeping: { agentId: a.id, disable: false, failureThreshold: 3 } }), true)
  assert.equal((await agentRow(a.id)).consecutive_failures, 1)
})

test('finishRun with bookkeeping from a stale holder writes nothing at all', { skip }, async () => {
  await clean()
  const a = await seedAgent({ dueInMs: -MIN })
  const run = (await claim({ instanceId: 'inst-1' })).claimed[0]!
  const out = { ...OUT, status: 'failed', errorCode: 'approval_expired' } as import('./scheduler/run.ts').RunOutcome
  assert.equal(await sched.finishRun(a.owner, run.runId, 'inst-stale', out, { bookkeeping: { agentId: a.id, disable: true, failureThreshold: 3 } }), false)
  const ag = await agentRow(a.id)
  assert.deepEqual([ag.enabled, ag.consecutive_failures, ag.last_run_at], [true, 0, null])
  assert.equal((await q(`SELECT 1 FROM admin_audit WHERE action = 'agent.run.finish' AND target = $1`, [`agent:${a.id}`])).length, 0)
})
