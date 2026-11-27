// Migration 0019 (A2A agents) against a real Postgres, as the deployed service principal bound by RLS:
//
//   - up / down / up round trip; the down removes both tables, the CHECK and the chat_tool_calls.auth column and keeps
//     every other tool-call column and row
//   - a2a_agents: any identity reads; only the admin flag writes; the CHECKs (strategy, provider matches strategy,
//     slug shape, unique slug and card URL)
//   - a2a_oauth_tokens: owner only. Another user, an empty identity and the admin flag see and change nothing of it
//   - chat_tool_calls.auth: an object up to 4096 bytes, nothing else
//
// Same harness as server/mcpApps.rls.test.ts: a scratch database per deployment. No local Postgres with pgvector -> skipped.
//
//   node --test server/a2a.rls.test.ts
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
  const name = `a2a_${kind}_${stamp}_${++seq}`
  await admin(`CREATE ROLE ${name} LOGIN PASSWORD '${env.PGPASSWORD}' ${extra}`)
  createdRoles.push(name)
  return name
}

async function scratchDb(owner: string) {
  const name = `a2a_db_${stamp}_${++seq}`
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
  const owner = `a2a_owner_${stamp}_${++seq}`
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
const A = `a2a-a-${RUN}@test.invalid`
const B = `a2a-b-${RUN}@test.invalid`
const ADMIN = { email: `a2a-admin-${RUN}@test.invalid`, admin: true }

const AGENT = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  display_name: `Agent ${slug}`,
  card_url: `https://${slug}.example.com/.well-known/agent-card.json`,
  auth_strategy: 'databricks-obo',
  auth_provider: null,
  ...extra,
})
const insertAgent = (c: pg.Client, a: ReturnType<typeof AGENT>) =>
  c.query(`INSERT INTO a2a_agents (slug, display_name, card_url, auth_strategy, auth_provider) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [a.slug, a.display_name, a.card_url, a.auth_strategy, a.auth_provider])

const tableExists = (c: pg.Client, name: string) => c.query(`SELECT to_regclass($1) AS t`, [`ai_prism.${name}`]).then((r) => r.rows[0].t !== null)
const colExists = (c: pg.Client) => c.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'ai_prism' AND table_name = 'chat_tool_calls' AND column_name = 'auth'`).then((r) => r.rowCount === 1)
const checkExists = (c: pg.Client) => c.query(`SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_prism.chat_tool_calls'::regclass AND conname = 'chat_tool_calls_auth_shape'`).then((r) => r.rowCount === 1)

test('0019 round trip: up, down, up (the other tool-call columns survive the down)', { skip: SKIP }, async () => {
  const d = await deployment()
  assert.ok(d.up.applied.includes(19))
  await as(d.db, SUPERUSER, async (c) => {
    assert.equal(await tableExists(c, 'a2a_agents'), true)
    assert.equal(await tableExists(c, 'a2a_oauth_tokens'), true)
    assert.equal(await colExists(c), true)
    assert.equal(await checkExists(c), true)
    for (const t of ['a2a_agents', 'a2a_oauth_tokens']) {
      const r = await c.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [`ai_prism.${t}`])
      assert.deepEqual(r.rows[0], { relrowsecurity: true, relforcerowsecurity: true }, `${t} has ENABLE + FORCE RLS`)
    }
    await c.query(`SELECT set_config('app.is_admin', 'on', false)`)
    const s = (await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 't', 'm') RETURNING id`, [A])).rows[0].id
    const m = (await c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'assistant', 'a') RETURNING id`, [s])).rows[0].id
    await c.query(`INSERT INTO chat_tool_calls (message_id, seq, tool_name, arguments, status, auth) VALUES ($1, 0, 'a2a__x', '{}'::jsonb, 'error', '{"kind":"a2a"}'::jsonb)`, [m])
  })
  const reopen = () => as(d.db, d.dep, (c) => prepareOwnerHandoff(c, { role: d.sp, owner: d.owner }))
  await reopen()
  const down = await as(d.db, d.sp, (c) => migrateDown(c, { to: 18, log: quiet, ownerRole: d.owner }))
  assert.deepEqual(down.reverted, [19])
  await as(d.db, SUPERUSER, async (c) => {
    assert.equal(await tableExists(c, 'a2a_agents'), false)
    assert.equal(await tableExists(c, 'a2a_oauth_tokens'), false)
    assert.equal(await colExists(c), false)
    assert.equal(await checkExists(c), false)
    const kept = await c.query(`SELECT tool_name, status FROM chat_tool_calls`)
    assert.deepEqual(kept.rows, [{ tool_name: 'a2a__x', status: 'error' }], 'the row and its other columns survive')
  })
  await as(d.db, d.sp, (c) => migrateUp(c, { log: quiet, ownerRole: d.owner }))
  await as(d.db, d.dep, (c) => applyAppGrants(c, { role: d.sp, owner: d.owner } as any)) // any: JS option bag
  await as(d.db, SUPERUSER, async (c) => {
    assert.equal(await tableExists(c, 'a2a_agents'), true)
    assert.equal(await colExists(c), true)
  })
  // idempotent: the up body can be replayed as the owner role
  const sql = fs.readFileSync(path.join(MIGRATIONS, '0019_a2a_agents.up.sql'), 'utf8')
  await as(d.db, SUPERUSER, async (c) => {
    await c.query(`SET ROLE ${d.owner}`)
    await c.query(sql)
    assert.equal(await tableExists(c, 'a2a_oauth_tokens'), true)
  })
})

