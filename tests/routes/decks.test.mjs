// Deck studio input budgets (W2-16) against the real app: a speaker note over
// 9 MiB, an attachment over 6 MiB or a fifth attachment is refused by the
// server with a 413 that names the limit (`code`, `limit`), BEFORE the deck is
// read, written or sent to a model; a deck at the documented maximum (4 x 6 MiB
// attachments + one 9 MiB note) still goes through.
//
// The real Express app (server/index.js) on an ephemeral port, the fake AI
// Gateway and the local test Postgres (same requirements as
// tests/routes.test.mjs). No Postgres with pgvector → skipped (CI runs with
// --fail-on-skip).
//
//   node --test tests/routes/decks.test.mjs
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
env.APPKIT_BOOT = '1' // importing server/index.js must not bind :8000
env.RATE_LIMIT_API_PER_MIN = '0'
env.RATE_LIMIT_TURNS_PER_MIN = '0'
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET
delete env.DATABRICKS_APP_NAME
delete env.DATABRICKS_APP_PORT
delete env.DATABRICKS_APP_URL

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const USER = `w216-${randomUUID().slice(0, 8)}@test.invalid`

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

const MiB = 1024 * 1024
const NOTE_LIMIT = 9 * MiB // 9437184 bytes (UTF-8)
const IMAGE_LIMIT = 6 * MiB // 6291456 decoded bytes
// a base64 data: URL that decodes to exactly `bytes` bytes (bytes % 3 === 0)
const imageOf = (bytes, tag = 'A') => 'data:image/png;base64,' + tag.repeat((bytes / 3) * 4)
const SLIDE = '<section><h1>Budget</h1></section>'

let gw, server, base, db, deckId
const calls = () => gw.requests.filter((r) => r.path.includes('/chat/completions')).length

before(async () => {
  if (SKIP) return
  gw = await startFakeGateway({ port: 0 })
  env.DATABRICKS_HOST = gw.url
  const { app } = await import('../../server/index.js')
  db = await import('../../server/db.js')
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
  // first request creates the schema
  await fetch(`${base}/api/me`, { headers: { 'x-forwarded-email': USER } })
  const sid = await db.createSession(USER, 'token', 'W2-16', 'databricks-claude-sonnet-5-5', null, [])
  deckId = await db.createDeck(USER, 'token', sid, 'Budget deck', [{ html: SLIDE, notes: 'original note' }], { format: 'html' })
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
    await c.query(`DELETE FROM usage_ledger WHERE user_email = $1`, [USER]).catch(() => {})
  } finally {
    await c.end()
  }
})

