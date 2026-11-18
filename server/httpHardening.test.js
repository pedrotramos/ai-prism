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
  outer.disable('x-powered-by') // the wrapper is test-only; the header under test comes from `app`
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

// ---- P4/I2: headers, numeric ids, final error handler ----------------------

test('cabeçalhos de segurança na API e no SPA; sem X-Powered-By', { skip }, async () => {
  for (const path of ['/api/me', '/']) {
    const r = await request('GET', path)
    assert.equal(r.headers['x-powered-by'], undefined, path)
    assert.equal(r.headers['x-content-type-options'], 'nosniff', path)
    assert.equal(r.headers['referrer-policy'], 'same-origin', path)
    assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN', path)
    assert.match(r.headers['content-security-policy'] || '', /frame-ancestors 'self'/, path)
  }
})

test('id malformado: 404 sem mensagem do Postgres (probes X39–X41)', { skip }, async () => {
  for (const [method, path] of [
    ['GET', '/api/sessions/abc/messages'],
    ['GET', '/api/decks/2%20OR%201%3D1'],
    ['GET', '/api/documents/99999999999999999999999'],
    ['PATCH', '/api/messages/abc/activate'],
    ['POST', '/api/sessions/1/messages/x/regenerate'],
  ]) {
    const r = await request(method, path, { body: method === 'GET' ? undefined : {} })
    assert.equal(r.status, 404, `${method} ${path}`)
    assert.doesNotMatch(r.text, /bigint|invalid input syntax|out of range/i, `${method} ${path}`)
  }
})

test('id válido continua chegando à rota', { skip }, async () => {
  const id = await db.createSession(ALICE, 'tok-a', 'válida', 'm1', null, [])
  const r = await request('GET', `/api/sessions/${id}/messages`)
  assert.equal(r.status, 200)
})

test('id textual do catálogo de modelos não é tratado como numérico', { skip }, async () => {
  // no owner/admin configured in this test: the route answers 403, not a 404 from the id check
  const r = await request('PUT', '/api/admin/model-endpoints/databricks-claude-sonnet-x', { body: { enabled: true } })
  assert.equal(r.status, 403)
})

test('JSON malformado: 400 JSON sem stack trace', { skip }, async () => {
  const r = await request('PATCH', '/api/sessions/1', { body: '{"title": }', headers: { 'content-type': 'application/json' } })
  assert.equal(r.status, 400)
  assert.equal(r.json?.code, 'bad_request')
  assert.doesNotMatch(r.text, /SyntaxError|node_modules|at \w+ \(/)
})

// ---- F5/P8: the cost ledger binds to a session only after the owner check ----

async function aliceThread() {
  const sid = await db.createSession(ALICE, 'tok-a', 'thread da Alice', 'm1', null, [])
  await db.addMessage(ALICE, 'tok-a', { sessionId: sid, role: 'user', content: 'pergunta da Alice' })
  const a = await db.addMessage(ALICE, 'tok-a', { sessionId: sid, role: 'assistant', content: 'resposta', model: 'm1' })
  return { sid: String(sid), assistantId: String(a.id) }
}

function ledgerSessionFor(path) {
  const hit = captured.filter((c) => c.path === path).at(-1)
  assert.ok(hit, `request ${path} finished`)
  return hit.sessionId
}

test('ledger: compact/continue/regenerate na sessão de outra pessoa não carregam o session_id dela', { skip }, async () => {
  const { sid, assistantId } = await aliceThread()
  const cases = [
    [`/api/sessions/${sid}/compact`, [409]],
    [`/api/sessions/${sid}/continue`, [404]],
    [`/api/sessions/${sid}/messages/${assistantId}/regenerate`, [404]],
  ]
  for (const [path, statuses] of cases) {
    const r = await request('POST', path, { as: BOB, body: {} })
    assert.ok(statuses.includes(r.status), `${path} -> ${r.status}`)
    assert.equal(ledgerSessionFor(path), null, `${path} bound the ledger to Alice's session`)
  }
})

test('ledger: na própria sessão o vínculo continua (continue após o load do dono)', { skip }, async () => {
  const { sid } = await aliceThread()
  const path = `/api/sessions/${sid}/continue`
  const r = await request('POST', path, { body: {} })
  // the thread ends on an assistant reply: nothing to continue, answered after the owner-scoped load
  assert.notEqual(r.status, 404)
  assert.equal(ledgerSessionFor(path), sid)
})

// ---- F2/P1 wiring: auth() runs the identity binding (QA r1 coverage note) ----
// A fake workspace answers SCIM /Me on loopback; IDENTITY_BINDING=enforce is
// set for this test only (the harness default is off: no Apps markers).
test('auth(): e-mail encaminhado que não é do dono do token → 401; o dono → 200', { skip }, async () => {
  const owners = { [`tok-bind-a-${stamp}`]: ALICE }
  const scim = http.createServer((req, res) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
    if (!req.url.startsWith('/api/2.0/preview/scim/v2/Me')) {
      res.writeHead(404).end()
      return
    }
    if (!owners[token]) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error_code: 401, message: 'Credential was not sent' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], id: '1', userName: owners[token], emails: [] })
    )
  })
  await new Promise((r) => scim.listen(0, '127.0.0.1', r))
  const saved = { host: env.DATABRICKS_HOST, mode: env.IDENTITY_BINDING }
  env.DATABRICKS_HOST = `http://127.0.0.1:${scim.address().port}`
  env.IDENTITY_BINDING = 'enforce'
  try {
    const tokA = `tok-bind-a-${stamp}`
    const forged = await request('GET', '/api/me', { as: BOB, headers: { 'x-forwarded-access-token': tokA } })
    assert.equal(forged.status, 401)
    assert.equal(forged.json?.code, 'identity_mismatch')
    const garbage = await request('GET', '/api/me', { as: ALICE, headers: { 'x-forwarded-access-token': `garbage-${stamp}` } })
    assert.equal(garbage.status, 401)
    assert.equal(garbage.json?.code, 'invalid_token')
    const own = await request('GET', '/api/me', { as: ALICE, headers: { 'x-forwarded-access-token': tokA } })
    assert.equal(own.status, 200)
    assert.equal(own.json?.email, ALICE)
  } finally {
    if (saved.host === undefined) delete env.DATABRICKS_HOST
    else env.DATABRICKS_HOST = saved.host
    if (saved.mode === undefined) delete env.IDENTITY_BINDING
    else env.IDENTITY_BINDING = saved.mode
    await new Promise((r) => scim.close(r))
  }
})

