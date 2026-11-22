// W2-5: retention policy, org instructions and the admin audit trail.
//
// What is proven here:
//   - migration 0007 (app_settings, admin_audit, the maintenance policies) is
//     idempotent and round-trips (AC-S2);
//   - the retention sweep deletes ONLY what the policy says: retention off =
//     never; sessions younger than N days (by last activity) survive; a session
//     a live turn holds survives; the cascade takes every content row of a
//     deleted session; the ledger keeps its cost rows (session_id → NULL); the
//     UC-volume files deleted are exactly those of the deleted sessions;
//   - the sweep runs once at a time (pg_try_advisory_xact_lock) and at most once
//     a day; it logs and audits its counts;
//   - the maintenance identity (app.maintenance = 'on') gives nothing to a
//     transaction that carries a user identity, nor to a request (AC-S1);
//   - every admin mutation writes admin_audit in the SAME transaction, with a
//     hashed actor; the audit is append-only; GET /api/admin/audit paginates;
//   - org instructions reach the model through registerTurnContextProvider.
//
// Database tests run in a scratch database of the local test server, with
// db.js connected as the non-owner app role (scripts/ci/pg-roles.sql), like
// server/isolation.test.js. No Postgres with pgvector → they are skipped.
//
//   node --test server/settingsAudit.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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

const SUPERUSER = env.PGUSER
const ADMIN_DB = env.PGDATABASE
const APP_ROLE = env.ISOLATION_APP_ROLE || 'ai_prism_app'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const OWNER = `w25-owner-${stamp}@test.invalid`
const A = `w25-a-${stamp}@test.invalid`
const B = `w25-b-${stamp}@test.invalid`
env.APP_OWNER_EMAIL = OWNER
const MODEL = 'databricks-claude-sonnet-5-5'
const DAY = 24 * 60 * 60 * 1000

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
async function superuser(sql, params = [], database = ADMIN_DB) {
  const c = new pg.Client(opts(database))
  await c.connect()
  try {
    return await c.query(sql, params)
  } finally {
    await c.end().catch(() => {})
  }
}

// A scratch database with every migration and the app role's grants, as the superuser.
async function scratch() {
  const name = `w25_db_${stamp}_${createdDbs.length + 1}`
  await superuser(`CREATE DATABASE ${name}`)
  createdDbs.push(name)
  const c = new pg.Client(opts(name))
  await c.connect()
  try {
    const hasRole = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])
    if (!hasRole.rows.length && APP_ROLE === 'ai_prism_app') {
      await c.query(fs.readFileSync(path.join(REPO, 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
    }
    const { migrateUp } = await import('./db/migrate.ts')
    const { applyAppGrants } = await import('./db/grants.ts')
    await migrateUp(c, { log: quiet })
    await applyAppGrants(c, { role: APP_ROLE, log: quiet })
  } finally {
    await c.end().catch(() => {})
  }
  return name
}

let DB // the scratch database db.js talks to (as the app role)
let raw // superuser client on it (no RLS) for fixtures and checks
let db, adminDb, audit, retention, orgInstructions, turnLockMod
let gw, server, base

if (!SKIP) {
  DB = await scratch()
  raw = new pg.Client(opts(DB))
  await raw.connect()
  await raw.query(`SET search_path TO ai_prism, public`)
  env.PGDATABASE = DB
  env.PGUSER = APP_ROLE
}
// pure modules load without a database
audit = await import('./audit.ts')
adminDb = await import('./db/admin.ts')
retention = await import('./retention.ts')
orgInstructions = await import('./orgInstructions.ts')
turnLockMod = await import('./turnLock.ts')
db = await import('./db.ts')

if (!SKIP) {
  const { startFakeGateway } = await import('../scripts/fake-gateway.mjs')
  gw = await startFakeGateway({ port: 0 })
  env.DATABRICKS_HOST = gw.url
}
const { app } = await import('./index.js')
if (!SKIP) {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
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
  await gw?.close()
  await raw?.end().catch(() => {})
  if (SKIP) return
  // db.js pools hold connections to the scratch database
  for (const name of createdDbs) {
    await superuser(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]).catch(() => {})
    await superuser(`DROP DATABASE IF EXISTS ${name}`).catch(() => {})
  }
})

const q = async (sql, params = []) => (await raw.query(sql, params)).rows

function as(email, init = {}) {
  return { ...init, headers: { ...(init.headers || {}), 'x-forwarded-email': email } }
}
async function call(method, p, email, body, headers = {}) {
  const init = as(email, { method, headers: { ...headers } })
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
  return { status: res.status, body: json }
}

// A session of `email` with a row in every table that hangs off it, last
// active `ageDays` ago (created `createdDays` ago). Written by the superuser.
async function seedSession(email, { ageDays, createdDays = ageDays, image = true, tag = 's' } = {}) {
  const s = (await q(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, $2, 'm') RETURNING id`, [email, tag]))[0].id
  const m = (await q(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'conteúdo') RETURNING id`, [s]))[0].id
  await q(`INSERT INTO chat_tool_calls (message_id, seq, tool_name, status) VALUES ($1, 0, 't', 'ok')`, [m])
  await q(`INSERT INTO chat_genie_conversations (session_id, space_id, conversation_id) VALUES ($1, 'sp', 'c')`, [s])
  await q(`INSERT INTO chat_compactions (session_id, upto_message_id, content) VALUES ($1, $2, 'x')`, [s, m])
  await q(`INSERT INTO chat_message_embeddings (message_id, session_id, embedding) VALUES ($1, $2, $3::vector)`, [
    m,
    s,
    `[${Array.from({ length: 1024 }, () => 0.1).join(',')}]`,
  ])
  await q(`INSERT INTO chat_decks (session_id, user_email, title, slides) VALUES ($1, $2, 'd', '[]')`, [s, email])
  await q(`INSERT INTO chat_spreadsheets (session_id, user_email, title, spec) VALUES ($1, $2, 'p', '{}')`, [s, email])
  await q(`INSERT INTO chat_documents (session_id, user_email, title, markdown) VALUES ($1, $2, 'd', 'x')`, [s, email])
  const volumePath = `/Volumes/c/s/ai_prism_images/${tag}-${s}.png`
  if (image) {
    await q(
      `INSERT INTO chat_images (session_id, user_email, prompt, model, volume_path, content_type) VALUES ($1, $2, 'p', 'm', $3, 'image/png')`,
      [s, email, volumePath]
    )
  }
  const ledger = (await q(`INSERT INTO usage_ledger (user_email, session_id, kind, model, cost_usd) VALUES ($1, $2, 'chat', 'm', 1) RETURNING id`, [email, s]))[0].id
  await q(`UPDATE chat_sessions SET updated_at = now() - make_interval(days => $2), created_at = now() - make_interval(days => $3) WHERE id = $1`, [
    s,
    ageDays,
    createdDays,
  ])
  // every row of the session is as old as its last activity
  await q(`UPDATE chat_messages SET created_at = now() - make_interval(days => $2) WHERE session_id = $1`, [s, ageDays])
  for (const t of ['chat_decks', 'chat_spreadsheets', 'chat_documents']) {
    await q(`UPDATE ${t} SET created_at = now() - make_interval(days => $2), updated_at = now() - make_interval(days => $2) WHERE session_id = $1`, [s, ageDays])
  }
  return { s: String(s), m: String(m), ledger: String(ledger), volumePath: image ? volumePath : null }
}

