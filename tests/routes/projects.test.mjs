// Projects routes (W2-3): CRUD, members (users and SCIM groups, fail closed),
// files, sessions-in-project, and the D4 permission matrix as a TABLE test
// (owner / manage / view / non-member / app admin × read, post turn, edit
// instructions, manage members) against the real app.
//
// The real Express app (server/index.js) on an ephemeral port, the fake AI
// Gateway, and a scratch database of the local test server with db.js
// connected as the NON-OWNER app role (scripts/ci/pg-roles.sql): every request
// runs under row-level security, like production. No Postgres with pgvector →
// skipped (CI runs with --fail-on-skip).
//
//   node --test tests/routes/projects.test.mjs
import test, { after, before } from 'node:test'
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
const who = (n) => `w23r-${n}-${stamp}@test.invalid`
const OWNER = who('owner')
const MANAGER = who('manage')
const VIEWER = who('view')
const OUTSIDER = who('outsider')
const ADMIN = who('admin') // the app owner: an app admin, never a project member
const GROUPIE = who('groupie')
const GROUP = `analytics ${stamp}`
env.APP_OWNER_EMAIL = ADMIN
const MODEL = 'databricks-claude-sonnet-5-5'

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
const DBNAME = `w23r_db_${stamp}`

async function superuser(sql, params = [], database = ADMIN_DB) {
  const c = new pg.Client(opts(database))
  await c.connect()
  try {
    return await c.query(sql, params)
  } finally {
    await c.end().catch(() => {})
  }
}

let raw, gw, server, base, pool, turnLock

before(async () => {
  if (SKIP) return
  await superuser(`CREATE DATABASE ${DBNAME}`)
  const c = new pg.Client(opts(DBNAME))
  await c.connect()
  try {
    const hasRole = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])
    if (!hasRole.rows.length && APP_ROLE === 'ai_prism_app') {
      await c.query(fs.readFileSync(path.join(REPO, 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
    }
    const { migrateUp } = await import('../../server/db/migrate.js')
    const { applyAppGrants } = await import('../../server/db/grants.js')
    await migrateUp(c, { log: quiet })
    await applyAppGrants(c, { role: APP_ROLE, log: quiet })
  } finally {
    await c.end().catch(() => {})
  }
  raw = new pg.Client(opts(DBNAME))
  await raw.connect()
  await raw.query(`SET search_path TO ai_prism, public`)
  env.PGDATABASE = DBNAME
  env.PGUSER = APP_ROLE
  const { startFakeGateway } = await import('../../scripts/fake-gateway.mjs')
  gw = await startFakeGateway({ port: 0 })
  env.DATABRICKS_HOST = gw.url
  pool = await import('../../server/db/pool.js')
  turnLock = (await import('../../server/turnLock.js')).turnLock
  const { app } = await import('../../server/index.js')
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
})

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
  await superuser(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DBNAME]).catch(() => {})
  await superuser(`DROP DATABASE IF EXISTS ${DBNAME}`).catch(() => {})
})

const q = async (sql, params = []) => (await raw.query(sql, params)).rows

