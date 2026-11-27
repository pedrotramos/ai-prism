// Agent versions (migration 0017) proven against a real Postgres: the migration round trip and the rules the database enforces.
//
//   V1  0017 round trip (up / down / up on a fresh database) and 0016 -> 0017 on a seeded one (agents survive, history starts empty)
//   V2  RLS: A cannot see or change B's versions or shares; no identity matches nothing; the scheduler identity reads none of it;
//       an admin reads all and changes no content
//   V3  the trigger: a version is immutable for every identity, numbers only go up, a new one starts as a draft, and the
//       approval columns follow the 0015 rules (the owner submits, only an admin decides)
//   V4  recipients: an approved version is readable by the audience a share row names (user, group, whole app) and only then;
//       the share rows a recipient can read are the ones addressed to her
//   V5  the table lists (RLS_TABLES) cover the new tables
//
// Same harness as server/agents.rls.test.ts. No local Postgres with pgvector -> skipped.
//
//   node --test server/agentVersions.rls.test.ts
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

import { loadMigrations, migrateDown, migrateUp } from './db/migrate.ts'
import { applyAppGrants, prepareOwnerHandoff } from './db/grants.ts'
import { RLS_0017_TABLES, RLS_TABLES } from './db/rls.ts'

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
  const name = `av17_${kind}_${stamp}_${++seq}`
  await admin(`CREATE ROLE ${name} LOGIN PASSWORD '${env.PGPASSWORD}' ${extra}`)
  createdRoles.push(name)
  return name
}

async function scratchDb(owner: string) {
  const name = `av17_db_${stamp}_${++seq}`
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
  const owner = `av17_owner_${stamp}_${++seq}`
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
const A = `av-a-${RUN}@test.invalid`
const B = `av-b-${RUN}@test.invalid`
const BOSS = `av-boss-${RUN}@test.invalid`
const C = `av-c-${RUN}@test.invalid`
const D = `av-d-${RUN}@test.invalid`
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
    await c.query(`INSERT INTO user_memories (user_email, content) VALUES ($1, $2)`, [owner, `fato ${++seq}`])
    await c.query(`INSERT INTO user_mcp_connections (user_email, connection_name) VALUES ($1, $2)`, [owner, `c${seq}`])
    return s as string
  })
}


interface Who2 extends Who { groups?: string[] }
// as asApp, plus the caller's groups (app.user_groups, the JSON array withTx sets)
async function asGroups<T>(d: Deployment, who: Who2, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return asApp(d, who, async (c) => {
    await c.query(`SELECT set_config('app.user_groups', $1, true)`, [JSON.stringify(who.groups ?? [])])
    return fn(c)
  })
}

const VSHAPE = `INSERT INTO agent_versions (agent_id, version, owner_email, name, definition, created_by) VALUES ($1, $2, $3, 'n', $4::jsonb, $3) RETURNING id`

// An agent and its version 1 inserted by the superuser (the way a seed would), plus an optional state for the version.
async function seedVersion(d: Deployment, owner: string, state: 'draft' | 'pending' | 'approved' = 'draft'): Promise<{ agent: string; version: number }> {
  const agent = await seedAgent(d, owner, 'draft', 'v-seed')
  await as(d.db, SUPERUSER, async (c) => {
    await c.query(`SELECT set_config('app.is_admin', 'on', false)`)
    await c.query(
      `INSERT INTO agent_versions (agent_id, version, owner_email, name, definition, created_by, status, approved_by_hash, approved_at)
       VALUES ($1, 1, $2, 'v-seed', $3::jsonb, $2, $4, $5, $6)`,
      [agent, owner, JSON.stringify(DEF), state, state === 'approved' ? 'h2:admin' : null, state === 'approved' ? new Date().toISOString() : null]
    )
  })
  return { agent, version: 1 }
}

// A share inserted the way a seed would (admin flag, no user), approved unless said otherwise: a request is `pending`.
const share = (d: Deployment, agent: string, owner: string, kind: string, principal: string, version = 1, status: 'pending' | 'approved' = 'approved') =>
  as(d.db, SUPERUSER, async (c) => {
    await c.query(`SELECT set_config('app.is_admin', 'on', false)`)
    return c.query(
      `INSERT INTO agent_shares (agent_id, version, owner_email, kind, principal, created_by, status, approved_by_hash, approved_at) VALUES ($1, $2, $3, $4, $5, $3, $6, $7, $8)`,
      [agent, version, owner, kind, principal, status, status === 'approved' ? 'h2:admin' : null, status === 'approved' ? new Date().toISOString() : null]
    )
  })

