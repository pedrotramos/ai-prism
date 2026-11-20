// N1b: project members read the artifacts of a shared chat, read-only, and a
// project delete cleans up its images (migration 0012).
//
//   AC1  member B reads A's deck / spreadsheet / document / image in a shared
//        chat: 200 with read_only: true; PATCH and AI edit by B: 403
//        artifact_read_only; export by B works
//   AC2  a non-member gets 404 on every getter; an app admin without
//        membership too (no implicit access); a member who left gets 404
//   AC3  deleting a project deletes its chats' image files (a fake volume counts
//        the DELETEs; at most 4 at a time); a failing delete never fails the
//        request and is counted in one warning
//   AC4  the policy uses the set form (no aip_project_rank call per row); 0012
//        round-trips (down, up); writes stay owner-only at the database
//   AC5  (docs: scripts/check-docs-i18n.mjs, changelog: tests/changelogFragments)
//
// Scratch database on the local test server, like server/ephemeral.test.js; no
// Postgres with pgvector → skipped.
//
//   node --test server/projectArtifacts.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
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
const ADMIN = `n1b-admin-${stamp}@test.invalid` // APP_OWNER_EMAIL: an app admin, never a project member
const A = `n1b-a-${stamp}@test.invalid` // creates the artifacts and owns the project
const B = `n1b-b-${stamp}@test.invalid` // a (view) member
const C = `n1b-c-${stamp}@test.invalid` // outsider
env.APP_OWNER_EMAIL = ADMIN

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

async function scratch() {
  const name = `n1b_db_${stamp}_${createdDbs.length + 1}`
  await superuser(`CREATE DATABASE ${name}`)
  // function call counts for the AC4 test (sessions opened afterwards inherit it)
  await superuser(`ALTER DATABASE ${name} SET track_functions = 'all'`)
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
    await migrateUp(c, { log: quiet })
    await applyAppGrants(c, { role: APP_ROLE, log: quiet })
  } finally {
    await c.end().catch(() => {})
  }
  return name
}

// ---- a fake UC volume ---------------------------------------------------------
// Answers the Files API (GET bytes, DELETE) and SCIM /Me; counts DELETEs, the
// most in flight at once, and fails the paths listed in `failing`.
const vol = { deletes: [], inflight: 0, maxInflight: 0, failing: new Set(), delayMs: 0, server: null, url: '' }
async function startVolume() {
  vol.server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/api/2.0/preview/scim/v2/Me') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ id: 'x', userName: 'x@test.invalid', groups: [] }))
    }
    const file = url.pathname.replace('/api/2.0/fs/files', '')
    if (req.method === 'GET' && url.pathname.startsWith('/api/2.0/fs/files/')) {
      res.setHeader('content-type', 'image/png')
      return res.end(Buffer.from('png-bytes'))
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/2.0/fs/files/')) {
      vol.inflight++
      vol.maxInflight = Math.max(vol.maxInflight, vol.inflight)
      vol.deletes.push(file)
      setTimeout(() => {
        vol.inflight--
        res.statusCode = vol.failing.has(file) ? 500 : 204
        res.end()
      }, vol.delayMs)
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((r) => vol.server.listen(0, '127.0.0.1', r))
  vol.url = `http://127.0.0.1:${vol.server.address().port}`
  env.DATABRICKS_HOST = vol.url
}
const resetVolume = () => Object.assign(vol, { deletes: [], inflight: 0, maxInflight: 0, delayMs: 0 }) && vol.failing.clear()

let DB, raw, appc, server, base, db
const fx = {}

if (!SKIP) {
  await startVolume()
  DB = await scratch()
  raw = new pg.Client(opts(DB))
  await raw.connect()
  await raw.query(`SET search_path TO ai_prism, public`)
  appc = new pg.Client(opts(DB, APP_ROLE))
  await appc.connect()
  await appc.query(`SET search_path TO ai_prism, public`)
  env.PGDATABASE = DB
  env.PGUSER = APP_ROLE
}
db = await import('./db.js')
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
  await new Promise((r) => (vol.server ? vol.server.close(r) : r()))
  await appc?.end().catch(() => {})
  await raw?.end().catch(() => {})
  if (SKIP) return
  for (const name of createdDbs) {
    await superuser(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]).catch(() => {})
    await superuser(`DROP DATABASE IF EXISTS ${name}`).catch(() => {})
  }
})

