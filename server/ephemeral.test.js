// W3-6: temporary (ephemeral) chats, migration 0011.
//
// What is proven here (AC numbers are the brief's):
//   AC1  created only through the first message of a chat; the flag never changes
//        (PATCH ignores it, the trigger refuses an UPDATE); never in a project (400)
//   AC2  no session embedding, no message vector, no embed call for a temporary
//        chat on /api/chat, /continue and /regenerate, nor in the helpers and the
//        backfill (a normal chat is the control: it IS indexed)
//   AC3  no memory extraction on /api/chat and /continue (regenerate never extracts)
//   AC4  never in the vector search nor in the backfill candidates
//   AC5  DELETE removes it; the ephemeral sweep deletes the ones idle > 24 h
//        (injected clock), spares busy / fresh / normal chats, whatever retention says
//   AC7  admins read a COUNT only; the audit row carries nothing, the list hides it
//   AC8  0011 is idempotent and round-trips (down → up)
//
// Database tests run in a scratch database of the local test server, with db.js
// connected as the non-owner app role (scripts/ci/pg-roles.sql), like
// server/settingsAudit.test.js. No Postgres with pgvector → they are skipped.
//
//   node --test server/ephemeral.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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
env.HISTORY_RETRIEVAL = 'on' // read at import by server/turn.js: the retrieval embed path is live in this file
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
const OWNER = `w36-owner-${stamp}@test.invalid`
const A = `w36-a-${stamp}@test.invalid`
const B = `w36-b-${stamp}@test.invalid`
env.APP_OWNER_EMAIL = OWNER
const MODEL = 'databricks-claude-sonnet-5-5'
const HOUR = 60 * 60 * 1000

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
  const name = `w36_db_${stamp}_${createdDbs.length + 1}`
  await superuser(`CREATE DATABASE ${name}`)
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

let DB, raw, db, eph, retention, memory, embeddings, gw, server, base

if (!SKIP) {
  DB = await scratch()
  raw = new pg.Client(opts(DB))
  await raw.connect()
  await raw.query(`SET search_path TO ai_prism, public`)
  env.PGDATABASE = DB
  env.PGUSER = APP_ROLE
}
db = await import('./db.js')
retention = await import('./retention.ts')
if (!SKIP) {
  const { startFakeGateway } = await import('../scripts/fake-gateway.mjs')
  gw = await startFakeGateway({ port: 0 })
  env.DATABRICKS_HOST = gw.url
}
const { app } = await import('./index.js')
eph = await import('./db/ephemeral.js')
memory = await import('./memory.ts')
embeddings = await import('./lib/embeddings.ts')
const { fakeEmbedding } = await import('../scripts/fake-gateway.mjs')
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
  await gw?.close()
  await raw?.end().catch(() => {})
  if (SKIP) return
  for (const name of createdDbs) {
    await superuser(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]).catch(() => {})
    await superuser(`DROP DATABASE IF EXISTS ${name}`).catch(() => {})
  }
})

const q = async (sql, params = []) => (await raw.query(sql, params)).rows
const as = (email, init = {}) => ({ ...init, headers: { ...(init.headers || {}), 'x-forwarded-email': email } })