const CHILD_TABLES = ['chat_messages', 'chat_genie_conversations', 'chat_compactions', 'chat_message_embeddings', 'chat_decks', 'chat_spreadsheets', 'chat_documents', 'chat_images']
async function rowsOf(fx) {
  const out = { chat_sessions: Number((await q(`SELECT count(*)::int AS n FROM chat_sessions WHERE id = $1`, [fx.s]))[0].n) }
  for (const t of CHILD_TABLES) out[t] = (await q(`SELECT count(*)::int AS n FROM ${t} WHERE session_id = $1`, [fx.s]))[0].n
  out.chat_tool_calls = (await q(`SELECT count(*)::int AS n FROM chat_tool_calls WHERE message_id = $1`, [fx.m]))[0].n
  return out
}

async function setRetention(days) {
  await q(
    `INSERT INTO app_settings (key, value) VALUES ('retention_days', to_jsonb($1::int))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [days]
  )
}
async function clearSweepStamp() {
  await q(`DELETE FROM app_settings WHERE key = 'retention_last_sweep_at'`)
}
async function clearAudit() {
  await q(`DELETE FROM admin_audit`)
}
async function auditRows() {
  return q(`SELECT id, at, actor_hash, action, target, details FROM admin_audit ORDER BY id`)
}

function captureLog() {
  const lines = []
  const rec = (level) => (msg, fields) => lines.push({ level, msg, fields })
  return { lines, info: rec('info'), warn: rec('warn'), error: rec('error'), log: rec('info') }
}

// ---- static guards ------------------------------------------------------------

test('AC-S1 lint: app.maintenance is set only by server/retention.ts (and named only by migration 0007)', () => {
  const offenders = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(m?js|cjs|ts|sql)$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) {
        if (fs.readFileSync(p, 'utf8').includes('app.maintenance')) offenders.push(path.relative(REPO, p).split(path.sep).join('/'))
      }
    }
  }
  for (const d of ['server', 'shared', 'scripts']) walk(path.join(REPO, d))
  assert.deepEqual(offenders.sort(), ['server/migrations/0007_settings_audit.down.sql', 'server/migrations/0007_settings_audit.up.sql', 'server/retention.ts'])
  const src = fs.readFileSync(path.join(HERE, 'retention.ts'), 'utf8')
  // transaction-local only: set_config(..., true), never a session-level SET
  assert.match(src, /set_config\('app\.maintenance', 'on', true\)/)
  assert.doesNotMatch(src, /SET\s+(SESSION\s+)?app\.maintenance/i)
  assert.doesNotMatch(src, /set_config\('app\.maintenance', 'on', false\)/)
})

test('every admin mutation route is classified for the audit trail (a new one fails here)', () => {
  const adminRoutes = []
  for (const layer of app._router.stack) {
    if (!layer.route) continue
    const chain = layer.route.stack.map((l) => l.handle.name)
    for (const m of Object.keys(layer.route.methods)) {
      const key = `${m.toUpperCase()} ${layer.route.path}`
      if (chain.includes('requireAdmin') && (m !== 'get' || audit.ADMIN_MUTATION_ROUTES[key] !== undefined)) adminRoutes.push(key)
    }
  }
  const classified = Object.keys(audit.ADMIN_MUTATION_ROUTES)
  for (const r of adminRoutes) assert.ok(classified.includes(r), `${r} is not classified in ADMIN_MUTATION_ROUTES`)
  for (const r of classified) {
    const [m, p] = r.split(' ')
    const exists = app._router.stack.some((l) => l.route?.path === p && l.route.methods[m.toLowerCase()])
    assert.ok(exists, `${r} is classified but is not a route`)
  }
  // the six families of the design row, plus settings, each name at least one route
  const actions = Object.values(audit.ADMIN_MUTATION_ROUTES).flat().filter(Boolean)
  for (const family of ['admins.', 'mcp_catalog.', 'tool_policy.', 'template.', 'model_endpoints.', 'settings.']) {
    assert.ok(actions.some((a) => a.startsWith(family)), `no route audits ${family}*`)
  }
  assert.equal(audit.ADMIN_MUTATION_ROUTES['POST /api/admin/mcp-catalog/inspect'], null, 'inspect is read-only (no audit)')
})

test('actor_hash and user targets are hashes, never the e-mail; details are redacted and capped', () => {
  const h = audit.actorHash('Ana.Admin@Example.com')
  assert.match(h, /^(h2:)?[0-9a-f]{12}$/, 'keyed (h2:) or, without APP_AUDIT_HASH_KEY, the legacy digest')
  assert.equal(h, audit.actorHash('ana.admin@example.com'), 'case-insensitive')
  assert.ok(!h.includes('@'))
  assert.equal(audit.SYSTEM_ACTOR, 'system')
  assert.match(audit.principalTarget('bob@example.com', 'user'), /^user:(h2:)?[0-9a-f]{12}$/)
  assert.equal(audit.principalTarget('data-team', 'group'), 'group:data-team')
  const d = audit.cleanDetails({ note: 'ping carol@example.com', big: 'x'.repeat(5000), nested: { who: 'dave@example.com' } })
  const text = JSON.stringify(d)
  assert.ok(!/@example\.com/.test(text), text.slice(0, 200))
  assert.ok(text.length <= audit.AUDIT_DETAILS_MAX_CHARS + 50)
})

test('audit cursor: opaque round trip; a malformed cursor is refused', () => {
  const at = new Date('2026-11-01T10:00:00.123Z')
  const c = audit.encodeCursor({ at, id: '42' })
  assert.equal(typeof c, 'string')
  assert.ok(!c.includes('2026'), 'opaque')
  assert.deepEqual(audit.decodeCursor(c), { at: at.toISOString(), id: '42' })
  for (const bad of ['', 'x', 'eyJ9', Buffer.from('{"at":"nope","id":"1"}').toString('base64url'), Buffer.from('{"at":"2026-01-01T00:00:00Z","id":"1; drop"}').toString('base64url')]) {
    assert.equal(audit.decodeCursor(bad), null, bad)
  }
})

test('settings validation: retention_days 0 or 1..3650 (integer), org_instructions ≤ 8000 chars', () => {
  const v = adminDb.validateSettingsPatch
  assert.deepEqual(v({ retentionDays: 0 }), { patch: { retentionDays: 0 } })
  assert.deepEqual(v({ retentionDays: 30, orgInstructions: '  Seja breve.  ' }), { patch: { retentionDays: 30, orgInstructions: 'Seja breve.' } })
  assert.deepEqual(v({ retentionDays: 3650 }), { patch: { retentionDays: 3650 } })
  for (const bad of [-1, 3651, 1.5, '30', null, true, NaN]) assert.ok(v({ retentionDays: bad }).error, String(bad))
  assert.ok(v({ orgInstructions: 'x'.repeat(adminDb.ORG_INSTRUCTIONS_MAX_CHARS + 1) }).error)
  assert.ok(v({ orgInstructions: 42 }).error)
  assert.ok(v({}).error, 'an empty patch is refused')
  assert.ok(v({ retentionDays: 1, other: 1 }).error, 'unknown keys are refused')
  assert.equal(adminDb.ORG_INSTRUCTIONS_MAX_CHARS, 8000)
})

test('org instructions provider: one system message when set, none when empty, cached for the TTL', async () => {
  let loads = 0
  let text = 'Responda sempre em tom formal.'
  let t = 0
  const provider = orgInstructions.createOrgInstructionsProvider({
    load: async () => {
      loads++
      return { orgInstructions: text }
    },
    now: () => t,
    ttlMs: 1000,
  })
  const req = { email: A, token: 'tok' }
  const out = await provider({ req, sessionId: '1', history: [] })
  assert.equal(out.length, 1)
  assert.ok(out[0].includes('Responda sempre em tom formal.'))
  assert.match(out[0], /<org_instructions>[\s\S]*<\/org_instructions>/)
  text = ''
  t = 500
  assert.equal((await provider({ req, sessionId: '1', history: [] })).length, 1, 'still cached')
  assert.equal(loads, 1)
  t = 1500
  assert.deepEqual(await provider({ req, sessionId: '1', history: [] }), [], 'empty → no message')
  assert.equal(loads, 2)
  // a failing load costs only the message, never the turn
  const failing = orgInstructions.createOrgInstructionsProvider({ load: async () => { throw new Error('db down') }, now: () => 0 })
  assert.deepEqual(await failing({ req, sessionId: '1', history: [] }), [])
})

test('org instructions are installed through registerTurnContextProvider, once', () => {
  const seen = []
  const register = (fn) => {
    seen.push(fn)
    return () => {}
  }
  orgInstructions.installOrgInstructions({ register, force: true })
  orgInstructions.installOrgInstructions({ register })
  assert.equal(seen.length, 1)
  assert.equal(typeof seen[0], 'function')
  const src = fs.readFileSync(path.join(HERE, 'orgInstructions.ts'), 'utf8')
  assert.match(src, /registerTurnContextProvider/)
})

test('turnLock.heldKeys lists the live holds only (the sweep spares those sessions)', () => {
  let t = 0
  const lock = turnLockMod.createTurnLock({ staleMs: 100, now: () => t })
  const r1 = lock.acquire('1')
  lock.acquire('2')
  assert.deepEqual(lock.heldKeys().sort(), ['1', '2'])
  r1()
  assert.deepEqual(lock.heldKeys(), ['2'])
  t = 200
  assert.deepEqual(lock.heldKeys(), [], 'a stale hold is not live')
})

test('the sweep scheduler: off with RETENTION_SWEEP=off; otherwise an unref timer that runs the sweep', async () => {
  assert.equal(retention.startRetentionScheduler({ env: { RETENTION_SWEEP: 'off' } }), null)
  let runs = 0
  const timers = []
  const stop = retention.startRetentionScheduler({
    env: {},
    run: async () => {
      runs++
      return { status: 'done' }
    },
    setTimer: (fn, ms) => {
      const h = { fn, ms, unref() { h.unrefed = true } }
      timers.push(h)
      return h
    },
    clearTimer: () => {},
    log: quiet,
  })
  assert.equal(typeof stop, 'function')
  assert.equal(timers.length, 1)
  assert.equal(timers[0].unrefed, true, 'never holds the process open')
  await timers[0].fn()
  assert.equal(runs, 1)
  assert.equal(timers.length, 2, 'reschedules itself')
  stop()
})

// ---- database: migration 0007 -------------------------------------------------

test('AC-S2: 0007 creates app_settings + admin_audit under FORCE RLS; the body is idempotent; down → up round trip', { skip: SKIP }, async () => {
  const name = await scratch()
  const c = new pg.Client(opts(name))
  await c.connect()
  try {
    await c.query(`SET search_path TO ai_prism, public`)
    const state = async () =>
      (
        await c.query(
          `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                  (SELECT array_agg(p.polname::text ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
             FROM pg_class c WHERE c.relnamespace = 'ai_prism'::regnamespace AND c.relkind = 'r'
              AND c.relname IN ('app_settings', 'admin_audit', 'chat_sessions', 'chat_images') ORDER BY c.relname`
        )
      ).rows
    const before = await state()
    const by = Object.fromEntries(before.map((r) => [r.relname, r]))
    for (const t of ['app_settings', 'admin_audit']) {
      assert.equal(by[t].rls, true, `${t} ENABLE RLS`)
      assert.equal(by[t].force, true, `${t} FORCE RLS`)
    }
    assert.ok(by.chat_sessions.policies.includes('aipr_maint_read'))
    assert.ok(by.chat_sessions.policies.includes('aipr_maint_delete'))
    assert.ok(by.chat_images.policies.includes('aipr_maint_read'))
    assert.ok(!by.admin_audit.policies.some((p) => /update|delete/.test(p)), 'admin_audit has no UPDATE/DELETE policy (append-only)')

    const up = fs.readFileSync(path.join(MIGRATIONS, '0007_settings_audit.up.sql'), 'utf8')
    const down = fs.readFileSync(path.join(MIGRATIONS, '0007_settings_audit.down.sql'), 'utf8')
    await c.query('BEGIN')
    await c.query(up)
    await c.query(up)
    // 0007 up resets the sweep policies and the audit policies it owns; 0011 (later) re-applies its versions
    await c.query(fs.readFileSync(path.join(MIGRATIONS, '0011_ephemeral.up.sql'), 'utf8'))
    // and 0015 its aiau_sched_insert on admin_audit
    await c.query(fs.readFileSync(path.join(MIGRATIONS, '0015_agents.up.sql'), 'utf8'))
    await c.query('COMMIT')
    assert.deepEqual(await state(), before, 'running the up body twice changes nothing')

    // keep a setting row: down drops it with the table (documented), up recreates the empty table
    await c.query(`INSERT INTO app_settings (key, value) VALUES ('retention_days', '30')`)
    const { migrateDown, migrateUp, loadMigrations } = await import('./db/migrate.ts')
    const versions = loadMigrations(MIGRATIONS).map((m) => m.version)
    const d = await migrateDown(c, { to: 6, log: quiet })
    assert.deepEqual(d.reverted, versions.filter((v) => v > 6).reverse())
    const gone = (await c.query(`SELECT to_regclass('ai_prism.app_settings') AS a, to_regclass('ai_prism.admin_audit') AS b`)).rows[0]
    assert.deepEqual(gone, { a: null, b: null })
    const left = (await c.query(`SELECT count(*)::int AS n FROM pg_policy WHERE polname LIKE 'aipr\\_%'`)).rows[0].n
    assert.equal(left, 0, 'down drops the maintenance policies')
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'aip\\_retention%' OR proname = 'aip_maintenance'`)).rows[0].n, 0)
    // running the down body twice is harmless too
    await c.query('BEGIN')
    await c.query(down)
    await c.query(down)
    await c.query('ROLLBACK')
    const u = await migrateUp(c, { log: quiet })
    assert.deepEqual(u.applied, versions.filter((v) => v > 6))
    assert.deepEqual(await state(), before)
  } finally {
    await c.end().catch(() => {})
  }
})

