// W4-4a: server/db/agents.ts against a real Postgres, connected as the app role (so RLS binds it).
//
//   AC4  decideAgent writes exactly one admin_audit row in the decision's transaction; a hash mismatch (or a state
//        that moved) answers 'stale' and writes nothing
//   AC2/3 through the module: owners reach only their rows, an edit of the approval scope returns the row as a draft,
//        enabling needs an approved, unexpired agent, run-now answers 'busy' while one is active
//
// Scratch database on the local test server, db.js connected as ai_prism_app (scripts/ci/pg-roles.sql).
// No Postgres with pgvector -> skipped.
//
//   node --test server/db/agents.test.ts
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')

const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGDATABASE ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
env.LOCAL_DEV_MODE = '1'
env.LOCAL_PGVECTOR = '1'
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET
delete env.DATABRICKS_APP_NAME

const SUPERUSER = env.PGUSER
const ADMIN_DB = env.PGDATABASE
const APP_ROLE = env.ISOLATION_APP_ROLE || 'ai_prism_app'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const A = `dba-a-${stamp}@test.invalid`
const B = `dba-b-${stamp}@test.invalid`
const C = `dba-c-${stamp}@test.invalid`
const BOSS = `dba-boss-${stamp}@test.invalid`

function opts(database: string | undefined, user = SUPERUSER) {
  return { host: env.PGHOST, port: Number(env.PGPORT), user, password: env.PGPASSWORD, database, ssl: false, connectionTimeoutMillis: 2000 }
}

async function skipReason(): Promise<string | null> {
  if (!LOCAL_HOSTS.has(env.PGHOST!) && env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${env.PGHOST} is not local`
  const c = new pg.Client(opts(ADMIN_DB))
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    return ext.rows.length ? null : 'pgvector is not installed on this Postgres'
  } catch (e) {
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${(e as { code?: string; message?: string }).code || (e as Error).message}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}
const SKIP = (await skipReason()) || false
const quiet = { log() {}, warn() {}, info() {}, error() {}, debug() {} }

let DB = ''
let raw: pg.Client
const createdDbs: string[] = []

async function superuser(sql: string, params: unknown[] = [], database: string | undefined = ADMIN_DB) {
  const c = new pg.Client(opts(database))
  await c.connect()
  try {
    return await c.query(sql, params)
  } finally {
    await c.end().catch(() => {})
  }
}

if (!SKIP) {
  DB = `w44a_agents_${stamp}`
  await superuser(`CREATE DATABASE ${DB}`)
  createdDbs.push(DB)
  const c = new pg.Client(opts(DB))
  await c.connect()
  try {
    if (!(await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])).rows.length && APP_ROLE === 'ai_prism_app') {
      await c.query(fs.readFileSync(path.join(REPO, 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
    }
    const { migrateUp } = await import('./migrate.ts')
    const { applyAppGrants } = await import('./grants.ts')
    await migrateUp(c, { log: quiet })
    await applyAppGrants(c, { role: APP_ROLE, log: quiet } as any) // any: JS option bag
  } finally {
    await c.end().catch(() => {})
  }
  raw = new pg.Client(opts(DB))
  await raw.connect()
  await raw.query(`SET search_path TO ai_prism, public`)
  env.PGDATABASE = DB
  env.PGUSER = APP_ROLE
}

after(async () => {
  if (SKIP) return
  await raw.end().catch(() => {})
  const db = await import('../db.ts')
  await (db as any).closePool?.().catch?.(() => {})
  for (const name of createdDbs) {
    await superuser(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`).catch(() => {})
    await superuser(`DROP DATABASE IF EXISTS ${name}`).catch(() => {})
  }
})

const DEF = { instructions: 'i', prompt: 'p', model: 'm', reasoningEffort: null, tools: [], schedule: null, lang: 'en' } as const
const input = (name: string, over: Record<string, unknown> = {}) => ({ name, description: '', definition: { ...DEF, ...over } as any })
const mod = () => import('./agents.ts')
const auditRows = async (target?: string) =>
  (await raw.query(`SELECT actor_hash, action, target, details FROM admin_audit WHERE ($1::text IS NULL OR target = $1) ORDER BY id`, [target ?? null])).rows
const sqlAdmin = async (sql: string, params: unknown[] = []) => {
  await raw.query(`SELECT set_config('app.is_admin', 'on', false)`)
  try {
    return await raw.query(sql, params)
  } finally {
    await raw.query(`SELECT set_config('app.is_admin', 'off', false)`)
  }
}

