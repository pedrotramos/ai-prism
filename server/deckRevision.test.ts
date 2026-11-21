// N6: optimistic concurrency on deck save (revision check, 409 deck_conflict), proven
// against a real Postgres and the real app.
//
// What is proven:
//   AC1  two saves from the same base: the second gets 409 deck_conflict carrying the
//        current deck; nothing is lost (also for two truly concurrent saves)
//   AC2  a save with the current revision succeeds, the response and the next GET carry
//        the new revision (If-Match header and body `baseRevision` both work)
//   AC4  a save with no base revision is accepted with a warn log (open tabs survive a deploy)
//   AI   the AI tweak path: a stale base conflicts before the model is called (preview or not);
//        a current base writes and advances the revision
//   claim  two simultaneous non-preview AI edits from the same base: exactly one model call; the loser is
//          409 deck_busy before any model spend; the claim is released on success and on every error path;
//          a crashed winner's lease expires on its own; preview edits need no claim but still conflict when stale
//   scope  a stranger never gets a deck back from a conflict (404, no content)
//   0014 adds chat_decks.revision (NOT NULL DEFAULT 1); idempotent; down/up round trip
//
// Scratch database on the local test server, db.js connected as the app role
// (scripts/ci/pg-roles.sql). No Postgres with pgvector → skipped.
//
//   node --test server/deckRevision.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
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
const who = (n: string) => `n6-${n}-${stamp}@test.invalid`
const A = who('a')
const B = who('b')

function opts(database: string | undefined, user = SUPERUSER) {
  return { host: env.PGHOST, port: Number(env.PGPORT), user, password: env.PGPASSWORD, database, ssl: false, connectionTimeoutMillis: 2000 }
}

async function skipReason() {
  if (!LOCAL_HOSTS.has(env.PGHOST!) && env.ISOLATION_TEST_ANY_HOST !== '1') {
    return `PGHOST=${env.PGHOST} is not local (set ISOLATION_TEST_ANY_HOST=1 to use another test server)`
  }
  const c = new pg.Client(opts(ADMIN_DB))
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    return ext.rows.length ? null : 'pgvector is not installed on this Postgres'
  } catch (e) {
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${(e as { code?: string; message?: string }).code || (e as Error).message}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}
const SKIP = (await skipReason()) || false
const quiet = { log() {}, warn() {}, info() {}, error() {}, debug() {} } // debug: the migrate logger type requires it

const createdDbs: string[] = []
const tmpDirs: string[] = []
async function superuser(sql: string, params: unknown[] = [], database: string | undefined = ADMIN_DB) {
  const c = new pg.Client(opts(database))
  await c.connect()
  try {
    return await c.query(sql, params)
  } finally {
    await c.end().catch(() => {})
  }
}

async function scratch({ to }: { to?: number } = {}) {
  const name = `n6_db_${stamp}_${createdDbs.length + 1}`
  await superuser(`CREATE DATABASE ${name}`)
  createdDbs.push(name)
  const c = new pg.Client(opts(name))
  await c.connect()
  try {
    const hasRole = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])
    if (!hasRole.rows.length && APP_ROLE === 'ai_prism_app') {
      await c.query(fs.readFileSync(path.join(REPO, 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
    }
    const { migrateUp } = await import('./db/migrate.ts')
    const { applyAppGrants } = await import('./db/grants.ts')
    let dir: string | undefined
    if (to) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n6-mig-'))
      for (const f of fs.readdirSync(MIGRATIONS)) if (Number.parseInt(f, 10) <= to) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f))
      tmpDirs.push(dir)
    }
    await migrateUp(c, { log: quiet, ...(dir ? { dir } : {}) })
    await applyAppGrants(c, { role: APP_ROLE, log: quiet } as any) // any: the JS option bag is typed only from its destructure defaults
  } finally {
    await c.end().catch(() => {})
  }
  return name
}