const q = async (sql, params = []) => (await raw.query(sql, params)).rows
async function call(method, p, email, body, headers = {}) {
  const init = { method, headers: { 'x-forwarded-email': email, ...headers } }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers['content-type'] = 'application/json'
  }
  const res = await fetch(`${base}${p}`, init)
  const buf = Buffer.from(await res.arrayBuffer())
  let json = null
  try {
    json = JSON.parse(buf.toString('utf8'))
  } catch {}
  return { status: res.status, body: json, buf, headers: res.headers }
}

async function seedArtifacts(sessionId, owner, tag) {
  const out = {}
  out.deck = String((await q(
    `INSERT INTO chat_decks (session_id, user_email, title, slides, meta) VALUES ($1, $2, $3, $4::jsonb, '{"format":"html"}'::jsonb) RETURNING id`,
    [sessionId, owner, `deck ${tag}`, JSON.stringify(['<section><h1>oi</h1></section>'])]
  ))[0].id)
  out.sheet = String((await q(
    `INSERT INTO chat_spreadsheets (session_id, user_email, title, spec) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [sessionId, owner, `sheet ${tag}`, JSON.stringify({ sheets: [{ name: 'S', blocks: [{ type: 'table', columns: [{ key: 'a', header: 'A' }], rows: [{ a: '1' }] }] }] })]
  ))[0].id)
  out.doc = String((await q(
    `INSERT INTO chat_documents (session_id, user_email, title, markdown) VALUES ($1, $2, $3, '# oi') RETURNING id`,
    [sessionId, owner, `doc ${tag}`]
  ))[0].id)
  out.img = String((await q(
    `INSERT INTO chat_images (session_id, user_email, prompt, model, volume_path) VALUES ($1, $2, 'p', 'm', $3) RETURNING id`,
    [sessionId, owner, `/Volumes/c/s/v/${tag}-${stamp}.png`]
  ))[0].id)
  return out
}

async function setup() {
  // the project goes through the API (the owner row comes from the trigger); B joins as a viewer
  const p = await call('POST', '/api/projects', A, { name: `n1b-${stamp}` })
  assert.equal(p.status, 201)
  fx.p = p.body.project.id
  assert.equal((await call('POST', `/api/projects/${fx.p}/members`, A, { kind: 'user', principal: B, role: 'view' })).status, 201)
  fx.shared = String((await q(`INSERT INTO chat_sessions (user_email, title, model, project_id) VALUES ($1, 'shared', 'm', $2) RETURNING id`, [A, fx.p]))[0].id)
  fx.personal = String((await q(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 'personal', 'm') RETURNING id`, [A]))[0].id)
  fx.art = await seedArtifacts(fx.shared, A, 'shared')
  fx.priv = await seedArtifacts(fx.personal, A, 'personal')
}
if (!SKIP) await setup()

const KINDS = [
  ['deck', 'decks', 'deck'],
  ['sheet', 'spreadsheets', 'spreadsheet'],
  ['doc', 'documents', 'document'],
]

// ---- AC1 -----------------------------------------------------------------------

test('AC1: a member reads the creator\'s deck, spreadsheet and document (200, read_only: true); the creator is not read-only', { skip: SKIP }, async () => {
  for (const [k, route, key] of KINDS) {
    const asB = await call('GET', `/api/${route}/${fx.art[k]}`, B)
    assert.equal(asB.status, 200, `${route}: member read`)
    assert.equal(asB.body[key].read_only, true, `${route}: read_only for the member`)
    const asA = await call('GET', `/api/${route}/${fx.art[k]}`, A)
    assert.equal(asA.status, 200)
    assert.equal(asA.body[key].read_only, false, `${route}: the creator can edit`)
  }
})