test('a2a_agents: any identity reads, only the admin flag writes', { skip: SKIP }, async () => {
  const d = await shared()
  const slug = `echo_${RUN.replace(/[^a-z0-9]/g, '')}`
  assert.match((await refused(d, { email: A }, (c) => insertAgent(c, AGENT(slug)))) ?? '', /row-level security/, 'a plain user cannot register')
  assert.equal(await refused(d, ADMIN, (c) => insertAgent(c, AGENT(slug))), null, 'the admin can')
  // everyone with an identity reads it, an empty identity reads nothing
  assert.equal((await asApp(d, { email: A }, (c) => c.query(`SELECT slug FROM a2a_agents WHERE slug = $1`, [slug]))).rowCount, 1)
  assert.equal((await asApp(d, { email: B }, (c) => c.query(`SELECT slug FROM a2a_agents WHERE slug = $1`, [slug]))).rowCount, 1)
  assert.equal((await asApp(d, {}, (c) => c.query(`SELECT slug FROM a2a_agents WHERE slug = $1`, [slug]))).rowCount, 0)
  // a plain user's UPDATE / DELETE match no row
  const upd = await asApp(d, { email: A }, (c) => c.query(`UPDATE a2a_agents SET enabled = false WHERE slug = $1`, [slug]))
  assert.equal(upd.rowCount, 0)
  const del = await asApp(d, { email: A }, (c) => c.query(`DELETE FROM a2a_agents WHERE slug = $1`, [slug]))
  assert.equal(del.rowCount, 0)
  assert.equal((await asApp(d, ADMIN, (c) => c.query(`UPDATE a2a_agents SET enabled = false WHERE slug = $1`, [slug]))).rowCount, 1)
  assert.equal((await asApp(d, ADMIN, (c) => c.query(`DELETE FROM a2a_agents WHERE slug = $1`, [slug]))).rowCount, 1)
})

test('a2a_agents: the CHECKs and the unique slug / card URL', { skip: SKIP }, async () => {
  const d = await shared()
  const n = RUN.replace(/[^a-z0-9]/g, '')
  const bad = (a: ReturnType<typeof AGENT>) => refused(d, ADMIN, (c) => insertAgent(c, a))
  assert.match((await bad(AGENT(`chk_a_${n}`, { auth_strategy: 'basic' }))) ?? '', /check constraint/)
  assert.match((await bad(AGENT(`chk_b_${n}`, { auth_strategy: 'oauth2-user', auth_provider: null }))) ?? '', /a2a_agents_provider_matches_strategy/)
  assert.match((await bad(AGENT(`chk_c_${n}`, { auth_strategy: 'none', auth_provider: 'okta' }))) ?? '', /a2a_agents_provider_matches_strategy/)
  assert.match((await bad(AGENT('Bad Slug!'))) ?? '', /check constraint/)
  assert.equal(await bad(AGENT(`chk_d_${n}`, { auth_strategy: 'oauth2-user', auth_provider: 'okta' })), null)
  assert.match((await bad(AGENT(`chk_d_${n}`))) ?? '', /uq_a2a_agents_slug|duplicate key/)
  assert.match((await bad(AGENT(`chk_e_${n}`, { card_url: AGENT(`chk_d_${n}`).card_url }))) ?? '', /uq_a2a_agents_card_url|duplicate key/)
})