interface TweakBarrier {
  seen: number
  released: Promise<unknown>
  releaseBoth: () => void
  onArrival?: (n: number) => void
  waitForArrival?: (n: number) => Promise<unknown>
}
let DB: string
let raw: pg.Client
let server: http.Server | undefined
let base: string
let gw: { url: string; close: () => Promise<void> } // any-shaped fake gateway (scripts/fake-gateway.mjs is untyped JS)
let proxy: http.Server
let tweakBarrier: TweakBarrier | null = null // { seen, released, releaseBoth }: parks tweak model calls until two arrived (or released)
let tweakFail = false // the next tweak model calls answer 500
const modelCalls: string[] = [] // chat completions that reached the gateway (the tweak must not make one when stale)

if (!SKIP) {
  DB = await scratch()
  raw = new pg.Client(opts(DB))
  await raw.connect()
  await raw.query(`SET search_path TO ai_prism, public`)
  env.PGDATABASE = DB
  env.PGUSER = APP_ROLE
  const { startFakeGateway } = await import('../scripts/fake-gateway.mjs')
  gw = await startFakeGateway({ port: 0 })
  // a thin front for the fake gateway: the AI edit prompt ("… <section> novo:") gets a real
  // <section> back, everything else is forwarded untouched
  proxy = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const buf = Buffer.concat(chunks)
      let tweak = false
      try {
        const msgs = JSON.parse(buf.toString('utf8') || '{}').messages || []
        const last = [...msgs].reverse().find((m: { role?: string }) => m?.role === 'user')
        const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content || '')
        tweak = /<section> novo:/.test(text)
      } catch {}
      if (tweak) {
        modelCalls.push('tweak')
        if (tweakBarrier) {
          tweakBarrier.seen++
          const seen = tweakBarrier.seen
          tweakBarrier.onArrival?.(seen)
          if (seen === 2) tweakBarrier.releaseBoth()
          await (tweakBarrier.waitForArrival ? tweakBarrier.waitForArrival(seen) : tweakBarrier.released)
        }
        if (tweakFail) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'boom' } }))
          return
        }
        const body = JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '<section class="slide"><h2>Tweaked</h2></section>' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(body)
        return
      }
      const up = http.request(gw!.url + req.url, { method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode!, r.headers)
        r.pipe(res)
      })
      up.on('error', () => res.destroy())
      up.end(buf)
    })
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  env.DATABRICKS_HOST = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
}
const { app: expressApp } = await import('./index.js')
const { logger } = await import('./log.ts')
if (!SKIP) {
  await new Promise<void>((resolve) => {
    server = expressApp.listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

after(async () => {
  if (server) {
    await new Promise<void>((r) => {
      server!.close(() => r())
      server!.closeAllConnections()
    })
  }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()))
  await gw?.close()
  await raw?.end().catch(() => {})
  if (SKIP) return
  for (const name of createdDbs) {
    await superuser(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]).catch(() => {})
    await superuser(`DROP DATABASE IF EXISTS ${name}`).catch(() => {})
  }
})

const q = async (sql: string, params: unknown[] = []) => (await raw.query(sql, params)).rows