async function call(method, p, email, body) {
  const init = as(email, { method })
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

// POST /api/chat, the whole SSE stream drained; resolves { status, sessionId, body }
async function chat(email, payload) {
  const form = new FormData()
  form.append('payload', JSON.stringify({ model: MODEL, enabledTools: [], ...payload }))
  const res = await fetch(`${base}/api/chat`, as(email, { method: 'POST', body: form }))
  const text = await res.text()
  const sid = /"sessionId":"?(\d+)"?/.exec(text)?.[1] || payload.sessionId || null
  return { status: res.status, sessionId: sid, text }
}

const embedCalls = () => gw.requests.filter((r) => r.path === '/serving-endpoints/embeddings').length
const memoryCalls = () =>
  gw.requests.filter((r) => r.path === '/serving-endpoints/chat/completions' && JSON.stringify(r.body?.messages || []).includes('memory extractor')).length
const vectors = async (sid) => ({
  messages: (await q(`SELECT count(*)::int AS n FROM chat_message_embeddings WHERE session_id = $1`, [sid]))[0].n,
  session: (await q(`SELECT embedding IS NOT NULL AS has FROM chat_sessions WHERE id = $1`, [sid]))[0].has,
})
const flag = async (sid) => (await q(`SELECT ephemeral FROM chat_sessions WHERE id = $1`, [sid]))[0]?.ephemeral
const exists = async (sid) => (await q(`SELECT count(*)::int AS n FROM chat_sessions WHERE id = $1`, [sid]))[0].n === 1
const memoryMarker = (items) => `[fake:memory:${Buffer.from(JSON.stringify({ memories: items })).toString('base64url')}]`

async function reset() {
  await q(`DELETE FROM chat_sessions`)
  await q(`DELETE FROM user_memories`)
  await q(`DELETE FROM admin_audit`)
  await q(`DELETE FROM app_settings`)
}

// ---- AC1 ------------------------------------------------------------------------

test('AC1: the first message creates a temporary chat; the flag never changes; a normal chat is not one', { skip: SKIP }, async () => {
  await reset()
  const t = await chat(A, { prompt: 'Responda apenas OK (temp)', ephemeral: true })
  assert.equal(t.status, 200)
  assert.equal(await flag(t.sessionId), true)
  const n = await chat(A, { prompt: 'Responda apenas OK (normal)' })
  assert.equal(await flag(n.sessionId), false)

  // the list and one session say so
  const list = (await call('GET', '/api/sessions', A)).body.sessions
  assert.equal(list.find((s) => s.id === t.sessionId).ephemeral, true)
  assert.equal(list.find((s) => s.id === n.sessionId).ephemeral, false)
  assert.equal((await call('GET', `/api/sessions/${t.sessionId}`, A)).body.session.ephemeral, true)

  // immutable: PATCH ignores it, a later message cannot flip it either way, the row refuses an UPDATE
  await call('PATCH', `/api/sessions/${t.sessionId}`, A, { ephemeral: false, title: 'novo' })
  assert.equal(await flag(t.sessionId), true)
  await chat(A, { sessionId: t.sessionId, prompt: 'de novo', ephemeral: false })
  assert.equal(await flag(t.sessionId), true)
  await chat(A, { sessionId: n.sessionId, prompt: 'de novo', ephemeral: true })
  assert.equal(await flag(n.sessionId), false, 'a normal chat cannot become temporary')
  await assert.rejects(db.updateSession(A, 'tok', t.sessionId, { ephemeral: false }), /cannot change/)
  await assert.rejects(db.updateSession(A, 'tok', n.sessionId, { ephemeral: true }), /cannot change/)
})

test('AC1: a temporary chat cannot belong to a project: 400 at creation and when attaching', { skip: SKIP }, async () => {
  await reset()
  const proj = await call('POST', '/api/projects', A, { name: `p-${stamp}` })
  assert.equal(proj.status, 201)
  const pid = proj.body.project.id
  const created = await chat(A, { prompt: 'oi', ephemeral: true, projectId: pid })
  assert.equal(created.status, 400)
  assert.match(created.text, /ephemeral_in_project/)
  assert.equal((await q(`SELECT count(*)::int AS n FROM chat_sessions`))[0].n, 0, 'nothing was created')

  const t = await chat(A, { prompt: 'oi', ephemeral: true })
  const attach = await call('POST', `/api/projects/${pid}/sessions`, A, { sessionId: t.sessionId })
  assert.equal(attach.status, 400)
  assert.equal(attach.body.error, 'ephemeral_in_project')
  assert.equal((await q(`SELECT project_id FROM chat_sessions WHERE id = $1`, [t.sessionId]))[0].project_id, null)
  // the trigger is the backstop for any other writer
  await assert.rejects(q(`UPDATE chat_sessions SET project_id = $1 WHERE id = $2`, [pid, t.sessionId]), /temporary chat cannot belong to a project/)
})

// ---- AC2 ------------------------------------------------------------------------

test('AC2: no embedding of any kind for a temporary chat on /api/chat, /continue and /regenerate; a normal chat is the control', { skip: SKIP }, async () => {
  await reset()
  const before = embedCalls()
  const n = await chat(A, { prompt: 'Responda apenas OK (controle)' })
  assert.equal(n.status, 200)
  const control = await vectors(n.sessionId)
  assert.ok(control.messages >= 2 && control.session, `control is indexed: ${JSON.stringify(control)}`)
  assert.ok(embedCalls() > before, 'control embedded')

  const mark = embedCalls()
  const t = await chat(A, { prompt: 'Responda apenas OK (temp)', ephemeral: true })
  assert.deepEqual(await vectors(t.sessionId), { messages: 0, session: false }, '/api/chat')
  // /regenerate on the answer
  const msgs = (await call('GET', `/api/sessions/${t.sessionId}/messages`, A)).body.messages
  const answer = msgs.filter((m) => m.role === 'assistant').at(-1)
  const regen = await call('POST', `/api/sessions/${t.sessionId}/messages/${answer.id}/regenerate`, A, { model: MODEL })
  assert.equal(regen.status, 200)
  assert.deepEqual(await vectors(t.sessionId), { messages: 0, session: false }, '/regenerate')
  // /continue: an unanswered user message
  await db.addMessage(A, 'tok', { sessionId: t.sessionId, role: 'user', content: 'e agora?' })
  const cont = await call('POST', `/api/sessions/${t.sessionId}/continue`, A, { model: MODEL })
  assert.equal(cont.status, 200)
  assert.deepEqual(await vectors(t.sessionId), { messages: 0, session: false }, '/continue')
  // a follow-up message in the same chat
  await chat(A, { sessionId: t.sessionId, prompt: 'mais uma' })
  assert.deepEqual(await vectors(t.sessionId), { messages: 0, session: false }, 'follow-up')
  assert.equal(embedCalls(), mark, 'no embed call reached the gateway for the temporary chat')
})

test('AC2: the helpers and the backfill refuse a temporary chat (no write, no call), even when called directly', { skip: SKIP }, async () => {
  await reset()
  const sid = await db.createSession(A, 'tok', 'tmp', MODEL, null, [], null, true)
  await db.addMessage(A, 'tok', { sessionId: sid, role: 'user', content: 'eu prefiro respostas curtas' })
  const req = { email: A, token: 'tok' }
  const mark = embedCalls()
  await embeddings.updateSessionEmbedding(req, sid, [{ role: 'user', content: 'x' }])
  await embeddings.indexSessionMessages(req, sid)
  await embeddings.backfillUserMessageEmbeddings({ email: A, token: 'tok' })
  assert.deepEqual(await vectors(sid), { messages: 0, session: false })
  assert.equal(embedCalls(), mark)
  // the write functions themselves hold the line (defence in depth)
  const [m] = await q(`SELECT id FROM chat_messages WHERE session_id = $1`, [sid])
  await db.setSessionEmbedding(A, 'tok', sid, fakeEmbedding('x'))
  await db.setMessageEmbedding(A, 'tok', sid, m.id, fakeEmbedding('x'))
  assert.deepEqual(await vectors(sid), { messages: 0, session: false })
  assert.deepEqual(await db.listMessagesMissingEmbedding(A, 'tok', sid), [])
  assert.deepEqual(await db.listUserMessagesMissingEmbedding(A, 'tok', 50), [])
})

// Embedding calls reaching the gateway whose input mentions `needle` (the retrieval and the
// skill-routing queries carry their own instruction prefix)
const embedInputs = () =>
  gw.requests.filter((r) => r.path === '/serving-endpoints/embeddings').flatMap((r) => [].concat(r.body?.input ?? []).map(String))
const retrievalCalls = () => embedInputs().filter((x) => x.includes('recupere trechos relevantes')).length
const skillRouteCalls = () => embedInputs().filter((x) => x.includes('recupere as skills')).length

test('AC2: a long temporary chat never sends its prompt to the embedding service while the turn is prepared (history retrieval)', { skip: SKIP }, async () => {
  await reset()
  const run = async (opts) => {
    const first = await chat(A, { prompt: 'primeira mensagem', ...opts })
    for (let i = 0; i < 4; i++) await chat(A, { sessionId: first.sessionId, prompt: `seguimento ${i}` })
    const calls = embedCalls()
    await chat(A, { sessionId: first.sessionId, prompt: 'pergunta que dispara a recuperação' })
    return { sid: first.sessionId, delta: embedCalls() - calls }
  }
  const control = await run({})
  assert.ok(retrievalCalls() >= 1, 'control: the retrieval query IS embedded for a normal long chat')
  const before = retrievalCalls()
  const t = await run({ ephemeral: true })
  assert.equal(t.delta, 0, 'no embedding call at all on a long temporary chat turn')
  assert.equal(retrievalCalls(), before)
  assert.deepEqual(await vectors(t.sid), { messages: 0, session: false })
  assert.ok(control.delta > 0)
})

test('AC2: semantic skill routing is off for a temporary chat (lexical hits and pins still work); a normal chat is the control', { skip: SKIP }, async () => {
  await reset()
  await q(`DELETE FROM skills`)
  const made = await call('POST', '/api/skills', A, { title: 'Relatorio fiscal', description: 'Monta relatórios fiscais trimestrais', body: 'Use o formato X.', triggers: ['xyzzy-gatilho'] })
  assert.equal(made.status, 200)
  const prompt = 'conte algo sobre balanços contábeis anuais'
  const n = skillRouteCalls()
  await chat(A, { prompt })
  assert.ok(skillRouteCalls() > n, 'control: a normal chat embeds the routing query')
  const before = skillRouteCalls()
  const embeds = embedCalls()
  const t = await chat(A, { prompt, ephemeral: true })
  assert.equal(skillRouteCalls(), before)
  assert.equal(embedCalls(), embeds, 'no embedding call of any kind on a temporary chat turn')
  // a lexical trigger still routes the skill
  await chat(A, { sessionId: t.sessionId, prompt: 'use o xyzzy-gatilho agora' })
  const last = gw.requests.filter((r) => r.path === '/serving-endpoints/chat/completions' && r.body?.stream).at(-1)
  assert.ok(JSON.stringify(last.body.messages).includes('Use o formato X.'), 'the lexical skill still applies')
  assert.equal(embedCalls(), embeds)
})

test('AC2: routeSkills with semantic:false (the async form turn.js passes) embeds nothing', { skip: SKIP }, async () => {
  const { routeSkills } = await import('./skills.ts')
  await reset()
  const before = embedCalls()
  const out = await routeSkills({ email: A, token: 'tok' }, 'um texto longo sem gatilho nenhum', { semantic: async () => false })
  assert.ok(Array.isArray(out))
  assert.equal(embedCalls(), before)
})

// ---- AC3 ------------------------------------------------------------------------

test('AC3: no memory extraction for a temporary chat on /api/chat and /continue; a normal chat is the control', { skip: SKIP }, async () => {
  await reset()
  const item = (content) => memoryMarker([{ content, category: 'preference', sensitive: false }])
  const n = await chat(A, { prompt: `Eu prefiro respostas curtas ${item('Prefere respostas curtas.')}` })
  assert.equal(n.status, 200)
  await memory.drainMemoryExtractions()
  assert.equal((await q(`SELECT count(*)::int AS n FROM user_memories WHERE user_email = $1`, [A]))[0].n, 1, 'control learned')

  const calls = memoryCalls()
  const t = await chat(A, { ephemeral: true, prompt: `Eu prefiro respostas longas ${item('Prefere respostas longas.')}` })
  await memory.drainMemoryExtractions()
  await db.addMessage(A, 'tok', { sessionId: t.sessionId, role: 'user', content: `Eu trabalho com dados ${item('Trabalha com dados.')}` })
  assert.equal((await call('POST', `/api/sessions/${t.sessionId}/continue`, A, { model: MODEL })).status, 200)
  await memory.drainMemoryExtractions()
  assert.equal(memoryCalls(), calls, 'the extractor model was never called')
  assert.deepEqual(
    (await q(`SELECT content FROM user_memories WHERE user_email = $1 ORDER BY id`, [A])).map((r) => r.content),
    ['Prefere respostas curtas.']
  )
})

test('AC3: extractTurnMemories fails closed: a throwing check extracts nothing', { skip: SKIP }, async () => {
  const calls = []
  const deps = {
    enabled: async () => true,
    now: async () => new Date().toISOString(),
    complete: async () => (calls.push('complete'), { text: '{"memories":[]}' }),
    save: async () => (calls.push('save'), 0),
  }
  const req = { email: A, token: 'tok' }
  const text = 'Eu prefiro respostas curtas'
  assert.equal(await memory.extractTurnMemories({ req, sessionId: '1', userText: text }, { ...deps, ephemeral: async () => true }), 0)
  await assert.rejects(memory.extractTurnMemories({ req, sessionId: '1', userText: text }, { ...deps, ephemeral: async () => { throw new Error('db down') } }))
  assert.deepEqual(calls, [])
  await memory.extractTurnMemories({ req, sessionId: '1', userText: text }, { ...deps, ephemeral: async () => false })
  assert.deepEqual(calls, ['complete'])
})

// ---- AC4 ------------------------------------------------------------------------

test('AC4: a temporary chat is never a search hit (vector search and GET /api/search), even with a stored vector', { skip: SKIP }, async () => {
  await reset()
  const normal = await db.createSession(A, 'tok', 'normal', MODEL, null, [])
  const temp = await db.createSession(A, 'tok', 'temporaria', MODEL, null, [], null, true)
  const qtext = `Instruct: Dada uma busca do usuário, recupere conversas de chat relevantes.\nQuery: tema-${stamp}`
  const vec = `[${fakeEmbedding(qtext).join(',')}]`
  for (const sid of [normal, temp]) {
    const m = (await q(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'x') RETURNING id`, [sid]))[0].id
    await q(`INSERT INTO chat_message_embeddings (message_id, session_id, embedding) VALUES ($1, $2, $3::vector)`, [m, sid, vec])
  }
  const direct = await db.searchSessionsByVector(A, 'tok', fakeEmbedding(qtext), { limit: 20, minSimilarity: 0.3 })
  assert.deepEqual(direct.map((r) => r.id), [String(normal)])
  const http = await call('GET', `/api/search?q=${encodeURIComponent(`tema-${stamp}`)}`, A)
  assert.equal(http.status, 200)
  assert.deepEqual(http.body.results.map((r) => r.id), [String(normal)])
  assert.ok(!http.text.includes('temporaria'))
})

// ---- AC5: the whole sequence on the real app (DB-backed HTTP integration) ----------
// The browser suite (client/e2e/ephemeral.spec.mjs) answers every endpoint with page.route, so it proves
// WHEN the client sends the DELETE. This test proves what the server does with it, end to end.

test('AC5 integration: create a temporary chat, send a turn, DELETE as the client does on leave: gone from the list, the session route and every table', { skip: SKIP }, async () => {
  await reset()
  const t = await chat(A, { prompt: 'Responda apenas OK (integração)', ephemeral: true })
  assert.equal(t.status, 200)
  const sid = t.sessionId
  assert.ok((await call('GET', '/api/sessions', A)).body.sessions.some((x) => x.id === sid && x.ephemeral === true), 'listed while open')
  assert.ok((await q(`SELECT count(*)::int AS n FROM chat_messages WHERE session_id = $1`, [sid]))[0].n >= 2, 'the turn was stored while open')
  // what the client sends when the user starts a new chat or the tab closes
  const del = await fetch(`${base}/api/sessions/${sid}`, as(A, { method: 'DELETE', keepalive: true }))
  assert.equal(del.status, 200)
  assert.ok(!(await call('GET', '/api/sessions', A)).body.sessions.some((x) => x.id === sid), 'not in the list')
  assert.equal((await call('GET', `/api/sessions/${sid}`, A)).status, 404)
  assert.equal((await call('GET', `/api/sessions/${sid}/messages`, A)).body.messages.length, 0)
  for (const [table, col] of [['chat_sessions', 'id'], ['chat_messages', 'session_id'], ['chat_message_embeddings', 'session_id'], ['chat_compactions', 'session_id']]) {
    assert.equal((await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [sid]))[0].n, 0, `${table} is empty for it`)
  }
  // another user cannot delete it either (nothing to delete after, and before)
  const t2 = await chat(A, { prompt: 'outra', ephemeral: true })
  await fetch(`${base}/api/sessions/${t2.sessionId}`, as(B, { method: 'DELETE' }))
  assert.equal(await exists(t2.sessionId), true, "B's DELETE did not touch A's chat")
})

// ---- AC5 ------------------------------------------------------------------------

test('AC5: leaving the chat deletes it (DELETE /api/sessions/:id) with everything under it', { skip: SKIP }, async () => {
  await reset()
  const t = await chat(A, { prompt: 'Responda apenas OK (temp)', ephemeral: true })
  assert.equal(await exists(t.sessionId), true)
  assert.equal((await call('DELETE', `/api/sessions/${t.sessionId}`, A)).status, 200)
  assert.equal(await exists(t.sessionId), false)
  assert.equal((await q(`SELECT count(*)::int AS n FROM chat_messages WHERE session_id = $1`, [t.sessionId]))[0].n, 0)
  assert.equal((await call('GET', `/api/sessions/${t.sessionId}`, A)).status, 404)
})

async function seedAged(email, { ephemeral, hoursIdle, image = false }) {
  const s = (await q(`INSERT INTO chat_sessions (user_email, title, model, ephemeral) VALUES ($1, 'x', 'm', $2) RETURNING id`, [email, ephemeral]))[0].id
  await q(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', 'segredo')`, [s])
  if (image) await q(`INSERT INTO chat_images (session_id, user_email, prompt, model, volume_path, content_type) VALUES ($1, $2, 'p', 'm', $3, 'image/png')`, [s, email, `/Volumes/c/s/i/${s}.png`])
  await q(`UPDATE chat_sessions SET updated_at = now() - make_interval(secs => $2) WHERE id = $1`, [s, hoursIdle * 3600])
  await q(`UPDATE chat_messages SET created_at = now() - make_interval(secs => $2) WHERE session_id = $1`, [s, hoursIdle * 3600])
  return String(s)
}

test('AC5: the ephemeral sweep deletes temporary chats idle > 24 h and only them, whatever retention says', { skip: SKIP }, async () => {
  await reset()
  const old = await seedAged(A, { ephemeral: true, hoursIdle: 25, image: true })
  const oldB = await seedAged(B, { ephemeral: true, hoursIdle: 30 })
  const fresh = await seedAged(A, { ephemeral: true, hoursIdle: 23 })
  const normalOld = await seedAged(A, { ephemeral: false, hoursIdle: 500 })
  const busy = await seedAged(A, { ephemeral: true, hoursIdle: 40 })
  const files = []
  const r = await retention.runEphemeralSweep({
    now: () => Date.now(),
    busySessionIds: () => [busy],
    deleteFile: async (p) => (files.push(p), true),
    log: quiet,
  })
  assert.equal(r.status, 'done')
  assert.equal(r.sessions, 2)
  assert.deepEqual(files, [`/Volumes/c/s/i/${old}.png`])
  assert.equal(await exists(old), false)
  assert.equal(await exists(oldB), false)
  for (const keep of [fresh, normalOld, busy]) assert.equal(await exists(keep), true, `kept ${keep}`)
  assert.equal((await q(`SELECT count(*)::int AS n FROM chat_messages WHERE session_id = ANY($1)`, [[old, oldB]]))[0].n, 0, 'cascade')
  // the audit holds counts only
  const audit = await q(`SELECT actor_hash, action, target, details FROM admin_audit WHERE action = 'retention.ephemeral'`)
  assert.deepEqual(audit, [{ actor_hash: 'system', action: 'retention.ephemeral', target: 'chat_sessions', details: { sessions: 2, images: 1 } }])
  // a second run has nothing left; the regular sweep (retention off) still deletes nothing
  assert.equal((await retention.runEphemeralSweep({ busySessionIds: () => [busy], deleteFile: async () => true, log: quiet })).sessions, 0)
  assert.equal((await retention.runRetentionSweep({ force: true, log: quiet })).reason, 'off')
  assert.equal(await exists(normalOld), true)
})

test('AC5: the sweep honours an injected clock, and the database floors the idle time at 24 h', { skip: SKIP }, async () => {
  await reset()
  const s = await seedAged(A, { ephemeral: true, hoursIdle: 23 })
  // a clock 2 h ahead makes it 25 h idle: swept
  const ahead = await retention.runEphemeralSweep({ now: () => Date.now() + 2 * HOUR, deleteFile: async () => true, log: quiet })
  assert.equal(ahead.sessions, 0, 'the database policy floors it at 24 h by ITS clock: 23 h idle is still safe')
  assert.equal(await exists(s), true)
  const t = await seedAged(A, { ephemeral: true, hoursIdle: 25 })
  // a clock 2 days BEHIND would spare it (cutoff in the past)
  const behind = await retention.runEphemeralSweep({ now: () => Date.now() - 48 * HOUR, deleteFile: async () => true, log: quiet })
  assert.equal(behind.sessions, 0)
  assert.equal(await exists(t), true)
  // a shorter idleMs than 24 h cannot reach below the floor
  const short = await retention.runEphemeralSweep({ idleMs: HOUR, deleteFile: async () => true, log: quiet })
  assert.equal(short.sessions, 1, 'only the 25 h one')
  assert.equal(await exists(s), true)
  assert.equal(await exists(t), false)
})

test('AC5: the scheduler tick runs the ephemeral rule even with retention off (the safety net for a dead tab)', { skip: SKIP }, async () => {
  await reset()
  const old = await seedAged(A, { ephemeral: true, hoursIdle: 26 })
  const keep = await seedAged(A, { ephemeral: false, hoursIdle: 26 })
  const timers = []
  const stop = retention.startRetentionScheduler({ env: {}, setTimer: (fn) => (timers.push(fn), { unref() {} }), clearTimer() {}, log: quiet })
  await timers[0]() // the first tick, as the timer would call it
  stop()
  assert.equal(await exists(old), false)
  assert.equal(await exists(keep), true)
})

// ---- AC7 ------------------------------------------------------------------------

test('AC7: admins read a count only; the audit row holds nothing; the audit list hides it; non-admins are refused', { skip: SKIP }, async () => {
  await reset()
  await chat(A, { prompt: 'segredo-do-usuario-A', ephemeral: true })
  await chat(B, { prompt: 'segredo-do-usuario-B', ephemeral: true })
  await chat(A, { prompt: 'normal' })
  const count = await call('GET', '/api/admin/ephemeral-chats', OWNER)
  assert.equal(count.status, 200)
  assert.deepEqual(Object.keys(count.body).sort(), ['last24h', 'last7d', 'total'])
  assert.deepEqual(count.body, { total: 2, last24h: 2, last7d: 2 })
  assert.equal((await call('GET', '/api/admin/ephemeral-chats', A)).status, 403)
  // what is stored: system actor, no target, empty details, nothing that identifies a chat or a person
  const rows = await q(`SELECT actor_hash, action, target, details FROM admin_audit WHERE action = 'ephemeral.started'`)
  assert.equal(rows.length, 2)
  for (const r of rows) assert.deepEqual(r, { actor_hash: 'system', action: 'ephemeral.started', target: null, details: {} })
  // counted, not listed
  const list = await call('GET', '/api/admin/audit', OWNER)
  assert.ok(!list.text.includes('ephemeral.started'))
  // an ordinary request identity cannot write anything else into the audit through the new policy
  const w = (sql) => import('./db/pool.js').then(({ withTx }) => withTx(A, 'tok', (c) => c.query(sql)))
  await assert.rejects(w(`INSERT INTO admin_audit (actor_hash, action, details) VALUES ('system', 'ephemeral.started', '{"session":1}')`))
  await assert.rejects(w(`INSERT INTO admin_audit (actor_hash, action, target) VALUES ('system', 'ephemeral.started', 'chat_sessions')`))
  await assert.rejects(w(`INSERT INTO admin_audit (actor_hash, action) VALUES ('system', 'settings.update')`))
  await assert.rejects(w(`INSERT INTO admin_audit (actor_hash, action) VALUES ('h2:abc', 'ephemeral.started')`))
  assert.deepEqual(await eph.countEphemeralChats(A, 'tok', { admin: false }), { total: 0, last24h: 0, last7d: 0 }, 'no admin flag, no rows')
})

// ---- AC8 ------------------------------------------------------------------------

test('AC8: 0011 is idempotent; down removes the column, the trigger and the new policy and restores 0007; up again matches', { skip: SKIP }, async () => {
  const name = await scratch()
  const c = new pg.Client(opts(name))
  await c.connect()
  try {
    await c.query(`SET search_path TO ai_prism, public`)
    const state = async () => ({
      cols: (await c.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'ai_prism' AND table_name = 'chat_sessions' AND column_name = 'ephemeral'`)).rows,
      policies: (
        await c.query(
          `SELECT c.relname || '.' || p.polname AS n, pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS w
             FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
            WHERE c.relnamespace = 'ai_prism'::regnamespace AND (p.polname LIKE 'aipr\\_%' OR p.polname LIKE 'aipe\\_%') ORDER BY 1`
        )
      ).rows,
      triggers: (await c.query(`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'aipe\\_%' AND NOT tgisinternal`)).rows,
    })
    const before = await state()
    assert.equal(before.cols.length, 1)
    assert.equal(before.cols[0].is_nullable, 'NO')
    assert.ok(before.policies.some((p) => p.n === 'admin_audit.aipe_started_insert'))
    assert.equal(before.policies.filter((p) => p.n.endsWith('aipr_maint_read')).length, 6)
    assert.ok(before.policies.every((p) => !/aip_retention_cutoff\(\)\)?$/.test(p.q || '') || /aip_session_swept/.test(p.q || '') || p.n.startsWith('admin_audit') || p.n.startsWith('app_settings')))
    const up = fs.readFileSync(path.join(MIGRATIONS, '0011_ephemeral.up.sql'), 'utf8')
    const down = fs.readFileSync(path.join(MIGRATIONS, '0011_ephemeral.down.sql'), 'utf8')
    await c.query('BEGIN')
    await c.query(up)
    await c.query(up)
    await c.query('COMMIT')
    assert.deepEqual(await state(), before, 'running the up body twice changes nothing')

    await c.query(`INSERT INTO chat_sessions (user_email, title, model, ephemeral) VALUES ('x@test.invalid', 't', 'm', true)`)
    const { migrateDown, migrateUp, loadMigrations } = await import('./db/migrate.js')
    const versions = loadMigrations(MIGRATIONS).map((m) => m.version)
    assert.ok(versions.includes(11))
    const d = await migrateDown(c, { to: 10, log: quiet })
    assert.deepEqual(d.reverted, versions.filter((v) => v > 10).reverse())
    const mid = await state()
    assert.deepEqual(mid.cols, [])
    assert.deepEqual(mid.triggers, [])
    assert.ok(!mid.policies.some((p) => p.n.includes('aipe_')), 'the audit policy is gone')
    assert.equal(mid.policies.filter((p) => p.n.endsWith('aipr_maint_read')).length, 6, '0007 policies are back')
    assert.ok(mid.policies.every((p) => !/aip_session_swept/.test(`${p.q} ${p.w}`)))
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('aip_session_swept', 'aipe_session_guard')`)).rows[0].n, 0)
    await c.query('BEGIN')
    await c.query(down)
    await c.query(down)
    await c.query('ROLLBACK')
    const u = await migrateUp(c, { log: quiet })
    assert.deepEqual(u.applied, versions.filter((v) => v > 10))
    assert.deepEqual(await state(), before)
    // the old row survived as an ordinary chat
    assert.equal((await c.query(`SELECT ephemeral FROM chat_sessions WHERE user_email = 'x@test.invalid'`)).rows[0].ephemeral, false)
  } finally {
    await c.end().catch(() => {})
  }
})