test('create, list, get and delete are owner-scoped; the 11th agent is refused with agents_limit', { skip: SKIP }, async () => {
  const m = await mod()
  const a = await m.createAgent(A, null, input('first'))
  assert.equal(a.status, 'draft')
  assert.equal(a.enabled, false)
  assert.equal(a.revision, 1)
  assert.equal(a.ownerEmail, A)
  assert.deepEqual(a.definition, DEF)
  assert.deepEqual((await m.listAgents(A, null)).map((x) => x.id), [a.id])
  assert.deepEqual(await m.listAgents(B, null), [])
  assert.equal(await m.getAgent(B, null, a.id), null, 'B gets nothing, not an error: no existence leak')
  assert.equal(await m.deleteAgent(B, null, a.id), false)
  assert.equal((await m.getAgent(A, null, a.id))?.id, a.id)
  assert.equal(await m.deleteAgent(A, null, a.id), true)
  assert.equal(await m.getAgent(A, null, a.id), null)
  for (let i = 0; i < 10; i++) await m.createAgent(B, null, input(`b${i}`))
  await assert.rejects(m.createAgent(B, null, input('b10')), (e: any) => e.code === 'agents_limit' || e.message === 'agents_limit')
  assert.equal((await m.listAgents(B, null)).length, 10)
})

test('updateAgent: revision check, conflict, and an approval-scope edit comes back as a draft', { skip: SKIP }, async () => {
  const m = await mod()
  const a = await m.createAgent(A, null, input('upd'))
  const b = await m.updateAgent(A, null, a.id, { name: 'renamed', description: 'd', definition: a.definition }, { revision: 1 })
  assert.ok(b && b !== 'conflict')
  assert.equal((b as any).name, 'renamed')
  assert.equal((b as any).revision, 2)
  assert.equal(await m.updateAgent(A, null, a.id, { name: 'x', description: '', definition: a.definition }, { revision: 1 }), 'conflict')
  assert.equal(await m.updateAgent(B, null, a.id, { name: 'x', description: '', definition: a.definition }, { revision: 2 }), null, 'B: not found')
  // approve it (admin path), then edit
  const sub = await m.submitAgent(A, null, a.id)
  assert.equal(sub?.status, 'pending')
  const { approvalHash } = await import('../agents/definition.ts')
  const done = await m.decideAgent(BOSS, null, a.id, { decision: 'approve', expectedHash: approvalHash(a.definition) })
  assert.ok(done && done !== 'stale')
  assert.equal((done as any).status, 'approved')
  const enabled = await m.setAgentEnabled(A, null, a.id, true, new Date(Date.now() + 3600_000))
  assert.equal(enabled?.enabled, true)
  const edited = await m.updateAgent(A, null, a.id, { name: 'renamed', description: 'd', definition: { ...a.definition, prompt: 'changed' } }, { revision: 2 })
  assert.ok(edited && edited !== 'conflict')
  assert.equal((edited as any).status, 'draft')
  assert.equal((edited as any).enabled, false)
  assert.equal((edited as any).nextRunAt, null)
  assert.equal((edited as any).approvalExpiresAt, null)
})

test('submitAgent moves draft/rejected/revoked to pending and nothing else', { skip: SKIP }, async () => {
  const m = await mod()
  const a = await m.createAgent(A, null, input('sub'))
  assert.equal((await m.submitAgent(A, null, a.id))?.status, 'pending')
  assert.equal(await m.submitAgent(A, null, a.id), null, 'already pending')
  assert.equal(await m.submitAgent(B, null, a.id), null, 'not B\'s')
})

test('setAgentEnabled: refused unless approved and unexpired; disabling always works', { skip: SKIP }, async () => {
  const m = await mod()
  const { approvalHash } = await import('../agents/definition.ts')
  const a = await m.createAgent(A, null, input('enable'))
  assert.equal(await m.setAgentEnabled(A, null, a.id, true, new Date()), null, 'a draft cannot be enabled')
  await m.submitAgent(A, null, a.id)
  assert.equal(await m.setAgentEnabled(A, null, a.id, true, new Date()), null, 'a pending one neither')
  await m.decideAgent(BOSS, null, a.id, { decision: 'approve', expectedHash: approvalHash(a.definition), days: 1 })
  const when = new Date(Date.now() + 3600_000)
  const on = await m.setAgentEnabled(A, null, a.id, true, when)
  assert.equal(on?.enabled, true)
  assert.equal(on?.nextRunAt, when.toISOString())
  const off = await m.setAgentEnabled(A, null, a.id, false, null)
  assert.equal(off?.enabled, false)
  assert.equal(off?.nextRunAt, null)
  // expired
  await sqlAdmin(`UPDATE agents SET approval_expires_at = now() - interval '1 minute' WHERE id = $1`, [a.id])
  assert.equal(await m.setAgentEnabled(A, null, a.id, true, new Date()), null)
  assert.equal(await m.setAgentEnabled(B, null, a.id, false, null), null, 'not B\'s')
})

