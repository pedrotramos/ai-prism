// N1a (ADR-0013/0014): project instructions and files reach the turn, on the three
// turn routes, under the caller's row-level security; each message says who sent it;
// the files API tells the user what a chat will not read; GET /api/projects exposes
// the real limits.
//
// The real Express app (server/index.js) on an ephemeral port, the fake AI Gateway
// (which records every model request, so the test reads the system block the model
// received), and a scratch database with db.js connected as the NON-OWNER app role
// (scripts/ci/pg-roles.sql). No Postgres with pgvector -> skipped.
//
//   node --test tests/routes/projectContext.test.mjs
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
env.PROJECT_CONTEXT_FILES_MAX_TOKENS = '1500'
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
const who = (n) => `n1a-${n}-${stamp}@test.invalid`
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
const DBNAME = `n1a_db_${stamp}`

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

const text = (c) => (typeof c === 'string' ? c : (c || []).map((p) => p?.text || '').join(''))
const lastUser = (body) => {
  const m = [...(body?.messages || [])].reverse().find((x) => x.role === 'user')
  return typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '')
}
/** The system text of each streaming model round whose current user message contains `marker`, oldest first. */
function systemRounds(marker) {
  return gw.requests
    .filter((r) => r.path === '/serving-endpoints/chat/completions' && r.body?.stream && lastUser(r.body).includes(marker))
    .map((r) => r.body.messages.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n'))
}

async function upload(email, pid, files) {
  const fd = new FormData()
  for (const [name, content] of files) fd.append('files', new Blob([content], { type: 'text/plain' }), name)
  return call('POST', `/api/projects/${pid}/files`, email, fd)
}

async function newProject(tag, instructions, members = []) {
  const created = await call('POST', '/api/projects', OWNER, { name: `P ${tag}`, instructions })
  assert.equal(created.status, 201, created.text)
  const pid = String(created.body.project.id)
  for (const [kind, principal, role] of members) {
    assert.equal((await call('POST', `/api/projects/${pid}/members`, OWNER, { kind, principal, role })).status, 201)
  }
  return pid
}

const projectPart = (system) => {
  const i = system.indexOf('Project "')
  assert.ok(i >= 0, 'the system block carries the project context')
  return system.slice(i)
}

// ---- the three routes ----------------------------------------------------------

test('the same project system block reaches the model on /chat, /regenerate and /continue', { skip: SKIP }, async () => {
  const tag = `three-${stamp}`
  const pid = await newProject(tag, `INSTR-${tag}: responda em português.`, [['user', MANAGER, 'manage']])
  const up = await upload(OWNER, pid, [[`notas-${tag}.txt`, `CORPO-${tag}: o trimestre foi bom.`]])
  assert.equal(up.status, 201, up.text)
  const prompt = `Diga OK (${tag})`
  const first = await chat(OWNER, { prompt, projectId: pid })
  assert.equal(first.status, 200)
  const sid = String(first.events.find((e) => e.type === 'meta').sessionId)
  const answer = (await q(`SELECT id FROM chat_messages WHERE session_id = $1 AND role = 'assistant' ORDER BY id DESC LIMIT 1`, [sid]))[0].id
  // /regenerate rewrites history: manage+ (D4); /continue answers a user message nothing answered yet
  const regen = await call('POST', `/api/sessions/${sid}/messages/${answer}/regenerate`, MANAGER, { model: MODEL, enabledTools: [] })
  assert.equal(regen.status, 200, regen.text)
  await q(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', $2)`, [sid, prompt])
  const cont = await call('POST', `/api/sessions/${sid}/continue`, MANAGER, { model: MODEL, enabledTools: [] })
  assert.equal(cont.status, 200, cont.text)

  const rounds = systemRounds(tag)
  assert.equal(rounds.length, 3, 'chat, regenerate and continue each reached the model once')
  for (const [i, route] of ['chat', 'regenerate', 'continue'].entries()) {
    assert.ok(rounds[i].includes(`<project_instructions>\nINSTR-${tag}: responda em português.\n</project_instructions>`), `${route}: instructions`)
    assert.ok(rounds[i].includes(`<project_file name="notas-${tag}.txt" part="full">\nCORPO-${tag}: o trimestre foi bom.\n</project_file>`), `${route}: file`)
  }
  assert.equal(rounds[1], rounds[0], 'regenerate: the identical system block')
  assert.equal(rounds[2], rounds[0], 'continue: the identical system block')
})

test('an unchanged project gives a byte-identical project block on every turn (prompt caching)', { skip: SKIP }, async () => {
  const tag = `bytes-${stamp}`
  const pid = await newProject(tag, `INSTR-${tag}`)
  await upload(OWNER, pid, [[`a-${tag}.txt`, `A-${tag}`], [`b-${tag}.txt`, `B-${tag}`]])
  const first = await chat(OWNER, { prompt: `um (${tag})`, projectId: pid })
  const sid = String(first.events.find((e) => e.type === 'meta').sessionId)
  await chat(OWNER, { prompt: `dois (${tag})`, sessionId: sid })
  const [a, b] = systemRounds(tag)
  assert.ok(a && b)
  assert.equal(projectPart(b), projectPart(a))
})

test('a personal chat carries no project context, and nothing leaks to a non-project turn', { skip: SKIP }, async () => {
  const tag = `personal-${stamp}`
  await newProject(tag, `INSTR-${tag}`)
  await chat(OWNER, { prompt: `pessoal (${tag})` })
  const [system] = systemRounds(tag)
  assert.ok(system !== undefined)
  assert.ok(!system.includes('Project "') && !system.includes(`INSTR-${tag}`))
})

test('every member role gets the project context (a viewer through a SCIM group included); non-members and app admins get none', { skip: SKIP }, async () => {
  const { createProjectContextProvider } = await import('../../server/projectContext.js')
  const tag = `roles-${stamp}`
  const pid = await newProject(tag, `INSTR-${tag}`, [['user', MANAGER, 'manage'], ['user', VIEWER, 'view'], ['group', GROUP, 'view']])
  await upload(OWNER, pid, [[`f-${tag}.txt`, `F-${tag}`]])
  const first = await chat(OWNER, { prompt: `oi (${tag})`, projectId: pid })
  const sid = String(first.events.find((e) => e.type === 'meta').sessionId)
  const provider = createProjectContextProvider()
  const as = (email) => provider({ req: { email, token: undefined }, sessionId: sid, history: [] })
  const previous = pool.setTxGroupsResolver(async (email) => (email === GROUPIE ? [GROUP] : []))
  try {
    const owner = await as(OWNER)
    assert.equal(owner.length, 2)
    assert.match(owner[0], new RegExp(`INSTR-${tag}`))
    for (const email of [MANAGER, VIEWER, GROUPIE]) assert.deepEqual(await as(email), owner, `${email} gets the same messages`)
    for (const email of [OUTSIDER, ADMIN]) assert.deepEqual(await as(email), [], `${email} gets nothing`)
  } finally {
    pool.setTxGroupsResolver(previous)
  }
  // a SCIM failure grants nothing (fail closed)
  const failing = pool.setTxGroupsResolver(async () => {
    throw new Error('scim down')
  })
  try {
    assert.deepEqual(await as(GROUPIE), [])
  } finally {
    pool.setTxGroupsResolver(failing)
  }
  // a chat that is not in a project adds nothing, whoever asks
  const mine = await chat(OWNER, { prompt: `solo (${tag})` })
  const personal = String(mine.events.find((e) => e.type === 'meta').sessionId)
  assert.deepEqual(await provider({ req: { email: OWNER, token: undefined }, sessionId: personal, history: [] }), [])
})

// ---- the budget and the files API -----------------------------------------------

test('files over the budget are named to the model and flagged by the files API with the same selection', { skip: SKIP }, async () => {
  // the budget is 1500 tokens here; ASCII counts 1 token per 2 characters
  const tag = `budget-${stamp}`
  const pid = await newProject(tag, `INSTR-${tag}`, [['user', VIEWER, 'view']])
  const big = `BIG-${tag} ` + 'x'.repeat(2390) // ~1200 tokens
  const mid = `MID-${tag} ` + 'y'.repeat(1990) // ~1000 tokens: ~300 left, under minPartial, excluded
  const small = `SMALL-${tag}`
  const tok = (t) => Math.ceil(t.length / 2)
  const up = await upload(OWNER, pid, [[`1-big-${tag}.txt`, big], [`2-mid-${tag}.txt`, mid], [`3-small-${tag}.txt`, small]])
  assert.equal(up.status, 201, up.text)

  const files = await call('GET', `/api/projects/${pid}/files`, VIEWER)
  assert.equal(files.status, 200)
  assert.deepEqual(files.body.files.map((f) => f.context), ['full', 'excluded', 'full'])
  assert.deepEqual(files.body.files.map((f) => f.context_tokens), [tok(big), tok(mid), tok(small)])
  assert.deepEqual(files.body.files.map((f) => f.extracted_chars), [big.length, mid.length, small.length])
  assert.ok(files.body.files.every((f) => f.truncated_at_upload === false))
  assert.deepEqual(files.body.context, { budget_tokens: 1500, used_tokens: tok(big) + tok(small), excluded_count: 1 })

  const first = await chat(VIEWER, { prompt: `oi (${tag})`, projectId: pid })
  assert.equal(first.status, 200)
  const [system] = systemRounds(tag)
  assert.ok(system.includes(`BIG-${tag}`) && system.includes(`SMALL-${tag}`))
  assert.ok(!system.includes(`MID-${tag}`), 'an excluded file is not read')
  assert.ok(system.includes(`Not read in this chat (over the context budget): 2-mid-${tag}.txt.`))
})

test('a file longer than the extraction cap is flagged truncated_at_upload', { skip: SKIP }, async () => {
  const pid = await newProject(`trunc-${stamp}`, '')
  const up = await upload(OWNER, pid, [[`longo-${stamp}.txt`, 'z'.repeat(60_000)]])
  assert.equal(up.status, 201, up.text)
  const [f] = (await call('GET', `/api/projects/${pid}/files`, OWNER)).body.files
  assert.equal(f.truncated_at_upload, true)
  assert.ok(f.extracted_chars > 50_000 && f.extracted_chars < 60_000)
  assert.equal(f.context, 'partial', 'bigger than the whole budget: clipped, not dropped')
  assert.ok(f.context_tokens >= 1000)
})

test('files uploaded before 0009 (context_tokens NULL) are counted on read and still selected', { skip: SKIP }, async () => {
  const pid = await newProject(`legacy-${stamp}`, '')
  await q(`INSERT INTO project_files (project_id, name, size_bytes, content_text, uploaded_by) VALUES ($1, 'velho.txt', 8, 'abcdefgh', $2)`, [pid, OWNER])
  const [f] = (await call('GET', `/api/projects/${pid}/files`, OWNER)).body.files
  assert.equal(f.context, 'full')
  assert.equal(f.context_tokens, 4)
})

test('PROJECT_CONTEXT_FILES_MAX_TOKENS=0 turns files off but keeps the instructions', { skip: SKIP }, async () => {
  const { selectProjectContextFiles } = await import('../../server/projectContext.js')
  assert.equal(selectProjectContextFiles([{ id: '1', name: 'a', contextTokens: 1 }], 0).files[0].mode, 'excluded')
})

test('GET /api/projects returns { projects, limits } read from the real constants', { skip: SKIP }, async () => {
  const r = await call('GET', '/api/projects', OWNER)
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body.projects))
  const { PROJECT_FILE_LIMITS } = await import('../../server/middleware/index.js')
  const { SUPPORTED_EXTENSIONS, MAX_CHARS_PER_FILE } = await import('../../server/files.ts')
  const { MAX_FILES_PER_PROJECT } = await import('../../server/db/projects.js')
  assert.deepEqual(r.body.limits, {
    nameMaxChars: 200,
    descriptionMaxChars: 2000,
    instructionsMaxChars: 20000,
    fileMaxBytes: PROJECT_FILE_LIMITS.fileSize,
    filesPerUpload: PROJECT_FILE_LIMITS.files,
    filesPerProject: MAX_FILES_PER_PROJECT,
    extractedCharsPerFile: MAX_CHARS_PER_FILE,
    contextFilesMaxTokens: 1500,
    supportedExtensions: SUPPORTED_EXTENSIONS,
  })
  assert.equal(MAX_CHARS_PER_FILE, 50_000)
})

// ---- authorship -------------------------------------------------------------------

test('each message carries sent_by: the member who sent the prompt, and who triggered the answer; legacy rows are null', { skip: SKIP }, async () => {
  const tag = `sentby-${stamp}`
  const pid = await newProject(tag, '', [['user', VIEWER, 'view']])
  const first = await chat(OWNER, { prompt: `dono (${tag})`, projectId: pid })
  const sid = String(first.events.find((e) => e.type === 'meta').sessionId)
  assert.equal((await chat(VIEWER, { prompt: `leitor (${tag})`, sessionId: sid })).status, 200)
  await q(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'antigo')`, [sid]) // no identity: legacy shape
  const r = await call('GET', `/api/sessions/${sid}/messages`, VIEWER)
  assert.equal(r.status, 200)
  const by = r.body.messages.map((m) => [m.role, m.sent_by])
  assert.deepEqual(by, [['user', OWNER], ['assistant', OWNER], ['user', VIEWER], ['assistant', VIEWER], ['user', null]])
})
