// N2: the admin web-search cost tile, proven against a real Postgres.
//
// What is proven:
//   - migration 0010 adds ONE permissive SELECT policy on usage_ledger keyed on
//     the admin flag (aipa_admin_read) and the (kind, created_at) index; the up
//     body is idempotent; down removes both and leaves the policy set of
//     usage_ledger exactly as it was before (byte for byte: name, command,
//     permissive, roles, expressions); re-running 0003 leaves it alone;
//   - semantics under RLS, as the non-owner app role: with the admin flag a
//     transaction reads every user's ledger rows, without it only its own, with
//     no identity none; the flag widens NOTHING else (sessions stay private);
//   - toolUsageAggregate: totals, per UTC day (inclusive edges), per provider,
//     top users; priced vs unpriced; other kinds out; an empty ledger is zeros;
//     the (kind, created_at) index serves it;
//   - the routes on the real app: an admin sees every user's aggregates with no
//     e-mail anywhere, a non-admin gets 403, the price editor writes the
//     override, audits it ('tool_price.set') and the next ledger row is priced.
//
// Scratch databases on the local test server, db.js connected as the app role
// (scripts/ci/pg-roles.sql). No Postgres with pgvector → skipped.
//
//   node --test server/adminUsage.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const MIGRATIONS = path.join(HERE, 'migrations')

const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGDATABASE ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
env.LOCAL_DEV_MODE = '1'
env.LOCAL_PGVECTOR = '1'
env.APPKIT_BOOT = '1'
env.RATE_LIMIT_API_PER_MIN = '0'
env.RATE_LIMIT_TURNS_PER_MIN = '0'
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET
delete env.DATABRICKS_APP_NAME
delete env.DATABRICKS_APP_PORT
delete env.DATABRICKS_APP_URL
delete env.WEB_SEARCH_PRICE_PER_1K_USD

const SUPERUSER = env.PGUSER
const ADMIN_DB = env.PGDATABASE
const APP_ROLE = env.ISOLATION_APP_ROLE || 'ai_prism_app'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const who = (n) => `n2-${n}-${stamp}@test.invalid`
const OWNER = who('owner') // an app admin (APP_OWNER_EMAIL)
const A = who('a')
const B = who('b')
const C = who('c')
env.APP_OWNER_EMAIL = OWNER

function opts(database, user = SUPERUSER) {
  return { host: env.PGHOST, port: Number(env.PGPORT), user, password: env.PGPASSWORD, database, ssl: false, connectionTimeoutMillis: 2000 }
}

async function skipReason() {
  if (!LOCAL_HOSTS.has(env.PGHOST) && env.ISOLATION_TEST_ANY_HOST !== '1') {
    return `PGHOST=${env.PGHOST} is not local (set ISOLATION_TEST_ANY_HOST=1 to use another test server)`
  }
  const c = new pg.Client(opts(ADMIN_DB))
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    return ext.rows.length ? null : 'pgvector is not installed on this Postgres'
  } catch (e) {
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${e.code || e.message}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}
const SKIP = (await skipReason()) || false
const quiet = { log() {}, warn() {}, info() {}, error() {} }

const createdDbs = []
const tmpDirs = []
async function superuser(sql, params = [], database = ADMIN_DB) {
  const c = new pg.Client(opts(database))
  await c.connect()
  try {
    return await c.query(sql, params)
  } finally {
    await c.end().catch(() => {})
  }
}

async function scratch({ to } = {}) {
  const name = `n2_db_${stamp}_${createdDbs.length + 1}`
  await superuser(`CREATE DATABASE ${name}`)
  createdDbs.push(name)
  const c = new pg.Client(opts(name))
  await c.connect()
  try {
    const hasRole = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])
    if (!hasRole.rows.length && APP_ROLE === 'ai_prism_app') {
      await c.query(fs.readFileSync(path.join(REPO, 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
    }
    const { migrateUp } = await import('./db/migrate.js')
    const { applyAppGrants } = await import('./db/grants.js')
    let dir
    if (to) {
      // the migrations up to `to` only: a copy of the directory without the later ones
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2-mig-'))
      for (const f of fs.readdirSync(MIGRATIONS)) if (Number.parseInt(f, 10) <= to) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f))
      tmpDirs.push(dir)
    }
    await migrateUp(c, { log: quiet, ...(dir ? { dir } : {}) })
    await applyAppGrants(c, { role: APP_ROLE, log: quiet })
  } finally {
    await c.end().catch(() => {})
  }
  return name
}