// ---- W1-4: report-only CSP, CSRF variants, rate and body limits ------------

test('W1-4 AC1: Permissions-Policy e CSP report-only em toda resposta (API, SPA, 404)', { skip }, async () => {
  for (const path of ['/api/me', '/', '/api/no-such-route']) {
    const r = await request('GET', path)
    assert.equal(r.headers['x-content-type-options'], 'nosniff', path)
    assert.equal(r.headers['referrer-policy'], 'same-origin', path)
    assert.equal(r.headers['permissions-policy'], 'microphone=(self), camera=()', path)
    const ro = r.headers['content-security-policy-report-only'] || ''
    assert.match(ro, /^default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'/, path)
    assert.match(ro, /report-uri \/api\/csp-report/, path)
    // the enforced policy from h1 is still there, unchanged
    assert.match(r.headers['content-security-policy'] || '', /frame-ancestors 'self'/, path)
  }
})

test('W1-4 AC2: violação POSTada em /api/csp-report de um iframe sandbox (Origin: null) → 204', { skip }, async () => {
  const r = await request('POST', '/api/csp-report', {
    body: JSON.stringify({ 'csp-report': { 'document-uri': 'about:srcdoc', 'effective-directive': 'script-src-elem', 'blocked-uri': 'inline', disposition: 'report' } }),
    headers: { 'content-type': 'application/csp-report', origin: 'null', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(r.status, 204)
})

test('W1-4 AC3: escrita cross-site → 403 (Sec-Fetch-Site e variantes de Origin); same-origin passa', { skip }, async () => {
  const id = await db.createSession(ALICE, 'tok-a', 'csrf variants', 'm1', null, [])
  const path = `/api/sessions/${id}`
  const own = `http://127.0.0.1:${port}`
  const blocked = [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'cross-site', origin: own }, // the browser's verdict wins over a matching Origin
    { 'sec-fetch-site': 'same-site', origin: 'https://other.example' },
    { origin: 'https://evil.example' },
    { origin: 'null' },
    { referer: 'https://evil.example/page' },
    { origin: `http://127.0.0.1:${port + 1}` }, // same host, other port = other origin
  ]
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const headers of blocked) {
      const r = await request(method, path, { body: { title: 'x' }, headers })
      assert.equal(r.status, 403, `${method} ${JSON.stringify(headers)}`)
      assert.equal(r.json?.code, 'cross_site_request')
    }
  }
  for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { origin: own }, { 'sec-fetch-site': 'same-origin', origin: own }]) {
    const r = await request('PATCH', path, { body: { title: 'ok' }, headers })
    assert.equal(r.status, 200, JSON.stringify(headers))
  }
})

test('W1-4 AC4: >120 req/min do mesmo usuário → 429 + Retry-After; outro usuário segue livre', { skip }, async () => {
  const carol = `http-c-${stamp}@test.invalid`
  let first429 = null
  for (let i = 1; i <= 121; i++) {
    const r = await request('GET', '/api/no-such-route', { as: carol })
    if (r.status === 429) {
      first429 = { i, r }
      break
    }
  }
  assert.ok(first429, 'never rate limited')
  assert.equal(first429.i, 121)
  assert.equal(first429.r.json?.code, 'rate_limited')
  assert.match(first429.r.headers['retry-after'] || '', /^\d+$/)
  const other = await request('GET', '/api/no-such-route', { as: `http-d-${stamp}@test.invalid` })
  assert.notEqual(other.status, 429)
})

