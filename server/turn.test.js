// The chat turn (server/turn.js).
//
// Unit part: the tool-call chip labels built by the turn loop (toolCallLabel). A
// label error is not cosmetic: the label is built inside runAssistantTurn's tool
// loop, so a throw there ends the whole turn with an error event.
//
// Route part: the three turn routes (/api/chat, /continue, /regenerate) on the
// real Express app, against the fake AI Gateway (scripts/fake-gateway.mjs) and
// the local pgvector Postgres used by tests/routes.test.mjs. Covers the
// per-session turn lock (409 turn_in_flight), the busy field on
// GET /api/sessions/:id, the context-provider registry, the lazy deck-template
// load, the stop-on-disconnect rule and the 3-route SSE parity. Without the
// database these are SKIPPED with the reason; CI runs --fail-on-skip.
//
//   node --test server/turn.test.js
import test, { before, after, describe } from 'node:test'
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
// importing the server must not bind :8000 — the route tests listen on port 0
env.APPKIT_BOOT = '1'
// these suites drive many turns and API calls as one user; the per-user rate
// limit (server/middleware/rateLimit.js, read when the app is imported) is off
// here. Its defaults are asserted by rateLimit.test.js and httpHardening.test.js.
env.RATE_LIMIT_API_PER_MIN = '0'
env.RATE_LIMIT_TURNS_PER_MIN = '0'
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET
delete env.DATABRICKS_APP_NAME
delete env.DATABRICKS_APP_PORT
delete env.DATABRICKS_APP_URL

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

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
// the fake gateway must be DATABRICKS_HOST before the server modules load
const gw = SKIP ? null : await startFakeGateway({ port: 0 })
if (gw) env.DATABRICKS_HOST = gw.url

const turn = await import('./turn.js')
const { toolCallLabel } = turn

// ---------------------------------------------------------------- unit: labels

test('web-fetch label shows the URL', () => {
  assert.equal(toolCallLabel({ kind: 'web-fetch' }, { url: 'https://example.com/a' }, 'web_fetch'), 'Web Fetch · https://example.com/a')
})

test('web-fetch label cuts a long URL at 80 characters with an ellipsis', () => {
  const url = 'https://example.com/' + 'a'.repeat(80) // 100 chars
  assert.equal(toolCallLabel({ kind: 'web-fetch' }, { url }, 'web_fetch'), 'Web Fetch · https://example.com/' + 'a'.repeat(60) + '…')
})

test('genie-one label drops the question lead-in', () => {
  assert.equal(toolCallLabel({ kind: 'genie-one' }, { question: 'Qual foi a receita por mês?' }, 'genie_one'), 'Genie One · a receita por mês?')
})

test('python label uses the leading comment of the code', () => {
  assert.equal(toolCallLabel({ kind: 'python' }, { code: '# projeção de vendas\nx = 1' }, 'python'), 'Python · projeção de vendas')
})

// ---------------------------------------------------------------- route tests

const RUN = randomUUID().slice(0, 8)
const USER = `turn-a-${RUN}@test.invalid`
const OTHER = `turn-b-${RUN}@test.invalid`
const MODEL = 'databricks-claude-sonnet-5-5'

let server
let base

function as(email, init = {}) {
  return { ...init, headers: { ...(init.headers || {}), 'x-forwarded-email': email } }
}

function parseSse(text) {
  return text
    .split('\n\n')
    .map((f) => f.trim())
    .filter((f) => f.startsWith('data:'))
    .map((f) => JSON.parse(f.slice(5).trim()))
}

/** Reads a turn response: SSE events on 200, the JSON body otherwise. */
async function readTurn(res) {
  const type = res.headers.get('content-type') || ''
  if (res.status === 200 && type.includes('text/event-stream')) return { status: 200, sse: true, events: parseSse(await res.text()) }
  return { status: res.status, sse: type.includes('text/event-stream'), body: await res.json().catch(() => null) }
}

function chat(email, payload, init = {}) {
  const form = new FormData()
  form.append('payload', JSON.stringify({ model: MODEL, enabledTools: [], ...payload }))
  return fetch(`${base}/api/chat`, as(email, { method: 'POST', body: form, ...init })).then(readTurn)
}

function postTurn(email, path, body = {}, init = {}) {
  return fetch(
    `${base}${path}`,
    as(email, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, enabledTools: [], ...body }), ...init })
  ).then(readTurn)
}

