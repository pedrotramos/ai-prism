// N1a QA round 1: the project-context read is bounded in what it transfers and in
// how long it holds a pooled connection (real Postgres, db.js as the NON-OWNER app role).
//
//   1. Files with no stored count (uploaded before migration 0009) are counted IN
//      SQL, never by moving their text into the app; a file the selection does not
//      read never has its body transferred (budget 0 transfers none at all). The count
//      is not written back: project_files has no UPDATE policy on purpose.
//   2. The provider's timeout also bounds the DATABASE: the read runs with a
//      transaction-local statement_timeout slightly below it, so Postgres cancels
//      the statement and the connection returns to the pool (the health route's pattern).
//
// Scratch database on the local test server; no Postgres with pgvector -> skipped.
//
//   node --test server/projectContextReads.test.js
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')

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
const OWNER = `n1a-reads-${stamp}@test.invalid`
const VIEWER = `n1a-reads-view-${stamp}@test.invalid`
const DB = `n1a_reads_${stamp}`
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

// every SELECT of file bodies the app issues, as a statement text
const bodyReads = []
const writes = []
const realQuery = pg.Client.prototype.query
pg.Client.prototype.query = function (...args) {
  const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text
  if (/content_text/i.test(sql || '') && /^\s*SELECT/i.test(sql || '') && !/length\(|char_length\(/i.test(sql || '')) bodyReads.push(sql)
  if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql || '') && /project_files/i.test(sql || '')) writes.push(sql)
  return realQuery.apply(this, args)
}

let admin, raw, projects, context, projectId, sessionId
const q = async (sql, params = []) => (await raw.query(sql, params)).rows

before(async () => {
  if (SKIP) return
  admin = new pg.Client(opts(ADMIN_DB))
  await admin.connect()
  await admin.query(`CREATE DATABASE ${DB}`)
  const c = new pg.Client(opts(DB))
  await c.connect()
  try {
    const hasRole = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])
    if (!hasRole.rows.length && APP_ROLE === 'ai_prism_app') await c.query(fs.readFileSync(path.join(REPO, 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
    const { migrateUp } = await import('./db/migrate.js')
    const { applyAppGrants } = await import('./db/grants.js')
    await migrateUp(c, { log: quiet })
    await applyAppGrants(c, { role: APP_ROLE, log: quiet })
  } finally {
    await c.end().catch(() => {})
  }
  raw = new pg.Client(opts(DB))
  await raw.connect()
  await raw.query(`SET search_path TO ai_prism, public`)
  env.PGDATABASE = DB
  env.PGUSER = APP_ROLE
  projects = await import('./db/projects.js')
  context = await import('./projectContext.js')
  const p = await projects.createProject(OWNER, undefined, { name: 'Legacy files', instructions: '' })
  projectId = p.id
  await q(`INSERT INTO project_members (project_id, kind, principal, role) VALUES ($1, 'user', $2, 'view')`, [projectId, VIEWER])
  sessionId = String((await q(`INSERT INTO chat_sessions (user_email, title, model, project_id) VALUES ($1, 't', 'm', $2) RETURNING id`, [OWNER, projectId]))[0].id)
})

after(async () => {
  pg.Client.prototype.query = realQuery
  await raw?.end().catch(() => {})
  try {
    const pool = await import('./db/pool.js')
    await pool.closeAll?.()
  } catch {}
  if (SKIP || !admin) return
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]).catch(() => {})
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {})
  await admin.end().catch(() => {})
})

async function legacyFiles(files) {
  await q(`DELETE FROM project_files WHERE project_id = $1`, [projectId])
  for (const [name, text] of files) {
    await q(`INSERT INTO project_files (project_id, name, size_bytes, content_text, uploaded_by) VALUES ($1, $2, $3, $4, $5)`, [projectId, name, text.length, text, OWNER])
  }
}

test('budget 0: legacy files are excluded without transferring any body', { skip: SKIP }, async () => {
  await legacyFiles([['old-a.txt', 'a'.repeat(50_000)], ['old-b.txt', 'b'.repeat(50_000)]])
  bodyReads.length = 0
  const ctx = await projects.getProjectTurnContext(OWNER, undefined, sessionId, context.projectContextDeps(0))
  assert.deepEqual(ctx.files, [])
  assert.deepEqual(ctx.excluded, ['old-a.txt', 'old-b.txt'])
  assert.deepEqual(bodyReads, [], 'excluded files must not transfer content_text into the app')
})

