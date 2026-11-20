// N4: project membership as a per-statement SET (migration 0008, ADR-0016).
//
// 0008 replaces every membership test `aip_project_rank(x) IS NOT NULL` in the
// aipj_* policies with `x = ANY ((SELECT aip_my_project_ids()))`, so the planner
// evaluates the membership once per statement (an InitPlan) instead of calling a
// SECURITY DEFINER function twice per project session. This file proves that:
//
//   1. nothing changed for any caller: the same matrix of identities {owner,
//      manage, view} x {direct, group}, a non-member, no identity, the admin flag,
//      the maintenance flag, a failed SCIM lookup and malformed groups runs on a
//      database at 0007 and on one at 0008 and sees the same rows and gets the
//      same allowed / refused writes on every aipj_* table (SELECT, INSERT,
//      UPDATE, DELETE);
//   2. the work no longer depends on the number of project sessions: counted by
//      function calls (never by time), at 20 and at 40 sessions;
//   3. aip_my_project_ids() itself (a sorted, distinct set; empty without an
//      identity), the policies that must keep the rank (role levels), and the
//      down migration, which restores the 0007 policy set byte for byte;
//   4. the app's own SQL helpers use the set, not the per-row call.
//
// Scratch databases on the local test server (like isolation.projects.test.js);
// no Postgres with pgvector -> skipped.
//
//   node --test server/projectPolicyEquivalence.test.js
import test, { after, before } from 'node:test'
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
const who = (n) => `n4-${n}-${stamp}@test.invalid`
const OWNER = who('owner')
const MANAGER = who('manage')
const VIEWER = who('view')
const OUTSIDER = who('outsider')
const OTHER = who('other')
const MULTI = who('multi') // a direct view row AND a group manage row in the same project
const GOWN = `n4 owners ${stamp}`
const GMAN = `n4 managers ${stamp}`
const GVIEW = `n4 viewers ${stamp}`
const GROUPIE = who('groupie')

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

/** A directory holding only the migrations up to `max` (the 0007 reference schema). */
function migrationsUpTo(max) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n4-migrations-'))
  tmpDirs.push(dir)
  for (const f of fs.readdirSync(MIGRATIONS)) {
    const v = Number(f.slice(0, 4))
    if (Number.isFinite(v) && v <= max) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f))
  }
  return dir
}