test('W1-4 AC4: >12 turnos/min do mesmo usuário → 429 + Retry-After', { skip }, async () => {
  const dave = `http-e-${stamp}@test.invalid`
  const statuses = []
  for (let i = 0; i < 13; i++) {
    const r = await request('POST', '/api/sessions/999999/continue', { as: dave, body: {} })
    statuses.push(r.status)
    if (r.status === 429) assert.match(r.headers['retry-after'] || '', /^\d+$/)
  }
  assert.ok(statuses.slice(0, 12).every((s) => s !== 429), statuses.join(','))
  assert.equal(statuses[12], 429)
})

test('W1-4 AC5: JSON de 2 MB → 413 numa rota comum; aceito em /api/deck-templates', { skip }, async () => {
  const big = JSON.stringify({ title: 'x', pad: 'y'.repeat(2 * 1024 * 1024) })
  const id = await db.createSession(ALICE, 'tok-a', 'big body', 'm1', null, [])
  const normal = await request('PATCH', `/api/sessions/${id}`, { body: big, headers: { 'content-type': 'application/json' } })
  assert.equal(normal.status, 413)
  assert.equal(normal.json?.code, 'payload_too_large')
  const docTweak = await request('POST', '/api/documents/1/tweak', { body: big, headers: { 'content-type': 'application/json' } })
  assert.equal(docTweak.status, 413, 'the larger classes do not leak to other routes')
  const templates = await request('POST', '/api/deck-templates', { body: big, headers: { 'content-type': 'application/json' } })
  assert.notEqual(templates.status, 413)
})

// Review B1 (PR #76): the deck studio's AI edit and native export carry the
// whole deck with its images as data: URLs. Each request reaches its route (the
// route's own 404 for a deck/spreadsheet that does not exist), never a 413.
test('W1-4 B1: estúdio com corpo de vários MB chega à rota (tweak, export-html, planilha) — sem 413', { skip }, async () => {
  const img = 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024)
  const cases = [
    ['POST', '/api/decks/999999/tweak', { instruction: 'x', slides: ['<section>s</section>'], images: [{ dataUrl: img, visionUrl: img }] }, /deck/i],
    ['POST', '/api/decks/999999/export-html', { slides: [[{ type: 'image', x: 0, y: 0, w: 1280, h: 720, dataUrl: img }]] }, /deck/i],

    ['POST', '/api/spreadsheets/999999/tweak', { instruction: 'x', images: [{ dataUrl: img }] }, /planilha/i],
    ['PATCH', '/api/spreadsheets/999999', { title: 't', sheets: [{ name: 'a', blocks: [{ kind: 'note', text: 'y'.repeat(3 * 1024 * 1024) }] }] }, /planilha/i],
  ]
  for (const [method, path, body, routeError] of cases) {
    const r = await request(method, path, { body })
    assert.notEqual(r.status, 413, `${method} ${path}`)
    assert.equal(r.status, 404, `${method} ${path} -> ${r.status} ${r.text.slice(0, 120)}`)
    assert.match(r.json?.error || '', routeError, `${method} ${path} answered by the route itself`)
  }
  // the editor save: the route answers (owner-scoped write, a no-op for an id that is not ours)
  const save = await request('PATCH', '/api/decks/999999', { body: { title: 'Deck', slides: [`<section><img src="${img}"></section>`] } })
  assert.equal(save.status, 200, save.text.slice(0, 120))
  assert.equal(save.json?.ok, true)
})

// Review B1 round 2: the largest deck tweak the client admits (4 x 6 MiB raster
// attachments, each sent once, plus 40 full slides) reaches the route.
test('W1-4 B1: o maior tweak de deck que o cliente admite (~36 MB) chega à rota — sem 413', { skip }, async () => {
  const img = (t) => 'data:image/png;base64,' + t.repeat(Math.ceil((6 * 1024 * 1024) / 3) * 4)
  const slides = Array.from({ length: 40 }, (_, i) => '<section>' + String(i).repeat(59_980) + '</section>')
  const body = JSON.stringify({ instruction: 'x', slides, images: ['a', 'b', 'c', 'd'].map((t) => ({ dataUrl: img(t) })), preview: true })
  const r = await request('POST', '/api/decks/999999/tweak', { body, headers: { 'content-type': 'application/json' } })
  assert.notEqual(r.status, 413)
  assert.equal(r.status, 404, r.text.slice(0, 120))
  assert.match(r.json?.error || '', /deck/i)
})

test('W1-4: upload de skill tem limite próprio (5 MB, 1 arquivo) → 413 acima disso', { skip }, async () => {
  const boundary = `----sk${stamp}`
  const file = 'x'.repeat(6 * 1024 * 1024)
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="SKILL.md"\r\nContent-Type: text/markdown\r\n\r\n${file}\r\n` +
    `--${boundary}--\r\n`
  const r = await request('POST', '/api/skills/upload', { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } })
  assert.equal(r.status, 413)
  assert.equal(r.json?.code, 'payload_too_large')
})
