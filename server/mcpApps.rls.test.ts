// W4-5: migration 0016 (chat_tool_calls.ui_resource) and the read rule of an MCP App View, proven against a real Postgres.
//
//   AC8  0016 round trip (up / down / up) and 0015 -> 0016 on a seeded database; the column CHECK (1.4 MB);
//        RLS: user B cannot read A's tool call (the query the routes run returns no row), a project member can, an
//        empty identity matches nobody; the down keeps every other column and row
//
// Same harness as server/agents.rls.test.ts: a scratch database per deployment, the SP as a plain role bound by RLS.
// No local Postgres with pgvector -> skipped.
//
//   node --test server/mcpApps.rls.test.ts
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
  const name = `w45_${kind}_${stamp}_${++seq}`
  await admin(`CREATE ROLE ${name} LOGIN PASSWORD '${env.PGPASSWORD}' ${extra}`)
  createdRoles.push(name)
  return name
}

async function scratchDb(owner: string) {
  const name = `w45_db_${stamp}_${++seq}`
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
  const owner = `w45_owner_${stamp}_${++seq}`
  createdRoles.push(owner)
  const db = await scratchDb(dep)
  await as(db, dep, (c) => prepareOwnerHandoff(c, { role: sp, owner }))
  let dir: string | undefined
  if (to !== undefined) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w45-mig-'))
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
const A = `mcpapps-a-${RUN}@test.invalid`
const B = `mcpapps-b-${RUN}@test.invalid`
const MEMBER = `mcpapps-m-${RUN}@test.invalid`
const UI = { v: 1, uri: 'ui://x/y.html', serviceName: 'main.apps.chart', toolName: 'show_chart', html: '<p>hi</p>', csp: {}, prefersBorder: true, sha256: 'x', fetchedAt: new Date().toISOString(), structuredContent: null }

async function seedCall(d: Deployment, owner: string, opts: { project?: boolean; ui?: unknown } = {}) {
  return as(d.db, SUPERUSER, async (c) => {
    await c.query(`SELECT set_config('app.is_admin', 'on', false)`)
    let projectId: string | null = null
    if (opts.project) {
      projectId = (await c.query(`INSERT INTO projects (name, created_by) VALUES ('p', $1) RETURNING id`, [owner])).rows[0].id
      await c.query(`INSERT INTO project_members (project_id, kind, principal, role) VALUES ($1, 'user', $2, 'owner'), ($1, 'user', $3, 'view') ON CONFLICT DO NOTHING`, [projectId, owner, MEMBER])
    }
    const s = (await c.query(`INSERT INTO chat_sessions (user_email, title, model, project_id) VALUES ($1, 't', 'm', $2) RETURNING id`, [owner, projectId])).rows[0].id
    const m = (await c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'assistant', 'a') RETURNING id`, [s])).rows[0].id
    const tc = (await c.query(`INSERT INTO chat_tool_calls (message_id, seq, call_id, tool_name, arguments, status, ui_resource) VALUES ($1, 0, 'c1', 'mcp_x__show_chart', '{}'::jsonb, 'ok', $2::jsonb) RETURNING id`, [m, opts.ui === undefined ? JSON.stringify(UI) : opts.ui === null ? null : JSON.stringify(opts.ui)])).rows[0].id
    return String(tc)
  })
}

const colExists = (c: pg.Client) => c.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'ai_prism' AND table_name = 'chat_tool_calls' AND column_name = 'ui_resource'`).then((r) => r.rowCount === 1)
const checkExists = (c: pg.Client) => c.query(`SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_prism.chat_tool_calls'::regclass AND conname = 'chat_tool_calls_ui_resource_size'`).then((r) => r.rowCount === 1)

test('AC8 0016 round trip on a fresh database: up, down, up (the other tool-call columns survive the down)', { skip: SKIP }, async () => {
  const d = await deployment()
  assert.ok(d.up.applied.includes(16))
  await as(d.db, SUPERUSER, async (c) => {
    assert.equal(await colExists(c), true)
    assert.equal(await checkExists(c), true)
  })
  const id = await seedCall(d, A)
  const reopen = () => as(d.db, d.dep, (c) => prepareOwnerHandoff(c, { role: d.sp, owner: d.owner }))
  const regrant = () => as(d.db, d.dep, (c) => applyAppGrants(c, { role: d.sp, owner: d.owner } as any))
  await reopen()
  const down = await as(d.db, d.sp, (c) => migrateDown(c, { to: 15, log: quiet, ownerRole: d.owner }))
  // later migrations (0017 and on) sit above 0016: they come off first, 0016 is the last one reverted to reach 15
  assert.equal(down.reverted.at(-1), 16)
  assert.ok(down.reverted.every((v) => v >= 16))
  await as(d.db, SUPERUSER, async (c) => {
    assert.equal(await colExists(c), false)
    assert.equal(await checkExists(c), false)
    const kept = await c.query(`SELECT tool_name, status FROM chat_tool_calls WHERE id = $1`, [id])
    assert.deepEqual(kept.rows, [{ tool_name: 'mcp_x__show_chart', status: 'ok' }], 'the row and its other columns survive')
  })
  await as(d.db, d.sp, (c) => migrateUp(c, { log: quiet, ownerRole: d.owner }))
  await regrant()
  await as(d.db, SUPERUSER, async (c) => {
    assert.equal(await colExists(c), true)
    assert.equal(await checkExists(c), true)
  })
  // idempotent: the up body can be replayed as the owner role
  const sql = fs.readFileSync(path.join(MIGRATIONS, '0016_tool_call_ui_resource.up.sql'), 'utf8')
  await as(d.db, SUPERUSER, async (c) => {
    await c.query(`SET ROLE ${d.owner}`)
    await c.query(sql)
    assert.equal(await colExists(c), true)
  })
})

test('AC8 0015 -> 0016 on a seeded database keeps every row; old rows read ui_resource as null', { skip: SKIP }, async () => {
  const d = await deployment({ to: 15 })
  assert.equal(Math.max(...d.up.applied), 15)
  const sessionId = await as(d.db, SUPERUSER, async (c) => {
    const s = (await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 't', 'm') RETURNING id`, [A])).rows[0].id
    const m = (await c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'assistant', 'a') RETURNING id`, [s])).rows[0].id
    await c.query(`INSERT INTO chat_tool_calls (message_id, seq, tool_name, arguments, status) VALUES ($1, 0, 'plain', '{}'::jsonb, 'ok')`, [m])
    return s
  })
  await as(d.db, d.dep, (c) => prepareOwnerHandoff(c, { role: d.sp, owner: d.owner }))
  const up = await as(d.db, d.sp, (c) => migrateUp(c, { log: quiet, ownerRole: d.owner }))
  assert.equal(up.applied[0], 16, '0016 is the first one applied on top of 0015')
  await as(d.db, d.dep, (c) => applyAppGrants(c, { role: d.sp, owner: d.owner } as any))
  await as(d.db, SUPERUSER, async (c) => {
    const r = await c.query(`SELECT tc.ui_resource FROM chat_tool_calls tc JOIN chat_messages m ON m.id = tc.message_id WHERE m.session_id = $1`, [sessionId])
    assert.deepEqual(r.rows, [{ ui_resource: null }])
  })
})

test('AC8 the column CHECK: a resource over 1,400,000 bytes is refused, one under it is stored', { skip: SKIP }, async () => {
  const d = await shared()
  const id = await seedCall(d, A, { ui: null })
  const set = (ui: unknown) => refused(d, { email: A }, (c) => c.query(`UPDATE chat_tool_calls SET ui_resource = $2::jsonb WHERE id = $1`, [id, JSON.stringify(ui)]))
  assert.equal(await set({ ...UI, html: 'x'.repeat(1_000_000) }), null)
  assert.match((await set({ ...UI, html: 'x'.repeat(1_500_000) })) ?? '', /chat_tool_calls_ui_resource_size|check constraint/)
})

test('AC8 RLS: the read the routes run returns the owner and a project member the row, B and an empty identity none', { skip: SKIP }, async () => {
  const { GET_UI_TOOL_CALL_SQL } = await import('./db/mcpApps.ts')
  const d = await shared()
  const personal = await seedCall(d, A)
  const inProject = await seedCall(d, A, { project: true })
  const noUi = await seedCall(d, A, { ui: null })
  const read = (who: Who, id: string) => asApp(d, who, async (c) => (await c.query(GET_UI_TOOL_CALL_SQL, [id, who.email ?? ''])).rows)
  assert.equal((await read({ email: A }, personal)).length, 1)
  assert.equal((await read({ email: B }, personal)).length, 0, 'B cannot read A\'s view')
  assert.equal((await read({ email: MEMBER }, personal)).length, 0, 'membership of another chat grants nothing')
  assert.equal((await read({}, personal)).length, 0, 'an empty identity matches nobody')
  assert.equal((await read({ email: MEMBER }, inProject)).length, 1, 'a project member reads a project chat\'s view')
  assert.equal((await read({ email: B }, inProject)).length, 0)
  assert.equal((await read({ email: A }, noUi)).length, 0, 'a call without a UI resource is not a view')
  // raw table access under RLS agrees (the SQL above is not the only guard)
  await asApp(d, { email: B }, async (c) => {
    assert.equal((await c.query(`SELECT 1 FROM chat_tool_calls WHERE id = $1`, [personal])).rowCount, 0)
    assert.equal((await c.query(`UPDATE chat_tool_calls SET ui_resource = NULL WHERE id = $1`, [personal])).rowCount, 0)
  })
})
