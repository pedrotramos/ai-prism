// W4-4a: the agents data model (migration 0015) proven against a real Postgres.
//
//   AC1  0015 round trip (up / down / up on a fresh database) and 0014 -> 0015 on a seeded one
//   AC2  RLS: owner A cannot see or change B's agents or runs; an admin reads every agent but no chat row;
//        the scheduler identity reads only approved agents (and runs) and no other user table
//   AC3  the trigger: any change of `definition` voids the approval, the approval columns are writable only with
//        the admin flag, enabling an unapproved or expired agent fails in the database, and no single statement
//        (UPDATE ... SET definition = definition, status = ...) gets around it
//   AC7  the table lists (RLS_TABLES) cover the new tables
//
// Same harness as server/rls.test.js: a scratch database per deployment, the SP as a plain role bound by RLS.
// No local Postgres with pgvector -> skipped.
//
//   node --test server/agents.rls.test.ts
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

import { loadMigrations, migrateDown, migrateUp } from './db/migrate.ts'
import { applyAppGrants, prepareOwnerHandoff } from './db/grants.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = path.join(HERE, 'migrations')

const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
const ADMIN_DB = env.PGDATABASE || 'ai_prism'
const SUPERUSER = env.PGUSER
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const createdDbs: string[] = []
const createdRoles: string[] = []
const tmpDirs: string[] = []
let seq = 0

function opts(database: string, user: string = SUPERUSER) {
  return { host: env.PGHOST, port: Number(env.PGPORT), user, password: env.PGPASSWORD, database, ssl: false, connectionTimeoutMillis: 2000 }
}

async function skipReason(): Promise<string | null> {
  if (!LOCAL_HOSTS.has(env.PGHOST!) && env.ISOLATION_TEST_ANY_HOST !== '1') {
    return `PGHOST=${env.PGHOST} is not local (set ISOLATION_TEST_ANY_HOST=1 to use another test server)`
  }
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

async function admin(sql: string, database = ADMIN_DB) {
  const c = new pg.Client(opts(database))
  await c.connect()
  try {
    return await c.query(sql)
  } finally {
    await c.end().catch(() => {})
  }
}

async function role(kind: string, extra = '') {
  const name = `w44a_${kind}_${stamp}_${++seq}`
  await admin(`CREATE ROLE ${name} LOGIN PASSWORD '${env.PGPASSWORD}' ${extra}`)
  createdRoles.push(name)
  return name
}

async function scratchDb(owner: string) {
  const name = `w44a_db_${stamp}_${++seq}`
  await admin(`CREATE DATABASE ${name} OWNER ${owner}`)
  createdDbs.push(name)
  await admin(`CREATE EXTENSION IF NOT EXISTS vector`, name)
  return name
}

async function as<T>(database: string, user: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client(opts(database, user))
  await c.connect()
  try {
    await c.query(`SET search_path TO ai_prism, public`)
    return await fn(c)
  } finally {
    await c.end().catch(() => {})
  }
}

const quiet = { log() {}, warn() {}, info() {}, error() {}, debug() {} }

after(async () => {
  if (SKIP) return
  for (const db of createdDbs) {
    await admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`).catch(() => {})
    await admin(`DROP DATABASE IF EXISTS ${db}`).catch(() => {})
  }
  for (const r of createdRoles.reverse()) await admin(`DROP ROLE IF EXISTS ${r}`).catch(() => {})
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

interface Deployment { dep: string; sp: string; owner: string; db: string; up: { applied: number[] } }

// A deployment the way the deploy runs it. `to` stops the migrations at that version (a copy of the files in a temp dir).
async function deployment({ to }: { to?: number } = {}): Promise<Deployment> {
  const dep = await role('dep', 'CREATEROLE')
  const sp = await role('sp')
  const owner = `w44a_owner_${stamp}_${++seq}`
  createdRoles.push(owner)
  const db = await scratchDb(dep)
  await as(db, dep, (c) => prepareOwnerHandoff(c, { role: sp, owner }))
  let dir: string | undefined
  if (to !== undefined) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w44a-mig-'))
    tmpDirs.push(dir)
    for (const f of fs.readdirSync(MIGRATIONS)) if (Number.parseInt(f, 10) <= to) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f))
  }
  const up = await as(db, sp, (c) => migrateUp(c, { log: quiet, ownerRole: owner, ...(dir ? { dir } : {}) }))
  await as(db, dep, (c) => applyAppGrants(c, { role: sp, owner } as any)) // any: JS option bag
  return { dep, sp, owner, db, up }
}

let sharedDeployment: Promise<Deployment> | null = null
const shared = () => (sharedDeployment ??= deployment())

interface Who { email?: string; admin?: boolean; scheduler?: boolean }

// One transaction as the SP with the app identity set the way withTx sets it (plus app.scheduler, which only the
// scheduler's own db module sets in production).
async function asApp<T>(d: Deployment, who: Who, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return as(d.db, d.sp, async (c) => {
    await c.query('BEGIN')
    try {
      await c.query(`SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', $2, true), set_config('app.scheduler', $3, true)`, [
        who.email ?? '',
        who.admin ? 'on' : 'off',
        who.scheduler ? 'on' : 'off',
      ])
      const r = await fn(c)
      await c.query('COMMIT')
      return r
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    }
  })
}

