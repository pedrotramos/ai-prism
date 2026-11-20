// N1a: migration 0009_project_context (up/down round trip) and the database-side
// guarantees it adds, proven as the NON-OWNER app role (scripts/ci/pg-roles.sql):
//   - chat_messages.sent_by is stamped by a BEFORE INSERT trigger from the
//     transaction identity (app.user_email); a value sent by the client is
//     always overwritten, so authorship cannot be spoofed; no identity → NULL;
//   - project_files.context_tokens accepts NULL (older rows) and refuses negatives;
//   - down restores the 0008 schema exactly (columns, trigger, function, constraint)
//     and up again is the identity.
// Scratch databases on the local test server; no Postgres with pgvector → skipped.
//
//   node --test server/projectContext.migration.test.js
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
env.LOCAL_PGVECTOR = '1'
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET

const SUPERUSER = env.PGUSER
const ADMIN_DB = env.PGDATABASE
const APP_ROLE = env.ISOLATION_APP_ROLE || 'ai_prism_app'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const ANA = `n1a-ana-${stamp}@test.invalid`
const BEA = `n1a-bea-${stamp}@test.invalid`

const opts = (database, user = SUPERUSER) => ({ host: env.PGHOST, port: Number(env.PGPORT), user, password: env.PGPASSWORD, database, ssl: false, connectionTimeoutMillis: 2000 })

async function skipReason() {
  if (!LOCAL_HOSTS.has(env.PGHOST) && env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${env.PGHOST} is not local`
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

function migrationsUpTo(max) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1a-migrations-'))
  tmpDirs.push(dir)
  for (const f of fs.readdirSync(MIGRATIONS)) {
    const v = Number(f.slice(0, 4))
    if (Number.isFinite(v) && v <= max) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f))
  }
  return dir
}

async function open(dir) {
  const db = `n1a_db_${stamp}_${createdDbs.length + 1}`
  await superuser(`CREATE DATABASE ${db}`)
  createdDbs.push(db)
  const c = new pg.Client(opts(db))
  await c.connect()
  try {
    const hasRole = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])
    if (!hasRole.rows.length && APP_ROLE === 'ai_prism_app') await c.query(fs.readFileSync(path.join(REPO, 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
    const { migrateUp } = await import('./db/migrate.js')
    const { applyAppGrants } = await import('./db/grants.js')
    await migrateUp(c, { dir, log: quiet })
    await applyAppGrants(c, { role: APP_ROLE, log: quiet })
  } finally {
    await c.end().catch(() => {})
  }
  const raw = new pg.Client(opts(db))
  await raw.connect()
  await raw.query(`SET search_path TO ai_prism, public`)
  const app = new pg.Client(opts(db, APP_ROLE))
  await app.connect()
  await app.query(`SET search_path TO ai_prism, public`)
  return {
    raw,
    app,
    async close() {
      await app.end().catch(() => {})
      await raw.end().catch(() => {})
    },
  }
}

after(async () => {
  if (SKIP) return
  for (const name of createdDbs) {
    await superuser(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]).catch(() => {})
    await superuser(`DROP DATABASE IF EXISTS ${name}`).catch(() => {})
  }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

/** Everything 0009 touches, read back from the catalog. */
async function snapshot(c) {
  const { readSchemaCatalog } = await import('./db/migrate.js')
  const catalog = await readSchemaCatalog(c)
  const triggers = (await c.query(`SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = 'ai_prism.chat_messages'::regclass AND NOT tgisinternal ORDER BY 1`)).rows
  const fns = (await c.query(`SELECT proname FROM pg_proc WHERE pronamespace = 'ai_prism'::regnamespace ORDER BY 1`)).rows.map((r) => r.proname)
  return { catalog, triggers, fns }
}

async function asIdentity(app, email, fn) {
  await app.query('BEGIN')
  try {
    await app.query(`SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', '', true), set_config('app.user_groups', '[]', true)`, [email ?? ''])
    return await fn(app)
  } finally {
    await app.query('ROLLBACK')
  }
}