const cont = (email, sessionId, init) => postTurn(email, `/api/sessions/${sessionId}/continue`, {}, init)
const regen = (email, sessionId, messageId, init) => postTurn(email, `/api/sessions/${sessionId}/messages/${messageId}/regenerate`, {}, init)

async function getJson(path, email) {
  const res = await fetch(`${base}${path}`, as(email))
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function messages(sessionId) {
  return (await getJson(`/api/sessions/${sessionId}/messages`, USER)).body.messages
}

async function lastAssistantId(sessionId) {
  return [...(await messages(sessionId))].reverse().find((m) => m.role === 'assistant').id
}

/** Opens a chat for USER with one answered exchange; returns its id. */
async function newSession(prompt = `Responda apenas com a palavra OK. (${RUN})`) {
  const r = await chat(USER, { prompt })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return String(r.events.find((e) => e.type === 'meta').sessionId)
}

/** Appends an unanswered user message straight in the database (what /continue recovers). */
async function appendUserMessage(sessionId, content) {
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false })
  await c.connect()
  try {
    await c.query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', $2)`, [sessionId, content])
  } finally {
    await c.end()
  }
}

/** The text of the last user message in a model request. */
function lastUser(body) {
  const m = [...(body?.messages || [])].reverse().find((x) => x.role === 'user')
  return typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '')
}

/** Streaming model calls (the turn's tool rounds) whose current user message contains `marker`. */
function roundsFor(marker) {
  return gw.requests.filter((r) => r.path === '/serving-endpoints/chat/completions' && r.body?.stream && lastUser(r.body).includes(marker))
}

/**
 * Registers a context provider that holds every turn whose history ends on a
 * user message containing `marker` until `open()` is called — a deterministic
 * "turn in flight". `entered` resolves once a held turn is inside the provider.
 */
function holdTurns(marker) {
  assert.equal(typeof turn.registerTurnContextProvider, 'function', 'server/turn.js must export registerTurnContextProvider')
  let open
  const gate = new Promise((r) => (open = r))
  let entered
  const enteredP = new Promise((r) => (entered = r))
  const unregister = turn.registerTurnContextProvider(async ({ history }) => {
    const last = history?.[history.length - 1]
    if (!String(last?.content || '').includes(marker)) return []
    entered()
    await gate
    return []
  })
  return { open, entered: enteredP, unregister }
}

async function waitFor(fn, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > until) return v
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/** Event types with consecutive repeats collapsed (token×n → token). */
function shape(events) {
  const out = []
  for (const e of events) if (out.at(-1) !== e.type) out.push(e.type)
  return out
}