async function call(method, p, email, body) {
  const init = { method, headers: { 'x-forwarded-email': email } }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) {
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

/** POST /api/chat as the browser does (multipart); returns status and SSE events. */
async function chat(email, payload) {
  const form = new FormData()
  form.append('payload', JSON.stringify({ model: MODEL, enabledTools: [], ...payload }))
  const res = await fetch(`${base}/api/chat`, { method: 'POST', body: form, headers: { 'x-forwarded-email': email } })
  const text = await res.text()
  const events = text
    .split('\n\n')
    .map((f) => f.trim())
    .filter((f) => f.startsWith('data:'))
    .map((f) => {
      try {
        return JSON.parse(f.slice(5).trim())
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return { status: res.status, events }
}

/** A project of OWNER with MANAGER (manage) and VIEWER (view), and a chat OWNER started in it. */
async function projectWithChat(tag) {
  const created = await call('POST', '/api/projects', OWNER, { name: `P ${tag}`, instructions: 'Seja breve.' })
  assert.equal(created.status, 201, created.text)
  const pid = created.body.project.id
  assert.equal((await call('POST', `/api/projects/${pid}/members`, OWNER, { kind: 'user', principal: MANAGER, role: 'manage' })).status, 201)
  assert.equal((await call('POST', `/api/projects/${pid}/members`, OWNER, { kind: 'user', principal: VIEWER, role: 'view' })).status, 201)
  const turn = await chat(OWNER, { prompt: `Responda OK (${tag})`, projectId: pid })
  assert.equal(turn.status, 200)
  const meta = turn.events.find((e) => e.type === 'meta')
  assert.ok(meta?.sessionId, 'the new chat reports its session id')
  return { pid: String(pid), sid: String(meta.sessionId) }
}

// ---- the D4 permission matrix --------------------------------------------------

const ROLES = { owner: OWNER, manage: MANAGER, view: VIEWER, 'non-member': OUTSIDER, 'app admin': ADMIN }
// expected HTTP status per role; a non-member (app admins included) never learns the project exists
const MATRIX = {
  read: { owner: 200, manage: 200, view: 200, 'non-member': 404, 'app admin': 404 },
  'read shared chat': { owner: 200, manage: 200, view: 200, 'non-member': 404, 'app admin': 404 },
  'post turn': { owner: 200, manage: 200, view: 200, 'non-member': 403, 'app admin': 403 },
  'edit instructions': { owner: 200, manage: 200, view: 403, 'non-member': 404, 'app admin': 404 },
  'manage members': { owner: 201, manage: 201, view: 403, 'non-member': 404, 'app admin': 404 },
}
const ACTIONS = {
  read: (email, fx) => call('GET', `/api/projects/${fx.pid}`, email),
  'read shared chat': (email, fx) => call('GET', `/api/sessions/${fx.sid}`, email),
  'post turn': (email, fx) => chat(email, { sessionId: fx.sid, prompt: `Responda OK (${email})` }),
  'edit instructions': (email, fx) => call('PATCH', `/api/projects/${fx.pid}`, email, { instructions: `por ${email}` }),
  'manage members': (email, fx) =>
    call('POST', `/api/projects/${fx.pid}/members`, email, { kind: 'user', principal: who(`added-by-${email.split('-')[1]}`), role: 'view' }),
}

test('the permission matrix: owner / manage / view / non-member / app admin × read, post turn, edit instructions, manage members', { skip: SKIP }, async () => {
  const fx = await projectWithChat('matrix')
  const got = {}
  for (const action of Object.keys(MATRIX)) {
    got[action] = {}
    for (const [role, email] of Object.entries(ROLES)) got[action][role] = (await ACTIONS[action](email, fx)).status
  }
  assert.deepEqual(got, MATRIX)
  // the denied writes changed nothing: instructions are the last allowed writer's
  assert.equal((await q(`SELECT instructions FROM projects WHERE id = $1`, [fx.pid]))[0].instructions, `por ${MANAGER}`)
  // the viewer's and the manager's turns are in the shared chat; the outsider's and the admin's are not
  const contents = (await q(`SELECT content FROM chat_messages WHERE session_id = $1 AND role = 'user'`, [fx.sid])).map((r) => r.content)
  for (const email of [OWNER, MANAGER, VIEWER]) assert.ok(contents.some((c) => c.includes(email)), `${email} posted`)
  for (const email of [OUTSIDER, ADMIN]) assert.ok(!contents.some((c) => c.includes(email)), `${email} did not post`)
})

test('a member reads the shared chat’s messages through the existing route; a non-member gets none', { skip: SKIP }, async () => {
  const fx = await projectWithChat('messages')
  const v = await call('GET', `/api/sessions/${fx.sid}/messages`, VIEWER)
  assert.equal(v.status, 200)
  assert.ok(v.body.messages.length >= 2, 'user + assistant')
  for (const email of [OUTSIDER, ADMIN]) {
    const o = await call('GET', `/api/sessions/${fx.sid}/messages`, email)
    assert.deepEqual(o.body.messages, [], email)
  }
  const s = await call('GET', `/api/sessions/${fx.sid}`, VIEWER)
  assert.equal(s.body.session.project_id, fx.pid)
  assert.equal(s.body.session.owner_email, OWNER)
  assert.equal(s.body.role, 'view')
})

test('turnLock busy exposes the sender to members', { skip: SKIP }, async () => {
  const fx = await projectWithChat('busy')
  const release = turnLock.acquire(fx.sid, { by: MANAGER })
  try {
    const v = await call('GET', `/api/sessions/${fx.sid}`, VIEWER)
    assert.equal(v.status, 200)
    assert.equal(v.body.busy.by, MANAGER)
    assert.match(v.body.busy.since, /^\d{4}-\d\d-\d\dT/)
    const t = await chat(VIEWER, { sessionId: fx.sid, prompt: 'agora' })
    assert.equal(t.status, 409, 'a second turn meanwhile is refused')
    assert.equal((await call('GET', `/api/sessions/${fx.sid}`, OUTSIDER)).status, 404, 'a non-member learns nothing, not even busy')
  } finally {
    release()
  }
  // a real turn records its sender: a member's turn holds the lock as that member
  const seen = []
  const original = turnLock.acquire
  turnLock.acquire = (key, o) => {
    seen.push(o?.by)
    return original.call(turnLock, key, o)
  }
  try {
    assert.equal((await chat(VIEWER, { sessionId: fx.sid, prompt: 'eu' })).status, 200)
  } finally {
    turnLock.acquire = original
  }
  assert.deepEqual(seen, [VIEWER])
})

// ---- projects CRUD ------------------------------------------------------------

test('projects CRUD: create (creator = owner), list with role, get, update, delete (owner only); validation', { skip: SKIP }, async () => {
  assert.equal((await call('POST', '/api/projects', OWNER, { name: '   ' })).status, 400)
  assert.equal((await call('POST', '/api/projects', OWNER, { name: 'x'.repeat(201) })).status, 400)
  assert.equal((await call('POST', '/api/projects', OWNER, { name: 'ok', instructions: 42 })).status, 400)
  const c = await call('POST', '/api/projects', OWNER, { name: '  Vendas Q4 ', description: 'd', instructions: 'i' })
  assert.equal(c.status, 201)
  const p = c.body.project
  assert.equal(p.name, 'Vendas Q4')
  assert.equal(p.role, 'owner')
  assert.equal(p.created_by, OWNER)
  const list = await call('GET', '/api/projects', OWNER)
  assert.ok(list.body.projects.some((x) => x.id === p.id && x.role === 'owner'))
  assert.ok(!(await call('GET', '/api/projects', OUTSIDER)).body.projects.some((x) => x.id === p.id))
  assert.ok(!(await call('GET', '/api/projects', ADMIN)).body.projects.some((x) => x.id === p.id), 'admins do not list others’ projects')
  const u = await call('PATCH', `/api/projects/${p.id}`, OWNER, { name: 'Vendas', description: 'nova' })
  assert.equal(u.status, 200)
  assert.equal(u.body.project.name, 'Vendas')
  assert.equal(u.body.project.instructions, 'i', 'fields not sent are kept')
  assert.equal((await call('PATCH', `/api/projects/${p.id}`, OWNER, { name: '' })).status, 400)
  await call('POST', `/api/projects/${p.id}/members`, OWNER, { kind: 'user', principal: MANAGER, role: 'manage' })
  assert.equal((await call('DELETE', `/api/projects/${p.id}`, MANAGER)).status, 403)
  assert.equal((await call('DELETE', `/api/projects/${p.id}`, OUTSIDER)).status, 404)
  assert.equal((await call('DELETE', `/api/projects/${p.id}`, ADMIN)).status, 404)
  assert.equal((await call('DELETE', `/api/projects/${p.id}`, OWNER)).status, 200)
  assert.equal((await call('GET', `/api/projects/${p.id}`, OWNER)).status, 404)
  assert.equal((await call('GET', '/api/projects/999999999', OWNER)).status, 404)
  assert.equal((await call('GET', '/api/projects/abc', OWNER)).status, 404, 'non-numeric id')
})

test('deleting a project deletes its chats', { skip: SKIP }, async () => {
  const fx = await projectWithChat('cascade')
  assert.equal((await call('DELETE', `/api/projects/${fx.pid}`, OWNER)).status, 200)
  assert.equal((await q(`SELECT count(*)::int AS n FROM chat_sessions WHERE id = $1`, [fx.sid]))[0].n, 0)
})

// ---- members --------------------------------------------------------------------

test('members CRUD: list, add, change role, remove; manage cannot grant owner; last owner protected; self-leave', { skip: SKIP }, async () => {
  const { pid } = await projectWithChat('members')
  const list = await call('GET', `/api/projects/${pid}/members`, VIEWER)
  assert.equal(list.status, 200)
  assert.deepEqual(
    list.body.members.map((m) => [m.kind, m.principal, m.role]).sort(),
    [['user', MANAGER, 'manage'], ['user', OWNER, 'owner'], ['user', VIEWER, 'view']].sort()
  )
  assert.equal((await call('GET', `/api/projects/${pid}/members`, OUTSIDER)).status, 404)
  // validation
  assert.equal((await call('POST', `/api/projects/${pid}/members`, OWNER, { kind: 'user', principal: 'not-an-email', role: 'view' })).status, 400)
  assert.equal((await call('POST', `/api/projects/${pid}/members`, OWNER, { kind: 'robot', principal: 'x', role: 'view' })).status, 400)
  assert.equal((await call('POST', `/api/projects/${pid}/members`, OWNER, { kind: 'user', principal: who('n'), role: 'admin' })).status, 400)
  // duplicates
  assert.equal((await call('POST', `/api/projects/${pid}/members`, OWNER, { kind: 'user', principal: VIEWER.toUpperCase(), role: 'view' })).status, 409)
  // manage: up to manage, never owner
  assert.equal((await call('POST', `/api/projects/${pid}/members`, MANAGER, { kind: 'user', principal: who('m1'), role: 'manage' })).status, 201)
  assert.equal((await call('POST', `/api/projects/${pid}/members`, MANAGER, { kind: 'user', principal: who('m2'), role: 'owner' })).status, 403)
  const enc = (e) => encodeURIComponent(e)
  assert.equal((await call('PATCH', `/api/projects/${pid}/members/user/${enc(VIEWER)}`, MANAGER, { role: 'owner' })).status, 403)
  assert.equal((await call('PATCH', `/api/projects/${pid}/members/user/${enc(OWNER)}`, MANAGER, { role: 'view' })).status, 403, 'manage cannot demote an owner')
  assert.equal((await call('DELETE', `/api/projects/${pid}/members/user/${enc(OWNER)}`, MANAGER)).status, 403, 'manage cannot remove an owner')
  assert.equal((await call('PATCH', `/api/projects/${pid}/members/user/${enc(VIEWER)}`, MANAGER, { role: 'manage' })).status, 200)
  assert.equal((await call('PATCH', `/api/projects/${pid}/members/user/${enc(VIEWER)}`, VIEWER, { role: 'view' })).status, 200, 'now a manager')
  // last owner
  assert.equal((await call('PATCH', `/api/projects/${pid}/members/user/${enc(OWNER)}`, OWNER, { role: 'view' })).status, 409)
  assert.equal((await call('DELETE', `/api/projects/${pid}/members/user/${enc(OWNER)}`, OWNER)).status, 409)
  assert.equal((await call('PATCH', `/api/projects/${pid}/members/user/${enc(who('ghost'))}`, OWNER, { role: 'view' })).status, 404)
  // a second owner, then the first may leave
  assert.equal((await call('POST', `/api/projects/${pid}/members`, OWNER, { kind: 'user', principal: who('o2'), role: 'owner' })).status, 201)
  // view can leave by itself
  assert.equal((await call('DELETE', `/api/projects/${pid}/members/user/${enc(VIEWER)}`, VIEWER)).status, 200)
  assert.equal((await call('GET', `/api/projects/${pid}`, VIEWER)).status, 404, 'gone after leaving')
  assert.equal((await call('DELETE', `/api/projects/${pid}/members/user/${enc(OWNER)}`, OWNER)).status, 200)
  assert.equal((await call('GET', `/api/projects/${pid}`, OWNER)).status, 404, 'the creator keeps nothing after leaving')
})

test('SCIM groups: a group member reads the project; a SCIM error or a missing group grants nothing (fail closed)', { skip: SKIP }, async () => {
  const fx = await projectWithChat('groups')
  assert.equal((await call('POST', `/api/projects/${fx.pid}/members`, OWNER, { kind: 'group', principal: GROUP.toUpperCase(), role: 'view' })).status, 201)
  const members = (await call('GET', `/api/projects/${fx.pid}/members`, OWNER)).body.members
  assert.ok(members.some((m) => m.kind === 'group' && m.principal === GROUP), 'stored lowercased')
  // the fake workspace's SCIM /Me answers with no groups: nothing
  assert.equal((await call('GET', `/api/projects/${fx.pid}`, GROUPIE)).status, 404)
  const previous = pool.setTxGroupsResolver(async (email) => (email === GROUPIE ? [GROUP] : []))
  try {
    assert.equal((await call('GET', `/api/projects/${fx.pid}`, GROUPIE)).status, 200)
    assert.equal((await call('GET', `/api/sessions/${fx.sid}`, GROUPIE)).status, 200)
    assert.equal((await chat(GROUPIE, { sessionId: fx.sid, prompt: 'grupo' })).status, 200, 'viewers post')
    assert.equal((await call('GET', `/api/projects/${fx.pid}`, OUTSIDER)).status, 404)
    pool.setTxGroupsResolver(async () => {
      throw new Error('SCIM down')
    })
    assert.equal((await call('GET', `/api/projects/${fx.pid}`, GROUPIE)).status, 404, 'a resolver error grants nothing')
    assert.equal((await call('GET', `/api/sessions/${fx.sid}`, GROUPIE)).status, 404)
    assert.equal((await call('GET', '/api/projects', GROUPIE)).status, 200, 'and the app keeps working')
  } finally {
    pool.setTxGroupsResolver(previous)
  }
})

// ---- files ----------------------------------------------------------------------

function filesForm(files) {
  const form = new FormData()
  for (const [name, content] of files) form.append('files', new Blob([content]), name)
  return form
}

test('files: manage uploads (text extracted), members list/read, view cannot upload or delete; path-like names are flattened', { skip: SKIP }, async () => {
  const { pid } = await projectWithChat('files')
  const up = await call('POST', `/api/projects/${pid}/files`, MANAGER, filesForm([['../../etc/notas.md', '# Notas\nconteúdo'], ['dados.csv', 'a,b\n1,2']]))
  assert.equal(up.status, 201, up.text)
  assert.deepEqual(up.body.files.map((f) => f.name).sort(), ['dados.csv', 'notas.md'])
  const list = await call('GET', `/api/projects/${pid}/files`, VIEWER)
  assert.equal(list.status, 200)
  assert.equal(list.body.files.length, 2)
  assert.ok(!('content_text' in list.body.files[0]), 'the list carries no content')
  const notes = list.body.files.find((f) => f.name === 'notas.md')
  const one = await call('GET', `/api/projects/${pid}/files/${notes.id}`, VIEWER)
  assert.equal(one.status, 200)
  assert.match(one.body.file.content_text, /conteúdo/)
  assert.equal((await call('POST', `/api/projects/${pid}/files`, VIEWER, filesForm([['x.txt', 'x']]))).status, 403)
  assert.equal((await call('POST', `/api/projects/${pid}/files`, OUTSIDER, filesForm([['x.txt', 'x']]))).status, 404)
  assert.equal((await call('GET', `/api/projects/${pid}/files`, OUTSIDER)).status, 404)
  assert.equal((await call('GET', `/api/projects/${pid}/files/${notes.id}`, ADMIN)).status, 404)
  assert.equal((await call('POST', `/api/projects/${pid}/files`, MANAGER, filesForm([['malware.exe', 'MZ']]))).status, 400, 'unsupported type')
  assert.equal((await call('POST', `/api/projects/${pid}/files`, MANAGER, new FormData())).status, 400, 'no file')
  assert.equal((await call('DELETE', `/api/projects/${pid}/files/${notes.id}`, VIEWER)).status, 403)
  assert.equal((await call('DELETE', `/api/projects/${pid}/files/${notes.id}`, MANAGER)).status, 200)
  assert.equal((await call('DELETE', `/api/projects/${pid}/files/${notes.id}`, MANAGER)).status, 404)
  assert.equal((await call('GET', `/api/projects/${pid}/files/abc`, MANAGER)).status, 404)
  // a file id of another project is not reachable through this one
  const other = await call('POST', '/api/projects', OUTSIDER, { name: 'theirs' })
  const theirs = await call('POST', `/api/projects/${other.body.project.id}/files`, OUTSIDER, filesForm([['s.txt', 'segredo']]))
  assert.equal((await call('GET', `/api/projects/${pid}/files/${theirs.body.files[0].id}`, OWNER)).status, 404)
})

test('files: the multer limits (size per file, files per request) answer 413, nothing stored', { skip: SKIP }, async () => {
  const { pid } = await projectWithChat('limits')
  const { PROJECT_FILE_LIMITS } = await import('../../server/middleware/index.js')
  assert.ok(PROJECT_FILE_LIMITS.fileSize > 0 && PROJECT_FILE_LIMITS.files > 0)
  const big = await call('POST', `/api/projects/${pid}/files`, MANAGER, filesForm([['big.txt', 'x'.repeat(PROJECT_FILE_LIMITS.fileSize + 1)]]))
  assert.equal(big.status, 413)
  const many = Array.from({ length: PROJECT_FILE_LIMITS.files + 1 }, (_, i) => [`f${i}.txt`, 'x'])
  assert.equal((await call('POST', `/api/projects/${pid}/files`, MANAGER, filesForm(many))).status, 413)
  assert.equal((await q(`SELECT count(*)::int AS n FROM project_files WHERE project_id = $1`, [pid]))[0].n, 0)
})

// ---- sessions in a project --------------------------------------------------------

test('sessions in a project: list for members; attach own chat (view+); not someone else’s; detach = creator with manage+', { skip: SKIP }, async () => {
  const fx = await projectWithChat('sessions')
  const l = await call('GET', `/api/projects/${fx.pid}/sessions`, VIEWER)
  assert.equal(l.status, 200)
  assert.deepEqual(l.body.sessions.map((s) => s.id), [fx.sid])
  assert.equal(l.body.sessions[0].owner_email, OWNER)
  assert.equal((await call('GET', `/api/projects/${fx.pid}/sessions`, OUTSIDER)).status, 404)
  // the viewer's personal chat
  const mine = await chat(VIEWER, { prompt: 'pessoal' })
  const vsid = String(mine.events.find((e) => e.type === 'meta').sessionId)
  // the outsider's personal chat cannot be attached by the viewer (not hers)
  const theirs = await chat(OUTSIDER, { prompt: 'meu' })
  const osid = String(theirs.events.find((e) => e.type === 'meta').sessionId)
  assert.equal((await call('POST', `/api/projects/${fx.pid}/sessions`, VIEWER, { sessionId: osid })).status, 404)
  // ...nor by the outsider into a project she is not in
  assert.equal((await call('POST', `/api/projects/${fx.pid}/sessions`, OUTSIDER, { sessionId: osid })).status, 404)
  assert.equal((await call('POST', `/api/projects/${fx.pid}/sessions`, VIEWER, { sessionId: 'x' })).status, 400)
  assert.equal((await call('POST', `/api/projects/${fx.pid}/sessions`, VIEWER, { sessionId: vsid })).status, 200)
  assert.equal((await call('GET', `/api/sessions/${vsid}`, MANAGER)).status, 200, 'now shared')
  // detaching: the creator, with manage+ (a detached chat is its creator's again)
  assert.equal((await call('DELETE', `/api/projects/${fx.pid}/sessions/${vsid}`, VIEWER)).status, 403, 'view')
  assert.equal((await call('DELETE', `/api/projects/${fx.pid}/sessions/${vsid}`, MANAGER)).status, 403, 'not the creator')
  assert.equal((await call('DELETE', `/api/projects/${fx.pid}/sessions/${fx.sid}`, OWNER)).status, 200, 'creator + owner')
  assert.equal((await call('GET', `/api/sessions/${fx.sid}`, MANAGER)).status, 404, 'personal again')
  assert.equal((await call('GET', `/api/sessions/${fx.sid}`, OWNER)).status, 200, 'and its creator’s')
  assert.equal((await call('DELETE', `/api/projects/${fx.pid}/sessions/${fx.sid}`, OWNER)).status, 404, 'not in the project any more')
  assert.equal((await call('GET', `/api/sessions/${vsid}`, MANAGER)).status, 200, 'the viewer’s chat is still shared')
  // a new chat cannot be started in a project the caller is not in
  const denied = await chat(OUTSIDER, { prompt: 'x', projectId: fx.pid })
  assert.equal(denied.status, 404)
})

test('the personal sidebar lists the caller’s own chats only (with their project), not other members’ shared chats', { skip: SKIP }, async () => {
  const fx = await projectWithChat('sidebar')
  const o = (await call('GET', '/api/sessions', OWNER)).body.sessions
  const shared = o.find((s) => s.id === fx.sid)
  assert.ok(shared, 'the creator sees her project chat')
  assert.equal(shared.project_id, fx.pid)
  assert.ok(!(await call('GET', '/api/sessions', VIEWER)).body.sessions.some((s) => s.id === fx.sid))
})