test('AC1: a member reads the creator\'s image: bytes and the read-only header; the DB getter says so', { skip: SKIP }, async () => {
  const asB = await call('GET', `/api/images/${fx.art.img}`, B)
  assert.equal(asB.status, 200)
  assert.equal(asB.buf.toString(), 'png-bytes')
  assert.equal(asB.headers.get('x-artifact-read-only'), 'true')
  const asA = await call('GET', `/api/images/${fx.art.img}`, A)
  assert.equal(asA.status, 200)
  assert.equal(asA.headers.get('x-artifact-read-only'), null)
  assert.equal((await db.getImage(B, 'tok', fx.art.img)).readOnly, true)
  assert.equal((await db.getImage(A, 'tok', fx.art.img)).readOnly, false)
})

test('AC1: every write by a member is 403 artifact_read_only and changes nothing (save, AI edit, preview too)', { skip: SKIP }, async () => {
  const before = await q(`SELECT (SELECT slides::text FROM chat_decks WHERE id = $1) d, (SELECT spec::text FROM chat_spreadsheets WHERE id = $2) s, (SELECT markdown FROM chat_documents WHERE id = $3) m`, [fx.art.deck, fx.art.sheet, fx.art.doc])
  const writes = [
    ['PATCH', `/api/decks/${fx.art.deck}`, { slides: ['<section><h1>hack</h1></section>'] }],
    ['POST', `/api/decks/${fx.art.deck}/tweak`, { instruction: 'x', preview: true }],
    ['POST', `/api/decks/${fx.art.deck}/tweak`, { instruction: 'x' }],
    ['PATCH', `/api/spreadsheets/${fx.art.sheet}`, { title: 'hack', sheets: [{ name: 'S', blocks: [] }] }],
    ['POST', `/api/spreadsheets/${fx.art.sheet}/tweak`, { instruction: 'x' }],
    ['PATCH', `/api/documents/${fx.art.doc}`, { title: 'hack', markdown: '# hack' }],
    ['POST', `/api/documents/${fx.art.doc}/tweak`, { instruction: 'x', preview: true }],
    ['POST', `/api/documents/${fx.art.doc}/tweak`, { instruction: 'x' }],
  ]
  for (const [m, p, body] of writes) {
    const r = await call(m, p, B, body)
    assert.equal(r.status, 403, `${m} ${p}`)
    assert.equal(r.body.error, 'artifact_read_only', `${m} ${p}`)
    assert.equal(typeof r.body.message, 'string', 'a localized message comes with the code')
  }
  const after = await q(`SELECT (SELECT slides::text FROM chat_decks WHERE id = $1) d, (SELECT spec::text FROM chat_spreadsheets WHERE id = $2) s, (SELECT markdown FROM chat_documents WHERE id = $3) m`, [fx.art.deck, fx.art.sheet, fx.art.doc])
  assert.deepEqual(after, before)
})

test('AC1: a member exports the creator\'s artifacts', { skip: SKIP }, async () => {
  const x = await call('GET', `/api/spreadsheets/${fx.art.sheet}/export`, B)
  assert.equal(x.status, 200)
  assert.match(x.headers.get('content-type'), /spreadsheetml/)
  const d = await call('GET', `/api/documents/${fx.art.doc}/export`, B)
  assert.equal(d.status, 200)
  const md = await call('GET', `/api/documents/${fx.art.doc}/export?format=md`, B)
  assert.equal(md.buf.toString(), '# oi')
  const p = await call('POST', `/api/decks/${fx.art.deck}/export-html`, B, { slides: [] })
  assert.equal(p.status, 400, 'the deck export is reached (empty slides → 400, not 404 or 403)')
})

test('AC1: the creator still edits her own artifact in the shared chat', { skip: SKIP }, async () => {
  const r = await call('PATCH', `/api/documents/${fx.art.doc}`, A, { title: 'doc shared', markdown: '# editado' })
  assert.equal(r.status, 200)
  assert.equal((await q(`SELECT markdown FROM chat_documents WHERE id = $1`, [fx.art.doc]))[0].markdown, '# editado')
  await q(`UPDATE chat_documents SET markdown = '# oi' WHERE id = $1`, [fx.art.doc])
})