let DB
let raw
let app // the app role on the scratch database (raw SQL, identity set by hand)
let adminUsage // server/db/adminUsage.js, bound to the scratch database as the app role
let server
let base
let gw

if (!SKIP) {
  DB = await scratch()
  raw = new pg.Client(opts(DB))
  await raw.connect()
  await raw.query(`SET search_path TO ai_prism, public`)
  app = new pg.Client(opts(DB, APP_ROLE))
  await app.connect()
  await app.query(`SET search_path TO ai_prism, public`)
  env.PGDATABASE = DB
  env.PGUSER = APP_ROLE
  const { startFakeGateway } = await import('../scripts/fake-gateway.mjs')
  gw = await startFakeGateway({ port: 0 })
  env.DATABRICKS_HOST = gw.url
}
adminUsage = await import('./db/adminUsage.js')
const { app: expressApp } = await import('./index.js')
if (!SKIP) {
  await new Promise((resolve) => {
    server = expressApp.listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
}

after(async () => {
  if (server) {
    await new Promise((r) => {
      server.close(r)
      server.closeAllConnections()
    })
  }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  await gw?.close()
  await app?.end().catch(() => {})
  await raw?.end().catch(() => {})
  if (SKIP) return
  for (const name of createdDbs) {
    await superuser(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]).catch(() => {})
    await superuser(`DROP DATABASE IF EXISTS ${name}`).catch(() => {})
  }
})

const q = async (sql, params = []) => (await raw.query(sql, params)).rows

/** fn(app) inside a transaction carrying this identity (rolled back). */
async function asIdentity(email, fn, { admin = false } = {}) {
  await app.query('BEGIN')
  try {
    await app.query(`SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', $2, true), set_config('app.user_groups', '[]', true)`, [
      email,
      admin ? 'on' : 'off',
    ])
    return await fn(app)
  } finally {
    await app.query('ROLLBACK')
  }
}

const iso = (d) => d.toISOString().slice(0, 10)
const DAY = 86_400_000
const TODAY = iso(new Date())
const daysAgo = (n) => iso(new Date(Date.now() - n * DAY))

async function ledger(email, { kind = 'web_search', model = 'brave', cost = null, at = new Date() } = {}) {
  await q(`INSERT INTO usage_ledger (user_email, kind, model, prompt_tokens, completion_tokens, cost_usd, created_at) VALUES ($1, $2, $3, 0, 0, $4, $5)`, [
    email,
    kind,
    model,
    cost,
    at,
  ])
}
const clearLedger = () => q(`DELETE FROM usage_ledger WHERE user_email LIKE $1`, [`n2-%-${stamp}@test.invalid`])

async function policySnapshot(c) {
  return (
    await c.query(
      `SELECT p.polname, p.polcmd, p.polpermissive, p.polroles::text AS roles,
              pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS chk
         FROM pg_policy p WHERE p.polrelid = 'ai_prism.usage_ledger'::regclass ORDER BY p.polname`
    )
  ).rows
}

// ---- migration 0010 --------------------------------------------------------------

test('0010: aipa_admin_read (SELECT, permissive, admin flag) + the (kind, created_at) index; up is idempotent; down restores the policy set byte for byte', { skip: SKIP }, async () => {
  const name = await scratch({ to: 7 })
  const c = new pg.Client(opts(name))
  await c.connect()
  try {
    await c.query(`SET search_path TO ai_prism, public`)
    const before = await policySnapshot(c)
    assert.ok(!before.some((p) => p.polname === 'aipa_admin_read'))
    const up = fs.readFileSync(path.join(MIGRATIONS, '0010_admin_usage_read.up.sql'), 'utf8')
    const down = fs.readFileSync(path.join(MIGRATIONS, '0010_admin_usage_read.down.sql'), 'utf8')

    await c.query('BEGIN')
    await c.query(up)
    await c.query(up)
    await c.query('COMMIT')
    const after = await policySnapshot(c)
    const added = after.filter((p) => !before.some((b) => b.polname === p.polname))
    assert.equal(added.length, 1, 'exactly one new policy, even after running the body twice')
    assert.equal(added[0].polname, 'aipa_admin_read')
    assert.equal(added[0].polcmd, 'r', 'SELECT only')
    assert.equal(added[0].polpermissive, true)
    assert.match(added[0].qual, /app\.is_admin/)
    assert.deepEqual(
      after.filter((p) => p.polname !== 'aipa_admin_read'),
      before,
      'the existing policies are untouched'
    )
    const idx = await c.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'ai_prism' AND indexname = 'idx_usage_ledger_kind_time'`)
    assert.match(idx.rows[0].indexdef, /\(kind, created_at\)/)

    // 0003's drop loop ('aip\_%') and 0005/0007 loops must not remove it
    const m0003 = fs.readFileSync(path.join(MIGRATIONS, '0003_rls.up.sql'), 'utf8')
    await c.query('BEGIN')
    await c.query(m0003)
    await c.query('COMMIT')
    assert.ok((await policySnapshot(c)).some((p) => p.polname === 'aipa_admin_read'), 're-running 0003 leaves it alone')

    // the down body alone: back to the earlier policy set, twice is harmless
    await c.query('BEGIN')
    await c.query(down)
    await c.query(down)
    await c.query('COMMIT')
    assert.deepEqual(await policySnapshot(c), before, 'down restores the previous policy set exactly')
    assert.equal((await c.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_usage_ledger_kind_time'`)).rows.length, 0)

    // and through the runner: up records 0010, down --to 7 reverts it, up again
    const { migrateDown, migrateUp, loadMigrations } = await import('./db/migrate.js')
    const versions = loadMigrations(MIGRATIONS).map((m) => m.version)
    assert.ok(versions.includes(10))
    const u1 = await migrateUp(c, { log: quiet })
    assert.ok(u1.applied.includes(10))
    assert.deepEqual(await policySnapshot(c), after)
    const d = await migrateDown(c, { to: 7, log: quiet })
    assert.ok(d.reverted.includes(10))
    assert.deepEqual(await policySnapshot(c), before, 'down --to 7 restores the previous policy set exactly')
    const u2 = await migrateUp(c, { log: quiet })
    assert.ok(u2.applied.includes(10))
    assert.deepEqual(await policySnapshot(c), after, 'up again gives the same policy set')
  } finally {
    await c.end().catch(() => {})
  }
})