// ---- database: settings -------------------------------------------------------

test('settings: defaults; an admin write lands with its audit row; a non-admin write is refused by RLS', { skip: SKIP }, async () => {
  await q(`DELETE FROM app_settings`)
  await clearAudit()
  assert.deepEqual(await adminDb.getAppSettings(A, 'tok'), { retentionDays: 0, orgInstructions: '', retentionLastSweepAt: null })

  await adminDb.updateAppSettings(OWNER, 'tok', { retentionDays: 45, orgInstructions: 'Use o glossário da empresa.' }, { admin: true })
  const s = await adminDb.getAppSettings(A, 'tok')
  assert.equal(s.retentionDays, 45)
  assert.equal(s.orgInstructions, 'Use o glossário da empresa.')
  const rows = await auditRows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].action, 'settings.update')
  assert.equal(rows[0].actor_hash, audit.actorHash(OWNER))
  assert.equal(rows[0].details.retentionDays, 45)
  assert.equal(rows[0].details.orgInstructionsChars, 'Use o glossário da empresa.'.length)

  await assert.rejects(adminDb.updateAppSettings(A, 'tok', { retentionDays: 1 }, { admin: false }), (e) => e.code === '42501')
  assert.equal((await adminDb.getAppSettings(A, 'tok')).retentionDays, 45, 'unchanged')
  assert.equal((await auditRows()).length, 1, 'no audit row for a refused write')
  await q(`DELETE FROM app_settings`)
})