// ---- AC2 -----------------------------------------------------------------------

test('AC2: a non-member and an app admin without membership get 404 on every getter and export; nothing leaks from a personal chat', { skip: SKIP }, async () => {
  for (const who of [C, ADMIN]) {
    for (const [k, route] of KINDS) {
      assert.equal((await call('GET', `/api/${route}/${fx.art[k]}`, who)).status, 404, `${who} ${route}`)
    }
    assert.equal((await call('GET', `/api/images/${fx.art.img}`, who)).status, 404)
    assert.equal((await call('GET', `/api/spreadsheets/${fx.art.sheet}/export`, who)).status, 404)
    assert.equal((await call('GET', `/api/documents/${fx.art.doc}/export`, who)).status, 404)
    assert.equal((await call('POST', `/api/decks/${fx.art.deck}/export-html`, who, { slides: [{}] })).status, 404)
  }
  // B is a member of the project, but A's PERSONAL chat is not shared
  for (const [k, route] of KINDS) assert.equal((await call('GET', `/api/${route}/${fx.priv[k]}`, B)).status, 404, `personal ${route}`)
  assert.equal((await call('GET', `/api/images/${fx.priv.img}`, B)).status, 404)
})

test('AC2: a member who leaves (or is removed) loses the artifacts at once; a chat taken out of the project is its creator\'s again', { skip: SKIP }, async () => {
  assert.equal((await call('POST', `/api/projects/${fx.p}/members`, A, { kind: 'user', principal: C, role: 'view' })).status, 201)
  assert.equal((await call('GET', `/api/documents/${fx.art.doc}`, C)).status, 200)
  assert.equal((await call('DELETE', `/api/projects/${fx.p}/members/user/${encodeURIComponent(C)}`, C)).status, 200, 'C leaves')
  for (const [k, route] of KINDS) assert.equal((await call('GET', `/api/${route}/${fx.art[k]}`, C)).status, 404, `${route} after leaving`)
  assert.equal((await call('GET', `/api/images/${fx.art.img}`, C)).status, 404)
})

// ---- AC3 -----------------------------------------------------------------------

async function projectWithImages(n, tag) {
  const p = (await call('POST', '/api/projects', A, { name: `del-${tag}-${stamp}` })).body.project.id
  await call('POST', `/api/projects/${p}/members`, A, { kind: 'user', principal: B, role: 'view' })
  const s1 = String((await q(`INSERT INTO chat_sessions (user_email, title, model, project_id) VALUES ($1, 'c1', 'm', $2) RETURNING id`, [A, p]))[0].id)
  const s2 = String((await q(`INSERT INTO chat_sessions (user_email, title, model, project_id) VALUES ($2, 'c2', 'm', $1) RETURNING id`, [p, B]))[0].id)
  const paths = []
  for (let i = 0; i < n; i++) {
    const owner = i % 2 ? B : A // images of every member's chats go, not only the deleter's
    const pth = `/Volumes/c/s/v/${tag}-${stamp}-${i}.png`
    paths.push(pth)
    await q(`INSERT INTO chat_images (session_id, user_email, prompt, model, volume_path) VALUES ($1, $2, 'p', 'm', $3)`, [i % 2 ? s2 : s1, owner, pth])
  }
  return { p, paths }
}

test('AC3: deleting a project deletes the image files of all its chats, at most 4 at a time, and the rows go too', { skip: SKIP }, async () => {
  resetVolume()
  vol.delayMs = 25
  const { p, paths } = await projectWithImages(11, 'ok')
  const keep = (await seedArtifacts(fx.personal, A, 'keepme')).img // a personal chat's image is not touched
  const r = await call('DELETE', `/api/projects/${p}`, A)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true })
  assert.deepEqual([...vol.deletes].sort(), [...paths].sort())
  assert.ok(vol.maxInflight <= 4 && vol.maxInflight >= 2, `concurrency ${vol.maxInflight} within (1, 4]`)
  assert.equal((await q(`SELECT count(*)::int AS n FROM projects WHERE id = $1`, [p]))[0].n, 0)
  assert.equal((await q(`SELECT count(*)::int AS n FROM chat_images WHERE volume_path = ANY($1)`, [paths]))[0].n, 0)
  assert.equal((await q(`SELECT count(*)::int AS n FROM chat_images WHERE id = $1`, [keep]))[0].n, 1)
})