async function send(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-forwarded-email': USER }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const storedDeck = async () => (await send('GET', `/api/decks/${deckId}`)).body.deck
const tweak = (extra) => send('POST', `/api/decks/${deckId}/tweak`, { instruction: 'make it bolder', slideIndex: null, preview: true, slides: [{ html: SLIDE, notes: 'n' }], ...extra })

// ---- AC-1: speaker note over 9 MiB ------------------------------------------

test('AC-1: saving a slide whose speaker note is 1 byte over 9 MiB is 413 deck_note_too_large naming the limit, and the stored deck is untouched', { skip: SKIP }, async () => {
  const r = await send('PATCH', `/api/decks/${deckId}`, { title: 'Budget deck', slides: [SLIDE, { html: SLIDE, notes: 'x'.repeat(NOTE_LIMIT + 1) }] })
  assert.equal(r.status, 413)
  assert.equal(r.body.code, 'deck_note_too_large')
  assert.equal(r.body.limit, 9437184)
  assert.equal(r.body.slide, 2) // 1-based, the slide the user sees
  assert.match(r.body.error, /9 MiB/)
  const d = await storedDeck()
  assert.deepEqual(d.slides, [{ html: SLIDE, notes: 'original note' }])
})

test('AC-1: the note budget counts UTF-8 bytes, not characters (3.2 Mi "€" = 9.6 MiB)', { skip: SKIP }, async () => {
  const notes = '€'.repeat(Math.floor(NOTE_LIMIT / 3) + 1) // 3 bytes each → 9437187 bytes, only 3145729 chars
  const r = await send('PATCH', `/api/decks/${deckId}`, { title: 'Budget deck', slides: [{ html: SLIDE, notes }] })
  assert.equal(r.status, 413)
  assert.equal(r.body.code, 'deck_note_too_large')
})

test('AC-1: an AI edit whose working slides carry an oversized note is refused before any model call', { skip: SKIP }, async () => {
  const before = calls()
  const r = await tweak({ slides: [{ html: SLIDE, notes: 'x'.repeat(NOTE_LIMIT + 1) }] })
  assert.equal(r.status, 413)
  assert.equal(r.body.code, 'deck_note_too_large')
  assert.equal(r.body.limit, 9437184)
  assert.equal(r.body.slide, 1)
  assert.equal(calls(), before)
})

// ---- AC-2: attachment over 6 MiB, or a fifth one -----------------------------

test('AC-2: an AI edit with a 7 MiB attachment is 413 deck_image_too_large naming the limit, before any model call', { skip: SKIP }, async () => {
  const before = calls()
  const r = await tweak({ images: [{ dataUrl: imageOf(IMAGE_LIMIT, 'a') }, { dataUrl: imageOf(7 * MiB - 1, 'b') }] }) // 7 MiB - 1 is a multiple of 3
  assert.equal(r.status, 413)
  assert.equal(r.body.code, 'deck_image_too_large')
  assert.equal(r.body.limit, 6291456)
  assert.equal(r.body.image, 2)
  assert.match(r.body.error, /6 MiB/)
  assert.equal(calls(), before)
})

test('AC-2: an SVG attachment counts its raster vision copy too (5 MiB + 1.5 MiB > 6 MiB)', { skip: SKIP }, async () => {
  const svg = 'data:image/svg+xml;base64,' + 'P'.repeat(((5 * MiB - 2) / 3) * 4) // 5 MiB - 2 = multiple of 3
  const r = await tweak({ images: [{ dataUrl: svg, visionUrl: imageOf(1.5 * MiB) }] })
  assert.equal(r.status, 413)
  assert.equal(r.body.code, 'deck_image_too_large')
})

test('AC-2: a fifth attachment is 413 deck_too_many_images naming the limit, not silently dropped', { skip: SKIP }, async () => {
  const before = calls()
  const images = ['a', 'b', 'c', 'd', 'e'].map((t) => ({ dataUrl: imageOf(3, t) }))
  const r = await tweak({ images })
  assert.equal(r.status, 413)
  assert.equal(r.body.code, 'deck_too_many_images')
  assert.equal(r.body.limit, 4)
  assert.equal(r.body.image, 5) // 1-based: the first attachment past the limit
  assert.equal(calls(), before)
})

// ---- AC-3: the documented maximum still saves --------------------------------

test('AC-3: a slide with a speaker note of exactly 9 MiB saves and reloads intact', { skip: SKIP }, async () => {
  const notes = 'n'.repeat(NOTE_LIMIT)
  const r = await send('PATCH', `/api/decks/${deckId}`, { title: 'Budget deck', slides: [{ html: SLIDE, notes }] })
  assert.equal(r.status, 200)
  const d = await storedDeck()
  assert.equal(d.slides[0].notes.length, NOTE_LIMIT)
})

test('AC-3: an AI edit at the documented maximum (4 x 6 MiB attachments + a 9 MiB note) goes through and keeps the note', { skip: SKIP }, async () => {
  const images = ['a', 'b', 'c', 'd'].map((t) => ({ dataUrl: imageOf(IMAGE_LIMIT, t) }))
  const r = await tweak({ images, slides: [{ html: SLIDE, notes: 'n'.repeat(NOTE_LIMIT) }] })
  assert.equal(r.status, 200, JSON.stringify(r.body)?.slice(0, 200))
  assert.equal(r.body.preview, true)
  assert.equal(r.body.deck.slides[0].notes.length, NOTE_LIMIT)
})