// ---- semantics under RLS ---------------------------------------------------------

test('RLS: with the admin flag every user\'s ledger rows are readable, without it only your own, with no identity none', { skip: SKIP }, async () => {
  await clearLedger()
  await ledger(A)
  await ledger(B)
  await ledger(B)
  const mine = `SELECT user_email, count(*)::int AS n FROM usage_ledger WHERE user_email LIKE '${'n2-%-' + stamp + '@test.invalid'}' GROUP BY 1 ORDER BY 1`
  const asAdmin = await asIdentity(OWNER, (c) => c.query(mine), { admin: true })
  assert.deepEqual(asAdmin.rows.map((r) => [r.user_email, r.n]), [[A, 1], [B, 2]])
  const plainB = await asIdentity(B, (c) => c.query(mine))
  assert.deepEqual(plainB.rows.map((r) => [r.user_email, r.n]), [[B, 2]], 'the flag off: own rows only (the pre-0010 behaviour)')
  const noOne = await asIdentity('', (c) => c.query(mine), { admin: true })
  assert.deepEqual(noOne.rows, [], 'no identity fails closed, even with the flag')
})

test('RLS: the admin flag does not widen sessions, messages or writes on the ledger', { skip: SKIP }, async () => {
  const s = (await q(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 'privado', 'm') RETURNING id`, [A]))[0].id
  await q(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'segredo')`, [s])
  await asIdentity(OWNER, async (c) => {
    assert.equal((await c.query(`SELECT 1 FROM chat_sessions WHERE id = $1`, [s])).rows.length, 0)
    assert.equal((await c.query(`SELECT 1 FROM chat_messages WHERE session_id = $1`, [s])).rows.length, 0)
    await assert.rejects(() => c.query(`INSERT INTO usage_ledger (user_email, kind) VALUES ($1, 'web_search')`, [A]), /row-level security/)
  }, { admin: true })
  // an admin cannot rewrite or delete somebody's ledger rows through the read policy
  const upd = await asIdentity(
    OWNER,
    async (c) => (await c.query(`UPDATE usage_ledger SET cost_usd = 99 WHERE user_email = $1`, [A])).rowCount,
    { admin: true }
  )
  assert.equal(upd, 0)
  const del = await asIdentity(OWNER, async (c) => (await c.query(`DELETE FROM usage_ledger WHERE user_email = $1`, [A])).rowCount, { admin: true })
  assert.equal(del, 0)
})