async function call(method: string, p: string, email: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { 'x-forwarded-email': email, ...headers } }
  if (body !== undefined) {
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

const sec = (t: string) => `<section class="slide"><h2>${t}</h2></section>`
async function newDeck(owner = A, slides: string[] = [sec('v1')]) {
  const s = (await q(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 'n6', 'm') RETURNING id`, [owner]))[0].id
  return String(
    (await q(`INSERT INTO chat_decks (session_id, user_email, title, slides, meta) VALUES ($1, $2, 'Deck', $3::jsonb, '{"format":"html"}'::jsonb) RETURNING id`, [s, owner, JSON.stringify(slides)]))[0].id
  )
}
const dbSlides = async (id: string) => (await q(`SELECT slides, revision FROM chat_decks WHERE id = $1`, [id]))[0]

// ---- migration 0014 -----------------------------------------------------------------

test('0014: chat_decks.revision INT NOT NULL DEFAULT 1; idempotent; down removes it; up again restores it (0013 is skipped on purpose)', { skip: SKIP }, async () => {
  assert.ok(fs.existsSync(path.join(MIGRATIONS, '0014_deck_revision.up.sql')))
  assert.ok(!fs.readdirSync(MIGRATIONS).some((f) => f.startsWith('0013_')), '0013 belongs to a closed branch and is never reused')
  const name = await scratch({ to: 12 })
  const c = new pg.Client(opts(name))
  await c.connect()
  try {
    await c.query(`SET search_path TO ai_prism, public`)
    const col = async () =>
      (await c.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'ai_prism' AND table_name = 'chat_decks' AND column_name = 'revision'`)).rows
    assert.equal((await col()).length, 0)
    // a deck that exists before the migration
    const s = (await c.query(`INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, 't', 'm') RETURNING id`, [A])).rows[0].id
    const d = (await c.query(`INSERT INTO chat_decks (session_id, user_email, title, slides) VALUES ($1, $2, 't', '[]'::jsonb) RETURNING id`, [s, A])).rows[0].id

    const up = fs.readFileSync(path.join(MIGRATIONS, '0014_deck_revision.up.sql'), 'utf8')
    const down = fs.readFileSync(path.join(MIGRATIONS, '0014_deck_revision.down.sql'), 'utf8')
    await c.query('BEGIN')
    await c.query(up)
    await c.query(up)
    await c.query('COMMIT')
    const [r] = await col()
    assert.equal(r!.data_type, 'integer')
    assert.equal(r!.is_nullable, 'NO')
    assert.match(r!.column_default, /1/)
    assert.equal((await c.query(`SELECT revision FROM chat_decks WHERE id = $1`, [d])).rows[0].revision, 1, 'existing decks start at revision 1')
    const claimCols = async () =>
      (await c.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'ai_prism' AND table_name = 'chat_decks' AND column_name IN ('tweak_claim', 'tweak_claim_until') ORDER BY 1`)).rows
    assert.deepEqual(await claimCols(), [
      { column_name: 'tweak_claim', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'tweak_claim_until', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ])

    await c.query('BEGIN')
    await c.query(down)
    await c.query(down)
    await c.query('COMMIT')
    assert.equal((await col()).length, 0)
    assert.equal((await claimCols()).length, 0, 'down drops the lease columns too')

    // through the runner: up (to 14), down --to 12, up again
    const { migrateDown, migrateUp, loadMigrations } = await import('./db/migrate.ts')
    assert.ok(loadMigrations(MIGRATIONS).map((m) => m.version).includes(14))
    const u1 = await migrateUp(c, { log: quiet })
    assert.ok(u1.applied.includes(14))
    assert.equal((await col()).length, 1)
    const dn = await migrateDown(c, { to: 12, log: quiet } as any) // any: the JS option bag is typed only from its destructure defaults
    assert.ok(dn.reverted.includes(14))
    assert.equal((await col()).length, 0)
    const u2 = await migrateUp(c, { log: quiet })
    assert.ok(u2.applied.includes(14))
    assert.equal((await col()).length, 1)
  } finally {
    await c.end().catch(() => {})
  }
})

// ---- the save --------------------------------------------------------------------------

test('AC2: GET carries the revision; a save with the current revision (If-Match or baseRevision) succeeds, increments it, and answers with it', { skip: SKIP }, async () => {
  const id = await newDeck()
  const g = await call('GET', `/api/decks/${id}`, A)
  assert.equal(g.body.deck.revision, 1)

  const s1 = await call('PATCH', `/api/decks/${id}`, A, { title: 'Deck', slides: [sec('v2')] }, { 'If-Match': '"1"' })
  assert.equal(s1.status, 200)
  assert.equal(s1.body.deck.revision, 2)
  const s2 = await call('PATCH', `/api/decks/${id}`, A, { title: 'Deck', slides: [sec('v3')], baseRevision: 2 })
  assert.equal(s2.status, 200)
  assert.equal(s2.body.deck.revision, 3)
  assert.equal((await call('GET', `/api/decks/${id}`, A)).body.deck.revision, 3)
  const row = await dbSlides(id)
  assert.equal(row.revision, 3)
  assert.match(JSON.stringify(row.slides), /v3/)
})

test('AC1: two saves from the same base: the second is 409 deck_conflict with the current deck; nothing is lost', { skip: SKIP }, async () => {
  const id = await newDeck()
  const first = await call('PATCH', `/api/decks/${id}`, A, { title: 'Deck', slides: [sec('tab1')] }, { 'If-Match': '1' })
  assert.equal(first.status, 200)
  const second = await call('PATCH', `/api/decks/${id}`, A, { title: 'Deck', slides: [sec('tab2')] }, { 'If-Match': '1' })
  assert.equal(second.status, 409)
  assert.equal(second.body.code, 'deck_conflict')
  assert.equal(second.body.error, 'deck_conflict')
  assert.equal(second.body.revision, 2)
  assert.equal(second.body.deck.revision, 2)
  assert.match(JSON.stringify(second.body.deck.slides), /tab1/, 'the answer is the current (the other tab\'s) deck')
  const row = await dbSlides(id)
  assert.match(JSON.stringify(row.slides), /tab1/)
  assert.ok(!JSON.stringify(row.slides).includes('tab2'), 'the stale write changed nothing')
  assert.equal(row.revision, 2)

  // "keep mine": the client re-sends with the base the 409 gave it
  const over = await call('PATCH', `/api/decks/${id}`, A, { title: 'Deck', slides: [sec('tab2')] }, { 'If-Match': String(second.body.revision) })
  assert.equal(over.status, 200)
  assert.equal(over.body.deck.revision, 3)
  assert.match(JSON.stringify((await dbSlides(id)).slides), /tab2/)
})

test('AC1: two truly concurrent saves from the same base: exactly one wins, the other is 409', { skip: SKIP }, async () => {
  const id = await newDeck()
  const [x, y] = await Promise.all([
    call('PATCH', `/api/decks/${id}`, A, { title: 'Deck', slides: [sec('x')] }, { 'If-Match': '1' }),
    call('PATCH', `/api/decks/${id}`, A, { title: 'Deck', slides: [sec('y')] }, { 'If-Match': '1' }),
  ])
  assert.deepEqual([x.status, y.status].sort(), [200, 409])
  const row = await dbSlides(id)
  assert.equal(row.revision, 2, 'incremented once')
  const winner = x.status === 200 ? 'x' : 'y'
  assert.match(JSON.stringify(row.slides), new RegExp(`>${winner}<`))
})

test('AC4: no base revision (an old open tab) is accepted once, logged as a warning, and still increments', { skip: SKIP }, async () => {
  const id = await newDeck()
  const seen: string[] = []
  const orig = logger.warn
  logger.warn = ((msg: string, ...rest: unknown[]) => {
    seen.push(String(msg))
    return (orig as (...a: unknown[]) => unknown).call(logger, msg, ...rest)
  }) as typeof logger.warn
  try {
    const r = await call('PATCH', `/api/decks/${id}`, A, { title: 'Deck', slides: [sec('legacy')] })
    assert.equal(r.status, 200)
    assert.equal(r.body.deck.revision, 2)
  } finally {
    logger.warn = orig
  }
  assert.ok(seen.some((m) => /deck_revision_missing/.test(m)), `a warn names the missing base (got: ${seen.join(' | ')})`)
})

test('a malformed base revision is 400 deck_revision_invalid and changes nothing', { skip: SKIP }, async () => {
  const id = await newDeck()
  for (const [h, b] of [['abc', undefined], ['0', undefined], ['-3', undefined], [undefined, 'x'], [undefined, 1.5]] as [string | undefined, string | number | undefined][]) {
    const r = await call('PATCH', `/api/decks/${id}`, A, { title: 'Deck', slides: [sec('bad')], ...(b !== undefined ? { baseRevision: b } : {}) }, h ? { 'If-Match': h } : {})
    assert.equal(r.status, 400, `${h} ${b}`)
    assert.equal(r.body.code, 'deck_revision_invalid')
  }
  assert.equal((await dbSlides(id)).revision, 1)
})

test('scope: a stranger with a base revision gets 404 and no deck content; the owner\'s deck is untouched', { skip: SKIP }, async () => {
  const id = await newDeck(A, [sec('private-text')])
  const r = await call('PATCH', `/api/decks/${id}`, B, { title: 'Deck', slides: [sec('hack')] }, { 'If-Match': '7' })
  assert.equal(r.status, 404)
  assert.ok(!r.text.includes('private-text'))
  const g = await call('PATCH', `/api/decks/${id}`, B, { title: 'Deck', slides: [sec('hack')] }, { 'If-Match': '1' })
  assert.equal(g.status, 404, 'even with the right revision')
  const row = await dbSlides(id)
  assert.equal(row.revision, 1)
  assert.ok(!JSON.stringify(row.slides).includes('hack'))
})

// ---- the AI edit path ----------------------------------------------------------------------

test('AI edit: a stale base conflicts before the model is called (preview or not) and writes nothing', { skip: SKIP }, async () => {
  const id = await newDeck()
  assert.equal((await call('PATCH', `/api/decks/${id}`, A, { title: 'Deck', slides: [sec('other-tab')] }, { 'If-Match': '1' })).status, 200)
  const before = modelCalls.length
  for (const preview of [true, false]) {
    const r = await call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview, baseRevision: 1 })
    assert.equal(r.status, 409, `preview=${preview}`)
    assert.equal(r.body.code, 'deck_conflict')
    assert.equal(r.body.deck.revision, 2)
    assert.match(JSON.stringify(r.body.deck.slides), /other-tab/)
  }
  assert.equal(modelCalls.length, before, 'no model call was spent')
  const row = await dbSlides(id)
  assert.equal(row.revision, 2)
  assert.match(JSON.stringify(row.slides), /other-tab/)
})

test('AI edit: a current base writes (non-preview), advances the revision and answers with it; preview writes nothing', { skip: SKIP }, async () => {
  const id = await newDeck()
  const pv = await call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: true, baseRevision: 1 })
  assert.equal(pv.status, 200)
  assert.equal(pv.body.deck.revision, 1, 'a preview leaves the revision alone')
  assert.equal((await dbSlides(id)).revision, 1)

  const w = await call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: false }, { 'If-Match': '1' })
  assert.equal(w.status, 200)
  assert.equal(w.body.deck.revision, 2)
  const row = await dbSlides(id)
  assert.equal(row.revision, 2)
  assert.match(JSON.stringify(row.slides), /Tweaked/)
  // a second write from the same (now stale) base conflicts
  const again = await call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: false, baseRevision: 1 })
  assert.equal(again.status, 409)
})

test('AI edit with no base revision (old tab) still works and advances the revision', { skip: SKIP }, async () => {
  const id = await newDeck()
  const w = await call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: false })
  assert.equal(w.status, 200)
  assert.equal(w.body.deck.revision, 2)
})

// ---- the claim before the model call (QA round 1) -------------------------------------------

test('AI edit: two simultaneous non-preview tweaks from the same base make exactly ONE model call; the loser is 409 before any spend', { skip: SKIP }, async () => {
  const id = await newDeck()
  const before = modelCalls.length
  let releaseModels!: () => void
  let releaseBoth!: () => void
  const released = new Promise<void>((r) => (releaseModels = r))
  const bothModels = new Promise<void>((r) => (releaseBoth = r))
  tweakBarrier = { seen: 0, released, releaseBoth }
  const body = { instruction: 'mais azul', slideIndex: 0, preview: false, baseRevision: 1 }
  const requests = [call('POST', `/api/decks/${id}/tweak`, A, body), call('POST', `/api/decks/${id}/tweak`, A, body)]
  try {
    // the loser answers before the winner's model returns; if instead both reach the model, the barrier trips
    const first = (await Promise.race([...requests.map((r) => r.then((result) => ({ result }))), bothModels.then(() => ({ bothModels: true }))])) as { bothModels?: boolean; result: Awaited<ReturnType<typeof call>> }
    assert.ok(!first.bothModels, 'both requests reached the model before one claimed the deck')
    assert.equal(first.result.status, 409)
    assert.equal(first.result.body.code, 'deck_busy')
    assert.ok(!first.result.text.includes('slides'), 'a busy answer carries no deck content')
    releaseModels()
    const [x, y] = await Promise.all(requests)
    assert.deepEqual([x!.status, y!.status].sort(), [200, 409])
  } finally {
    releaseModels()
    tweakBarrier = null
  }
  assert.equal(modelCalls.length - before, 1, 'one model call, one bill')
  const row = (await q(`SELECT slides, revision, tweak_claim, tweak_claim_until FROM chat_decks WHERE id = $1`, [id]))[0]
  assert.equal(row.revision, 2)
  assert.match(JSON.stringify(row.slides), /Tweaked/)
  assert.equal(row.tweak_claim, null, 'the winner\'s final write released the claim')
  assert.equal(row.tweak_claim_until, null)
})

test('AI edit: a held lease is deck_busy with no model call; once it expires (a crashed winner) the next edit goes through', { skip: SKIP }, async () => {
  const id = await newDeck()
  // a winner that died mid-model: claim set, lease in the future
  await q(`UPDATE chat_decks SET tweak_claim = gen_random_uuid(), tweak_claim_until = now() + interval '120 seconds' WHERE id = $1`, [id])
  const before = modelCalls.length
  const busy = await call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: false, baseRevision: 1 })
  assert.equal(busy.status, 409)
  assert.equal(busy.body.code, 'deck_busy')
  const busyNoBase = await call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: false })
  assert.equal(busyNoBase.status, 409)
  assert.equal(busyNoBase.body.code, 'deck_busy')
  assert.equal(modelCalls.length, before, 'no model call while the lease is held')
  // a preview writes nothing, so it needs no claim and is not blocked by one
  const pv = await call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: true, baseRevision: 1 })
  assert.equal(pv.status, 200)
  // a plain save is not blocked either, and clears the stale claim (the revision moves on)
  // the lease runs out on its own
  await q(`UPDATE chat_decks SET tweak_claim_until = now() - interval '1 second' WHERE id = $1`, [id])
  const ok = await call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: false, baseRevision: 1 })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.deck.revision, 2)
  assert.equal((await q(`SELECT tweak_claim FROM chat_decks WHERE id = $1`, [id]))[0].tweak_claim, null)
})

test('AI edit: a stale base is still deck_conflict (not busy) even while another edit holds the lease', { skip: SKIP }, async () => {
  const id = await newDeck()
  assert.equal((await call('PATCH', `/api/decks/${id}`, A, { title: 'Deck', slides: [sec('moved')] }, { 'If-Match': '1' })).status, 200)
  await q(`UPDATE chat_decks SET tweak_claim = gen_random_uuid(), tweak_claim_until = now() + interval '120 seconds' WHERE id = $1`, [id])
  const r = await call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'x', slideIndex: 0, preview: false, baseRevision: 1 })
  assert.equal(r.status, 409)
  assert.equal(r.body.code, 'deck_conflict')
})

test('AI edit: the claim is released when the model fails, so the next edit is not blocked', { skip: SKIP }, async () => {
  const id = await newDeck()
  tweakFail = true
  try {
    const bad = await call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: false, baseRevision: 1 })
    assert.equal(bad.status, 500)
  } finally {
    tweakFail = false
  }
  const row = (await q(`SELECT revision, tweak_claim, tweak_claim_until FROM chat_decks WHERE id = $1`, [id]))[0]
  assert.equal(row.revision, 1, 'a failed edit changes nothing')
  assert.equal(row.tweak_claim, null)
  assert.equal(row.tweak_claim_until, null)
  const ok = await call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: false, baseRevision: 1 })
  assert.equal(ok.status, 200)
})

test('AI edit: the claim is released when the final write loses to a save that landed while the model worked', { skip: SKIP }, async () => {
  // a save lands while the model works: the winner's write is 409 deck_conflict and its claim is gone
  const id = await newDeck()
  let releaseModels!: () => void
  let arrived!: () => void
  const released = new Promise<void>((r) => (releaseModels = r))
  const inModel = new Promise<void>((r) => (arrived = r))
  tweakBarrier = { seen: 0, released, releaseBoth: arrived }
  tweakBarrier.seen = 1 // the first arrival trips `seen === 2`
  try {
    const tw = call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: false, baseRevision: 1 })
    await inModel
    assert.equal((await call('PATCH', `/api/decks/${id}`, A, { title: 'Deck', slides: [sec('saved-meanwhile')] }, { 'If-Match': '1' })).status, 200)
    releaseModels()
    const r = await tw
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'deck_conflict')
    assert.match(JSON.stringify(r.body.deck.slides), /saved-meanwhile/)
  } finally {
    releaseModels()
    tweakBarrier = null
  }
  const row = (await q(`SELECT slides, revision, tweak_claim FROM chat_decks WHERE id = $1`, [id]))[0]
  assert.equal(row.revision, 2)
  assert.match(JSON.stringify(row.slides), /saved-meanwhile/)
  assert.equal(row.tweak_claim, null)
})

test('AI edit: a holder whose lease expired during a slow model call cannot write or clear its successor\'s claim (fenced by its own token)', { skip: SKIP }, async () => {
  const id = await newDeck()
  const gate = { first: null as unknown as () => void, second: null as unknown as () => void }
  const arrived = { first: null as unknown as () => void, second: null as unknown as () => void }
  const gates = { first: new Promise<void>((r) => (gate.first = r)), second: new Promise<void>((r) => (gate.second = r)) }
  const arrivals = { first: new Promise<void>((r) => (arrived.first = r)), second: new Promise<void>((r) => (arrived.second = r)) }
  const within = <T>(p: Promise<T>, label: string): Promise<T> =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${label}`)), 5000).unref())])
  tweakBarrier = {
    seen: 0,
    released: new Promise(() => {}),
    releaseBoth() {},
    onArrival(n: number) {
      if (n === 1) arrived.first()
      if (n === 2) arrived.second()
    },
    waitForArrival: (n: number) => (n === 1 ? gates.first : gates.second),
  }
  const body = { instruction: 'mais azul', slideIndex: 0, preview: false, baseRevision: 1 }
  type Res = Awaited<ReturnType<typeof call>>
  let firstReq: Promise<Res> | undefined
  let secondReq: Promise<Res> | undefined
  let firstRes!: Res
  let secondRes!: Res
  let original: unknown
  let successor: unknown
  let afterFirst!: Record<string, unknown> & { slides: unknown; revision: unknown }
  try {
    firstReq = call('POST', `/api/decks/${id}/tweak`, A, body)
    await within(arrivals.first, 'the first model call')
    original = (await q(`SELECT tweak_claim FROM chat_decks WHERE id = $1`, [id]))[0].tweak_claim
    // the first holder's 120 s lease lapses while its model call is still running (a controlled timestamp, no sleep)
    await q(`UPDATE chat_decks SET tweak_claim_until = now() - interval '1 second' WHERE id = $1`, [id])
    secondReq = call('POST', `/api/decks/${id}/tweak`, A, body)
    await within(arrivals.second, 'the successor model call')
    successor = (await q(`SELECT tweak_claim FROM chat_decks WHERE id = $1`, [id]))[0].tweak_claim
    assert.ok(successor && successor !== original, 'the expired lease was taken over by a successor')

    // the stale holder's model returns now: it must not write, and must not touch the successor's claim
    gate.first()
    firstRes = await within(firstReq, 'the stale holder\'s answer')
    afterFirst = (await q(`SELECT slides, revision, tweak_claim FROM chat_decks WHERE id = $1`, [id]))[0]

    gate.second()
    secondRes = await within(secondReq, 'the successor\'s answer')
  } finally {
    gate.first()
    gate.second()
    await Promise.allSettled([firstReq, secondReq].filter(Boolean))
    tweakBarrier = null
  }
  assert.equal(firstRes.status, 409)
  assert.equal(firstRes.body.code, 'deck_busy', 'a live successor holds the deck')
  assert.ok(!firstRes.text.includes('slides'), 'no deck content leaks')
  assert.equal(afterFirst.revision, 1, 'the stale holder committed nothing')
  assert.ok(!JSON.stringify(afterFirst.slides).includes('Tweaked'))
  assert.equal(afterFirst.tweak_claim, successor, 'the successor\'s live claim survived')
  // the successor is unaffected: its write lands and releases its own claim
  assert.equal(secondRes.status, 200)
  assert.equal(secondRes.body.deck.revision, 2)
  const row = (await q(`SELECT slides, revision, tweak_claim, tweak_claim_until FROM chat_decks WHERE id = $1`, [id]))[0]
  assert.equal(row.revision, 2)
  assert.match(JSON.stringify(row.slides), /Tweaked/)
  assert.equal(row.tweak_claim, null)
  assert.equal(row.tweak_claim_until, null)
})