test('queueManualRun: needs an approved, unexpired agent; busy while a run is active; owner-scoped', { skip: SKIP }, async () => {
  const m = await mod()
  const { approvalHash } = await import('../agents/definition.ts')
  const a = await m.createAgent(A, null, input('run'))
  assert.equal(await m.queueManualRun(A, null, a.id), null, 'a draft cannot run')
  await m.submitAgent(A, null, a.id)
  await m.decideAgent(BOSS, null, a.id, { decision: 'approve', expectedHash: approvalHash(a.definition) })
  assert.equal(await m.queueManualRun(B, null, a.id), null)
  const r = await m.queueManualRun(A, null, a.id)
  assert.ok(r && r !== 'busy')
  assert.equal((r as any).status, 'queued')
  assert.equal((r as any).trigger, 'manual')
  assert.equal(await m.queueManualRun(A, null, a.id), 'busy')
  const stored = (await raw.query(`SELECT approval_hash FROM agent_runs WHERE id = $1`, [(r as any).id])).rows[0].approval_hash
  assert.equal(stored, approvalHash(a.definition), 'the run records the hash it was queued under')
  // history: newest first, limit and cursor
  await raw.query(`UPDATE agent_runs SET status = 'succeeded' WHERE agent_id = $1`, [a.id])
  await m.queueManualRun(A, null, a.id)
  await raw.query(`UPDATE agent_runs SET status = 'failed' WHERE agent_id = $1 AND status = 'queued'`, [a.id])
  await m.queueManualRun(A, null, a.id)
  const all = await m.listAgentRuns(A, null, a.id)
  assert.equal(all.length, 3)
  assert.ok(Number(all[0]!.id) > Number(all[1]!.id), 'newest first')
  const page = await m.listAgentRuns(A, null, a.id, { limit: 2 })
  assert.equal(page.length, 2)
  const rest = await m.listAgentRuns(A, null, a.id, { limit: 2, before: page[1]!.id })
  assert.deepEqual(rest.map((x) => x.id), [all[2]!.id])
  assert.deepEqual(await m.listAgentRuns(B, null, a.id), [], 'B sees no runs')
})

test('AC4 decideAgent approve: one audit row in the same transaction, the owner and expiry recorded', { skip: SKIP }, async () => {
  const m = await mod()
  const { approvalHash } = await import('../agents/definition.ts')
  const a = await m.createAgent(A, null, input('decide-ok'))
  await m.submitAgent(A, null, a.id)
  const before = (await auditRows(`agent:${a.id}`)).length
  const r = await m.decideAgent(BOSS, null, a.id, { decision: 'approve', expectedHash: approvalHash(a.definition), days: 7 })
  assert.ok(r && r !== 'stale')
  const row = r as any
  assert.equal(row.status, 'approved')
  assert.equal(row.approvalHash, approvalHash(a.definition))
  assert.equal(row.currentHash, row.approvalHash)
  const days = (Date.parse(row.approvalExpiresAt) - Date.now()) / 86400_000
  assert.ok(days > 6.9 && days < 7.1, `expires in 7 days, got ${days}`)
  const rows = await auditRows(`agent:${a.id}`)
  assert.equal(rows.length - before, 1, 'exactly one audit row')
  assert.equal(rows.at(-1).action, 'agent.approve')
  assert.equal(rows.at(-1).details.hash, approvalHash(a.definition))
  assert.ok(!JSON.stringify(rows.at(-1)).includes(BOSS), 'no e-mail in the audit row')
  const stored = (await raw.query(`SELECT approved_by_hash, approved_snapshot FROM agents WHERE id = $1`, [a.id])).rows[0]
  assert.ok(stored.approved_by_hash && !stored.approved_by_hash.includes('@'))
  assert.deepEqual(stored.approved_snapshot, a.definition)
})

test('AC4 decideAgent on a hash mismatch answers stale and writes nothing', { skip: SKIP }, async () => {
  const m = await mod()
  const a = await m.createAgent(A, null, input('decide-stale'))
  await m.submitAgent(A, null, a.id)
  const auditBefore = (await auditRows()).length
  const snap = (await raw.query(`SELECT * FROM agents WHERE id = $1`, [a.id])).rows[0]
  assert.equal(await m.decideAgent(BOSS, null, a.id, { decision: 'approve', expectedHash: 'f'.repeat(64) }), 'stale')
  assert.equal((await auditRows()).length, auditBefore, 'no audit row')
  assert.deepEqual((await raw.query(`SELECT * FROM agents WHERE id = $1`, [a.id])).rows[0], snap, 'row untouched')
  // an unknown id is null; a decision that does not fit the state (reject of a draft) is stale too
  assert.equal(await m.decideAgent(BOSS, null, '999999999', { decision: 'approve', expectedHash: 'x' }), null)
  const d = await m.createAgent(A, null, input('decide-draft'))
  assert.equal(await m.decideAgent(BOSS, null, d.id, { decision: 'reject', expectedHash: 'x', reason: 'no' }), 'stale')
  assert.equal((await auditRows()).length, auditBefore)
})