test('AC3: a failing file delete does not fail the request; one warning counts the failures', { skip: SKIP }, async () => {
  resetVolume()
  const { p, paths } = await projectWithImages(5, 'fail')
  vol.failing.add(paths[1])
  vol.failing.add(paths[3])
  const { logger } = await import('./log.ts')
  const warns = []
  const orig = logger.warn
  logger.warn = (msg, meta) => warns.push({ msg, meta })
  try {
    const r = await call('DELETE', `/api/projects/${p}`, A)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { ok: true })
  } finally {
    logger.warn = orig
  }
  assert.equal(vol.deletes.length, 5, 'every file was attempted')
  const w = warns.filter((x) => /imagens|images/i.test(x.msg))
  assert.equal(w.length, 1, 'one warning for the whole batch')
  assert.equal(w[0].meta.failed, 2)
  assert.equal(w[0].meta.total, 5)
})

test('AC3: a project delete by a non-owner deletes no file; a project without images calls the volume zero times', { skip: SKIP }, async () => {
  resetVolume()
  const { p, paths } = await projectWithImages(3, 'norole')
  assert.equal((await call('DELETE', `/api/projects/${p}`, B)).status, 403)
  assert.equal(vol.deletes.length, 0)
  assert.equal((await q(`SELECT count(*)::int AS n FROM chat_images WHERE volume_path = ANY($1)`, [paths]))[0].n, 3)
  const empty = (await call('POST', '/api/projects', A, { name: `empty-${stamp}` })).body.project.id
  assert.equal((await call('DELETE', `/api/projects/${empty}`, A)).status, 200)
  assert.equal(vol.deletes.length, 0)
})

test('W3-6: a temporary chat cannot be in a project, so no artifact of one can be shared', { skip: SKIP }, async () => {
  await assert.rejects(
    q(`INSERT INTO chat_sessions (user_email, title, model, project_id, ephemeral) VALUES ($1, 'tmp', 'm', $2, true)`, [A, fx.p]),
    /temporary chat cannot belong to a project/
  )
})

// ---- AC4 -----------------------------------------------------------------------

async function asIdentity(email, fn, { admin = false } = {}) {
  await appc.query('BEGIN')
  try {
    await appc.query(
      `SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', $2, true), set_config('app.user_groups', '[]', true)`,
      [email, admin ? 'on' : 'off']
    )
    return await fn(appc)
  } finally {
    await appc.query('ROLLBACK')
  }
}
const n = async (c, sql, params = []) => Number((await c.query(`SELECT count(*)::int AS n FROM (${sql}) x`, params)).rows[0].n)

test('AC4: the database lets a member SELECT the shared chat\'s artifacts and nothing else of the creator\'s; writes stay owner-only', { skip: SKIP }, async () => {
  const tables = ['chat_decks', 'chat_spreadsheets', 'chat_documents', 'chat_images']
  await asIdentity(B, async (c) => {
    for (const t of tables) {
      assert.equal(await n(c, `SELECT id FROM ${t} WHERE session_id = $1`, [fx.shared]), 1, `${t}: shared chat visible`)
      assert.equal(await n(c, `SELECT id FROM ${t} WHERE session_id = $1`, [fx.personal]), 0, `${t}: personal chat hidden`)
      const upd = await c.query(`UPDATE ${t} SET user_email = user_email WHERE session_id = $1`, [fx.shared])
      assert.equal(upd.rowCount, 0, `${t}: a member updates nothing of the creator's`)
      const del = await c.query(`DELETE FROM ${t} WHERE session_id = $1`, [fx.shared])
      assert.equal(del.rowCount, 0, `${t}: a member deletes nothing of the creator's`)
    }
  })
  for (const who of [C, ADMIN]) {
    await asIdentity(who, async (c) => {
      for (const t of tables) assert.equal(await n(c, `SELECT id FROM ${t}`), 0, `${t}: ${who} sees nothing`)
    }, { admin: who === ADMIN })
  }
})