// ---- the aggregate ---------------------------------------------------------------

test('toolUsageAggregate: totals, per UTC day (inclusive edges), per provider, top users; priced vs unpriced; other kinds out', { skip: SKIP }, async () => {
  await clearLedger()
  const d1 = daysAgo(2)
  const d2 = daysAgo(1)
  const at = (day, hms) => new Date(`${day}T${hms}Z`)
  await ledger(A, { model: 'brave', cost: 0.005, at: at(d1, '00:00:00') }) // first instant of the first day
  await ledger(A, { model: 'brave', cost: 0.005, at: at(d1, '12:00:00') })
  await ledger(B, { model: 'databricks', cost: null, at: at(d1, '23:59:59') })
  await ledger(B, { model: 'databricks', cost: null, at: at(d2, '10:00:00') })
  await ledger(C, { model: 'brave', cost: 0.005, at: at(d2, '23:59:59') }) // last instant of the last day
  await ledger(C, { model: 'brave', cost: 0.005, at: at(daysAgo(3), '23:59:59') }) // the day before: out
  await ledger(A, { kind: 'chat', model: 'm', cost: 1, at: at(d1, '09:00:00') }) // another kind: out
  const r = await adminUsage.toolUsageAggregate(OWNER, 'tok', { kind: 'web_search', from: d1, to: d2 })
  assert.deepEqual(r.totals, { calls: 5, pricedCalls: 3, unpricedCalls: 2, costUsd: 0.015 })
  assert.deepEqual(r.byDay, [
    { day: d1, calls: 3, unpricedCalls: 1, costUsd: 0.01 },
    { day: d2, calls: 2, unpricedCalls: 1, costUsd: 0.005 },
  ])
  assert.deepEqual(
    r.byProvider.map((p) => [p.provider, p.calls, p.unpricedCalls, p.costUsd]),
    [
      ['brave', 3, 0, 0.015],
      ['databricks', 2, 2, 0],
    ]
  )
  assert.deepEqual(
    r.topUsers.map((u) => [u.userEmail, u.calls]),
    [[A, 2], [B, 2], [C, 1]].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map((x) => [x[0], x[1]])
  )
  assert.equal(Object.keys(r.topUsers[0]).sort().join(), 'calls,costUsd,userEmail')
})

test('toolUsageAggregate: an empty ledger is zeros, not an error; top users are capped at 10', { skip: SKIP }, async () => {
  await clearLedger()
  const empty = await adminUsage.toolUsageAggregate(OWNER, 'tok', { kind: 'web_search', from: daysAgo(5), to: TODAY })
  assert.deepEqual(empty, {
    totals: { calls: 0, pricedCalls: 0, unpricedCalls: 0, costUsd: 0 },
    byDay: [],
    byProvider: [],
    topUsers: [],
  })
  for (let i = 0; i < 12; i++) await ledger(`n2-u${String(i).padStart(2, '0')}-${stamp}@test.invalid`, { cost: 0.001 })
  const r = await adminUsage.toolUsageAggregate(OWNER, 'tok', { kind: 'web_search', from: daysAgo(1), to: TODAY })
  assert.equal(r.totals.calls, 12)
  assert.equal(r.topUsers.length, 10)
})

test('toolUsageAggregate is read-only and uses the (kind, created_at) index', { skip: SKIP }, async () => {
  const plan = await asIdentity(
    OWNER,
    async (c) => {
      await c.query(`SET LOCAL enable_seqscan = off`)
      return (
        await c.query(
          `EXPLAIN SELECT count(*) FROM usage_ledger WHERE kind = 'web_search' AND created_at >= now() - interval '30 days' AND created_at < now()`
        )
      ).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n')
    },
    { admin: true }
  )
  assert.match(plan, /idx_usage_ledger_kind_time/)
})