// ---- database: audit ----------------------------------------------------------

test('every admin mutation writes admin_audit in its own transaction, with a hashed actor', { skip: SKIP }, async () => {
  await clearAudit()
  const ADM = { admin: true }
  const T = 'tok'
  const userTpl = await db.createDeckTemplate(OWNER, T, { name: `tpl-${stamp}` })
  const cases = [
    ['admins.add', () => db.addAppAdmin(OWNER, T, B, 'user', ADM)],
    ['admins.remove', () => db.removeAppAdmin(OWNER, T, B, ADM)],
    ['mcp_catalog.upsert', () => db.upsertMcpCatalogEntry(OWNER, T, `svc-${stamp}`, { displayName: 'S', hidden: false }, ADM)],
    ['mcp_catalog.delete', () => db.deleteMcpCatalogEntry(OWNER, T, `svc-${stamp}`, ADM)],
    ['tool_policy.set', () => db.setToolPolicy(OWNER, T, 'web', false, ADM)],
    ['template.scope', () => db.setDeckTemplateScope(OWNER, T, userTpl.id, 'global', ADM)],
    ['template.update', () => db.updateDeckTemplate(OWNER, T, userTpl.id, { name: 'org' }, true)],
    ['model_endpoints.upsert', () => db.upsertModelOverride(OWNER, T, `m-${stamp}`, { enabled: true, priceIn: 1, priceOut: 2 }, ADM)],
    ['model_endpoints.reorder', () => db.reorderModelOverrides(OWNER, T, [`m-${stamp}`], ADM)],
    ['model_endpoints.clear_prices', () => db.clearModelOverridePrices(OWNER, T, [`m-${stamp}`], ADM)],
    ['skill.upsert', async () => {
      const id = await db.upsertSkill(OWNER, T, { scope: 'global', name: `g-${stamp}`, title: 't', description: 'd', body: 'b', triggers: [] }, ADM)
      cases.skillId = id
    }],
    ['skill.delete', () => db.deleteSkill(OWNER, T, cases.skillId, { allowGlobal: true })],
    ['template.delete', () => db.deleteDeckTemplate(OWNER, T, userTpl.id, true)],
  ]
  for (const [action, run] of cases) {
    const before = (await auditRows()).length
    await run()
    const rows = await auditRows()
    assert.equal(rows.length, before + 1, `${action}: exactly one audit row`)
    const row = rows.at(-1)
    assert.equal(row.action, action)
    assert.equal(row.actor_hash, audit.actorHash(OWNER), `${action}: hashed actor`)
  }
  // the admin principal target is hashed too
  const added = (await auditRows()).find((r) => r.action === 'admins.add')
  assert.equal(added.target, audit.principalTarget(B, 'user'))
  // the seed runs once (only when it inserted rows)
  await q(`DELETE FROM model_catalog_overrides`)
  await db.seedModelOverridesIfEmpty(OWNER, T, [{ id: `seed-${stamp}`, label: 'x' }], ADM)
  await db.seedModelOverridesIfEmpty(OWNER, T, [{ id: `seed-${stamp}`, label: 'x' }], ADM)
  assert.equal((await auditRows()).filter((r) => r.action === 'model_endpoints.seed').length, 1)
  // no e-mail anywhere in the trail
  const dump = JSON.stringify(await auditRows())
  assert.ok(!dump.includes('@'), 'no raw e-mail in admin_audit')
})

test('non-admin attempts and no-op mutations write no audit row; a user template edit is not an admin action', { skip: SKIP }, async () => {
  await clearAudit()
  await db.removeAppAdmin(A, 'tok', 'nobody@test.invalid', { admin: false })
  await db.removeAppAdmin(OWNER, 'tok', `never-${stamp}@test.invalid`, { admin: true }) // 0 rows
  await assert.rejects(db.setToolPolicy(A, 'tok', 'web', true, { admin: false }), (e) => e.code === '42501')
  const own = await db.createDeckTemplate(A, 'tok', { name: 'own' })
  await db.updateDeckTemplate(A, 'tok', own.id, { name: 'own2' }, false)
  await db.deleteDeckTemplate(A, 'tok', own.id, false)
  const sid = await db.upsertSkill(A, 'tok', { scope: 'user', name: `u-${stamp}`, title: 't', description: 'd', body: 'b', triggers: [] })
  await db.deleteSkill(A, 'tok', sid)
  assert.deepEqual(await auditRows(), [])
})

test('admin_audit is append-only for the app role, even with the admin flag; only admins read it', { skip: SKIP }, async () => {
  await clearAudit()
  await db.setToolPolicy(OWNER, 'tok', 'web', true, { admin: true })
  const [row] = await auditRows()
  const { withTx } = await import('./db/pool.ts')
  const tryWrite = (sql) =>
    withTx(OWNER, 'tok', async (c) => (await c.query(sql, [row.id])).rowCount, { admin: true }).catch((e) => e.code)
  const upd = await tryWrite(`UPDATE admin_audit SET action = 'forged' WHERE id = $1`)
  const del = await tryWrite(`DELETE FROM admin_audit WHERE id = $1`)
  assert.ok(upd === 0 || upd === '42501', `update: ${upd}`)
  assert.ok(del === 0 || del === '42501', `delete: ${del}`)
  assert.deepEqual(await auditRows(), [row], 'unchanged')
  const nonAdmin = await withTx(A, 'tok', async (c) => (await c.query(`SELECT count(*)::int AS n FROM admin_audit`)).rows[0].n)
  assert.equal(nonAdmin, 0, 'a non-admin transaction sees no audit row')
  await assert.rejects(
    withTx(A, 'tok', (c) => c.query(`INSERT INTO admin_audit (actor_hash, action) VALUES ('x', 'forged')`)),
    (e) => e.code === '42501'
  )
})