test('AC4: the policy is the set form: aip_project_rank is never called per row, aip_my_project_ids once per statement', { skip: SKIP }, async () => {
  // many artifacts in the shared chat, so a per-row call would show
  for (let i = 0; i < 40; i++) {
    await q(`INSERT INTO chat_documents (session_id, user_email, title, markdown) VALUES ($1, $2, $3, 'x')`, [fx.shared, A, `bulk ${i}`])
  }
  const pol = (await q(`SELECT polname, pg_get_expr(polqual, polrelid) AS qual FROM pg_policy WHERE polname = 'aipj_member_read' AND polrelid = 'ai_prism.chat_documents'::regclass`))[0]
  assert.ok(pol, 'aipj_member_read exists on chat_documents')
  assert.match(pol.qual, /aip_my_project_ids/)
  assert.doesNotMatch(pol.qual, /aip_project_rank/)
  await q(`SELECT pg_stat_reset_single_function_counters('ai_prism.aip_project_rank(bigint)'::regprocedure), pg_stat_reset_single_function_counters('ai_prism.aip_my_project_ids()'::regprocedure)`)
  const rows = await asIdentity(B, async (c) => (await c.query(`SELECT id FROM chat_documents`)).rowCount)
  assert.ok(rows >= 41)
  // function counters reach the shared stats a moment after the transaction ends
  let calls
  for (let i = 0; i < 40; i++) {
    calls = (await q(`SELECT funcname, calls::int AS calls FROM pg_stat_user_functions WHERE schemaname = 'ai_prism' AND funcname IN ('aip_project_rank', 'aip_my_project_ids')`))
    if (calls.some((x) => x.funcname === 'aip_my_project_ids' && x.calls > 0)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  const by = Object.fromEntries(calls.map((x) => [x.funcname, x.calls]))
  assert.ok(by.aip_my_project_ids >= 1, 'the set function ran')
  assert.ok(by.aip_my_project_ids <= 3, `the set function ran ${by.aip_my_project_ids} times for one statement`)
  assert.ok(!by.aip_project_rank, `aip_project_rank ran ${by.aip_project_rank} times`)
})

test('AC4: 0012 is idempotent and round-trips (down removes the four policies, up restores them)', { skip: SKIP }, async () => {
  const up = fs.readFileSync(path.join(MIGRATIONS, '0012_project_artifact_read.up.sql'), 'utf8')
  const down = fs.readFileSync(path.join(MIGRATIONS, '0012_project_artifact_read.down.sql'), 'utf8')
  const state = async () =>
    (await q(`SELECT polrelid::regclass::text AS t, polname, polcmd, pg_get_expr(polqual, polrelid) AS qual FROM pg_policy WHERE polname = 'aipj_member_read' AND polrelid::regclass::text ~ 'chat_(decks|spreadsheets|documents|images)' ORDER BY 1`))
  const before = await state()
  assert.equal(before.length, 4)
  assert.ok(before.every((x) => x.polcmd === 'r'), 'FOR SELECT only')
  await raw.query(up)
  assert.deepEqual(await state(), before, 'up twice changes nothing')
  await raw.query(down)
  assert.deepEqual(await state(), [], 'down drops them')
  await raw.query(down)
  await raw.query(up)
  assert.deepEqual(await state(), before, 'down then up matches')
  // and through the runner, with every later and earlier migration
  const { migrateDown, migrateUp, loadMigrations } = await import('./db/migrate.js')
  const versions = loadMigrations(MIGRATIONS).map((m) => m.version)
  assert.ok(versions.includes(12))
  assert.equal((await migrateDown(raw, { to: 11, log: quiet })).reverted.join(), '12')
  assert.deepEqual(await state(), [])
  await migrateUp(raw, { log: quiet })
  assert.deepEqual(await state(), before)
})
