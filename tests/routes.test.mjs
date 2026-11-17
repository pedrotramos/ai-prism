// Route tests: the real Express `app` (server/index.js) on an ephemeral port,
// talking to the fake AI Gateway (scripts/fake-gateway.mjs) and a local
// Postgres with pgvector. Requests go through `fetch`, so the middleware,
// multer, the SSE writer and the DB layer all run exactly as in production —
// only the AI Gateway is fake.
//
// Requirements: the same local database as server/isolation.test.js (default
// 127.0.0.1:55432/ai_prism, see `npm run local:up`; CI uses a pgvector
// service). Without it the suite is SKIPPED with the reason; CI runs with
// `--fail-on-skip`, so a skip there is a failure. Rows are written under
// *.test.invalid users and deleted at the end.
//
//   node --test tests/routes.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { startFakeGateway } from '../scripts/fake-gateway.mjs'

const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGDATABASE ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
env.LOCAL_DEV_MODE = '1'
env.LOCAL_PGVECTOR = '1'
// importing server/index.js must not bind :8000 — the test listens on port 0
env.APPKIT_BOOT = '1'
// identities come only from the x-forwarded-email header in these tests
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET
delete env.DATABRICKS_APP_NAME
delete env.DATABRICKS_APP_PORT
delete env.DATABRICKS_APP_URL

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const RUN = randomUUID().slice(0, 8)
const USER_A = `routes-a-${RUN}@test.invalid`
const USER_B = `routes-b-${RUN}@test.invalid`

async function skipReason() {
  if (!LOCAL_HOSTS.has(env.PGHOST) && env.ISOLATION_TEST_ANY_HOST !== '1') {
    return `PGHOST=${env.PGHOST} is not local (set ISOLATION_TEST_ANY_HOST=1 to use another test database)`
  }
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false, connectionTimeoutMillis: 2000 })
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    return ext.rows.length ? null : 'pgvector is not installed in this Postgres'
  } catch (e) {
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${e.code || e.message}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}

// `skip: null` counts as a skip in node:test, so normalise to false
const SKIP = (await skipReason()) || false
let gw
let server
let base

before(async () => {
  if (SKIP) return
  gw = await startFakeGateway({ port: 0 })
  env.DATABRICKS_HOST = gw.url
  const { app } = await import('../server/index.js')
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (SKIP) return
  await new Promise((r) => {
    server?.close(r)
    server?.closeAllConnections() // fetch keep-alive sockets would hold close() open
  })
  await gw?.close()
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false })
  await c.connect()
  try {
    await c.query(`DELETE FROM chat_sessions WHERE user_email = ANY($1)`, [[USER_A, USER_B]])
    await c.query(`DELETE FROM usage_ledger WHERE user_email = ANY($1)`, [[USER_A, USER_B]]).catch(() => {})
  } finally {
    await c.end()
  }
})

function as(email, init = {}) {
  return { ...init, headers: { ...(init.headers || {}), 'x-forwarded-email': email } }
}

async function getJson(path, email) {
  const res = await fetch(`${base}${path}`, as(email))
  return { status: res.status, body: await res.json() }
}

/** POST /api/chat (multipart, like the browser) and collect the SSE events. */
async function chat(email, payload) {
  const form = new FormData()
  form.append('payload', JSON.stringify(payload))
  const res = await fetch(`${base}/api/chat`, as(email, { method: 'POST', body: form }))
  assert.equal(res.status, 200, `POST /api/chat → ${res.status}`)
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/)
  const text = await res.text()
  return text
    .split('\n\n')
    .map((f) => f.trim())
    .filter((f) => f.startsWith('data:'))
    .map((f) => JSON.parse(f.slice(5).trim()))
}

const MODEL = 'databricks-claude-sonnet-5-5'
const state = {}

test('GET /api/me returns the proxy identity', { skip: SKIP }, async () => {
  const { status, body } = await getJson('/api/me', USER_A)
  assert.equal(status, 200)
  assert.equal(body.email, USER_A)
  assert.equal(body.isAdmin, false)
})