// ---- the routes, on the real app ---------------------------------------------------

function as(email, init = {}) {
  return { ...init, headers: { ...(init.headers || {}), 'x-forwarded-email': email } }
}
async function call(method, p, email, body) {
  const init = as(email, { method })
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers['content-type'] = 'application/json'
  }
  const res = await fetch(`${base}${p}`, init)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, body: json, text }
}

test('GET /api/admin/usage/tools: an admin sees every user\'s aggregates with no e-mail; a non-admin gets 403', { skip: SKIP }, async () => {
  await clearLedger()
  await ledger(A, { model: 'brave', cost: 0.005 })
  await ledger(B, { model: 'databricks', cost: null })
  await ledger(B, { model: 'databricks', cost: null })
  const url = `/api/admin/usage/tools?kind=web_search&from=${daysAgo(1)}&to=${TODAY}`
  const denied = await call('GET', url, A)
  assert.equal(denied.status, 403)
  assert.ok(!denied.text.includes('brave'))
  const ok = await call('GET', url, OWNER)
  assert.equal(ok.status, 200)
  assert.equal(ok.body.totals.calls, 3)
  assert.equal(ok.body.totals.unpricedCalls, 2)
  assert.equal(ok.body.topUsers.length, 2)
  for (const e of [A, B, C, OWNER]) assert.ok(!ok.text.includes(e), 'no e-mail in the response')
  assert.ok(!/@/.test(ok.text), 'no e-mail-shaped string at all')
  assert.equal((await call('GET', `/api/admin/usage/tools?kind=chat`, OWNER)).status, 400)
})

test('PUT /api/admin/tool-prices/:key: sets the override, audits tool_price.set, prices the next row; null clears it', { skip: SKIP }, async () => {
  await q(`DELETE FROM model_catalog_overrides WHERE endpoint_id LIKE 'tool:%'`)
  await q(`DELETE FROM admin_audit`)
  assert.equal((await call('PUT', '/api/admin/tool-prices/web_search', A, { per1kUsd: 5 })).status, 403)
  assert.equal((await call('PUT', '/api/admin/tool-prices/web_search:evil', OWNER, { per1kUsd: 5 })).status, 400)
  assert.equal((await call('PUT', '/api/admin/tool-prices/web_search', OWNER, { per1kUsd: -1 })).status, 400)
  assert.equal((await q(`SELECT 1 FROM model_catalog_overrides WHERE endpoint_id LIKE 'tool:%'`)).length, 0, 'refused writes leave nothing')
  assert.equal((await q(`SELECT 1 FROM admin_audit`)).length, 0, 'refused writes are not audited')

  const set = await call('PUT', '/api/admin/tool-prices/web_search%3Adatabricks', OWNER, { per1kUsd: 12 })
  assert.equal(set.status, 200)
  const row = (await q(`SELECT price_in FROM model_catalog_overrides WHERE endpoint_id = 'tool:web_search:databricks'`))[0]
  assert.equal(Number(row.price_in), 12)
  const audit = await q(`SELECT action, target, actor_hash FROM admin_audit`)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].action, 'tool_price.set')
  assert.equal(audit[0].target, 'web_search:databricks')
  assert.ok(!audit[0].actor_hash.includes('@'))

  // the price book of this instance is refreshed: the endpoint shows it, and recordToolUsage prices with it
  const { toolPricePer1k } = await import('./usage.js')
  assert.equal(toolPricePer1k('databricks'), 12)
  const view = await call('GET', `/api/admin/usage/tools?kind=web_search`, OWNER)
  assert.equal(view.body.prices['web_search:databricks'], 12)

  const clear = await call('PUT', '/api/admin/tool-prices/web_search%3Adatabricks', OWNER, { per1kUsd: null })
  assert.equal(clear.status, 200)
  assert.equal(toolPricePer1k('databricks'), null, 'cleared: back to the seed (none for databricks)')
  assert.equal((await q(`SELECT count(*)::int AS n FROM admin_audit WHERE action = 'tool_price.set'`))[0].n, 2)
})
