// HTTP-level hardening, exercised against the real Express app (server/index.js)
// on an ephemeral port: CSRF guard on the routes, security headers, numeric id
// validation, the final error handler and the cost-ledger session binding.
//
// Needs a local Postgres (same as server/isolation.test.js; `npm run local:up`
// or the CI pgvector service). The suite creates and drops its own scratch
// database, so it never races the isolation suite's DDL. No Postgres → skipped.
//
//   node --test server/httpHardening.test.js
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import pg from 'pg'

const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGDATABASE ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
env.LOCAL_DEV_MODE = '1'
env.APPKIT_BOOT = '1' // import the app without listening on :8000
delete env.LOCAL_PGVECTOR // plain DOUBLE PRECISION[] embeddings table: no extension needed
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET
delete env.DATABRICKS_HOST // nothing in these tests may reach a workspace
for (const name of ['DATABRICKS_APP_NAME', 'DATABRICKS_APP_PORT', 'DATABRICKS_APP_URL', 'IDENTITY_BINDING']) delete env[name]

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const SCRATCH_DB = `ai_prism_http_${stamp}`
const ALICE = `http-a-${stamp}@test.invalid`
const BOB = `http-b-${stamp}@test.invalid`

function adminClient(database = env.PGDATABASE) {
  return new pg.Client({
    host: env.PGHOST,
    port: Number(env.PGPORT),
    user: env.PGUSER,
    password: env.PGPASSWORD,
    database,
    ssl: false,
    connectionTimeoutMillis: 2000,
  })
}

async function skipReason() {
  if (!LOCAL_HOSTS.has(env.PGHOST)) return `PGHOST=${env.PGHOST} is not local`
  const c = adminClient()
  try {
    await c.connect()
    await c.query(`CREATE DATABASE ${SCRATCH_DB}`)
    return null
  } catch (e) {
    return `no usable Postgres at ${env.PGHOST}:${env.PGPORT} (${e.code || e.message}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}

const SKIP = await skipReason()
const skip = SKIP || false

let server
let port
let db
let app
let captured = [] // req.usageScope.sessionId of every finished request (F5)

before(async () => {
  if (SKIP) return
  env.PGDATABASE = SCRATCH_DB
  ;({ app } = await import('./index.js'))
  db = await import('./db.js')
  await db.ensureSchema(ALICE, 'tok-a')
  // an outer app sees the same req object the inner app's routes see, so it can
  // read which session the cost ledger was bound to once the response is done
  const express = (await import('express')).default
  const outer = express()
  outer.use((req, res, next) => {
    res.on('finish', () => captured.push({ path: req.path, sessionId: req.usageScope?.sessionId ?? null }))
    next()
  })
  outer.use(app)
  server = http.createServer(outer)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  port = server.address().port
})

after(async () => {
  if (server) await new Promise((r) => server.close(r))
  if (SKIP) return
  // drop the scratch database (the app's pools may still hold connections)
  const c = adminClient(env.PGDATABASE === SCRATCH_DB ? 'postgres' : env.PGDATABASE)
  try {
    await c.connect()
    await c.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`)
  } finally {
    await c.end().catch(() => {})
  }
})

// raw node:http so the test controls every header (fetch adds Sec-Fetch-* itself)
function request(method, path, { as = ALICE, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { 'x-forwarded-email': as, 'x-forwarded-access-token': `tok-${as}`, ...headers }
    let payload = body
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      payload = JSON.stringify(body)
      h['content-type'] ||= 'application/json'
    }
    if (payload != null) h['content-length'] = Buffer.byteLength(payload)
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(20_000, () => req.destroy(new Error(`timeout ${method} ${path}`)))
    if (payload != null) req.write(payload)
    req.end()
  })
}

function multipart(fields) {
  const boundary = `----h1${stamp}`
  const parts = Object.entries(fields).map(
    ([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
  )
  return { body: parts.join('') + `--${boundary}--\r\n`, type: `multipart/form-data; boundary=${boundary}` }
}

async function sessionCount(email) {
  const c = adminClient(SCRATCH_DB)
  await c.connect()
  try {
    return Number((await c.query(`SELECT count(*) FROM chat_sessions WHERE user_email = $1`, [email])).rows[0].count)
  } finally {
    await c.end()
  }
}

// ---- F3/P2: CSRF -----------------------------------------------------------

test('C3: POST multipart /api/chat de outro site é recusado antes de criar sessão', { skip }, async () => {
  const before = await sessionCount(BOB)
  const { body, type } = multipart({ payload: JSON.stringify({ prompt: 'csrf probe', enabledTools: [] }) })
  const r = await request('POST', '/api/chat', {
    as: BOB,
    body,
    headers: {
      'content-type': type,
      origin: 'https://evil.example',
      referer: 'https://evil.example/x',
      'sec-fetch-site': 'cross-site',
    },
  })
  assert.equal(r.status, 403)
  assert.equal(r.json?.code, 'cross_site_request')
  assert.equal(await sessionCount(BOB), before, 'no session was created for the victim')
})

test('C3: o mesmo POST vindo do próprio app (same-origin) não é barrado pelo guard', { skip }, async () => {
  const id = await db.createSession(ALICE, 'tok-a', 'minha sessão', 'm1', null, [])
  const r = await request('PATCH', `/api/sessions/${id}`, {
    body: { title: 'renomeada' },
    headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(r.status, 200)
})