// ---- V5: static guards ------------------------------------------------------------

test('V5 the RLS lists name the new tables and 0017 forces RLS on both', () => {
  const up = fs.readFileSync(path.join(MIGRATIONS, '0017_agent_versions.up.sql'), 'utf8')
  for (const t of RLS_0017_TABLES) {
    assert.ok(up.includes(`ai_prism.${t}`), `0017 up creates ${t}`)
    assert.ok(new RegExp(`${t} FORCE ROW LEVEL SECURITY`).test(up), `0017 up forces RLS on ${t}`)
    assert.ok(RLS_TABLES.includes(t), `RLS_TABLES lists ${t}`)
  }
  // every identity read goes through NULLIF (an empty identity matches no row)
  assert.ok(!/current_setting\('app\.user_email', true\)\s*(=|<>|!=)/.test(up.replace(/NULLIF\(current_setting\('app\.user_email', true\), ''\)/g, 'X')), 'no bare user_email comparison')
  assert.ok(!up.includes('app.scheduler'), 'the scheduler identity is not named: it matches no policy of 0017')
})

// ---- V1: the migration --------------------------------------------------------------

test('V1 0017 round trip on a fresh database: up, down, up', { skip: SKIP }, async () => {
  const d = await deployment()
  assert.ok(d.up.applied.includes(17))
  const shape = async () =>
    as(d.db, SUPERUSER, async (c) => ({
      tables: (await c.query(`SELECT relname FROM pg_class WHERE relnamespace = 'ai_prism'::regnamespace AND relkind = 'r' AND relname IN ('agent_versions','agent_shares') ORDER BY 1`)).rows.map((r) => r.relname),
      policies: (await c.query(`SELECT polrelid::regclass::text AS t, polname FROM pg_policy WHERE polname LIKE 'aiav\_%' OR polname LIKE 'aias\_%' ORDER BY 1, 2`)).rows,
      triggers: (await c.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = to_regclass('ai_prism.agent_versions')`)).rows.map((r) => r.tgname),
      fns: (await c.query(`SELECT proname FROM pg_proc WHERE pronamespace = 'ai_prism'::regnamespace AND proname LIKE 'aip_agent_versions%'`)).rows.map((r) => r.proname),
    }))
  const first = await shape()
  assert.deepEqual(first.tables, ['agent_shares', 'agent_versions'])
  assert.deepEqual(first.policies.map((p) => p.polname), ['aias_admin_decide', 'aias_admin_read', 'aias_owner', 'aias_recipient_read', 'aiav_admin_decide', 'aiav_admin_read', 'aiav_owner_insert', 'aiav_owner_select', 'aiav_owner_update', 'aiav_shared_read'])
  assert.deepEqual(first.triggers, ['aip_agent_versions_guard'])
  const reopen = () => as(d.db, d.dep, (c) => prepareOwnerHandoff(c, { role: d.sp, owner: d.owner }))
  const regrant = () => as(d.db, d.dep, (c) => applyAppGrants(c, { role: d.sp, owner: d.owner } as any))
  await reopen()
  const down = await as(d.db, d.sp, (c) => migrateDown(c, { to: 16, log: quiet, ownerRole: d.owner }))
  assert.deepEqual(down.reverted, [17])
  assert.deepEqual(await shape(), { tables: [], policies: [], triggers: [], fns: [] })
  // 0015's tables and policies are untouched by the down
  assert.equal((await as(d.db, SUPERUSER, (c) => c.query(`SELECT count(*)::int n FROM pg_policy WHERE polname LIKE 'aiag\_%'`))).rows[0].n, 5)
  await as(d.db, d.sp, (c) => migrateUp(c, { log: quiet, ownerRole: d.owner }))
  await regrant()
  assert.deepEqual(await shape(), first)
  // idempotent: the up body can be replayed as the owner role
  const sql = fs.readFileSync(path.join(MIGRATIONS, '0017_agent_versions.up.sql'), 'utf8')
  await as(d.db, SUPERUSER, async (c) => {
    await c.query(`SET ROLE ${d.owner}`)
    await c.query(sql)
  })
  assert.deepEqual(await shape(), first)
})

test('V1 0016 -> 0017 on a seeded database keeps every agent; the history starts empty and the SP can use the new tables', { skip: SKIP }, async () => {
  const d = await deployment({ to: 16 })
  assert.equal(Math.max(...d.up.applied), 16)
  const agent = await seedAgent(d, A, 'approved', 'before-0017')
  await as(d.db, d.dep, (c) => prepareOwnerHandoff(c, { role: d.sp, owner: d.owner }))
  const up = await as(d.db, d.sp, (c) => migrateUp(c, { log: quiet, ownerRole: d.owner }))
  assert.equal(up.applied[0], 17)
  await as(d.db, d.dep, (c) => applyAppGrants(c, { role: d.sp, owner: d.owner } as any))
  const kept = await as(d.db, SUPERUSER, async (c) => ({
    a: (await c.query(`SELECT status FROM agents WHERE id = $1`, [agent])).rows,
    v: (await c.query(`SELECT 1 FROM agent_versions`)).rowCount,
  }))
  assert.deepEqual(kept, { a: [{ status: 'approved' }], v: 0 })
  // the owner (through the SP, default privileges) writes the first row of a legacy agent
  await asApp(d, { email: A }, async (c) => {
    await c.query(VSHAPE, [agent, 1, A, JSON.stringify(DEF)])
  })
})

// ---- V2: row-level security -----------------------------------------------------------

test('V2 A cannot see or change B\'s versions or shares; no identity matches nothing; the scheduler reads none', { skip: SKIP }, async () => {
  const d = await shared()
  const a = await seedVersion(d, A)
  const b = await seedVersion(d, B)
  await share(d, b.agent, B, 'user', A) // B shares the (unapproved) version with A: still nothing for A
  await asApp(d, { email: A }, async (c) => {
    const seen = (await c.query(`SELECT agent_id::text FROM agent_versions`)).rows.map((r) => r.agent_id)
    assert.ok(seen.includes(a.agent))
    assert.ok(!seen.includes(b.agent), 'B\'s version is invisible to A')
    assert.equal((await c.query(`UPDATE agent_versions SET status = 'pending' WHERE agent_id = $1`, [b.agent])).rowCount, 0)
    assert.equal((await c.query(`DELETE FROM agent_versions WHERE agent_id = $1`, [b.agent])).rowCount, 0)
    assert.equal((await c.query(`DELETE FROM agent_versions WHERE agent_id = $1`, [a.agent])).rowCount, 0, 'nobody deletes a version: there is no policy for it')
    // the share row addressed to A is hers to read, but it names an unapproved version, so the version stays hidden
    assert.equal((await c.query(`SELECT 1 FROM agent_shares WHERE agent_id = $1`, [b.agent])).rowCount, 1)
  })
  assert.match((await refused(d, { email: A }, (c) => c.query(VSHAPE, [b.agent, 5, B, JSON.stringify(DEF)]))) ?? '', /row-level security/, 'A cannot write a version of B\'s agent')
  assert.match((await refused(d, { email: A }, (c) => c.query(VSHAPE, [b.agent, 5, A, JSON.stringify(DEF)]))) ?? '', /row-level security/, 'nor under her own name')
  assert.match((await refused(d, { email: A }, (c) => c.query(`INSERT INTO agent_shares (agent_id, version, owner_email, kind, principal, created_by) VALUES ($1, 1, $2, 'app', '*', $2)`, [b.agent, A]))) ?? '', /row-level security/, 'A cannot share B\'s agent')
  assert.match((await refused(d, { email: A }, (c) => c.query(`INSERT INTO agent_shares (agent_id, version, owner_email, kind, principal, created_by) VALUES ($1, 1, $2, 'app', '*', $2)`, [b.agent, B]))) ?? '', /row-level security/, 'nor as B')
  await asApp(d, {}, async (c) => {
    assert.equal((await c.query(`SELECT 1 FROM agent_versions`)).rowCount, 0)
    assert.equal((await c.query(`SELECT 1 FROM agent_shares`)).rowCount, 0)
  })
  await asApp(d, { scheduler: true }, async (c) => {
    assert.equal((await c.query(`SELECT 1 FROM agent_versions`)).rowCount, 0, 'the scheduler identity reads no version')
    assert.equal((await c.query(`SELECT 1 FROM agent_shares`)).rowCount, 0)
  })
  // an admin reads every version and share, and changes no content
  await asApp(d, { email: BOSS, admin: true }, async (c) => {
    const ids = (await c.query(`SELECT agent_id::text FROM agent_versions`)).rows.map((r) => r.agent_id)
    assert.ok(ids.includes(a.agent) && ids.includes(b.agent))
    assert.ok((await c.query(`SELECT 1 FROM agent_shares WHERE agent_id = $1`, [b.agent])).rowCount === 1)
  })
  assert.match((await refused(d, { email: BOSS, admin: true }, (c) => c.query(`UPDATE agent_versions SET definition = '{}'::jsonb WHERE agent_id = $1`, [a.agent]))) ?? '', /a saved version cannot change/)
  // the admin flag without an identity reads nothing (the seed identity is a superuser's business, not the app role's)
  await asApp(d, { admin: true }, async (c) => {
    assert.equal((await c.query(`SELECT 1 FROM agent_versions`)).rowCount, 0)
  })
})

// ---- V3: the trigger ---------------------------------------------------------------------

test('V3 a version is immutable, numbered upward, starts as a draft, and only an admin decides', { skip: SKIP }, async () => {
  const d = await shared()
  const a = await seedVersion(d, A)
  // immutable, for the owner, an admin, and the seed identity
  for (const who of [{ email: A }, { email: BOSS, admin: true }]) {
    for (const col of ['name', 'description', 'definition', 'origin', 'created_by', 'owner_email', 'version', 'created_at']) {
      const set = col === 'definition' || col === 'origin' ? `${col} = '{"z":1}'::jsonb` : col === 'version' ? `${col} = 7` : col === 'created_at' ? `${col} = now() + interval '1 day'` : `${col} = 'zz'`
      const msg = (await refused(d, who, (c) => c.query(`UPDATE agent_versions SET ${set} WHERE agent_id = $1`, [a.agent]))) ?? ''
      assert.match(msg, /a saved version cannot change|row-level security|violates/, `${col} (${JSON.stringify(who)})`)
    }
  }
  await as(d.db, SUPERUSER, async (c) => {
    await c.query('BEGIN')
    await c.query(`SELECT set_config('app.is_admin', 'on', true)`)
    await assert.rejects(c.query(`UPDATE agent_versions SET name = 'seed' WHERE agent_id = $1`, [a.agent]), /a saved version cannot change/)
    await c.query('ROLLBACK')
  })
  // a new version: increasing numbers, a draft
  await asApp(d, { email: A }, async (c) => {
    await c.query(VSHAPE, [a.agent, 2, A, JSON.stringify(DEF)])
  })
  assert.match((await refused(d, { email: A }, (c) => c.query(VSHAPE, [a.agent, 2, A, JSON.stringify(DEF)]))) ?? '', /increasing order/)
  const low = await refused(d, { email: A }, (c) => c.query(`INSERT INTO agent_versions (agent_id, version, owner_email, name, definition, created_by) VALUES ($1, 1, $2, 'back', '{}'::jsonb, $2)`, [a.agent, A]))
  assert.match(low ?? '', /increasing order/)
  await asApp(d, { email: A }, async (c) => assert.equal((await c.query(`DELETE FROM agent_versions WHERE agent_id = $1 AND version = 1`, [a.agent])).rowCount, 0, 'no delete policy: a no-op, not an error'))
  assert.match((await refused(d, { email: A }, (c) => c.query(`INSERT INTO agent_versions (agent_id, version, owner_email, name, definition, created_by, status) VALUES ($1, 3, $2, 'n', '{}'::jsonb, $2, 'approved')`, [a.agent, A]))) ?? '', /starts as a draft|approved_complete|violates/)
  assert.match((await refused(d, { email: A }, (c) => c.query(`INSERT INTO agent_versions (agent_id, version, owner_email, name, definition, created_by, status) VALUES ($1, 3, $2, 'n', '{}'::jsonb, $2, 'pending')`, [a.agent, A]))) ?? '', /starts as a draft/)
  // approval columns: the owner submits, cannot approve; an admin decides, the owner cannot undo it
  assert.equal(await refused(d, { email: A }, (c) => c.query(`UPDATE agent_versions SET status = 'pending' WHERE agent_id = $1 AND version = 1`, [a.agent])), null)
  assert.match((await refused(d, { email: A }, (c) => c.query(`UPDATE agent_versions SET status = 'approved', approved_by_hash = 'x', approved_at = now() WHERE agent_id = $1 AND version = 1`, [a.agent]))) ?? '', /admin-only/)
  assert.match((await refused(d, { email: A }, (c) => c.query(`UPDATE agent_versions SET status = 'draft' WHERE agent_id = $1 AND version = 1`, [a.agent]))) ?? '', /admin-only/)
  await asApp(d, { email: B }, async (c) => assert.equal((await c.query(`UPDATE agent_versions SET status = 'approved', approved_by_hash = 'x', approved_at = now() WHERE agent_id = $1 AND version = 1`, [a.agent])).rowCount, 0, 'B: no row to update'))
  assert.equal(await refused(d, { email: BOSS, admin: true }, (c) => c.query(`UPDATE agent_versions SET status = 'approved', approved_by_hash = 'h2:boss', approved_at = now() WHERE agent_id = $1 AND version = 1`, [a.agent])), null)
  assert.match((await refused(d, { email: A }, (c) => c.query(`UPDATE agent_versions SET status = 'pending' WHERE agent_id = $1 AND version = 1`, [a.agent]))) ?? '', /admin-only/, 'an approved version is not re-submitted')
  assert.match((await refused(d, { email: BOSS, admin: true }, (c) => c.query(`UPDATE agent_versions SET status = 'approved', approved_by_hash = 'h2:boss', approved_at = now() WHERE agent_id = $1 AND version = 2`, [a.agent]))) ?? '', /admin-only/, 'a draft is not approved without being submitted')
  assert.equal(await refused(d, { email: BOSS, admin: true }, (c) => c.query(`UPDATE agent_versions SET status = 'revoked', approved_by_hash = NULL, approved_at = NULL, decision_reason = 'x' WHERE agent_id = $1 AND version = 1`, [a.agent])), null)
})

// ---- V4: recipients ---------------------------------------------------------------------

test('V4 an approved version is readable by the audience a share names, and only then', { skip: SKIP }, async () => {
  const d = await shared()
  const a = await seedVersion(d, A, 'approved')
  const pending = await seedVersion(d, A, 'pending')
  await share(d, a.agent, A, 'user', B)
  await share(d, a.agent, A, 'group', 'finance-team')
  await share(d, a.agent, A, 'user', D, 1, 'pending') // a REQUEST for D: the version is approved, the audience is not
  await share(d, pending.agent, A, 'app', '*')
  const sees = async (who: Who2) => asGroups(d, who, async (c) => (await c.query(`SELECT agent_id::text FROM agent_versions`)).rows.map((r) => r.agent_id as string))
  // by user (the e-mail is compared lowercased)
  assert.ok((await sees({ email: B })).includes(a.agent))
  assert.ok((await sees({ email: B.toUpperCase() })).includes(a.agent), 'an upper-case identity still matches the lowercased principal')
  assert.ok(!(await sees({ email: C })).includes(a.agent))
  // an audience nobody approved reads nothing, and its row is not even visible to the person it names
  assert.ok(!(await sees({ email: D })).includes(a.agent), 'a pending audience is not live')
  await asApp(d, { email: D }, async (c) => assert.equal((await c.query(`SELECT 1 FROM agent_shares WHERE agent_id = $1`, [a.agent])).rowCount, 0))
  // by group, from app.user_groups only
  assert.ok((await sees({ email: C, groups: ['finance-team'] })).includes(a.agent))
  assert.ok(!(await sees({ email: C, groups: ['other'] })).includes(a.agent))
  assert.ok(!(await sees({ email: C, groups: [] })).includes(a.agent))
  assert.ok(!(await sees({ email: '', groups: ['finance-team'] })).includes(a.agent), 'a group without a user matches nobody')
  // a whole-app share of a version that is only pending reveals nothing
  assert.ok(!(await sees({ email: C })).includes(pending.agent))
  assert.ok(!(await sees({})).includes(pending.agent))
  // what a recipient can do with it: read. Not write, not delete, not see the owner's other versions.
  await asApp(d, { email: B }, async (c) => {
    assert.equal((await c.query(`UPDATE agent_versions SET status = 'revoked' WHERE agent_id = $1`, [a.agent])).rowCount, 0)
    assert.equal((await c.query(`DELETE FROM agent_shares WHERE agent_id = $1`, [a.agent])).rowCount, 0)
    assert.equal((await c.query(`UPDATE agent_shares SET principal = 'x' WHERE agent_id = $1`, [a.agent])).rowCount, 0)
    // the share rows she can read are the ones addressed to her
    const rows = (await c.query(`SELECT kind, principal FROM agent_shares WHERE agent_id = $1`, [a.agent])).rows
    assert.deepEqual(rows, [{ kind: 'user', principal: B }])
  })
  // the agent row itself stays the owner's
  await asApp(d, { email: B }, async (c) => assert.equal((await c.query(`SELECT 1 FROM agents WHERE id = $1`, [a.agent])).rowCount, 0))
  // a share cannot name a version that does not exist (the FK), nor be a malformed principal
  await assert.rejects(share(d, a.agent, A, 'user', B, 99))
  await assert.rejects(share(d, a.agent, A, 'app', 'someone'), /agent_shares_app_star/)
  await assert.rejects(share(d, a.agent, A, 'user', 'UPPER@x.test'), /violates check constraint/)
  // a revoked version stops being read at once, with the share row still there
  await as(d.db, SUPERUSER, async (c) => {
    await c.query(`SELECT set_config('app.is_admin', 'on', false)`)
    await c.query(`UPDATE agent_versions SET status = 'revoked', approved_by_hash = NULL, approved_at = NULL WHERE agent_id = $1`, [a.agent])
  })
  assert.ok(!(await sees({ email: B })).includes(a.agent))
})

// ---- the audience guard (aip_agent_shares_guard) --------------------------------------------------------------------

test('V4b a share is a request: only an admin approves it, only for an approved version; the owner cannot widen or keep a stale approval', { skip: SKIP }, async () => {
  const d = await shared()
  const a = await seedVersion(d, A, 'approved')
  const ins = (who: Who2, kind: string, principal: string, extra = '') =>
    refused(d, who, (c) => c.query(`INSERT INTO agent_shares (agent_id, version, owner_email, kind, principal, created_by${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ($1, 1, $2, $3, $4, $2${extra ? ', ' + extra.split('=')[1] : ''})`, [a.agent, A, kind, principal]))
  // a new share starts pending; the owner cannot insert it already decided
  assert.equal(await ins({ email: A }, 'user', B), null)
  assert.equal((await asApp(d, { email: A }, (c) => c.query(`SELECT status FROM agent_shares WHERE agent_id = $1 AND principal = $2`, [a.agent, B]))).rows[0].status, 'pending')
  assert.match((await ins({ email: A }, 'user', C, "status='approved'")) ?? '', /a request \(pending\)/)
  // the owner cannot approve her own request, nor edit the approval columns
  assert.match((await refused(d, { email: A }, (c) => c.query(`UPDATE agent_shares SET status = 'approved', approved_by_hash = 'x', approved_at = now() WHERE agent_id = $1 AND principal = $2`, [a.agent, B]))) ?? '', /admin-only/)
  assert.match((await refused(d, { email: A }, (c) => c.query(`UPDATE agent_shares SET decision_reason = 'ok' WHERE agent_id = $1 AND principal = $2`, [a.agent, B]))) ?? '', /admin-only/)
  // the audience of a row never changes: a different audience is a different row
  assert.match((await refused(d, { email: A }, (c) => c.query(`UPDATE agent_shares SET kind = 'app', principal = '*' WHERE agent_id = $1 AND principal = $2`, [a.agent, B]))) ?? '', /cannot change its audience/)
  assert.match((await refused(d, { email: BOSS, admin: true }, (c) => c.query(`UPDATE agent_shares SET principal = $3 WHERE agent_id = $1 AND principal = $2`, [a.agent, B, C]))) ?? '', /cannot change its audience/)
  // an admin decides: pending -> approved needs an approved version; the admin does not move the pin
  const approve = `UPDATE agent_shares SET status = 'approved', approved_by_hash = 'h2:boss', approved_at = now() WHERE agent_id = $1 AND principal = $2`
  assert.equal(await refused(d, { email: BOSS, admin: true }, (c) => c.query(approve, [a.agent, B])), null)
  assert.match((await refused(d, { email: BOSS, admin: true }, (c) => c.query(`UPDATE agent_shares SET version = 2 WHERE agent_id = $1 AND principal = $2`, [a.agent, B]))) ?? '', /only the owner moves/)
  assert.match((await refused(d, { email: BOSS, admin: true }, (c) => c.query(`UPDATE agent_shares SET status = 'pending' WHERE agent_id = $1 AND principal = $2`, [a.agent, B]))) ?? '', /does not fit the share/)
  // an approval for a version that is not approved is refused by the database
  const draft = await seedVersion(d, A, 'draft')
  await share(d, draft.agent, A, 'user', B, 1, 'pending')
  assert.match((await refused(d, { email: BOSS, admin: true }, (c) => c.query(approve, [draft.agent, B]))) ?? '', /approved only for an approved version/)
  // the owner moves an APPROVED audience: to an approved version it keeps the approval, to anything else it is pending again
  await as(d.db, SUPERUSER, async (c) => {
    await c.query(`SELECT set_config('app.is_admin', 'on', false)`)
    await c.query(`INSERT INTO agent_versions (agent_id, version, owner_email, name, definition, created_by, status, approved_by_hash, approved_at) VALUES ($1, 2, $2, 'v2', $3::jsonb, $2, 'approved', 'h2:a', now())`, [a.agent, A, JSON.stringify(DEF)])
    await c.query(`INSERT INTO agent_versions (agent_id, version, owner_email, name, definition, created_by) VALUES ($1, 3, $2, 'v3', $3::jsonb, $2)`, [a.agent, A, JSON.stringify(DEF)])
  })
  const status = async () => (await asApp(d, { email: A }, (c) => c.query(`SELECT version, status, approved_by_hash FROM agent_shares WHERE agent_id = $1 AND principal = $2`, [a.agent, B]))).rows[0]
  assert.equal(await refused(d, { email: A }, (c) => c.query(`UPDATE agent_shares SET version = 2 WHERE agent_id = $1 AND principal = $2`, [a.agent, B])), null)
  assert.deepEqual(await status(), { version: 2, status: 'approved', approved_by_hash: 'h2:boss' })
  // the owner cannot smuggle the approval onto another version by setting the columns in the same statement
  assert.equal(await refused(d, { email: A }, (c) => c.query(`UPDATE agent_shares SET version = 3, status = 'approved', approved_by_hash = 'forged', approved_at = now() WHERE agent_id = $1 AND principal = $2`, [a.agent, B])), null)
  assert.deepEqual(await status(), { version: 3, status: 'pending', approved_by_hash: null }, 'a pin on a version nobody approved is a new request, and the forged columns are discarded')
  // rejected / revoked can be asked for again with the same pin; nothing else changes by the owner
  await as(d.db, SUPERUSER, async (c) => {
    await c.query(`SELECT set_config('app.is_admin', 'on', false)`)
    await c.query(`UPDATE agent_shares SET status = 'rejected', decision_reason = 'no' WHERE agent_id = $1 AND principal = $2`, [a.agent, B])
  })
  assert.equal(await refused(d, { email: A }, (c) => c.query(`UPDATE agent_shares SET status = 'pending' WHERE agent_id = $1 AND principal = $2`, [a.agent, B])), null)
  assert.equal((await status()).status, 'pending')
  // an admin who is not the owner changes nothing but the approval columns, and a stranger nothing at all
  assert.equal((await asApp(d, { email: C }, (c) => c.query(`UPDATE agent_shares SET status = 'pending' WHERE agent_id = $1`, [a.agent]))).rowCount, 0)
})