/** A scratch database migrated with `dir` (default: every migration), the app role granted. */
async function scratch(dir) {
  const name = `n4_db_${stamp}_${createdDbs.length + 1}`
  await superuser(`CREATE DATABASE ${name}`)
  createdDbs.push(name)
  // function calls are counted per database, so the bound app role needs no privilege
  await superuser(`ALTER DATABASE ${name} SET track_functions = 'all'`)
  const c = new pg.Client(opts(name))
  await c.connect()
  try {
    const hasRole = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])
    if (!hasRole.rows.length && APP_ROLE === 'ai_prism_app') {
      await c.query(fs.readFileSync(path.join(REPO, 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
    }
    const { migrateUp } = await import('./db/migrate.js')
    const { applyAppGrants } = await import('./db/grants.js')
    await migrateUp(c, { dir, log: quiet })
    await applyAppGrants(c, { role: APP_ROLE, log: quiet })
  } finally {
    await c.end().catch(() => {})
  }
  return name
}

after(async () => {
  await OLD?.close()
  await NEW?.close()
  if (SKIP) return
  for (const name of createdDbs) {
    await superuser(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]).catch(() => {})
    await superuser(`DROP DATABASE IF EXISTS ${name}`).catch(() => {})
  }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

const VEC = `[${Array.from({ length: 1024 }, () => 0.1).join(',')}]`

/** A database plus its fixtures: `raw` is the superuser, `app` the bound app role. */
async function open(dir) {
  const db = await scratch(dir)
  const raw = new pg.Client(opts(db))
  await raw.connect()
  await raw.query(`SET search_path TO ai_prism, public`)
  const app = new pg.Client(opts(db, APP_ROLE))
  await app.connect()
  await app.query(`SET search_path TO ai_prism, public`)
  return { db, raw, app, fx: {}, async close() { await app.end().catch(() => {}); await raw.end().catch(() => {}) } }
}

async function seedChat(raw, email, projectId, title) {
  const q = async (sql, params) => (await raw.query(sql, params)).rows
  const s = (await q(`INSERT INTO chat_sessions (user_email, title, model, project_id) VALUES ($1, $2, 'm', $3) RETURNING id`, [email, title, projectId]))[0].id
  const m = (await q(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'oi') RETURNING id`, [s]))[0].id
  await q(`INSERT INTO chat_tool_calls (message_id, seq, tool_name, status) VALUES ($1, 0, 't', 'ok')`, [m])
  await q(`INSERT INTO chat_genie_conversations (session_id, space_id, conversation_id) VALUES ($1, 'sp', 'c')`, [s])
  await q(`INSERT INTO chat_compactions (session_id, upto_message_id, content) VALUES ($1, $2, 'x')`, [s, m])
  await q(`INSERT INTO chat_message_embeddings (message_id, session_id, embedding) VALUES ($1, $2, $3::vector)`, [m, s, VEC])
  await q(`INSERT INTO usage_ledger (user_email, session_id, kind, model, cost_usd) VALUES ($1, $2, 'chat', 'm', 1)`, [email, s])
  await q(`INSERT INTO chat_decks (session_id, user_email, title) VALUES ($1, $2, 'd')`, [s, email])
  await q(`INSERT INTO chat_spreadsheets (session_id, user_email, title) VALUES ($1, $2, 's')`, [s, email])
  await q(`INSERT INTO chat_documents (session_id, user_email, title, markdown) VALUES ($1, $2, 'd', 'x')`, [s, email])
  await q(`INSERT INTO chat_images (session_id, user_email, prompt, model, volume_path, content_type) VALUES ($1, $2, 'p', 'm', '/Volumes/x/y.png', 'image/png')`, [s, email])
  return { s: String(s), m: String(m) }
}

async function seed(h) {
  const { raw, fx } = h
  const q = async (sql, params) => (await raw.query(sql, params)).rows
  fx.p = String((await q(`INSERT INTO projects (name, created_by) VALUES ('P', $1) RETURNING id`, [OWNER]))[0].id)
  fx.p2 = String((await q(`INSERT INTO projects (name, created_by) VALUES ('P2', $1) RETURNING id`, [OTHER]))[0].id)
  await q(
    `INSERT INTO project_members (project_id, kind, principal, role) VALUES
       ($1, 'user', $2, 'manage'), ($1, 'user', $3, 'view'),
       ($1, 'group', $4, 'owner'), ($1, 'group', $5, 'manage'), ($1, 'group', $6, 'view'),
       ($1, 'user', $7, 'view')`,
    [fx.p, MANAGER, VIEWER, GOWN, GMAN, GVIEW, MULTI]
  )
  // MULTI also reaches P through a group: two rows match the same project
  await q(`INSERT INTO project_members (project_id, kind, principal, role) VALUES ($1, 'group', $2, 'manage')`, [fx.p, `${GMAN}-multi`])
  await q(`INSERT INTO project_files (project_id, name, size_bytes, content_text, uploaded_by) VALUES ($1, 'a.txt', 2, 'oi', $2)`, [fx.p, OWNER])
  fx.shared = await seedChat(raw, OWNER, fx.p, 'shared')
  fx.other = await seedChat(raw, OTHER, fx.p2, 'other project')
  fx.personal = await seedChat(raw, OWNER, null, 'personal')
}

/** fn(app) inside a transaction with this identity, rolled back. */
async function asIdentity(app, id, fn) {
  await app.query('BEGIN')
  try {
    const settings = [
      ['app.user_email', id.email ?? ''],
      ['app.is_admin', id.admin ? 'on' : 'off'],
      ['app.user_groups', id.rawGroups ?? JSON.stringify(id.groups || [])],
    ]
    if (id.maintenance) settings.push(['app.maintenance', 'on'])
    for (const [k, v] of settings) await app.query(`SELECT set_config($1, $2, true)`, [k, v])
    return await fn(app)
  } finally {
    await app.query('ROLLBACK')
  }
}

const IDENTITIES = {
  owner: { email: OWNER },
  manage: { email: MANAGER },
  view: { email: VIEWER },
  'group owner': { email: GROUPIE, groups: [GOWN] },
  'group manage': { email: GROUPIE, groups: [GMAN] },
  'group view': { email: GROUPIE, groups: [GVIEW] },
  'group, upper case': { email: GROUPIE, groups: [GMAN.toUpperCase()] },
  'direct view + group manage on the same project': { email: MULTI, groups: [`${GMAN}-multi`] },
  'member of the other project only': { email: OTHER },
  'non-member': { email: OUTSIDER },
  'non-member, admin flag on': { email: OUTSIDER, admin: true },
  'non-member, a group named like a member e-mail': { email: OUTSIDER, groups: [MANAGER] },
  'no identity': { email: '', groups: [GOWN], admin: true },
  'maintenance identity': { email: '', maintenance: true, admin: true, groups: [GOWN] },
  'SCIM failure (empty groups) for a group member': { email: GROUPIE, groups: [] },
  'malformed groups: not json': { email: GROUPIE, rawGroups: 'not json' },
  'malformed groups: object': { email: GROUPIE, rawGroups: '{"a":1}' },
  'malformed groups: mixed array': { email: GROUPIE, rawGroups: JSON.stringify([GOWN, 1]) },
}

const READ_TABLES = {
  projects: `SELECT id::text AS k FROM projects`,
  project_members: `SELECT project_id::text || '/' || kind || '/' || principal AS k FROM project_members`,
  project_files: `SELECT id::text AS k FROM project_files`,
  chat_sessions: `SELECT id::text AS k FROM chat_sessions`,
  chat_messages: `SELECT id::text AS k FROM chat_messages`,
  chat_tool_calls: `SELECT id::text AS k FROM chat_tool_calls`,
  chat_genie_conversations: `SELECT session_id::text AS k FROM chat_genie_conversations`,
  chat_compactions: `SELECT id::text AS k FROM chat_compactions`,
  chat_message_embeddings: `SELECT message_id::text AS k FROM chat_message_embeddings`,
  usage_ledger: `SELECT id::text AS k FROM usage_ledger`,
  chat_decks: `SELECT id::text AS k FROM chat_decks`,
  chat_spreadsheets: `SELECT id::text AS k FROM chat_spreadsheets`,
  chat_documents: `SELECT id::text AS k FROM chat_documents`,
  chat_images: `SELECT id::text AS k FROM chat_images`,
}

/** Every write the matrix tries, as [name, sql, params(fx, email)]. Each runs in its own savepoint. */
function writes(fx, email) {
  const me = email || OWNER
  const sh = fx.shared
  return [
    ['projects INSERT', `INSERT INTO projects (name, created_by) VALUES ('x', $1)`, [email]],
    ['projects UPDATE', `UPDATE projects SET instructions = 'x' WHERE id = $1`, [fx.p]],
    ['projects DELETE', `DELETE FROM projects WHERE id = $1`, [fx.p]],
    ['project_members INSERT view', `INSERT INTO project_members (project_id, kind, principal, role) VALUES ($1, 'user', 'new-view@test.invalid', 'view')`, [fx.p]],
    ['project_members INSERT owner', `INSERT INTO project_members (project_id, kind, principal, role) VALUES ($1, 'user', 'new-owner@test.invalid', 'owner')`, [fx.p]],
    ['project_members UPDATE', `UPDATE project_members SET role = 'manage' WHERE project_id = $1 AND principal = $2`, [fx.p, VIEWER]],
    ['project_members UPDATE owner row', `UPDATE project_members SET role = 'view' WHERE project_id = $1 AND principal = $2`, [fx.p, OWNER]],
    ['project_members DELETE other', `DELETE FROM project_members WHERE project_id = $1 AND principal = $2`, [fx.p, VIEWER]],
    ['project_members DELETE self', `DELETE FROM project_members WHERE project_id = $1 AND kind = 'user' AND principal = $2`, [fx.p, email]],
    ['project_files INSERT', `INSERT INTO project_files (project_id, name, size_bytes, content_text, uploaded_by) VALUES ($1, 'b.txt', 1, 'b', $2)`, [fx.p, me]],
    ['project_files INSERT as someone else', `INSERT INTO project_files (project_id, name, size_bytes, content_text, uploaded_by) VALUES ($1, 'b.txt', 1, 'b', $2)`, [fx.p, OWNER + '.x']],
    // 0005 defines no UPDATE policy on project_files: under RLS the statement matches no row for anybody
    ['project_files UPDATE', `UPDATE project_files SET name = 'c.txt' WHERE project_id = $1`, [fx.p]],
    ['project_files UPDATE content', `UPDATE project_files SET content_text = 'x', size_bytes = 1 WHERE project_id = $1`, [fx.p]],
    ['project_files UPDATE move to the other project', `UPDATE project_files SET project_id = $2 WHERE project_id = $1`, [fx.p, fx.p2]],
    ['project_files UPDATE uploaded_by', `UPDATE project_files SET uploaded_by = $2 WHERE project_id = $1`, [fx.p, me]],
    ['project_files DELETE', `DELETE FROM project_files WHERE project_id = $1`, [fx.p]],
    ['chat_sessions INSERT in the project', `INSERT INTO chat_sessions (user_email, title, model, project_id) VALUES ($1, 'n', 'm', $2)`, [me, fx.p]],
    ['chat_sessions INSERT in the other project', `INSERT INTO chat_sessions (user_email, title, model, project_id) VALUES ($1, 'n', 'm', $2)`, [me, fx.p2]],
    ['chat_sessions UPDATE', `UPDATE chat_sessions SET title = 'y' WHERE id = $1`, [sh.s]],
    ['chat_sessions UPDATE detach', `UPDATE chat_sessions SET project_id = NULL WHERE id = $1`, [sh.s]],
    ['chat_sessions UPDATE move to the other project', `UPDATE chat_sessions SET project_id = $2 WHERE id = $1`, [sh.s, fx.p2]],
    ['chat_sessions UPDATE attach a personal chat', `UPDATE chat_sessions SET project_id = $2 WHERE id = $1`, [fx.personal.s, fx.p]],
    ['chat_sessions DELETE', `DELETE FROM chat_sessions WHERE id = $1`, [sh.s]],
    ['chat_messages INSERT', `INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'z')`, [sh.s]],
    ['chat_messages UPDATE', `UPDATE chat_messages SET content = 'z' WHERE session_id = $1`, [sh.s]],
    ['chat_messages DELETE', `DELETE FROM chat_messages WHERE session_id = $1`, [sh.s]],
    ['chat_tool_calls INSERT', `INSERT INTO chat_tool_calls (message_id, seq, tool_name, status) VALUES ($1, 9, 't', 'ok')`, [sh.m]],
    ['chat_tool_calls UPDATE', `UPDATE chat_tool_calls SET status = 'err' WHERE message_id = $1`, [sh.m]],
    ['chat_tool_calls DELETE', `DELETE FROM chat_tool_calls WHERE message_id = $1`, [sh.m]],
    ['chat_genie_conversations INSERT', `INSERT INTO chat_genie_conversations (session_id, space_id, conversation_id) VALUES ($1, 'sp2', 'c2')`, [sh.s]],
    ['chat_genie_conversations UPDATE', `UPDATE chat_genie_conversations SET conversation_id = 'c3' WHERE session_id = $1`, [sh.s]],
    ['chat_genie_conversations DELETE', `DELETE FROM chat_genie_conversations WHERE session_id = $1`, [sh.s]],
    ['chat_compactions INSERT', `INSERT INTO chat_compactions (session_id, upto_message_id, content) VALUES ($1, $2, 'y')`, [sh.s, sh.m]],
    ['chat_compactions UPDATE', `UPDATE chat_compactions SET content = 'z' WHERE session_id = $1`, [sh.s]],
    ['chat_compactions DELETE', `DELETE FROM chat_compactions WHERE session_id = $1`, [sh.s]],
    ['chat_message_embeddings INSERT', `INSERT INTO chat_message_embeddings (message_id, session_id, embedding) VALUES ($1, $2, '${VEC}'::vector)`, [sh.m, sh.s]],
    ['chat_message_embeddings UPDATE', `UPDATE chat_message_embeddings SET embedding = '${VEC}'::vector WHERE session_id = $1`, [sh.s]],
    ['chat_message_embeddings DELETE', `DELETE FROM chat_message_embeddings WHERE session_id = $1`, [sh.s]],
    ['usage_ledger INSERT', `INSERT INTO usage_ledger (user_email, session_id, kind, model) VALUES ($1, $2, 'chat', 'm')`, [me, sh.s]],
    ['usage_ledger INSERT as someone else', `INSERT INTO usage_ledger (user_email, session_id, kind, model) VALUES ($1, $2, 'chat', 'm')`, [OWNER + '.x', sh.s]],
    ['usage_ledger UPDATE', `UPDATE usage_ledger SET cost_usd = 2 WHERE session_id = $1`, [sh.s]],
    ['usage_ledger DELETE', `DELETE FROM usage_ledger WHERE session_id = $1`, [sh.s]],
    ['chat_decks INSERT', `INSERT INTO chat_decks (session_id, user_email, title) VALUES ($1, $2, 'n')`, [sh.s, me]],
    ['chat_decks UPDATE', `UPDATE chat_decks SET title = 'z' WHERE session_id = $1`, [sh.s]],
    ['chat_decks DELETE', `DELETE FROM chat_decks WHERE session_id = $1`, [sh.s]],
    ['chat_spreadsheets INSERT', `INSERT INTO chat_spreadsheets (session_id, user_email, title) VALUES ($1, $2, 'n')`, [sh.s, me]],
    ['chat_spreadsheets UPDATE', `UPDATE chat_spreadsheets SET title = 'z' WHERE session_id = $1`, [sh.s]],
    ['chat_spreadsheets DELETE', `DELETE FROM chat_spreadsheets WHERE session_id = $1`, [sh.s]],
    ['chat_documents INSERT', `INSERT INTO chat_documents (session_id, user_email, title, markdown) VALUES ($1, $2, 'n', 'x')`, [sh.s, me]],
    ['chat_documents UPDATE', `UPDATE chat_documents SET title = 'z' WHERE session_id = $1`, [sh.s]],
    ['chat_documents DELETE', `DELETE FROM chat_documents WHERE session_id = $1`, [sh.s]],
    ['chat_images INSERT', `INSERT INTO chat_images (session_id, user_email, prompt, model, volume_path) VALUES ($1, $2, 'p', 'm', '/Volumes/a/b.png')`, [sh.s, me]],
    ['chat_images UPDATE', `UPDATE chat_images SET prompt = 'z' WHERE session_id = $1`, [sh.s]],
    ['chat_images DELETE', `DELETE FROM chat_images WHERE session_id = $1`, [sh.s]],
  ]
}

/** What this identity sees (every table) and which writes it is allowed. */
async function snapshot(h, id) {
  return asIdentity(h.app, id, async (c) => {
    const reads = {}
    for (const [t, sql] of Object.entries(READ_TABLES)) {
      reads[t] = (await c.query(`${sql} ORDER BY 1`)).rows.map((r) => r.k)
    }
    const outcomes = {}
    for (const [name, sql, params] of writes(h.fx, id.email)) {
      await c.query('SAVEPOINT w')
      try {
        const r = await c.query(sql, params)
        outcomes[name] = `ok:${r.rowCount}`
      } catch (e) {
        outcomes[name] = `err:${e.code}`
      }
      await c.query('ROLLBACK TO SAVEPOINT w')
    }
    return { reads, outcomes }
  })
}

let OLD // a database at 0007 (the reference)
let NEW // a database at 0008 (migrationsUpTo(8): later migrations are out of this comparison)

before(async () => {
  if (SKIP) return
  OLD = await open(migrationsUpTo(7))
  await seed(OLD)
  // 0008 is the head of THIS comparison (0007 vs 0008): later migrations change other tables' policies
  // (0010 lets an admin read the usage ledger), which is not what the matrix is about
  NEW = await open(migrationsUpTo(8))
  await seed(NEW)
})

// ---- 1. equivalence ------------------------------------------------------------

test('0008 exists and is what the NEW database runs', { skip: SKIP }, async () => {
  const { loadMigrations } = await import('./db/migrate.js')
  const v = loadMigrations(MIGRATIONS).map((m) => `${m.version}:${m.name}`)
  assert.ok(v.includes('8:project_member_set'), `migrations: ${v.join(', ')}`)
  const has = async (h) => (await h.raw.query(`SELECT to_regprocedure('ai_prism.aip_my_project_ids()') AS f`)).rows[0].f
  assert.equal(await has(OLD), null, '0007 has no set function')
  assert.equal(await has(NEW), 'aip_my_project_ids()')
})

test('the identity matrix sees the same rows and gets the same writes at 0007 and at 0008', { skip: SKIP }, async () => {
  let refusals = 0
  let allowed = 0
  for (const [label, id] of Object.entries(IDENTITIES)) {
    const before7 = await snapshot(OLD, id)
    const after8 = await snapshot(NEW, id)
    assert.deepEqual(after8.reads, before7.reads, `${label}: visible rows`)
    assert.deepEqual(after8.outcomes, before7.outcomes, `${label}: allowed and refused writes`)
    for (const o of Object.values(after8.outcomes)) (o.startsWith('err:') ? refusals++ : allowed++)
  }
  // the matrix is not vacuous: it exercises both outcomes many times
  assert.ok(refusals > 100 && allowed > 100, `refusals=${refusals} allowed=${allowed}`)
})

test('hand-derived anchors hold at 0008: a view member reads and posts, cannot edit the project; a non-member sees nothing; admin and maintenance add nothing', { skip: SKIP }, async () => {
  const view = await snapshot(NEW, IDENTITIES.view)
  assert.deepEqual(view.reads.projects, [NEW.fx.p])
  assert.deepEqual(view.reads.chat_sessions, [NEW.fx.shared.s])
  assert.equal(view.outcomes['chat_messages INSERT'], 'ok:1')
  assert.equal(view.outcomes['projects UPDATE'], 'ok:0')
  assert.equal(view.outcomes['project_files INSERT'].startsWith('err:'), true)
  for (const label of ['non-member', 'non-member, admin flag on', 'no identity', 'maintenance identity']) {
    const s = await snapshot(NEW, IDENTITIES[label])
    for (const t of ['projects', 'project_members', 'project_files', 'chat_sessions', 'chat_messages']) {
      assert.deepEqual(s.reads[t], [], `${label}: ${t}`)
    }
    assert.equal(s.outcomes['chat_messages INSERT'].startsWith('err:'), true, label)
  }
  const multi = await snapshot(NEW, IDENTITIES['direct view + group manage on the same project'])
  assert.equal(multi.outcomes['projects UPDATE'], 'ok:1', 'the highest of two matching rows decides (rank kept for role levels)')
  assert.deepEqual(multi.reads.projects, [NEW.fx.p], 'one project, not one per matching row')
})

test('coverage: every table with an aipj_ policy has SELECT, INSERT, UPDATE and DELETE cases in the matrix', { skip: SKIP }, async () => {
  const tables = (
    await NEW.raw.query(
      `SELECT DISTINCT c.relname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE p.polname LIKE 'aipj\\_%' AND c.relnamespace = 'ai_prism'::regnamespace ORDER BY 1`
    )
  ).rows.map((r) => r.relname)
  assert.equal(tables.length, 14, `tables with aipj_ policies: ${tables.join(', ')}`)
  const names = writes(NEW.fx, OWNER).map(([n]) => n)
  const grid = {}
  for (const t of tables) {
    grid[t] = {
      SELECT: Object.hasOwn(READ_TABLES, t),
      INSERT: names.some((n) => n.startsWith(`${t} INSERT`)),
      UPDATE: names.some((n) => n.startsWith(`${t} UPDATE`)),
      DELETE: names.some((n) => n.startsWith(`${t} DELETE`)),
    }
  }
  const missing = Object.entries(grid).flatMap(([t, ops]) => Object.entries(ops).filter(([, v]) => !v).map(([op]) => `${t} ${op}`))
  assert.deepEqual(missing, [], 'table x operation cases missing from the matrix')
  assert.deepEqual(Object.keys(READ_TABLES).sort(), tables.slice().sort(), 'every read table has an aipj_ policy, and the reverse')
})

test('project_files UPDATE: no policy grants it at 0007 or 0008, so it is refused for every identity while the rows are visible and match', { skip: SKIP }, async () => {
  for (const h of [OLD, NEW]) {
    const cmds = (await h.raw.query(`SELECT polcmd FROM pg_policy WHERE polrelid = 'ai_prism.project_files'::regclass ORDER BY 1`)).rows.map((r) => r.polcmd)
    assert.ok(!cmds.includes('w') && !cmds.includes('*'), `no UPDATE (or ALL) policy on project_files: ${cmds}`)
    // control: the statement does match the row (the superuser, outside RLS, updates it and we roll back)
    await h.raw.query('BEGIN')
    try {
      const r = await h.raw.query(`UPDATE project_files SET name = 'c.txt' WHERE project_id = $1`, [h.fx.p])
      assert.ok(r.rowCount >= 1, 'the UPDATE matches rows when RLS does not apply')
    } finally {
      await h.raw.query('ROLLBACK')
    }
    // the owner sees the row and still cannot update it: refused by the missing policy, not by invisibility
    const owner = await snapshot(h, IDENTITIES.owner)
    assert.ok(owner.reads.project_files.length >= 1)
    for (const k of ['project_files UPDATE', 'project_files UPDATE content', 'project_files UPDATE move to the other project', 'project_files UPDATE uploaded_by']) {
      assert.equal(owner.outcomes[k], 'ok:0', `${k} as owner`)
    }
  }
  // the matrix can tell the two outcomes apart: INSERT on the same table is allowed for owner and refused for a viewer
  const owner = await snapshot(NEW, IDENTITIES.owner)
  const view = await snapshot(NEW, IDENTITIES.view)
  assert.equal(owner.outcomes['project_files INSERT'], 'ok:1')
  assert.ok(view.outcomes['project_files INSERT'].startsWith('err:'))
})

// ---- 2. the work does not depend on the number of project sessions -------------

/** Calls of the two membership functions made by `sql` as `id` (pg_stat_xact_user_functions). */
async function callsFor(h, id, sql, params = []) {
  return asIdentity(h.app, id, async (c) => {
    await c.query(`SELECT pg_stat_clear_snapshot()`)
    const before = await functionCalls(c)
    await c.query(sql, params)
    await c.query(`SELECT pg_stat_clear_snapshot()`)
    const after = await functionCalls(c)
    return {
      rank: (after.aip_project_rank || 0) - (before.aip_project_rank || 0),
      set: (after.aip_my_project_ids || 0) - (before.aip_my_project_ids || 0),
    }
  })
}
async function functionCalls(c) {
  const r = await c.query(
    `SELECT funcname, calls::int AS calls FROM pg_stat_xact_user_functions WHERE funcname IN ('aip_project_rank', 'aip_my_project_ids')`
  )
  return Object.fromEntries(r.rows.map((x) => [x.funcname, x.calls]))
}

test('work count: policy checks on one session read the membership set a constant number of times, never the per-row rank, at 20 and at 40 project sessions', { skip: SKIP }, async () => {
  const h = NEW
  const seen = []
  for (const total of [20, 40]) {
    const have = Number((await h.raw.query(`SELECT count(*)::int AS n FROM chat_sessions WHERE project_id = $1`, [h.fx.p])).rows[0].n)
    for (let i = have; i < total; i++) await seedChat(h.raw, OWNER, h.fx.p, `bulk ${i}`)
    const id = IDENTITIES.view
    const sid = h.fx.shared.s
    const q2 = await callsFor(h, id, `SELECT m.id FROM chat_messages m WHERE m.session_id = $1 ORDER BY m.id`, [sid])
    const q1 = await callsFor(h, id, `SELECT s.id FROM chat_sessions s WHERE s.user_email = $1 ORDER BY s.updated_at DESC LIMIT 100`, [OWNER])
    const q4 = await callsFor(h, IDENTITIES['group view'], `SELECT e.message_id FROM chat_message_embeddings e WHERE e.session_id = $1`, [sid])
    seen.push({ total, q1, q2, q4 })
  }
  for (const k of ['q1', 'q2', 'q4']) {
    assert.equal(seen[0][k].rank, 0, `${k}: no per-row aip_project_rank at ${seen[0].total} sessions`)
    assert.equal(seen[1][k].rank, 0, `${k}: no per-row aip_project_rank at ${seen[1].total} sessions`)
    assert.deepEqual(seen[1][k], seen[0][k], `${k}: the same calls at 20 and at 40 sessions`)
    assert.ok(seen[0][k].set >= 1 && seen[0][k].set <= 4, `${k}: a small constant number of set reads (${seen[0][k].set})`)
  }
})

test('work count at 0007 (the metric works): the old policy calls aip_project_rank and never the set', { skip: SKIP }, async () => {
  const h = OLD
  for (let i = 0; i < 20; i++) await seedChat(h.raw, OWNER, h.fx.p, `bulk ${i}`)
  const c = await callsFor(h, IDENTITIES.view, `SELECT m.id FROM chat_messages m WHERE m.session_id = $1 ORDER BY m.id`, [h.fx.shared.s])
  // how many depends on the plan; the growth with the project sessions (200 -> 400)
  // is shown by scripts/bench/explain.sql, not asserted on a toy table
  assert.ok(c.rank >= 1, `aip_project_rank is called per row (${c.rank})`)
  assert.equal(c.set, 0)
})

// ---- 3. the function, the kept ranks, the down migration -----------------------

test('aip_my_project_ids: a sorted distinct set of the caller’s projects; empty without identity or with bad groups', { skip: SKIP }, async () => {
  const ids = (h, id) => asIdentity(h.app, id, async (c) => (await c.query(`SELECT ai_prism.aip_my_project_ids() AS ids`)).rows[0].ids.map(Number))
  const p = Number(NEW.fx.p)
  const p2 = Number(NEW.fx.p2)
  assert.deepEqual(await ids(NEW, IDENTITIES.owner), [p])
  assert.deepEqual(await ids(NEW, IDENTITIES['group view']), [p])
  assert.deepEqual(await ids(NEW, IDENTITIES['direct view + group manage on the same project']), [p], 'distinct')
  assert.deepEqual(await ids(NEW, { email: OTHER, groups: [GVIEW] }), [p, p2].sort((a, b) => a - b), 'direct + group, sorted')
  for (const label of ['non-member', 'no identity', 'maintenance identity', 'SCIM failure (empty groups) for a group member', 'malformed groups: not json', 'malformed groups: mixed array']) {
    assert.deepEqual(await ids(NEW, IDENTITIES[label]), [], label)
  }
  const f = (await NEW.raw.query(`SELECT prosecdef, provolatile, pg_get_userbyid(proowner) AS owner, proconfig FROM pg_proc WHERE proname = 'aip_my_project_ids'`)).rows[0]
  assert.equal(f.prosecdef, true)
  assert.equal(f.provolatile, 's')
  assert.ok(f.proconfig.some((s) => s.startsWith('search_path=ai_prism')), `pinned search_path: ${f.proconfig}`)
  const own = (await NEW.raw.query(`SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname = 'aip_project_rank'`)).rows[0].owner
  assert.equal(f.owner, own, 'owned like aip_project_rank (it reads project_members as the table owner)')
})

async function policies(c) {
  return (
    await c.query(
      `SELECT p.polrelid::regclass::text AS tbl, p.polname, p.polcmd, p.polpermissive, p.polroles::regrole[]::text AS roles,
              pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS chk
         FROM pg_policy p WHERE p.polrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'ai_prism'::regnamespace)
        ORDER BY 1, 2, 3`
    )
  ).rows
}

test('every aipj_ membership test is the set; the rank stays only for role levels (>= 2, = 3)', { skip: SKIP }, async () => {
  const ps = (await policies(NEW.raw)).filter((p) => p.polname.startsWith('aipj_'))
  // hand count: projects 4 + project_members 4 + project_files 3 + chat_sessions 3 + 4 session tables x 3 + chat_tool_calls 2 + 5 owned tables x 1
  assert.equal(ps.length, 33, `aipj_ policies: ${ps.length}`)
  const perRowMembership = /aip_project_rank\([^)]*\)\s+IS\s+NOT\s+NULL/i
  for (const p of ps) {
    for (const [part, text] of [['USING', p.qual], ['WITH CHECK', p.chk]]) {
      if (!text) continue
      assert.doesNotMatch(text, perRowMembership, `${p.tbl}.${p.polname} ${part}`)
      // a bare rank without a level comparison is a membership test in disguise
      for (const m of text.matchAll(/aip_project_rank\([^)]*\)(\s*(>=|=)\s*\d)?/g)) {
        assert.ok(m[1], `${p.tbl}.${p.polname} ${part}: rank without a level: ${m[0]}`)
      }
    }
  }
  const text = (tbl, name) => {
    const p = ps.find((x) => x.tbl === tbl && x.polname === name)
    return `${p?.qual || ''} ${p?.chk || ''}`
  }
  assert.match(text('chat_sessions', 'aipj_project_gate'), /aip_my_project_ids/)
  assert.match(text('chat_messages', 'aipj_member_read'), /aip_my_project_ids/)
  assert.match(text('projects', 'aipj_read'), /aip_my_project_ids/)
  assert.match(text('projects', 'aipj_update'), /aip_project_rank\(id\) >= 2/)
  assert.match(text('projects', 'aipj_delete'), /aip_project_rank\(id\) = 3/)
})

test('down restores the 0007 policy set byte for byte (and up again restores 0008’s)', { skip: SKIP }, async () => {
  const h = await open(migrationsUpTo(8)) // 0008 is the head here: down --to 7 reverts exactly it
  try {
    const { migrateDown, migrateUp } = await import('./db/migrate.js')
    const at8 = await policies(h.raw)
    const d = await migrateDown(h.raw, { to: 7, log: quiet })
    assert.deepEqual(d.reverted, [8])
    const at7 = await policies(h.raw)
    const reference = await open(migrationsUpTo(7))
    try {
      assert.deepEqual(at7, await policies(reference.raw), 'the policy set after down equals a database that never had 0008')
    } finally {
      await reference.close()
    }
    assert.equal((await h.raw.query(`SELECT to_regprocedure('ai_prism.aip_my_project_ids()') AS f`)).rows[0].f, null, 'the function is gone')
    assert.notDeepEqual(at8, at7)
    const u = await migrateUp(h.raw, { dir: migrationsUpTo(8), log: quiet }) // 0008 is the head here, as above
    assert.deepEqual(u.applied, [8])
    assert.deepEqual(await policies(h.raw), at8, 'down then up is the identity')
  } finally {
    await h.close()
  }
})

// ---- 4. the app's SQL ----------------------------------------------------------

test('the app SQL tests membership with the set, not with a per-row rank call', () => {
  const files = ['db.js', 'db/projects.js', 'ownerScopedWrites.js']
  for (const f of files) {
    const src = fs.readFileSync(path.join(HERE, f), 'utf8')
    assert.doesNotMatch(src, /aip_project_rank\([^)]*\)\s+IS\s+NOT\s+NULL/i, `${f} still tests membership per row`)
  }
})