// W2-17: bundle/auto_config.py seeds the deployer into app_admins BEFORE the app
// has migrated (admin_audit does not exist yet on a first install), so the app
// writes the seed's audit row after its migrations, on the schema connection.
test('W2-17: the first-admin seed of auto_config gets ONE admins.add row after migrations (hashed target, no e-mail)', { skip: SKIP }, async () => {
  await clearAudit()
  const DEP = `W217-Deployer-${stamp}@Test.invalid`
  const MANUAL = `w217-manual-${stamp}@test.invalid`
  await q(`DELETE FROM app_admins WHERE added_by = 'auto-config'`)
  await q(`INSERT INTO app_admins (principal, kind, added_by) VALUES ($1, 'user', 'auto-config')`, [DEP])
  await q(`INSERT INTO app_admins (principal, kind, added_by) VALUES ($1, 'user', $2)`, [MANUAL, OWNER])
  try {
    await db.ensureSchema(OWNER, 'tok')
    const rows = await auditRows()
    assert.equal(rows.length, 1, 'one row, for the seed only (a UI-added admin was audited by its own route)')
    const [row] = rows
    assert.equal(row.actor_hash, audit.BOOTSTRAP_ADDED_BY)
    assert.equal(row.action, 'admins.add')
    assert.equal(row.target, audit.principalTarget(DEP, 'user'))
    assert.equal(row.details.source, 'auto-config')
    assert.equal(row.details.kind, 'user')
    assert.match(row.details.granted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    assert.equal(typeof row.details.host, 'string')
    assert.ok(!JSON.stringify(rows).includes('@'), 'no clear e-mail in the seed row')

    // every boot runs it: idempotent (and under any user)
    await db.ensureSchema(OWNER, 'tok')
    await db.ensureSchema(A, 'tok')
    assert.equal((await auditRows()).length, 1)

    // a key configured later does not duplicate the row of the same grant
    const { withTx } = await import('./db/pool.ts')
    const keyed = await withTx('', 'tok', (c) => audit.recordBootstrapAdminSeeds(c, { key: 'w2-17-test-only-key-not-a-secret' }), { admin: true })
    assert.equal(keyed, 0)
    assert.equal((await auditRows()).length, 1)

    // removed and seeded again by a later deploy = a new grant, a second row
    await q(`DELETE FROM app_admins WHERE principal = $1`, [DEP])
    await q(`INSERT INTO app_admins (principal, kind, added_by, created_at) VALUES ($1, 'user', 'auto-config', now() + interval '1 second')`, [DEP])
    await db.ensureSchema(OWNER, 'tok')
    assert.equal((await auditRows()).filter((r) => r.action === 'admins.add').length, 2)

    // a seed row with no created_at (the column is nullable) is still written once, not once per boot
    const NULLAT = `w217-nullat-${stamp}@test.invalid`
    await q(`INSERT INTO app_admins (principal, kind, added_by, created_at) VALUES ($1, 'user', 'auto-config', NULL)`, [NULLAT])
    try {
      await db.ensureSchema(OWNER, 'tok')
      await db.ensureSchema(OWNER, 'tok')
      const nullRows = (await auditRows()).filter((r) => r.target === audit.principalTarget(NULLAT, 'user'))
      assert.equal(nullRows.length, 1)
      assert.equal(nullRows[0].details.granted_at, null)
    } finally {
      await q(`DELETE FROM app_admins WHERE principal = $1`, [NULLAT])
    }

    // the admin reader shows the bootstrap actor
    const page = await adminDb.listAdminAudit(OWNER, 'tok', {}, { admin: true })
    assert.equal(page.items[0].actorHash, 'auto-config')
  } finally {
    await q(`DELETE FROM app_admins WHERE principal = ANY($1)`, [[DEP, MANUAL]])
  }
})

test('W2-17: the seed audit never breaks the schema step (no admin_audit yet = nothing written, no throw)', async () => {
  const calls = []
  const fake = {
    async query(sql) {
      calls.push(sql)
      if (/to_regclass/.test(sql)) return { rows: [{ t: null }] }
      throw new Error(`unexpected: ${sql}`)
    },
  }
  assert.equal(await audit.recordBootstrapAdminSeeds(fake), 0)
  assert.equal(calls.length, 1)
})

test('listAdminAudit: newest first, cursor pages without gaps or repeats', { skip: SKIP }, async () => {
  await clearAudit()
  for (let i = 0; i < 7; i++) await db.setToolPolicy(OWNER, 'tok', `k${i}`, i % 2 === 0, { admin: true })
  const all = []
  let cursor = null
  let pages = 0
  do {
    const page = await adminDb.listAdminAudit(OWNER, 'tok', { cursor, limit: 3 }, { admin: true })
    assert.ok(page.items.length <= 3)
    all.push(...page.items)
    cursor = page.nextCursor
    pages++
  } while (cursor && pages < 10)
  assert.equal(pages, 3)
  const hidden = await adminDb.listAdminAudit(A, 'tok', {}, { admin: false })
  assert.deepEqual(hidden.items, [], 'without the admin flag the trail reads empty (RLS)')
  assert.equal(all.length, 7)
  assert.deepEqual(all.map((r) => r.target), ['k6', 'k5', 'k4', 'k3', 'k2', 'k1', 'k0'])
  assert.equal(new Set(all.map((r) => r.id)).size, 7)
  for (const r of all) {
    assert.deepEqual(Object.keys(r).sort(), ['action', 'actorHash', 'at', 'details', 'id', 'target'])
  }
})

// ---- database: the retention sweep ---------------------------------------------

test('retention off (0 or unset): the sweep never deletes, however old the session', { skip: SKIP }, async () => {
  await q(`DELETE FROM app_settings`)
  await clearAudit()
  const old = await seedSession(A, { ageDays: 4000, tag: 'off' })
  const files = []
  const r1 = await retention.runRetentionSweep({ force: true, deleteFile: async (p) => (files.push(p), true), log: quiet })
  assert.equal(r1.status, 'skipped')
  assert.equal(r1.reason, 'off')
  await setRetention(0)
  const r2 = await retention.runRetentionSweep({ force: true, deleteFile: async (p) => (files.push(p), true), log: quiet })
  assert.equal(r2.reason, 'off')
  assert.equal((await rowsOf(old)).chat_sessions, 1)
  assert.deepEqual(files, [])
  await q(`DELETE FROM chat_sessions WHERE id = $1`, [old.s])
})

test('the sweep deletes only sessions inactive for N days, with their cascade and their volume files; logs and audits counts', { skip: SKIP }, async () => {
  await q(`DELETE FROM chat_sessions`)
  await clearSweepStamp()
  await clearAudit()
  await setRetention(30)
  const oldA = await seedSession(A, { ageDays: 40, tag: 'oldA' })
  const oldB = await seedSession(B, { ageDays: 31, tag: 'oldB' })
  const oldNoImage = await seedSession(B, { ageDays: 90, image: false, tag: 'oldNoImg' })
  const youngA = await seedSession(A, { ageDays: 29, tag: 'youngA' })
  const activeOldA = await seedSession(A, { ageDays: 1, createdDays: 400, tag: 'activeOld' }) // created long ago, used yesterday
  const busyOld = await seedSession(B, { ageDays: 60, tag: 'busy' }) // a live turn holds it
  const files = []
  const log = captureLog()
  const r = await retention.runRetentionSweep({
    deleteFile: async (p) => {
      files.push(p)
      return p !== oldB.volumePath // one file delete fails: counted, not fatal
    },
    busySessionIds: () => [busyOld.s],
    log,
    batchSize: 2, // 3 expired sessions → two DELETE statements
  })
  assert.equal(r.status, 'done')
  assert.equal(r.sessions, 3)
  assert.equal(r.users, 2)
  assert.equal(r.images, 2)
  assert.equal(r.filesDeleted, 1)
  assert.equal(r.filesFailed, 1)
  assert.equal(r.retentionDays, 30)
  assert.equal(r.capped, false)

  for (const fx of [oldA, oldB, oldNoImage]) {
    const rows = await rowsOf(fx)
    for (const [t, n] of Object.entries(rows)) assert.equal(n, 0, `${fx.s}: ${t} cascaded`)
    const [ledger] = await q(`SELECT session_id, cost_usd FROM usage_ledger WHERE id = $1`, [fx.ledger])
    assert.ok(ledger, 'the cost row stays')
    assert.equal(ledger.session_id, null, 'detached from the deleted session')
  }
  for (const fx of [youngA, activeOldA, busyOld]) {
    const rows = await rowsOf(fx)
    for (const [t, n] of Object.entries(rows)) assert.equal(n, 1, `${fx.s}: ${t} kept`)
  }
  assert.deepEqual(files.sort(), [oldA.volumePath, oldB.volumePath].sort(), 'only the deleted sessions’ files')

  const done = log.lines.find((l) => /retention sweep/.test(l.msg))
  assert.ok(done, 'the sweep logs')
  assert.equal(done.fields.sessions, 3)
  assert.equal(done.fields.images, 2)
  const trail = await auditRows()
  assert.equal(trail.length, 1)
  assert.equal(trail[0].action, 'retention.sweep')
  assert.equal(trail[0].actor_hash, 'system')
  assert.equal(trail[0].details.sessions, 3)
  assert.ok(!JSON.stringify(trail).includes('@'))
  assert.ok((await adminDb.getAppSettings(A, 'tok')).retentionLastSweepAt, 'the run is stamped')
})

test('a backlog beyond batchSize x maxBatches is capped: the run deletes what fits and says so', { skip: SKIP }, async () => {
  await q(`DELETE FROM chat_sessions`)
  await clearSweepStamp()
  await setRetention(30)
  const fx = []
  for (let i = 0; i < 5; i++) fx.push(await seedSession(A, { ageDays: 50 + i, image: false, tag: `cap${i}` }))
  const r = await retention.runRetentionSweep({ force: true, deleteFile: async () => true, log: quiet, batchSize: 2, maxBatches: 2 })
  assert.equal(r.sessions, 4)
  assert.equal(r.capped, true)
  const left = (await q(`SELECT count(*)::int AS n FROM chat_sessions WHERE id = ANY($1::bigint[])`, [fx.map((f) => f.s)]))[0].n
  assert.equal(left, 1, 'the rest waits for the next run')
  const next = await retention.runRetentionSweep({ force: true, deleteFile: async () => true, log: quiet, batchSize: 2, maxBatches: 2 })
  assert.deepEqual([next.sessions, next.capped], [1, false])
})

// ---- last activity (QA W2-5 round 1: an old session with a recent message was deleted) ----

test('a recent user message refreshes activity so retention preserves the session', { skip: SKIP }, async () => {
  await q(`DELETE FROM chat_sessions`)
  await clearSweepStamp()
  await setRetention(30)
  const fx = await seedSession(A, { ageDays: 45, tag: 'recently-active' })
  await db.addMessage(A, 'tok', { sessionId: fx.s, role: 'user', content: 'new activity' })
  const [row] = await q(`SELECT updated_at > now() - interval '1 minute' AS fresh FROM chat_sessions WHERE id = $1`, [fx.s])
  assert.equal(row.fresh, true, 'a message write refreshes chat_sessions.updated_at in its transaction')
  const result = await retention.runRetentionSweep({ force: true, deleteFile: async () => true, log: quiet })
  assert.equal(result.sessions, 0, 'a session with a newly added user message is active')
  assert.equal((await rowsOf(fx)).chat_sessions, 1, 'the active conversation survives')
})

test('a turn answer committed on an old session (the turn path) refreshes activity', { skip: SKIP }, async () => {
  await q(`DELETE FROM chat_sessions`)
  await setRetention(30)
  const fx = await seedSession(A, { ageDays: 45, tag: 'turn-path' })
  const { commitTurnAnswer } = await import('./db/turnCommit.ts')
  await commitTurnAnswer(A, 'tok', { sessionId: fx.s, message: { role: 'assistant', content: 'resposta' } })
  const [row] = await q(`SELECT updated_at > now() - interval '1 minute' AS fresh FROM chat_sessions WHERE id = $1`, [fx.s])
  assert.equal(row.fresh, true)
})

test('a chat turn over HTTP on an old session keeps it (end to end through POST /api/chat)', { skip: SKIP }, async () => {
  await q(`DELETE FROM chat_sessions`)
  await clearSweepStamp()
  await setRetention(30)
  const sid = await db.createSession(A, 'tok', 'antiga', MODEL, null, [])
  await q(`UPDATE chat_sessions SET updated_at = now() - interval '45 days', created_at = now() - interval '45 days' WHERE id = $1`, [sid])
  const form = new FormData()
  form.append('payload', JSON.stringify({ sessionId: String(sid), prompt: `Responda apenas com a palavra OK. (${stamp})`, model: MODEL, enabledTools: [] }))
  const res = await fetch(`${base}/api/chat`, as(A, { method: 'POST', body: form }))
  assert.equal(res.status, 200)
  await res.text()
  const r = await retention.runRetentionSweep({ force: true, deleteFile: async () => true, log: quiet })
  assert.equal(r.sessions, 0)
  assert.equal((await q(`SELECT count(*)::int AS n FROM chat_sessions WHERE id = $1`, [sid]))[0].n, 1, 'used today: kept')
})

test('stale updated_at from before the fix: a recent message, deck, sheet or document still keeps the session', { skip: SKIP }, async () => {
  await q(`DELETE FROM chat_sessions`)
  await clearSweepStamp()
  await setRetention(30)
  // written straight by the superuser: updated_at stays 45 days old, like existing data
  const msg = await seedSession(A, { ageDays: 45, image: false, tag: 'stale-msg' })
  await q(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'ontem')`, [msg.s])
  const kept = [msg]
  for (const t of ['chat_decks', 'chat_spreadsheets', 'chat_documents']) {
    const fx = await seedSession(A, { ageDays: 45, image: false, tag: `stale-${t}` })
    await q(`UPDATE ${t} SET updated_at = now() - interval '1 day' WHERE session_id = $1`, [fx.s])
    kept.push(fx)
  }
  const old = await seedSession(A, { ageDays: 45, image: false, tag: 'stale-old' })
  for (const fx of kept) {
    const [row] = await q(`SELECT updated_at < now() - interval '30 days' AS stale FROM chat_sessions WHERE id = $1`, [fx.s])
    assert.equal(row.stale, true, 'the fixture really has a stale session timestamp')
  }
  const r = await retention.runRetentionSweep({ force: true, deleteFile: async () => true, log: quiet })
  assert.equal(r.sessions, 1, 'only the session with no recent row')
  assert.equal((await rowsOf(old)).chat_sessions, 0)
  for (const fx of kept) assert.equal((await rowsOf(fx)).chat_sessions, 1, `${fx.s} kept`)
})

// QA W2-5 round 2: an artifact edit committed while the sweep waits on the
// cascade lock is activity too. The edit runs as the app role, through the
// production function (db.updateDeckSlides / updateSpreadsheet / updateDocument),
// and is held open until the sweep is observed waiting.
const ARTIFACT_EDITS = [
  ['deck', 'chat_decks', (id) => db.updateDeckSlides(A, 'tok', id, 'recent edit', [{ title: 'recent' }], {})],
  ['spreadsheet', 'chat_spreadsheets', (id) => db.updateSpreadsheet(A, 'tok', id, 'recent edit', { sheets: [] })],
  ['document', 'chat_documents', (id) => db.updateDocument(A, 'tok', id, 'recent edit', '# recent')],
]

// Runs `edit` inside a transaction that stays open until `release` resolves:
// the app's pool connection is wrapped so COMMIT waits for the test.
async function sweepWaitsOn(waitingFor) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const [row] = await q(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND state = 'active'
                        AND wait_event_type = 'Lock' AND query LIKE $1) AS waiting`,
      [waitingFor]
    )
    if (row.waiting) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return false
}

for (const [kind, table, edit] of ARTIFACT_EDITS) {
  test(`a ${kind} edit committed while the sweep waits preserves a stale-timestamp session`, { skip: SKIP }, async () => {
    await q(`DELETE FROM chat_sessions`)
    await clearSweepStamp()
    await setRetention(30)
    const fx = await seedSession(A, { ageDays: 45, tag: `${kind}-edit-race` })
    const id = String((await q(`SELECT id FROM ${table} WHERE session_id = $1`, [fx.s]))[0].id)

    // hold the edit's transaction open: a second connection locks the artifact
    // row first, so the production edit (and its transaction) queues behind it
    const blocker = new pg.Client(opts(DB))
    await blocker.connect()
    let sweep
    let editing
    try {
      await blocker.query('BEGIN')
      await blocker.query(`SELECT 1 FROM ai_prism.${table} WHERE id = $1 FOR UPDATE`, [id])
      editing = edit(id)
      assert.equal(await sweepWaitsOn(`%UPDATE ${table}%`), true, 'the edit is in flight, waiting on the artifact row')
      sweep = retention.runRetentionSweep({ force: true, busySessionIds: () => [], deleteFile: async () => true, log: quiet })
      assert.equal(await sweepWaitsOn('WITH victims AS%'), true, 'the sweep reached the session and waits')
      await blocker.query('COMMIT')
      await editing
      const result = await sweep
      assert.equal(result.sessions, 0, `a concurrent committed ${kind} edit is recent activity`)
      assert.equal((await rowsOf(fx)).chat_sessions, 1, 'the edited conversation survives')
      const [row] = await q(`SELECT title FROM ${table} WHERE id = $1`, [id])
      assert.equal(row.title, 'recent edit', 'and so does the edit')
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await blocker.end().catch(() => {})
      await Promise.allSettled([editing, sweep].filter(Boolean))
    }
  })
}

// QA's own repro, ported: the app-role edit transaction is opened by hand and
// held while the sweep waits on its cascade lock.
test('a deck edit committed while the sweep waits on the cascade (QA r2 repro) preserves a stale-timestamp session', { skip: SKIP }, async () => {
  await q(`DELETE FROM chat_sessions`)
  await clearSweepStamp()
  await setRetention(30)
  const fx = await seedSession(A, { ageDays: 45, tag: 'deck-edit-race-qa' })
  const deck = (await q(`SELECT id FROM chat_decks WHERE session_id = $1`, [fx.s]))[0].id
  const writer = new pg.Client(opts(DB, APP_ROLE))
  await writer.connect()
  let sweep
  try {
    await writer.query('BEGIN')
    await writer.query(
      `SELECT set_config('search_path', 'ai_prism, public', true), set_config('app.user_email', $1, true), set_config('app.is_admin', 'off', true)`,
      [A]
    )
    // the statements of db.updateDeckSlides, in its order
    for (const [sql, params] of db.deckEditStatements(deck, A, 'recent edit', [{ title: 'recent' }], {})) await writer.query(sql, params)
    sweep = retention.runRetentionSweep({ force: true, busySessionIds: () => [], deleteFile: async () => true, log: quiet })
    assert.equal(await sweepWaitsOn('WITH victims AS%'), true, 'the sweep waits on the uncommitted edit')
    await writer.query('COMMIT')
    const result = await sweep
    assert.equal(result.sessions, 0, 'a concurrent committed deck edit is recent activity')
    assert.equal((await rowsOf(fx)).chat_sessions, 1, 'the edited conversation survives')
  } finally {
    await writer.query('ROLLBACK').catch(() => {})
    await writer.end().catch(() => {})
    await Promise.allSettled([sweep].filter(Boolean))
  }
})

test('a standalone artifact edit moves the session’s last activity (studio saves count)', { skip: SKIP }, async () => {
  await q(`DELETE FROM chat_sessions`)
  for (const [kind, table, edit] of ARTIFACT_EDITS) {
    const fx = await seedSession(A, { ageDays: 45, image: false, tag: `${kind}-touch` })
    const id = String((await q(`SELECT id FROM ${table} WHERE session_id = $1`, [fx.s]))[0].id)
    await edit(id)
    const [row] = await q(`SELECT updated_at > now() - interval '1 minute' AS fresh FROM chat_sessions WHERE id = $1`, [fx.s])
    assert.equal(row.fresh, true, `${kind} edit refreshes chat_sessions.updated_at`)
  }
})

test('a backlog exactly at the batch cap is not reported as capped', { skip: SKIP }, async () => {
  await q(`DELETE FROM chat_sessions`)
  await clearSweepStamp()
  await setRetention(30)
  for (let i = 0; i < 4; i++) await seedSession(A, { ageDays: 45 + i, image: false, tag: `exact-cap-${i}` })
  const result = await retention.runRetentionSweep({ force: true, deleteFile: async () => true, log: quiet, batchSize: 2, maxBatches: 2 })
  assert.equal(result.sessions, 4)
  assert.equal(result.capped, false, 'there is no remaining backlog')
})

test('daily: a second sweep within 24 h is skipped unless forced', { skip: SKIP }, async () => {
  await clearSweepStamp()
  await setRetention(30)
  const first = await retention.runRetentionSweep({ deleteFile: async () => true, log: quiet })
  assert.equal(first.status, 'done')
  const again = await retention.runRetentionSweep({ deleteFile: async () => true, log: quiet })
  assert.deepEqual([again.status, again.reason], ['skipped', 'recent'])
  const later = await retention.runRetentionSweep({ deleteFile: async () => true, log: quiet, now: () => Date.now() + DAY })
  assert.equal(later.status, 'done', 'a day later it runs')
  const forced = await retention.runRetentionSweep({ force: true, deleteFile: async () => true, log: quiet })
  assert.equal(forced.status, 'done')
})

test('never twice at once: two simultaneous sweeps → one runs, the other is skipped (advisory lock)', { skip: SKIP }, async () => {
  await clearSweepStamp()
  await setRetention(30)
  const old = await seedSession(A, { ageDays: 45, tag: 'race' })
  let release
  const gate = new Promise((r) => (release = r))
  let entered
  const inside = new Promise((r) => (entered = r))
  const files = []
  const first = retention.runRetentionSweep({
    force: true,
    deleteFile: async (p) => (files.push(p), true),
    log: quiet,
    afterLock: async () => {
      entered()
      await gate
    },
  })
  await inside
  const second = await retention.runRetentionSweep({ force: true, deleteFile: async (p) => (files.push(p), true), log: quiet })
  assert.deepEqual([second.status, second.reason], ['skipped', 'locked'])
  release()
  const r1 = await first
  assert.equal(r1.status, 'done')
  assert.equal(r1.sessions, 1)
  assert.deepEqual(files, [old.volumePath], 'one delete, by the sweep that held the lock')
  // the lock is transaction-scoped: nothing is left on the pooled connection
  const next = await retention.runRetentionSweep({ force: true, deleteFile: async () => true, log: quiet })
  assert.equal(next.status, 'done')
})

// ---- AC-S1: the maintenance identity outside the sweep ------------------------

test('AC-S1: a user or admin transaction that sets app.maintenance gains nothing; it does not survive the sweep', { skip: SKIP }, async () => {
  await clearSweepStamp()
  await setRetention(30)
  const victim = await seedSession(B, { ageDays: 90, tag: 'victim' })
  const { withTx } = await import('./db/pool.ts')
  for (const [who, opts] of [
    [A, {}],
    [OWNER, { admin: true }],
  ]) {
    const seen = await withTx(
      who,
      'tok',
      async (c) => {
        await c.query(`SELECT set_config('app.maintenance', 'on', true)`)
        const s = (await c.query(`SELECT count(*)::int AS n FROM chat_sessions WHERE id = $1`, [victim.s])).rows[0].n
        const i = (await c.query(`SELECT count(*)::int AS n FROM chat_images WHERE session_id = $1`, [victim.s])).rows[0].n
        const m = (await c.query(`SELECT count(*)::int AS n FROM chat_messages WHERE session_id = $1`, [victim.s])).rows[0].n
        const a = (await c.query(
          `SELECT (SELECT count(*) FROM chat_decks WHERE session_id = $1) + (SELECT count(*) FROM chat_spreadsheets WHERE session_id = $1)
                + (SELECT count(*) FROM chat_documents WHERE session_id = $1) AS n`,
          [victim.s]
        )).rows[0].n
        const d = (await c.query(`DELETE FROM chat_sessions WHERE id = $1`, [victim.s])).rowCount
        return { s, i, m, a: Number(a), d }
      },
      opts
    )
    assert.deepEqual(seen, { s: 0, i: 0, m: 0, a: 0, d: 0 }, `${who === A ? 'user' : 'admin'}: no elevated visibility`)
  }
  assert.equal((await rowsOf(victim)).chat_sessions, 1)
  // retention off: even the sweep's own identity reaches nothing
  await setRetention(0)
  const offSeen = await withTx('', null, async (c) => {
    await c.query(`SELECT set_config('app.maintenance', 'on', true)`)
    return (await c.query(`SELECT count(*)::int AS n FROM chat_sessions`)).rows[0].n
  })
  assert.equal(offSeen, 0)
  // after a real sweep, the next transactions on the pool carry no maintenance flag
  await setRetention(30)
  await retention.runRetentionSweep({ force: true, deleteFile: async () => true, log: quiet })
  for (let i = 0; i < 10; i++) {
    const flag = await withTx('', null, async (c) => (await c.query(`SELECT current_setting('app.maintenance', true) AS v`)).rows[0].v)
    assert.ok(flag !== 'on', `pooled connection ${i}: ${flag}`)
  }
})

test('AC-S1: a request carrying a maintenance header, query or body gets only its own rows', { skip: SKIP }, async () => {
  await setRetention(30)
  const other = await seedSession(B, { ageDays: 90, tag: 'req-victim' })
  const mine = await seedSession(A, { ageDays: 0, tag: 'req-mine' })
  const headers = { 'x-app-maintenance': 'on', 'x-maintenance': 'on' }
  const list = await call('GET', '/api/sessions?maintenance=on&app.maintenance=on', A, undefined, headers)
  assert.equal(list.status, 200)
  const ids = list.body.sessions.map((s) => String(s.id))
  assert.ok(ids.includes(mine.s))
  assert.ok(!ids.includes(other.s))
  const read = await call('GET', `/api/sessions/${other.s}/messages?maintenance=on`, A, undefined, headers)
  assert.ok(read.status === 404 || (read.body?.messages || []).length === 0, `status ${read.status}`)
  const del = await call('DELETE', `/api/sessions/${other.s}`, A, { maintenance: 'on' }, headers)
  assert.ok([200, 404].includes(del.status))
  assert.equal((await rowsOf(other)).chat_sessions, 1, 'the other user’s expired session is untouched')
})

// ---- routes ----------------------------------------------------------------------

test('GET/PUT /api/admin/settings: admin only, validated, audited; GET /api/admin/audit pages with a cursor', { skip: SKIP }, async () => {
  await q(`DELETE FROM app_settings`)
  await clearAudit()
  assert.equal((await call('GET', '/api/admin/settings', A)).status, 403)
  assert.equal((await call('PUT', '/api/admin/settings', A, { retentionDays: 7 })).status, 403)
  assert.equal((await call('GET', '/api/admin/audit', A)).status, 403)
  assert.equal((await call('PUT', '/api/admin/settings', OWNER, { retentionDays: -3 })).status, 400)
  assert.equal((await call('PUT', '/api/admin/settings', OWNER, { orgInstructions: 'x'.repeat(8001) })).status, 400)
  assert.deepEqual((await auditRows()).length, 0, 'refused writes are not audited')

  const ok = await call('PUT', '/api/admin/settings', OWNER, { retentionDays: 90, orgInstructions: 'Cite a política interna.' })
  assert.equal(ok.status, 200)
  const got = await call('GET', '/api/admin/settings', OWNER)
  assert.equal(got.status, 200)
  assert.equal(got.body.retentionDays, 90)
  assert.equal(got.body.orgInstructions, 'Cite a política interna.')
  assert.equal(got.body.limits.orgInstructionsMaxChars, 8000)

  for (let i = 0; i < 4; i++) assert.equal((await call('PUT', `/api/admin/tool-policy/python`, OWNER, { enabled: i % 2 === 0 })).status, 200)
  const p1 = await call('GET', '/api/admin/audit?limit=2', OWNER)
  assert.equal(p1.status, 200)
  assert.equal(p1.body.items.length, 2)
  assert.ok(p1.body.nextCursor)
  const p2 = await call('GET', `/api/admin/audit?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`, OWNER)
  const p3 = await call('GET', `/api/admin/audit?limit=2&cursor=${encodeURIComponent(p2.body.nextCursor)}`, OWNER)
  const items = [...p1.body.items, ...p2.body.items, ...p3.body.items]
  assert.equal(items.length, 5)
  assert.equal(p3.body.nextCursor, null)
  assert.deepEqual(items.map((r) => r.action), ['tool_policy.set', 'tool_policy.set', 'tool_policy.set', 'tool_policy.set', 'settings.update'])
  assert.equal((await call('GET', '/api/admin/audit?cursor=garbage', OWNER)).status, 400)
  assert.ok(!JSON.stringify(items).includes('@'))
})

test('org instructions reach the model on a chat turn through the context-provider registry; cleared → absent', { skip: SKIP }, async () => {
  const marker = `ORG-${stamp}`
  assert.equal((await call('PUT', '/api/admin/settings', OWNER, { orgInstructions: `Assine como ${marker}.` })).status, 200)
  const systemOf = async () => {
    const form = new FormData()
    form.append('payload', JSON.stringify({ prompt: `Responda apenas com a palavra OK. (${stamp})`, model: MODEL, enabledTools: [] }))
    const res = await fetch(`${base}/api/chat`, as(A, { method: 'POST', body: form }))
    assert.equal(res.status, 200)
    await res.text()
    const turn = gw.requests.filter((r) => r.path === '/serving-endpoints/chat/completions' && r.body?.stream).at(-1)
    return (turn.body.messages || []).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
  }
  assert.ok((await systemOf()).includes(marker), 'injected')
  assert.equal((await call('PUT', '/api/admin/settings', OWNER, { orgInstructions: '' })).status, 200)
  assert.ok(!(await systemOf()).includes(marker), 'gone once cleared')
})