test('0009 adds the two columns and the trigger; down removes exactly them; up again is the identity', { skip: SKIP }, async () => {
  const h = await open()
  try {
    const { migrateDown, migrateUp } = await import('./db/migrate.js')
    const at9 = await snapshot(h.raw)
    assert.ok(at9.catalog.columns.includes('chat_messages.sent_by'))
    assert.ok(at9.catalog.columns.includes('project_files.context_tokens'))
    assert.deepEqual(at9.triggers.map((t) => t.tgname), ['aipj_message_sent_by'])
    assert.ok(at9.fns.includes('aipj_message_sent_by'))

    const d = await migrateDown(h.raw, { to: 8, log: quiet })
    assert.deepEqual(d.reverted, [9])
    const at8 = await snapshot(h.raw)
    const reference = await open(migrationsUpTo(8))
    try {
      assert.deepEqual(at8, await snapshot(reference.raw), 'after down the schema equals a database that never had 0009')
    } finally {
      await reference.close()
    }
    assert.ok(!at8.catalog.columns.includes('chat_messages.sent_by'))
    assert.ok(!at8.fns.includes('aipj_message_sent_by'))

    const u = await migrateUp(h.raw, { log: quiet })
    assert.deepEqual(u.applied, [9])
    assert.deepEqual(await snapshot(h.raw), at9)
  } finally {
    await h.close()
  }
})

test('0009 up is idempotent (re-running its SQL changes nothing and does not fail)', { skip: SKIP }, async () => {
  const h = await open()
  try {
    const before = await snapshot(h.raw)
    await h.raw.query(fs.readFileSync(path.join(MIGRATIONS, '0009_project_context.up.sql'), 'utf8'))
    assert.deepEqual(await snapshot(h.raw), before)
  } finally {
    await h.close()
  }
})

test('sent_by is the transaction identity, never the client value; no identity → NULL; legacy rows stay NULL', { skip: SKIP }, async () => {
  const h = await open()
  try {
    const s = (await h.raw.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 't', 'm') RETURNING id`, [ANA])).rows[0].id
    const legacy = (await h.raw.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'antes') RETURNING id, sent_by`, [s])).rows[0]
    assert.equal(legacy.sent_by, null, 'a write without identity (maintenance, legacy) has no author')

    const mine = await asIdentity(h.app, ANA, async (c) => (await c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'eu') RETURNING sent_by`, [s])).rows[0])
    assert.equal(mine.sent_by, ANA)
    const spoof = await asIdentity(h.app, ANA, async (c) =>
      (await c.query(`INSERT INTO chat_messages (session_id, role, content, sent_by) VALUES ($1, 'user', 'x', $2) RETURNING sent_by`, [s, BEA])).rows[0]
    )
    assert.equal(spoof.sent_by, ANA, 'a client-supplied sent_by is overwritten')
    const assistant = await asIdentity(h.app, ANA, async (c) => (await c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'assistant', 'oi') RETURNING sent_by`, [s])).rows[0])
    assert.equal(assistant.sent_by, ANA, 'an assistant row records who triggered the turn')
    const none = await h.raw.query(`SELECT set_config('app.user_email', '', false)`).then(() => h.raw.query(`INSERT INTO chat_messages (session_id, role, content, sent_by) VALUES ($1, 'user', 'y', $2) RETURNING sent_by`, [s, BEA]))
    assert.equal(none.rows[0].sent_by, null, 'with no identity even a supplied value is dropped')
    assert.equal((await h.raw.query(`SELECT sent_by FROM chat_messages WHERE id = $1`, [legacy.id])).rows[0].sent_by, null)
  } finally {
    await h.close()
  }
})

test('project_files.context_tokens: NULL for older rows, never negative', { skip: SKIP }, async () => {
  const h = await open()
  try {
    const p = (await h.raw.query(`INSERT INTO projects (name, created_by) VALUES ('P', $1) RETURNING id`, [ANA])).rows[0].id
    const row = (await h.raw.query(`INSERT INTO project_files (project_id, name, size_bytes, content_text, uploaded_by) VALUES ($1, 'a.txt', 2, 'oi', $2) RETURNING context_tokens`, [p, ANA])).rows[0]
    assert.equal(row.context_tokens, null)
    await h.raw.query(`INSERT INTO project_files (project_id, name, size_bytes, content_text, uploaded_by, context_tokens) VALUES ($1, 'b.txt', 2, 'oi', $2, 0)`, [p, ANA])
    await assert.rejects(
      h.raw.query(`INSERT INTO project_files (project_id, name, size_bytes, content_text, uploaded_by, context_tokens) VALUES ($1, 'c.txt', 2, 'oi', $2, -1)`, [p, ANA]),
      /project_files_context_tokens_check|check constraint/
    )
  } finally {
    await h.close()
  }
})