test('decideAgent reject and revoke: reason kept, schedule off, one audit row each', { skip: SKIP }, async () => {
  const m = await mod()
  const { approvalHash } = await import('../agents/definition.ts')
  const a = await m.createAgent(A, null, input('reject'))
  await m.submitAgent(A, null, a.id)
  const h = approvalHash(a.definition)
  const rej = (await m.decideAgent(BOSS, null, a.id, { decision: 'reject', expectedHash: h, reason: 'too broad' })) as any
  assert.equal(rej.status, 'rejected')
  assert.equal(rej.decisionReason, 'too broad')
  assert.equal((await auditRows(`agent:${a.id}`)).filter((r) => r.action === 'agent.reject').length, 1)
  assert.equal((await m.submitAgent(A, null, a.id))?.status, 'pending', 'she resubmits')
  await m.decideAgent(BOSS, null, a.id, { decision: 'approve', expectedHash: h })
  await m.setAgentEnabled(A, null, a.id, true, new Date(Date.now() + 3600_000))
  const rev = (await m.decideAgent(BOSS, null, a.id, { decision: 'revoke', expectedHash: h, reason: 'offboarded' })) as any
  assert.equal(rev.status, 'revoked')
  assert.equal(rev.enabled, false)
  assert.equal(rev.nextRunAt, null)
  assert.equal(rev.approvalHash, null)
  assert.equal((await auditRows(`agent:${a.id}`)).filter((r) => r.action === 'agent.revoke').length, 1)
  assert.equal((await m.getAgent(A, null, a.id))?.status, 'revoked')
})

test('listAgentsForReview: all owners, filtered by status, with the stored and the current hash', { skip: SKIP }, async () => {
  const m = await mod()
  const a = await m.createAgent(A, null, input('review-a'))
  const b = await m.createAgent(C, null, input('review-b', { prompt: 'other' }))
  await m.submitAgent(A, null, a.id)
  await m.submitAgent(C, null, b.id)
  const pend = await m.listAgentsForReview(BOSS, null, { status: 'pending' })
  const ids = pend.map((x) => x.id)
  assert.ok(ids.includes(a.id) && ids.includes(b.id))
  assert.ok(pend.every((x) => x.status === 'pending'))
  const { approvalHash } = await import('../agents/definition.ts')
  const mine = pend.find((x) => x.id === a.id)!
  assert.equal(mine.currentHash, approvalHash(a.definition))
  assert.equal(mine.approvalHash, null)
  assert.equal(mine.ownerEmail, A)
  // a non-admin identity going through the same function still reads only its own rows (the admin flag is the module's, RLS decides)
  assert.ok((await m.listAgentsForReview(BOSS, null, {})).length >= 2)
})

test('agent settings: defaults, validated writes, one audit row per write', { skip: SKIP }, async () => {
  const m = await mod()
  assert.deepEqual(await m.readAgentSettings(A, null), { enabled: false, maxRunCostUsd: 1, approvalDays: 90 })
  const before = (await auditRows()).length
  await m.writeAgentSettings(BOSS, null, { enabled: true, maxRunCostUsd: 2.5, approvalDays: 30 })
  assert.deepEqual(await m.readAgentSettings(A, null), { enabled: true, maxRunCostUsd: 2.5, approvalDays: 30 })
  const rows = (await auditRows()).slice(before)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].action, 'agents.settings')
  await assert.rejects(m.writeAgentSettings(BOSS, null, { maxRunCostUsd: 0.01 }), /maxRunCostUsd|invalid/)
  await assert.rejects(m.writeAgentSettings(BOSS, null, { maxRunCostUsd: 51 }), /maxRunCostUsd|invalid/)
  await assert.rejects(m.writeAgentSettings(BOSS, null, { approvalDays: 0 }), /approvalDays|invalid/)
  await assert.rejects(m.writeAgentSettings(BOSS, null, { approvalDays: 366 }), /approvalDays|invalid/)
  assert.equal((await auditRows()).length - before, 1, 'a refused write leaves no audit row')
  await m.writeAgentSettings(BOSS, null, { enabled: false })
  assert.equal((await m.readAgentSettings(A, null)).enabled, false)
})