test('a2a_oauth_tokens: owner only, no admin read, no cross-user write', { skip: SKIP }, async () => {
  const d = await shared()
  const put = (c: pg.Client, email: string, provider = 'okta') =>
    c.query(`INSERT INTO a2a_oauth_tokens (user_email, provider_id, access_token_enc, refresh_token_enc) VALUES ($1, $2, 'v1.sealed', 'v1.sealed2') ON CONFLICT (user_email, provider_id) DO NOTHING`, [email, provider])
  assert.equal(await refused(d, { email: A }, (c) => put(c, A)), null, 'a user stores their own connection')
  assert.match((await refused(d, { email: B }, (c) => put(c, A))) ?? '', /row-level security/, 'B cannot write a row as A')
  assert.equal(await refused(d, { email: B }, (c) => put(c, B)), null)
  const rows = (who: Who) => asApp(d, who, (c) => c.query(`SELECT user_email FROM a2a_oauth_tokens WHERE user_email = ANY($1)`, [[A, B]]))
  assert.deepEqual((await rows({ email: A })).rows, [{ user_email: A }])
  assert.deepEqual((await rows({ email: B })).rows, [{ user_email: B }])
  assert.equal((await rows({})).rowCount, 0, 'an empty identity matches nobody')
  assert.equal((await rows({ email: ADMIN.email, admin: true })).rowCount, 0, 'the admin flag reads no one\'s tokens')
  const upd = await asApp(d, { email: B }, (c) => c.query(`UPDATE a2a_oauth_tokens SET access_token_enc = 'stolen' WHERE user_email = $1`, [A]))
  assert.equal(upd.rowCount, 0)
  const del = await asApp(d, { email: B }, (c) => c.query(`DELETE FROM a2a_oauth_tokens WHERE user_email = $1`, [A]))
  assert.equal(del.rowCount, 0)
  const kept = await asApp(d, { email: A }, (c) => c.query(`SELECT access_token_enc FROM a2a_oauth_tokens WHERE user_email = $1`, [A]))
  assert.equal(kept.rows[0].access_token_enc, 'v1.sealed')
  assert.equal((await asApp(d, { email: A }, (c) => c.query(`DELETE FROM a2a_oauth_tokens WHERE user_email = $1`, [A]))).rowCount, 1, 'the owner disconnects')
})

test('chat_tool_calls.auth: an object up to 4096 bytes', { skip: SKIP }, async () => {
  const d = await shared()
  const callId = await as(d.db, SUPERUSER, async (c) => {
    await c.query(`SELECT set_config('app.is_admin', 'on', false)`)
    const s = (await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 't', 'm') RETURNING id`, [A])).rows[0].id
    const m = (await c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'assistant', 'a') RETURNING id`, [s])).rows[0].id
    return (await c.query(`INSERT INTO chat_tool_calls (message_id, seq, tool_name, arguments, status) VALUES ($1, 0, 'a2a__x', '{}'::jsonb, 'error') RETURNING id`, [m])).rows[0].id
  })
  const set = (v: unknown) => refused(d, { email: A }, (c) => c.query(`UPDATE chat_tool_calls SET auth = $2::jsonb WHERE id = $1`, [callId, JSON.stringify(v)]))
  assert.equal(await set({ kind: 'a2a', id: '1', name: 'Echo', reason: 'missing' }), null)
  assert.match((await set(['not', 'an', 'object'])) ?? '', /chat_tool_calls_auth_shape|check constraint/)
  assert.match((await set({ kind: 'a2a', pad: 'x'.repeat(5000) })) ?? '', /chat_tool_calls_auth_shape|check constraint/)
})