test('AI edit: a holder whose lease lapsed but was NOT taken over still writes (the token is still its own)', { skip: SKIP }, async () => {
  const id = await newDeck()
  let release!: () => void
  let arrive!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const arrived = new Promise<void>((r) => (arrive = r))
  tweakBarrier = { seen: 0, released: new Promise(() => {}), releaseBoth() {}, onArrival: () => arrive(), waitForArrival: () => gate }
  let req: Promise<Awaited<ReturnType<typeof call>>> | undefined
  try {
    req = call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: false, baseRevision: 1 })
    await arrived
    await q(`UPDATE chat_decks SET tweak_claim_until = now() - interval '1 second' WHERE id = $1`, [id])
    release()
    const r = await req
    assert.equal(r.status, 200)
    assert.equal(r.body.deck.revision, 2)
  } finally {
    release()
    await Promise.allSettled([req].filter(Boolean))
    tweakBarrier = null
  }
})

// ---- access lost while an AI claim is held (QA round 3) -------------------------------------

test('AI edit: the creator leaves the project while the model runs: the write answers 404 with no deck, the lease is left to expire, then a successor can claim', { skip: SKIP }, async () => {
  const within = <T>(p: Promise<T>, label: string): Promise<T> => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(label)), 5000).unref())])
  const project = await call('POST', '/api/projects', A, { name: `n6-${stamp}` })
  assert.equal(project.status, 201)
  const projectId = project.body.project.id
  assert.equal((await call('POST', `/api/projects/${projectId}/members`, A, { kind: 'user', principal: B, role: 'owner' })).status, 201)
  const sessionId = String((await q(`INSERT INTO chat_sessions (user_email, title, model, project_id) VALUES ($1, 'member removal', 'm', $2) RETURNING id`, [A, projectId]))[0].id)
  const id = String(
    (await q(`INSERT INTO chat_decks (session_id, user_email, title, slides, meta) VALUES ($1, $2, 'Deck', $3::jsonb, '{"format":"html"}'::jsonb) RETURNING id`, [sessionId, A, JSON.stringify([sec('initial')])]))[0].id
  )
  let releaseModel!: () => void
  let arrive!: () => void
  const gate = new Promise<void>((r) => (releaseModel = r))
  const inModel = new Promise<void>((r) => (arrive = r))
  tweakBarrier = { seen: 0, released: new Promise(() => {}), releaseBoth() {}, onArrival: () => arrive(), waitForArrival: () => gate }
  let request: Promise<Awaited<ReturnType<typeof call>>> | undefined
  let result!: Awaited<ReturnType<typeof call>>
  try {
    request = call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: false, baseRevision: 1 })
    await within(inModel, 'the model call')
    assert.ok((await q(`SELECT tweak_claim FROM chat_decks WHERE id = $1`, [id]))[0].tweak_claim, 'the claim is held')
    assert.equal((await call('DELETE', `/api/projects/${projectId}/members/user/${encodeURIComponent(A)}`, A)).status, 200)
    assert.equal((await call('GET', `/api/decks/${id}`, A)).status, 404, 'access is gone')
    releaseModel()
    result = await within(request, 'the tweak answer')
  } finally {
    releaseModel()
    await Promise.allSettled([request].filter(Boolean))
    tweakBarrier = null
  }
  assert.equal(result.status, 404, `like any other access loss (got ${result.status} ${result.text})`)
  assert.ok(!result.body?.deck, 'no deck content')
  assert.ok(!/row-level|policy|chat_decks/i.test(result.text), 'no database detail in the answer')
  const row = (await q(`SELECT slides, revision, tweak_claim FROM chat_decks WHERE id = $1`, [id]))[0]
  assert.equal(row.revision, 1, 'nothing was written')
  assert.ok(!JSON.stringify(row.slides).includes('Tweaked'))
  assert.ok(row.tweak_claim, 'a caller who lost access cannot release the lease: it is left to expire')

  // access comes back (the other owner re-adds the creator): the lease still blocks until it expires, then a new edit claims
  assert.equal((await call('POST', `/api/projects/${projectId}/members`, B, { kind: 'user', principal: A, role: 'owner' })).status, 201)
  const blocked = await call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: false, baseRevision: 1 })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.body.code, 'deck_busy')
  await q(`UPDATE chat_decks SET tweak_claim_until = now() - interval '1 second' WHERE id = $1`, [id])
  const ok = await call('POST', `/api/decks/${id}/tweak`, A, { instruction: 'mais azul', slideIndex: 0, preview: false, baseRevision: 1 })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.deck.revision, 2)
})