test('only the files the selection reads have their body transferred, legacy ones included', { skip: SKIP }, async () => {
  // 1000 + 3000 + 1000 tokens, budget 2500: the first whole, the second clipped to the 1500 left, the third excluded
  await legacyFiles([['one.txt', 'x'.repeat(2000)], ['two.txt', 'y'.repeat(6000)], ['three.txt', 'z'.repeat(2000)]])
  bodyReads.length = 0
  const ctx = await projects.getProjectTurnContext(OWNER, undefined, sessionId, context.projectContextDeps(2500))
  assert.deepEqual(ctx.files.map((f) => [f.name, f.mode]), [['one.txt', 'full'], ['two.txt', 'partial']])
  assert.deepEqual(ctx.excluded, ['three.txt'])
  assert.equal(bodyReads.length, 1, 'one read of bodies')
  assert.match(bodyReads[0], /ANY\(\$2/i)
})

test('the SQL count of a legacy file equals memoryTokens for every script (ASCII, accents, CJK, emoji)', { skip: SKIP }, async () => {
  const { memoryTokens } = await import('./memory.js')
  const samples = ['', 'abc', 'ação número', '日本語のテキスト', 'emoji 😀😀 end', 'mix ä漢😀 z'.repeat(50), 'x'.repeat(1001)]
  await legacyFiles(samples.map((s, i) => [`s${i}.txt`, s]))
  const out = await projects.listFiles(OWNER, undefined, projectId, context.projectContextDeps(120_000))
  assert.deepEqual(
    out.files.map((f) => f.context_tokens),
    samples.map((s) => memoryTokens(s))
  )
})

test('a legacy file is read by a viewer too, and the count is never written back (no UPDATE on project_files)', { skip: SKIP }, async () => {
  await legacyFiles([['p.txt', 'abcdefgh'], ['q.txt', 'ação']])
  writes.length = 0
  for (const who of [VIEWER, OWNER]) {
    const ctx = await projects.getProjectTurnContext(who, undefined, sessionId, context.projectContextDeps(1000))
    assert.deepEqual(ctx.files.map((f) => f.text), ['abcdefgh', 'ação'])
  }
  assert.deepEqual(writes, [], 'a read never writes')
  assert.deepEqual((await q(`SELECT context_tokens FROM project_files WHERE project_id = $1 ORDER BY id`, [projectId])).map((r) => r.context_tokens), [null, null])
})

test('a provider timeout cancels the statement: the pooled connection is released', { skip: SKIP }, async () => {
  await legacyFiles([['a.txt', 'a']])
  const previous = pg.Client.prototype.query
  let started
  const queryStarted = new Promise((resolve) => {
    started = resolve
  })
  pg.Client.prototype.query = function (...args) {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text
    if (/FROM project_files WHERE project_id = \$1 ORDER BY id/i.test(sql || '')) {
      started()
      // the same statement, made slow on the server
      return previous.call(this, { text: `SELECT delay.qa_delay, files.* FROM (SELECT pg_sleep(2) AS qa_delay) AS delay CROSS JOIN (${sql}) AS files`, values: args[1] })
    }
    return previous.apply(this, args)
  }
  const slowActive = async () =>
    (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND usename = $2 AND state = 'active' AND query LIKE '%pg_sleep(2)%'`, [DB, APP_ROLE])).rows[0].n > 0
  try {
    const provider = context.createProjectContextProvider({ timeoutMs: 100, budget: 0, warn() {} })
    const pending = provider({ req: { email: OWNER, token: undefined }, sessionId })
    await queryStarted
    const messages = await pending
    assert.deepEqual(messages, [])
    // by the time the provider gave up, Postgres must already have cancelled the statement
    const end = Date.now() + 1500
    while (Date.now() < end && (await slowActive())) await new Promise((r) => setTimeout(r, 10))
    assert.equal(await slowActive(), false, 'a timed-out project read must not keep using a pooled connection')
  } finally {
    pg.Client.prototype.query = previous
  }
})