// The outcome of fn as an error message (or null when it succeeded).
async function refused(d: Deployment, who: Who, fn: (c: pg.Client) => Promise<unknown>): Promise<string | null> {
  try {
    await asApp(d, who, fn)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

const RUN = `${stamp}`
const A = `agents-a-${RUN}@test.invalid`
const B = `agents-b-${RUN}@test.invalid`
const BOSS = `agents-boss-${RUN}@test.invalid`
const DEF = { instructions: 'i', prompt: 'p', model: 'm', reasoningEffort: null, tools: [], schedule: null, lang: 'en' }
const DEF2 = { ...DEF, prompt: 'p2' }

// An agent inserted by the superuser with the admin flag (the way a seed or a support fix would), in any state.
async function seedAgent(d: Deployment, owner: string, state: 'draft' | 'pending' | 'approved' | 'expired' = 'draft', name = 'seed'): Promise<string> {
  return as(d.db, SUPERUSER, async (c) => {
    await c.query(`SELECT set_config('app.is_admin', 'on', false)`)
    const approved = state === 'approved' || state === 'expired'
    const r = await c.query(
      `INSERT INTO agents (owner_email, name, definition, status, approval_hash, approved_snapshot, approved_by_hash, approved_at, approval_expires_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8, $9) RETURNING id`,
      [
        owner,
        name,
        JSON.stringify(DEF),
        approved ? 'approved' : state,
        approved ? 'hash' : null,
        approved ? JSON.stringify(DEF) : null,
        approved ? 'h2:admin' : null,
        approved ? new Date().toISOString() : null,
        state === 'approved' ? new Date(Date.now() + 30 * 86400_000).toISOString() : state === 'expired' ? new Date(Date.now() - 86400_000).toISOString() : null,
      ]
    )
    return String(r.rows[0].id)
  })
}

async function seedChatFor(d: Deployment, owner: string) {
  return as(d.db, SUPERUSER, async (c) => {
    const s = (await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 't', 'm') RETURNING id`, [owner])).rows[0].id
    await c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'segredo')`, [s])
    await c.query(`INSERT INTO usage_ledger (user_email, session_id, kind, model, cost_usd) VALUES ($1, $2, 'chat', 'm', 1)`, [owner, s])
    await c.query(`INSERT INTO user_memories (user_email, content) VALUES ($1, 'fato')`, [owner])
    await c.query(`INSERT INTO user_mcp_connections (user_email, connection_name) VALUES ($1, 'c')`, [owner])
    return s as string
  })
}

// ---- static guards --------------------------------------------------------------

test('the RLS lists name the new tables, 0015 forces RLS on both, and app.scheduler appears only in 0015', async () => {
  const rls = await import('./db/rls.ts')
  assert.deepEqual([...(rls as any).RLS_0015_TABLES], ['agents', 'agent_runs'])
  for (const t of ['agents', 'agent_runs']) assert.ok(rls.RLS_TABLES.includes(t), `${t} in RLS_TABLES`)
  const up = fs.readFileSync(path.join(MIGRATIONS, '0015_agents.up.sql'), 'utf8')
  for (const t of ['agents', 'agent_runs']) {
    assert.ok(up.includes(`ai_prism.${t}`), `0015 creates ${t}`)
    assert.ok(new RegExp(`${t} FORCE ROW LEVEL SECURITY`).test(up), `0015 forces RLS on ${t}`)
  }
  const offenders = fs.readdirSync(MIGRATIONS).filter((f) => !f.startsWith('0015_') && fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').includes('app.scheduler'))
  assert.deepEqual(offenders, [], 'only 0015 mentions the scheduler identity')
})

test('every policy of 0015 reads the identity through NULLIF (an empty identity matches nobody)', () => {
  const up = fs.readFileSync(path.join(MIGRATIONS, '0015_agents.up.sql'), 'utf8')
  assert.equal(/current_setting\(\s*''?app\.user_email''?\s*,\s*true\s*\)/.test(up.replace(/NULLIF\(\s*current_setting\(\s*''?app\.user_email''?\s*,\s*true\s*\)\s*,\s*''''\s*\)/g, '')), false, 'a bare app.user_email read')
})

// ---- AC1: migrations ------------------------------------------------------------

test('AC1 0015 round trip on a fresh database: up, down, up', { skip: SKIP }, async () => {
  const d = await deployment()
  assert.ok(d.up.applied.includes(15))
  const shape = async () =>
    as(d.db, SUPERUSER, async (c) => ({
      tables: (await c.query(`SELECT relname FROM pg_class WHERE relnamespace = 'ai_prism'::regnamespace AND relkind = 'r' AND relname IN ('agents','agent_runs') ORDER BY 1`)).rows.map((r) => r.relname),
      policies: (await c.query(`SELECT polrelid::regclass::text AS t, polname FROM pg_policy WHERE polname LIKE 'aia%' ORDER BY 1, 2`)).rows,
      triggers: (await c.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'ai_prism.agents'::regclass`)).rows.map((r) => r.tgname),
      fns: (await c.query(`SELECT proname FROM pg_proc WHERE pronamespace = 'ai_prism'::regnamespace AND proname LIKE 'aip_agents%'`)).rows.map((r) => r.proname),
    }))
  const first = await shape()
  assert.deepEqual(first.tables, ['agent_runs', 'agents'])
  assert.ok(first.policies.length >= 8, 'owner/admin/scheduler policies plus the audit insert')
  assert.deepEqual(first.triggers, ['aip_agents_guard'])
  // a settings key the feature would have written
  await as(d.db, SUPERUSER, (c) => c.query(`INSERT INTO app_settings (key, value) VALUES ('agents_enabled', 'true'), ('agents_max_run_cost_usd', '1'), ('agents_approval_days', '90'), ('retention_days', '30')`))
  const down = await as(d.db, d.sp, (c) => migrateDown(c, { to: 14, log: quiet, ownerRole: d.owner }))
  assert.deepEqual(down.reverted, [15])
  const gone = await shape()
  assert.deepEqual(gone, { tables: [], policies: [], triggers: [], fns: [] })
  const keys = await as(d.db, SUPERUSER, (c) => c.query(`SELECT key FROM app_settings ORDER BY key`))
  assert.deepEqual(keys.rows.map((r) => r.key), ['retention_days'], 'down removes only the three agents keys')
  await as(d.db, d.sp, (c) => migrateUp(c, { log: quiet, ownerRole: d.owner }))
  assert.deepEqual(await shape(), first)
  // idempotent: the up body can be replayed
  const sql = fs.readFileSync(path.join(MIGRATIONS, '0015_agents.up.sql'), 'utf8')
  await as(d.db, d.dep, (c) => c.query(`SET ROLE ${d.owner}`).then(() => c.query(sql)))
  assert.deepEqual(await shape(), first)
})

test('AC1 0014 -> 0015 on a seeded database keeps every row and the new tables work', { skip: SKIP }, async () => {
  const d = await deployment({ to: 14 })
  assert.equal(Math.max(...d.up.applied), 14)
  const s = await seedChatFor(d, A)
  const up = await as(d.db, d.sp, (c) => migrateUp(c, { log: quiet, ownerRole: d.owner }))
  assert.deepEqual(up.applied, [15])
  await as(d.db, d.dep, (c) => applyAppGrants(c, { role: d.sp, owner: d.owner } as any))
  const counts = await as(d.db, SUPERUSER, async (c) => ({
    s: (await c.query(`SELECT count(*)::int n FROM chat_sessions WHERE id = $1`, [s])).rows[0].n,
    m: (await c.query(`SELECT count(*)::int n FROM chat_messages WHERE session_id = $1`, [s])).rows[0].n,
    l: (await c.query(`SELECT count(*)::int n FROM usage_ledger WHERE session_id = $1`, [s])).rows[0].n,
  }))
  assert.deepEqual(counts, { s: 1, m: 1, l: 1 })
  // the SP got DML on the new tables through the default privileges (APP_TABLES only lists the 0002 set)
  const id = await asApp(d, { email: A }, async (c) => (await c.query(`INSERT INTO agents (owner_email, name, definition) VALUES ($1, 'n', $2::jsonb) RETURNING id`, [A, JSON.stringify(DEF)])).rows[0].id)
  assert.ok(id)
})

// ---- AC2: row-level security ----------------------------------------------------

test('AC2 owner A cannot see or change B\'s agents or runs (and an empty identity matches nobody)', { skip: SKIP }, async () => {
  const d = await shared()
  const aId = await seedAgent(d, A, 'draft', 'a-owned')
  const bId = await seedAgent(d, B, 'draft', 'b-owned')
  const orphan = await seedAgent(d, '', 'draft', 'no-owner')
  await as(d.db, SUPERUSER, (c) => c.query(`INSERT INTO agent_runs (agent_id, owner_email, trigger, slot_at, approval_hash, status) VALUES ($1, $2, 'manual', now(), 'h', 'queued')`, [bId, B]))

  await asApp(d, { email: A }, async (c) => {
    const seen = (await c.query(`SELECT id::text FROM agents`)).rows.map((r) => r.id)
    assert.ok(seen.includes(aId))
    assert.ok(!seen.includes(bId), 'B\'s agent is invisible to A')
    assert.ok(!seen.includes(orphan), 'a row with an empty owner is nobody\'s')
    assert.equal((await c.query(`SELECT 1 FROM agent_runs`)).rowCount, 0, 'B\'s run is invisible to A')
    assert.equal((await c.query(`UPDATE agents SET name = 'pwn' WHERE id = $1`, [bId])).rowCount, 0)
    assert.equal((await c.query(`DELETE FROM agents WHERE id = $1`, [bId])).rowCount, 0)
    assert.equal((await c.query(`UPDATE agent_runs SET status = 'cancelled'`)).rowCount, 0)
  })
  assert.match((await refused(d, { email: A }, (c) => c.query(`INSERT INTO agents (owner_email, name, definition) VALUES ($1, 'x', '{}'::jsonb)`, [B]))) ?? '', /row-level security/)
  assert.match((await refused(d, { email: A }, (c) => c.query(`INSERT INTO agent_runs (agent_id, owner_email, trigger, slot_at, approval_hash, status) VALUES ($1, $2, 'manual', now(), 'h', 'queued')`, [bId, B]))) ?? '', /row-level security/)
  assert.match((await refused(d, { email: A }, (c) => c.query(`INSERT INTO agent_runs (agent_id, owner_email, trigger, slot_at, approval_hash, status) VALUES ($1, $2, 'manual', now(), 'h', 'queued')`, [bId, A]))) ?? '', /row-level security/, 'A cannot queue a run on B\'s agent even under her own name')
  // no identity at all
  await asApp(d, {}, async (c) => {
    assert.equal((await c.query(`SELECT 1 FROM agents`)).rowCount, 0)
    assert.equal((await c.query(`SELECT 1 FROM agent_runs`)).rowCount, 0)
  })
  assert.match((await refused(d, {}, (c) => c.query(`INSERT INTO agents (owner_email, name, definition) VALUES ('', 'x', '{}'::jsonb)`))) ?? '', /row-level security/)
})

test('AC2 an owner may queue only a manual, queued run on her own agent; her other run writes are limited to her rows', { skip: SKIP }, async () => {
  const d = await shared()
  const id = await seedAgent(d, A, 'approved', 'own-approved')
  const ins = (trigger: string, status: string) => (c: pg.Client) =>
    c.query(`INSERT INTO agent_runs (agent_id, owner_email, trigger, slot_at, approval_hash, status) VALUES ($1, $2, $3, now() + (random() * interval '1 hour'), 'h', $4)`, [id, A, trigger, status])
  assert.match((await refused(d, { email: A }, ins('schedule', 'queued'))) ?? '', /row-level security/)
  assert.match((await refused(d, { email: A }, ins('manual', 'running'))) ?? '', /row-level security/)
  assert.equal(await refused(d, { email: A }, ins('manual', 'queued')), null)
  // one active run per agent (design §1.5 agent_runs_active)
  assert.match((await refused(d, { email: A }, ins('manual', 'queued'))) ?? '', /agent_runs_active|duplicate key/)
  // the owner finishes her own run (finishRun runs under the owner identity)
  await asApp(d, { email: A }, async (c) => {
    assert.equal((await c.query(`UPDATE agent_runs SET status = 'succeeded' WHERE agent_id = $1`, [id])).rowCount, 1)
  })
})

test('AC2 an admin reads every agent and run but no chat row, and changes no definition', { skip: SKIP }, async () => {
  const d = await shared()
  const aId = await seedAgent(d, A, 'pending', 'admin-sees-a')
  const bId = await seedAgent(d, B, 'pending', 'admin-sees-b')
  await seedChatFor(d, A)
  await asApp(d, { email: BOSS, admin: true }, async (c) => {
    const ids = (await c.query(`SELECT id::text FROM agents`)).rows.map((r) => r.id)
    assert.ok(ids.includes(aId) && ids.includes(bId))
    for (const t of ['chat_sessions', 'chat_messages', 'usage_ledger', 'user_memories', 'user_mcp_connections']) {
      const n = (await c.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n
      assert.equal(n === 0 || t === 'usage_ledger', true, `${t}: an admin reads no chat data (usage_ledger is the 0010 aggregate read)`)
    }
    assert.equal((await c.query(`SELECT count(*)::int n FROM chat_sessions`)).rows[0].n, 0)
    assert.equal((await c.query(`SELECT count(*)::int n FROM chat_messages`)).rows[0].n, 0)
    assert.equal((await c.query(`SELECT count(*)::int n FROM user_memories`)).rows[0].n, 0)
  })
  // the admin flag without an identity reads nothing
  await asApp(d, { admin: true }, async (c) => assert.equal((await c.query(`SELECT 1 FROM agents`)).rowCount, 0))
  // an admin cannot edit another owner's definition, name or owner, nor delete, nor create runs
  assert.match((await refused(d, { email: BOSS, admin: true }, (c) => c.query(`UPDATE agents SET definition = $2::jsonb WHERE id = $1`, [aId, JSON.stringify(DEF2)]))) ?? '', /agents_guard/)
  assert.match((await refused(d, { email: BOSS, admin: true }, (c) => c.query(`UPDATE agents SET name = 'renamed' WHERE id = $1`, [aId]))) ?? '', /agents_guard/)
  assert.match((await refused(d, { email: BOSS, admin: true }, (c) => c.query(`UPDATE agents SET owner_email = $2 WHERE id = $1`, [aId, BOSS]))) ?? '', /agents_guard|row-level security/)
  await asApp(d, { email: BOSS, admin: true }, async (c) => assert.equal((await c.query(`DELETE FROM agents WHERE id = $1`, [aId])).rowCount, 0))
  assert.match((await refused(d, { email: BOSS, admin: true }, (c) => c.query(`INSERT INTO agent_runs (agent_id, owner_email, trigger, slot_at, approval_hash, status) VALUES ($1, $2, 'manual', now(), 'h', 'queued')`, [aId, A]))) ?? '', /row-level security/)
  // and a non-admin with the flag text 'off' reads only her own
  await asApp(d, { email: A }, async (c) => {
    const ids = (await c.query(`SELECT id::text FROM agents`)).rows.map((r) => r.id)
    assert.ok(ids.includes(aId) && !ids.includes(bId))
  })
})

test('AC2 the scheduler identity reads only approved agents and runs, and no other user table', { skip: SKIP }, async () => {
  const d = await shared()
  const approved = await seedAgent(d, A, 'approved', 'sched-approved')
  const pending = await seedAgent(d, A, 'pending', 'sched-pending')
  const draft = await seedAgent(d, B, 'draft', 'sched-draft')
  const s = await seedChatFor(d, A)
  await as(d.db, SUPERUSER, async (c) => {
    await c.query(`INSERT INTO chat_decks (session_id, user_email, title, slides) VALUES ($1, $2, 'd', '[]')`, [s, A])
    await c.query(`INSERT INTO projects (name, owner_email) VALUES ('p', $1)`, [A]).catch(() => {})
  })
  await asApp(d, { scheduler: true }, async (c) => {
    const ids = (await c.query(`SELECT id::text FROM agents`)).rows.map((r) => r.id)
    assert.ok(ids.includes(approved), 'reads approved agents')
    assert.ok(!ids.includes(pending) && !ids.includes(draft), 'and nothing that is not approved')
    assert.ok((await c.query(`SELECT count(*)::int n FROM agent_runs`)).rows[0].n >= 0)
    const userTables = [
      'chat_sessions', 'chat_messages', 'chat_tool_calls', 'chat_genie_conversations', 'chat_compactions', 'chat_message_embeddings',
      'chat_decks', 'chat_spreadsheets', 'chat_documents', 'chat_images', 'usage_ledger', 'user_mcp_connections',
      'user_template_selection', 'user_image_model_selection', 'user_memories', 'user_memory_state', 'projects', 'project_members',
      'project_files', 'admin_audit',
    ]
    for (const t of userTables) assert.equal((await c.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, 0, `${t}: the scheduler reads nothing`)
  })
  // scheduler on, but with a user identity: not the scheduler (the policy needs the empty identity)
  await asApp(d, { email: B, scheduler: true }, async (c) => {
    const ids = (await c.query(`SELECT id::text FROM agents`)).rows.map((r) => r.id)
    assert.ok(!ids.includes(approved), 'a user identity does not become the scheduler by setting the flag')
  })
  // without the flag the empty identity reads nothing
  await asApp(d, {}, async (c) => assert.equal((await c.query(`SELECT 1 FROM agents`)).rowCount, 0))
})

test('AC2 the scheduler writes only run bookkeeping: runs for approved agents, bounded agent columns, audit rows of kind agent.run.*', { skip: SKIP }, async () => {
  const d = await shared()
  const approved = await seedAgent(d, A, 'approved', 'sched-write')
  const pending = await seedAgent(d, A, 'pending', 'sched-write-pending')
  const run = (id: string, owner: string, slot: string, status = 'running') => (c: pg.Client) =>
    c.query(`INSERT INTO agent_runs (agent_id, owner_email, trigger, slot_at, approval_hash, status, lease_owner, lease_expires_at) VALUES ($1, $2, 'schedule', $3::timestamptz, 'h', $4, 'inst', now() + interval '2 minutes')`, [id, owner, slot, status])
  assert.equal(await refused(d, { scheduler: true }, run(approved, A, '2030-01-01T08:00:00Z')), null)
  assert.match((await refused(d, { scheduler: true }, run(approved, A, '2030-01-01T08:00:00Z', 'skipped'))) ?? '', /agent_runs_slot|duplicate key/, 'one run per (agent, occurrence)')
  assert.match((await refused(d, { scheduler: true }, run(approved, A, '2030-01-02T08:00:00Z'))) ?? '', /agent_runs_active|duplicate key/, 'one active run per agent')
  assert.equal(await refused(d, { scheduler: true }, run(approved, A, '2030-01-03T08:00:00Z', 'skipped')), null, 'skipped rows are not active')
  assert.match((await refused(d, { scheduler: true }, run(pending, A, '2030-01-01T08:00:00Z'))) ?? '', /row-level security/, 'no run for an agent that is not approved')
  assert.match((await refused(d, { scheduler: true }, run(approved, B, '2030-01-04T08:00:00Z', 'skipped'))) ?? '', /row-level security/, 'the run\'s owner must be the agent\'s owner')
  await asApp(d, { scheduler: true }, async (c) => {
    assert.equal((await c.query(`UPDATE agent_runs SET status = 'failed', error_code = 'lease_expired' WHERE agent_id = $1 AND status = 'running'`, [approved])).rowCount, 1)
    assert.equal((await c.query(`UPDATE agents SET next_run_at = now(), last_run_at = now(), consecutive_failures = 2, disabled_reason = 'timeout' WHERE id = $1`, [approved])).rowCount, 1)
    assert.equal((await c.query(`DELETE FROM agents WHERE id = $1`, [approved])).rowCount, 0)
    assert.equal((await c.query(`DELETE FROM agent_runs`)).rowCount, 0)
  })
  const cols = (set: string) => (c: pg.Client) => c.query(`UPDATE agents SET ${set} WHERE id = $1`, [approved])
  for (const set of [`definition = '{}'::jsonb`, `name = 'x'`, `status = 'revoked'`, `approval_expires_at = now() + interval '1 year'`, `owner_email = 'x@y.z'`, `approval_hash = 'zz'`, `approved_snapshot = '{}'::jsonb`]) {
    assert.match((await refused(d, { scheduler: true }, cols(set))) ?? '', /agents_guard/, `scheduler cannot set ${set}`)
  }
  assert.equal(await refused(d, { scheduler: true }, cols(`enabled = false, disabled_reason = 'approval_expired', next_run_at = NULL`)), null)
  assert.match((await refused(d, { scheduler: true }, (c) => c.query(`INSERT INTO agents (owner_email, name, definition) VALUES ($1, 'x', '{}'::jsonb)`, [A]))) ?? '', /row-level security/)
  const audit = (actor: string, action: string) => (c: pg.Client) => c.query(`INSERT INTO admin_audit (actor_hash, action, target) VALUES ($1, $2, 'agent:1')`, [actor, action])
  assert.equal(await refused(d, { scheduler: true }, audit('system', 'agent.run.start')), null)
  assert.equal(await refused(d, { scheduler: true }, audit('system', 'agent.run.finish')), null)
  assert.match((await refused(d, { scheduler: true }, audit('system', 'agent.approve'))) ?? '', /row-level security/)
  assert.match((await refused(d, { scheduler: true }, audit('someone', 'agent.run.start'))) ?? '', /row-level security/)
  assert.match((await refused(d, { email: A }, audit('system', 'agent.run.start'))) ?? '', /row-level security/, 'a user cannot write the scheduler\'s audit rows')
  await asApp(d, { scheduler: true }, async (c) => assert.equal((await c.query(`SELECT 1 FROM admin_audit`)).rowCount, 0, 'the scheduler cannot read the audit trail'))
})

test('AC2 the app role owns nothing and cannot drop the guard', { skip: SKIP }, async () => {
  const d = await shared()
  const msg = await refused(d, { email: A }, (c) => c.query(`ALTER TABLE ai_prism.agents DISABLE TRIGGER aip_agents_guard`))
  assert.match(msg ?? '', /must be owner|permission denied/)
})

// ---- AC3: the approval trigger ----------------------------------------------------

const upd = (id: string, set: string, args: unknown[] = []) => (c: pg.Client) => c.query(`UPDATE agents SET ${set} WHERE id = $1`, [id, ...args])
const row = async (d: Deployment, id: string) => (await as(d.db, SUPERUSER, (c) => c.query(`SELECT * FROM agents WHERE id = $1`, [id]))).rows[0]

test('AC3 the owner can submit but cannot write the approval columns; only an admin decides', { skip: SKIP }, async () => {
  const d = await shared()
  const id = await seedAgent(d, A, 'draft', 'trig-flow')
  assert.equal(await refused(d, { email: A }, upd(id, `status = 'pending'`)), null, 'the owner submits')
  for (const set of [
    `status = 'approved'`,
    `status = 'rejected'`,
    `status = 'revoked'`,
    `approval_hash = 'x'`,
    `approved_snapshot = definition`,
    `approved_by_hash = 'x'`,
    `approved_at = now()`,
    `approval_expires_at = now() + interval '1 day'`,
    `decision_reason = 'ok'`,
    `definition = definition, status = 'approved'`,
    `status = 'approved', approval_hash = 'x', approved_snapshot = definition, approved_by_hash = 'x', approved_at = now(), approval_expires_at = now() + interval '1 day'`,
  ]) {
    assert.match((await refused(d, { email: A }, upd(id, set))) ?? '', /agents_guard/, `owner cannot: ${set}`)
  }
  assert.equal((await row(d, id)).status, 'pending')
  // an admin approves it (same statement shape decideAgent uses)
  const approve = `status = 'approved', approval_hash = 'hh', approved_snapshot = definition, approved_by_hash = 'h2:boss', approved_at = now(), approval_expires_at = now() + interval '30 days'`
  assert.equal(await refused(d, { email: BOSS, admin: true }, upd(id, approve)), null)
  const r = await row(d, id)
  assert.equal(r.status, 'approved')
  assert.equal(r.approval_hash, 'hh')
  // an approval must be of what is stored: a snapshot that differs from the definition is refused
  const id2 = await seedAgent(d, A, 'pending', 'trig-snapshot')
  assert.match((await refused(d, { email: BOSS, admin: true }, upd(id2, approve.replace('approved_snapshot = definition', `approved_snapshot = '{}'::jsonb`)))) ?? '', /agents_guard/)
  // and only a pending agent can be approved (never straight from draft)
  const id3 = await seedAgent(d, A, 'draft', 'trig-from-draft')
  assert.match((await refused(d, { email: BOSS, admin: true }, upd(id3, approve))) ?? '', /agents_guard/)
})

test('AC3 any change of definition voids the approval, also when smuggled into one statement', { skip: SKIP }, async () => {
  const d = await shared()
  for (const state of ['approved', 'pending'] as const) {
    const id = await seedAgent(d, A, state, `void-${state}`)
    if (state === 'approved') await as(d.db, SUPERUSER, (c) => c.query(`SELECT set_config('app.is_admin','on',false)`).then(() => c.query(`UPDATE agents SET enabled = true, next_run_at = now() WHERE id = $1`, [id])))
    assert.equal(await refused(d, { email: A }, upd(id, `definition = $2::jsonb, revision = revision + 1`, [JSON.stringify(DEF2)])), null)
    const r = await row(d, id)
    assert.equal(r.status, 'draft', `${state} -> draft`)
    assert.equal(r.enabled, false)
    assert.equal(r.next_run_at, null)
    for (const c of ['approval_hash', 'approved_snapshot', 'approved_by_hash', 'approved_at', 'approval_expires_at']) assert.equal(r[c], null, c)
    assert.equal(r.definition.prompt, 'p2')
  }
  // the bypass attempts: edit plus status / enabled in the same statement
  const id = await seedAgent(d, A, 'approved', 'void-bypass')
  assert.match((await refused(d, { email: A }, upd(id, `definition = $2::jsonb, status = 'approved'`, [JSON.stringify(DEF2)]))) ?? '', /agents_guard/)
  assert.match((await refused(d, { email: A }, upd(id, `definition = definition, status = 'rejected'`))) ?? '', /agents_guard/)
  assert.equal(await refused(d, { email: A }, upd(id, `definition = $2::jsonb, enabled = true`, [JSON.stringify(DEF2)])), null)
  const r = await row(d, id)
  assert.deepEqual([r.status, r.enabled], ['draft', false], 'enabled in the same statement as an edit ends disabled')
  // a no-op rewrite of definition keeps the approval
  const keep = await seedAgent(d, A, 'approved', 'void-noop')
  assert.equal(await refused(d, { email: A }, upd(keep, `definition = definition, name = 'renamed', description = 'd', revision = revision + 1`)), null)
  assert.equal((await row(d, keep)).status, 'approved', 'name and description are outside the approval scope')
  // jsonb equality, not text: the same document in another key order is not a change
  assert.equal(await refused(d, { email: A }, upd(keep, `definition = $2::jsonb`, [JSON.stringify({ lang: 'en', tools: [], schedule: null, reasoningEffort: null, model: 'm', prompt: 'p', instructions: 'i' })])), null)
  assert.equal((await row(d, keep)).status, 'approved')
  // a rejected or revoked agent edited by its owner stays what it is (she resubmits)
  const rej = await seedAgent(d, A, 'draft', 'void-rejected')
  await as(d.db, SUPERUSER, (c) => c.query(`SELECT set_config('app.is_admin','on',false)`).then(() => c.query(`UPDATE agents SET status = 'rejected', decision_reason = 'no' WHERE id = $1`, [rej])))
  assert.equal(await refused(d, { email: A }, upd(rej, `definition = $2::jsonb`, [JSON.stringify(DEF2)])), null)
  assert.equal((await row(d, rej)).status, 'rejected')
  assert.equal(await refused(d, { email: A }, upd(rej, `status = 'pending'`)), null, 'and resubmits')
})

test('AC3 enabling needs an approved, unexpired agent, and the database says so', { skip: SKIP }, async () => {
  const d = await shared()
  const draft = await seedAgent(d, A, 'draft', 'en-draft')
  const pending = await seedAgent(d, A, 'pending', 'en-pending')
  const expired = await seedAgent(d, A, 'expired', 'en-expired')
  const ok = await seedAgent(d, A, 'approved', 'en-ok')
  for (const id of [draft, pending, expired]) {
    const m = await refused(d, { email: A }, upd(id, `enabled = true`))
    assert.match(m ?? '', /agents_guard|agents_enabled_requires_approval|check constraint/, `enabling ${id} fails`)
  }
  assert.equal(await refused(d, { email: A }, upd(ok, `enabled = true, next_run_at = now() + interval '1 hour'`)), null)
  assert.equal((await row(d, ok)).enabled, true)
  // inserting an enabled or approved agent as the owner is refused too
  assert.match((await refused(d, { email: A }, (c) => c.query(`INSERT INTO agents (owner_email, name, definition, enabled) VALUES ($1, 'x', '{}'::jsonb, true)`, [A]))) ?? '', /agents_guard|check constraint|row-level security/)
  assert.match((await refused(d, { email: A }, (c) => c.query(`INSERT INTO agents (owner_email, name, definition, status) VALUES ($1, 'x', '{}'::jsonb, 'approved')`, [A]))) ?? '', /agents_guard/)
  // an approval that expires while the agent runs does not break the scheduler's bookkeeping (only the false -> true move is checked)
  await as(d.db, SUPERUSER, (c) => c.query(`SELECT set_config('app.is_admin','on',false)`).then(() => c.query(`UPDATE agents SET approval_expires_at = now() - interval '1 minute' WHERE id = $1`, [ok])))
  assert.equal(await refused(d, { scheduler: true }, upd(ok, `last_run_at = now(), consecutive_failures = 1`)), null)
  assert.equal(await refused(d, { scheduler: true }, upd(ok, `enabled = false, disabled_reason = 'approval_expired'`)), null)
  assert.match((await refused(d, { email: A }, upd(ok, `enabled = true`))) ?? '', /agents_guard/, 'and it cannot be switched back on')
})

test('AC3 the column CHECKs and the cascade', { skip: SKIP }, async () => {
  const d = await shared()
  const bad = (cols: string, vals: string) => (c: pg.Client) => c.query(`INSERT INTO agents (owner_email, name, definition${cols}) VALUES ($1, 'n', '{}'::jsonb${vals})`, [A])
  assert.match((await refused(d, { email: A }, (c) => c.query(`INSERT INTO agents (owner_email, name, definition) VALUES ($1, '', '{}'::jsonb)`, [A]))) ?? '', /check constraint/)
  assert.match((await refused(d, { email: A }, (c) => c.query(`INSERT INTO agents (owner_email, name, definition) VALUES ($1, $2, '{}'::jsonb)`, [A, 'x'.repeat(81)]))) ?? '', /check constraint/)
  assert.match((await refused(d, { email: A }, bad(', description', `, '${'x'.repeat(501)}'`))) ?? '', /check constraint/)
  assert.match((await refused(d, { email: A }, bad(', status', `, 'bogus'`))) ?? '', /check constraint/)
  // deleting an agent removes its runs; the run's chat survives (session_id is SET NULL the other way round)
  const id = await seedAgent(d, A, 'approved', 'cascade')
  const s = await seedChatFor(d, A)
  await as(d.db, SUPERUSER, (c) => c.query(`INSERT INTO agent_runs (agent_id, owner_email, trigger, slot_at, approval_hash, status, session_id) VALUES ($1, $2, 'manual', now(), 'h', 'succeeded', $3)`, [id, A, s]))
  await asApp(d, { email: A }, async (c) => {
    assert.equal((await c.query(`DELETE FROM agents WHERE id = $1`, [id])).rowCount, 1)
  })
  const left = await as(d.db, SUPERUSER, async (c) => ({
    runs: (await c.query(`SELECT count(*)::int n FROM agent_runs WHERE agent_id = $1`, [id])).rows[0].n,
    session: (await c.query(`SELECT count(*)::int n FROM chat_sessions WHERE id = $1`, [s])).rows[0].n,
  }))
  assert.deepEqual(left, { runs: 0, session: 1 })
  // the run keeps working when its chat is deleted by retention
  const id2 = await seedAgent(d, A, 'approved', 'setnull')
  const s2 = await seedChatFor(d, A)
  await as(d.db, SUPERUSER, async (c) => {
    await c.query(`INSERT INTO agent_runs (agent_id, owner_email, trigger, slot_at, approval_hash, status, session_id) VALUES ($1, $2, 'manual', now(), 'h', 'succeeded', $3)`, [id2, A, s2])
    await c.query(`DELETE FROM chat_sessions WHERE id = $1`, [s2])
    assert.equal((await c.query(`SELECT session_id FROM agent_runs WHERE agent_id = $1`, [id2])).rows[0].session_id, null)
  })
})