test('GET /api/models lists enabled chat models', { skip: SKIP }, async () => {
  const { status, body } = await getJson('/api/models', USER_A)
  assert.equal(status, 200)
  const ids = body.models.map((m) => m.id)
  assert.ok(ids.includes(MODEL), `expected ${MODEL} in ${ids.slice(0, 5).join(', ')}`)
})

test('POST /api/chat streams meta → reasoning → token → done and persists both turns', { skip: SKIP }, async () => {
  const events = await chat(USER_A, { prompt: `Responda apenas com a palavra OK. (${RUN})`, model: MODEL, enabledTools: [] })
  const types = events.map((e) => e.type)
  assert.equal(types[0], 'meta')
  assert.ok(types.includes('reasoning'), `no reasoning event in ${types.join(',')}`)
  assert.ok(types.includes('token'))
  assert.ok(types.includes('done'))
  assert.equal(types.includes('error'), false, JSON.stringify(events.filter((e) => e.type === 'error')))
  state.sessionId = String(events[0].sessionId)
  const answer = events.filter((e) => e.type === 'token').map((e) => e.value).join('')
  assert.equal(answer, 'OK')

  const { body } = await getJson(`/api/sessions/${state.sessionId}/messages`, USER_A)
  assert.ok(body.messages.some((m) => m.role === 'user' && m.content.includes(RUN)))
  assert.ok(body.messages.some((m) => m.role === 'assistant' && m.content === 'OK'))
  const { body: list } = await getJson('/api/sessions', USER_A)
  assert.ok(list.sessions.some((s) => String(s.id) === state.sessionId))
})

test('a document request in the same chat persists a document block', { skip: SKIP }, async () => {
  const events = await chat(USER_A, {
    prompt: `Crie um documento curto com título "Smoke test" e um parágrafo de uma frase. (${RUN})`,
    model: MODEL,
    enabledTools: [],
    sessionId: state.sessionId,
  })
  const doc = events.filter((e) => e.type === 'blocks').flatMap((e) => e.blocks || []).find((b) => b.type === 'document')
  assert.ok(doc?.documentId, `no persisted document block in ${JSON.stringify(events.map((e) => e.type))}`)
  state.documentId = String(doc.documentId)
  const { status, body } = await getJson(`/api/documents/${state.documentId}`, USER_A)
  assert.equal(status, 200)
  assert.match(body.document.markdown, /^# Smoke test/)
})

test('another user cannot read, list or delete the chat and its document', { skip: SKIP }, async () => {
  const msgs = await getJson(`/api/sessions/${state.sessionId}/messages`, USER_B)
  assert.deepEqual(msgs.body.messages, [])
  const list = await getJson('/api/sessions', USER_B)
  assert.equal(list.body.sessions.some((s) => String(s.id) === state.sessionId), false)
  const doc = await getJson(`/api/documents/${state.documentId}`, USER_B)
  assert.equal(doc.status, 404)
  await fetch(`${base}/api/sessions/${state.sessionId}`, as(USER_B, { method: 'DELETE' }))
  const still = await getJson('/api/sessions', USER_A)
  assert.ok(still.body.sessions.some((s) => String(s.id) === state.sessionId), 'B deleted A\'s chat')
})

test('DELETE /api/sessions/:id removes the owner\'s chat', { skip: SKIP }, async () => {
  const res = await fetch(`${base}/api/sessions/${state.sessionId}`, as(USER_A, { method: 'DELETE' }))
  assert.equal(res.status, 200)
  const { body } = await getJson('/api/sessions', USER_A)
  assert.equal(body.sessions.some((s) => String(s.id) === state.sessionId), false)
})

test('an unknown /api path is a JSON 404, not the SPA', { skip: SKIP }, async () => {
  const res = await fetch(`${base}/api/does-not-exist`, as(USER_A))
  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), { error: 'not found' })
})