describe('turn routes', { skip: SKIP }, () => {
  before(async () => {
    const { app } = await import('./index.js')
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    base = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    await new Promise((r) => {
      server?.close(r)
      server?.closeAllConnections()
    })
    await gw?.close()
    const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false })
    await c.connect()
    try {
      await c.query(`DELETE FROM chat_sessions WHERE user_email = ANY($1)`, [[USER, OTHER]])
      await c.query(`DELETE FROM usage_ledger WHERE user_email = ANY($1)`, [[USER, OTHER]]).catch(() => {})
      await c.query(`DELETE FROM skills WHERE owner_email = ANY($1)`, [[USER, OTHER]]).catch(() => {})
    } finally {
      await c.end()
    }
  })

  // ------------------------------------------------------------ AC1: the lock

  test('a second /api/chat on a session with a turn in flight gets 409 turn_in_flight before any SSE', async () => {
    const sessionId = await newSession()
    const marker = `hold-chat-${RUN}`
    const hold = holdTurns(marker)
    try {
      const first = chat(USER, { prompt: `primeiro ${marker}`, sessionId })
      await hold.entered
      const second = await chat(USER, { prompt: `segundo (${RUN})`, sessionId })
      assert.equal(second.status, 409)
      assert.equal(second.sse, false, 'the 409 must come before the SSE stream opens')
      assert.deepEqual(second.body, { error: 'turn_in_flight' })
      hold.open()
      const done = await first
      assert.equal(done.status, 200)
      assert.ok(done.events.some((e) => e.type === 'done'))
    } finally {
      hold.open()
      hold.unregister()
    }
  })

  test('/continue and /regenerate also get 409 turn_in_flight while a turn runs on the session', async () => {
    const sessionId = await newSession()
    const assistantId = await lastAssistantId(sessionId)
    const marker = `hold-cr-${RUN}`
    const hold = holdTurns(marker)
    try {
      const first = chat(USER, { prompt: `primeiro ${marker}`, sessionId })
      await hold.entered
      const c = await cont(USER, sessionId)
      assert.equal(c.status, 409)
      assert.deepEqual(c.body, { error: 'turn_in_flight' })
      const r = await regen(USER, sessionId, assistantId)
      assert.equal(r.status, 409)
      assert.deepEqual(r.body, { error: 'turn_in_flight' })
      hold.open()
      assert.equal((await first).status, 200)
    } finally {
      hold.open()
      hold.unregister()
    }
  })

  test('another user gets 404, not 409, on a session that is busy (busy state never leaks)', async () => {
    const sessionId = await newSession()
    const assistantId = await lastAssistantId(sessionId)
    const marker = `hold-leak-${RUN}`
    const hold = holdTurns(marker)
    try {
      const first = chat(USER, { prompt: `primeiro ${marker}`, sessionId })
      await hold.entered
      assert.equal((await cont(OTHER, sessionId)).status, 404)
      assert.equal((await regen(OTHER, sessionId, assistantId)).status, 404)
      assert.equal((await chat(OTHER, { prompt: `intruso (${RUN})`, sessionId })).status, 403)
      hold.open()
      await first
    } finally {
      hold.open()
      hold.unregister()
    }
  })

  test('the lock is released when the turn ends, so the next turn on the session runs', async () => {
    const sessionId = await newSession()
    const again = await chat(USER, { prompt: `de novo (${RUN})`, sessionId })
    assert.equal(again.status, 200)
    const r = await regen(USER, sessionId, await lastAssistantId(sessionId))
    assert.equal(r.status, 200)
  })

  test('the lock is released after a turn whose model call failed', async () => {
    const sessionId = await newSession()
    const failed = await chat(USER, { prompt: `falha [fake:error] (${RUN})`, sessionId })
    assert.equal(failed.status, 200)
    assert.ok(failed.events.some((e) => e.type === 'error'), 'the fake gateway 503 surfaces as an error event')
    const next = await chat(USER, { prompt: `depois da falha (${RUN})`, sessionId })
    assert.equal(next.status, 200, JSON.stringify(next.body))
  })

  test('the lock is per session: a turn on another session of the same user runs', async () => {
    const s1 = await newSession()
    const s2 = await newSession()
    const marker = `hold-iso-${RUN}`
    const hold = holdTurns(marker)
    try {
      const first = chat(USER, { prompt: `primeiro ${marker}`, sessionId: s1 })
      await hold.entered
      const other = await chat(USER, { prompt: `outra sessão (${RUN})`, sessionId: s2 })
      assert.equal(other.status, 200)
      hold.open()
      await first
    } finally {
      hold.open()
      hold.unregister()
    }
  })

  // ------------------------------------------------------------ AC2: busy

  test('GET /api/sessions/:id reports busy.since while a turn runs and busy null after', async () => {
    const sessionId = await newSession()
    const idle = await getJson(`/api/sessions/${sessionId}`, USER)
    assert.equal(idle.status, 200)
    assert.equal(idle.body.session.id, sessionId)
    assert.equal(idle.body.busy, null)

    const marker = `hold-busy-${RUN}`
    const hold = holdTurns(marker)
    try {
      const startedBefore = Date.now()
      const first = chat(USER, { prompt: `primeiro ${marker}`, sessionId })
      await hold.entered
      const busy = await getJson(`/api/sessions/${sessionId}`, USER)
      assert.equal(busy.status, 200)
      const since = Date.parse(busy.body.busy?.since)
      assert.ok(Number.isFinite(since), `busy.since is an ISO timestamp, got ${JSON.stringify(busy.body.busy)}`)
      assert.ok(since >= startedBefore - 1000 && since <= Date.now(), 'busy.since is when the running turn started')
      hold.open()
      await first
    } finally {
      hold.open()
      hold.unregister()
    }
    const after = await getJson(`/api/sessions/${sessionId}`, USER)
    assert.equal(after.body.busy, null)
  })

  test('GET /api/sessions/:id is 404 for another user\'s session', async () => {
    const sessionId = await newSession()
    const r = await getJson(`/api/sessions/${sessionId}`, OTHER)
    assert.equal(r.status, 404)
    assert.equal(r.body?.session, undefined)
  })

  // ------------------------------------------------------------ AC5: registry

  test('context providers run after the skills, with req, sessionId and history', async () => {
    const trigger = `gatilho${RUN}`
    const skill = await fetch(
      `${base}/api/skills`,
      as(USER, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: `Skill ${RUN}`, description: 'skill de teste', body: `SKILL-BODY-${RUN}`, triggers: [trigger] }),
      })
    )
    assert.equal(skill.status, 200, await skill.text())

    const sessionId = await newSession()
    const marker = `provider-${RUN}`
    const seen = []
    const unregister = turn.registerTurnContextProvider(async ({ req, sessionId: sid, history }) => {
      const last = history?.[history.length - 1]
      if (!String(last?.content || '').includes(marker)) return []
      seen.push({ email: req.email, sessionId: String(sid), lastRole: last.role })
      return [{ role: 'system', content: `PROVIDER-MARK-${RUN}` }]
    })
    try {
      const r = await chat(USER, { prompt: `${trigger} ${marker}`, sessionId })
      assert.equal(r.status, 200)
      assert.deepEqual(seen, [{ email: USER, sessionId, lastRole: 'user' }])
      const [round] = roundsFor(marker)
      assert.ok(round, 'the turn reached the model')
      // llm.js collapses every system message, in order, into one at index 0
      const text = (c) => (typeof c === 'string' ? c : (c || []).map((p) => p?.text || '').join(''))
      const system = round.body.messages.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n')
      const skillAt = system.indexOf(`SKILL-BODY-${RUN}`)
      const provAt = system.indexOf(`PROVIDER-MARK-${RUN}`)
      assert.ok(skillAt >= 0, 'the skill fired')
      assert.ok(provAt > skillAt, `provider text (${provAt}) comes after the skills (${skillAt})`)
      assert.equal(system.split(`PROVIDER-MARK-${RUN}`).length, 2, 'provider text injected once')
    } finally {
      unregister()
    }
  })

  test('a context provider that throws does not break the turn', async () => {
    const sessionId = await newSession()
    const marker = `boom-${RUN}`
    const unregister = turn.registerTurnContextProvider(async ({ history }) => {
      if (String(history?.at(-1)?.content || '').includes(marker)) throw new Error('provider exploded')
      return []
    })
    try {
      const r = await chat(USER, { prompt: `Responda OK ${marker}`, sessionId })
      assert.equal(r.status, 200)
      assert.equal(r.events.some((e) => e.type === 'error'), false, JSON.stringify(r.events.filter((e) => e.type === 'error')))
      assert.equal(r.events.filter((e) => e.type === 'token').map((e) => e.value).join(''), 'OK')
    } finally {
      unregister()
    }
  })

  test('an unregistered provider no longer runs', async () => {
    const sessionId = await newSession()
    let calls = 0
    const unregister = turn.registerTurnContextProvider(async () => {
      calls++
      return []
    })
    unregister()
    await chat(USER, { prompt: `sem provider (${RUN})`, sessionId })
    assert.equal(calls, 0)
  })

  // ------------------------------------------------------------ AC6: lazy template

  test('no route loads the deck template on a turn that is not about a deck', async () => {
    assert.equal(typeof turn.turnDeps?.getSelectedDeckTemplate, 'function', 'server/turn.js must export turnDeps.getSelectedDeckTemplate')
    const real = turn.turnDeps.getSelectedDeckTemplate
    let loads = 0
    turn.turnDeps.getSelectedDeckTemplate = (...a) => {
      loads++
      return real(...a)
    }
    try {
      const sessionId = await newSession()
      assert.equal((await regen(USER, sessionId, await lastAssistantId(sessionId))).status, 200)
      await appendUserMessage(sessionId, `Responda OK (${RUN})`)
      assert.equal((await cont(USER, sessionId)).status, 200)
      assert.equal(loads, 0, 'chat, regenerate and continue all skipped the template')
    } finally {
      turn.turnDeps.getSelectedDeckTemplate = real
    }
  })

  test('/chat, /continue and /regenerate load the deck template when the turn is about a deck', async () => {
    assert.equal(typeof turn.turnDeps?.getSelectedDeckTemplate, 'function', 'server/turn.js must export turnDeps.getSelectedDeckTemplate')
    const real = turn.turnDeps.getSelectedDeckTemplate
    let loads = 0
    turn.turnDeps.getSelectedDeckTemplate = (...a) => {
      loads++
      return real(...a)
    }
    // [fake:error] fails the intent classifier, so the regex router decides:
    // a slides request → caps.deck. The model round then fails too (error event).
    const deckPrompt = `Crie uma apresentação de 5 slides sobre vendas [fake:error] (${RUN})`
    try {
      const sessionId = await newSession()
      await chat(USER, { prompt: deckPrompt, sessionId })
      assert.equal(loads, 1, '/chat')
      await regen(USER, sessionId, await lastAssistantId(sessionId))
      assert.equal(loads, 2, '/regenerate')
      await appendUserMessage(sessionId, deckPrompt)
      await cont(USER, sessionId)
      assert.equal(loads, 3, '/continue')
    } finally {
      turn.turnDeps.getSelectedDeckTemplate = real
    }
  })

  // ------------------------------------------------------------ AC7: disconnect

  test('a client that disconnects mid-turn gets no new model round and the lock is released', async () => {
    const sessionId = await newSession()
    const marker = `gone-${RUN}`
    const hold = holdTurns(marker)
    const ac = new AbortController()
    try {
      const first = chat(USER, { prompt: `primeiro ${marker}`, sessionId }, { signal: ac.signal }).catch((e) => e)
      await hold.entered
      ac.abort()
      await first
      // give the server a moment to observe the closed socket, then let the turn go on
      await new Promise((r) => setTimeout(r, 100))
      hold.open()
      const freed = await waitFor(async () => (await getJson(`/api/sessions/${sessionId}`, USER)).body?.busy === null)
      assert.ok(freed, 'busy cleared after the abandoned turn ended')
      assert.equal(roundsFor(marker).length, 0, 'no model round was issued after the client left')
      // nothing was answered, so nothing is persisted: /continue can recover the turn
      const last = (await messages(sessionId)).at(-1)
      assert.equal(last.role, 'user')
      assert.ok(last.content.includes(marker))
    } finally {
      hold.open()
      hold.unregister()
    }
  })

  // ------------------------------------------------------------ AC4: parity

  test('3-route parity: /chat, /continue and /regenerate stream the same event sequence', async () => {
    const prompt = `Crie um documento curto com título "Paridade" e um parágrafo de uma frase. (${RUN})`
    const sessionId = await newSession()

    const viaChat = await chat(USER, { prompt, sessionId })
    const viaRegen = await regen(USER, sessionId, await lastAssistantId(sessionId))
    await appendUserMessage(sessionId, prompt)
    const viaCont = await cont(USER, sessionId)
    for (const [name, r] of [['chat', viaChat], ['regenerate', viaRegen], ['continue', viaCont]]) {
      assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`)
    }

    // each route's full sequence, pinned (hand-derived from turn.js; the only
    // per-route events are the envelope: /chat's `meta`, the other two's `variant`)
    assert.deepEqual(shape(viaChat.events), ['meta', 'skill_active', 'reasoning', 'token', 'blocks', 'usage', 'done'])
    assert.deepEqual(shape(viaRegen.events), ['skill_active', 'reasoning', 'token', 'blocks', 'usage', 'variant', 'done'])
    assert.deepEqual(shape(viaCont.events), ['skill_active', 'reasoning', 'token', 'blocks', 'usage', 'variant', 'done'])

    // and the shared core is identical once the envelope is set aside
    const ENVELOPE = new Set(['meta', 'title', 'variant'])
    const core = (r) => shape(r.events.filter((e) => !ENVELOPE.has(e.type)))
    assert.deepEqual(core(viaRegen), core(viaChat))
    assert.deepEqual(core(viaCont), core(viaChat))

    // same artifact on all three routes (a persisted document block)
    for (const r of [viaChat, viaRegen, viaCont]) {
      const doc = r.events.filter((e) => e.type === 'blocks').flatMap((e) => e.blocks).find((b) => b.type === 'document')
      assert.ok(doc?.documentId, 'document block persisted')
      assert.equal(doc.title, 'Paridade')
    }
  })

  test('3-route parity: a new chat adds only the title event to the envelope', async () => {
    const r = await chat(USER, { prompt: `Responda apenas OK. (${RUN})` })
    assert.equal(r.status, 200)
    assert.deepEqual(shape(r.events), ['meta', 'reasoning', 'token', 'usage', 'title', 'done'])
  })
})
