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
// load, the stop-on-disconnect rule, the 3-route SSE parity (a plain answer, a
// tool round and a deck) and, for W2-2, abort threading (a disconnect cancels
// the in-flight gateway request, the tool call and the deck slide queue, frees
// the lock at once and persists nothing) and the chat.turn root span. Without
// the database these are SKIPPED with the reason; CI runs --fail-on-skip.
//
//   node --test server/turn.test.js
import test, { before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import { trace, context, ROOT_CONTEXT } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { startFakeGateway } from '../scripts/fake-gateway.mjs'

// Spans in memory. In production AppKit's NodeTracerProvider.register() installs
// an async-hooks context manager, which is what nests llm.call/tool.call under
// chat.turn across awaits; this minimal one does the same job here.
class AlsContextManager {
  #als = new AsyncLocalStorage()
  active() {
    return this.#als.getStore() ?? ROOT_CONTEXT
  }
  with(ctx, fn, thisArg, ...args) {
    return this.#als.run(ctx, () => fn.call(thisArg, ...args))
  }
  bind(_ctx, target) {
    return target
  }
  enable() {
    return this
  }
  disable() {
    return this
  }
}
context.setGlobalContextManager(new AlsContextManager())
const exporter = new InMemorySpanExporter()
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }))

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
const { logger } = await import('./log.ts')
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
    as(email, { method: 'POST', body: JSON.stringify({ model: MODEL, enabledTools: [], ...body }), ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } })
  ).then(readTurn)
}

const cont = (email, sessionId, init, body = {}) => postTurn(email, `/api/sessions/${sessionId}/continue`, body, init)
const regen = (email, sessionId, messageId, init, body = {}) => postTurn(email, `/api/sessions/${sessionId}/messages/${messageId}/regenerate`, body, init)

// a per-space Genie tool: offline its backend is the fake gateway (404, or held)
const GENIE_REF = { kind: 'genie', spaceId: 'fake-space', title: 'Fake space' }
const ABORT_BUDGET_MS = 1000

/** Resolves with `p`, or rejects when it takes longer than `ms`. */
function within(p, ms, what) {
  let t
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, reject) => (t = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms))),
  ])
}

/** The per-slide materialization calls of the deck expansion (server/deckHtmlGenerate.js). */
const isSlideCall = (r) => r.path === '/serving-endpoints/chat/completions' && r.body && !r.body.stream && /<section> do slide \d+:\s*$/.test(lastUser(r.body))

async function query(sql, params) {
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false })
  await c.connect()
  try {
    return (await c.query(sql, params)).rows
  } finally {
    await c.end()
  }
}

/** Messages after the user message containing `marker` (what the cancelled turn may have written). */
async function afterMarker(sessionId, marker) {
  const all = await messages(sessionId)
  const i = all.findIndex((m) => m.role === 'user' && String(m.content).includes(marker))
  assert.ok(i >= 0, 'the user message of the cancelled turn is kept (/continue can answer it)')
  return all.slice(i + 1)
}

const finished = (name) => exporter.getFinishedSpans().filter((s) => s.name === name)
const turnSpan = (rid) => finished('chat.turn').find((s) => s.attributes.request_id === rid)
const parentId = (s) => s.parentSpanContext?.spanId ?? s.parentSpanId

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

  /** Runs `prompt` on /chat, then /regenerate and /continue over the same session. */
  async function threeRoutes(prompt, body = {}) {
    const sessionId = await newSession()
    const viaChat = await chat(USER, { prompt, sessionId, ...body })
    const viaRegen = await regen(USER, sessionId, await lastAssistantId(sessionId), undefined, body)
    await appendUserMessage(sessionId, prompt)
    const viaCont = await cont(USER, sessionId, undefined, body)
    for (const [name, r] of [['chat', viaChat], ['regenerate', viaRegen], ['continue', viaCont]]) {
      assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`)
    }
    const ENVELOPE = new Set(['meta', 'title', 'variant'])
    const core = (r) => shape(r.events.filter((e) => !ENVELOPE.has(e.type)))
    assert.deepEqual(core(viaRegen), core(viaChat))
    assert.deepEqual(core(viaCont), core(viaChat))
    return { viaChat, viaRegen, viaCont, core: core(viaChat) }
  }

  test('3-route parity: a tool round streams the same event sequence on all three routes', async () => {
    const { viaChat, viaRegen, viaCont, core } = await threeRoutes(`[fake:tool] consulte (${RUN})`, { enabledTools: [GENIE_REF] })
    assert.deepEqual(core, ['reasoning', 'tool_call', 'tool_result', 'reasoning', 'token', 'usage', 'done'])
    for (const r of [viaChat, viaRegen, viaCont]) {
      const call = r.events.find((e) => e.type === 'tool_call')
      assert.match(call.label, /^Genie\b/, 'the Genie tool was called')
      assert.ok(r.events.some((e) => e.type === 'tool_result' && e.id === call.id))
    }
  })

  test('3-route parity: a deck outline is expanded slide by slide and persisted on all three routes', async () => {
    const { viaChat, viaRegen, viaCont, core } = await threeRoutes(`Crie uma apresentação curta sobre vendas [fake:deck] (${RUN})`)
    assert.ok(core.includes('deck_stream_start') && core.includes('deck_slide') && core.includes('blocks'), core.join(','))
    for (const r of [viaChat, viaRegen, viaCont]) {
      assert.equal(r.events.filter((e) => e.type === 'deck_slide').length, 3)
      const d = r.events.filter((e) => e.type === 'blocks').flatMap((e) => e.blocks).find((b) => b.type === 'deck-html')
      assert.ok(d?.deckId, 'deck persisted')
      assert.equal(d.slides.length, 3)
    }
  })

  // ------------------------------------------------------------ W2-12: artifact tools

  const fakeArgs = (obj) => `[fake:args:${Buffer.from(JSON.stringify(obj)).toString('base64url')}]`
  const blocksOf = (r, type) => r.events.filter((e) => e.type === 'blocks').flatMap((e) => e.blocks).filter((b) => b.type === type)
  const countRows = async (table, sessionId) => (await query(`SELECT count(*)::int AS n FROM ${table} WHERE session_id = $1`, [sessionId]))[0].n
  const artifactLedger = async (sessionId) => (await query(`SELECT count(*)::int AS n FROM usage_ledger WHERE session_id = $1 AND kind = 'artifact'`, [sessionId]))[0].n

  test('W2-12 parity: a create_deck tool call creates one deck row, streams the slides and emits the block on all three routes', async () => {
    const { viaChat, viaRegen, viaCont, core } = await threeRoutes(`Crie uma apresentação curta sobre vendas [fake:tool:create_deck] (${RUN})`)
    // pinned: the tool round, the live build inside the tool call, the answer, the block
    assert.deepEqual(core, ['skill_active', 'reasoning', 'tool_call', 'deck_stream_start', 'deck_slide', 'tool_result', 'reasoning', 'token', 'blocks', 'usage', 'done'])
    const sessionId = String(viaChat.events.find((e) => e.type === 'meta').sessionId)
    for (const [name, r] of [['chat', viaChat], ['regenerate', viaRegen], ['continue', viaCont]]) {
      const call = r.events.find((e) => e.type === 'tool_call')
      assert.equal(call.name, 'create_deck', name)
      assert.equal(r.events.find((e) => e.type === 'tool_result').status, 'ok', name)
      assert.equal(r.events.filter((e) => e.type === 'deck_slide').length, 3, `${name}: 3 slides streamed`)
      const decks = blocksOf(r, 'deck-html')
      assert.equal(decks.length, 1, `${name}: exactly one deck block (no duplicate per turn)`)
      assert.ok(decks[0].deckId, `${name}: the deck row id is stamped by the commit`)
      assert.equal(decks[0].slides.length, 3)
      assert.equal(decks[0].title, 'Fake tool deck')
    }
    // one deck row per answered turn, none extra
    assert.equal(await countRows('chat_decks', sessionId), 3)
    const ids = [viaChat, viaRegen, viaCont].map((r) => blocksOf(r, 'deck-html')[0].deckId)
    assert.equal(new Set(ids).size, 3, 'each turn (variant) owns its own deck row')
    // the slide materialization of the tool lands in the ledger as kind artifact (3 slides × 3 turns)
    assert.equal(await waitFor(async () => ((await artifactLedger(sessionId)) === 9 ? 9 : 0)), 9)
  })

  test('W2-12: create_document and create_spreadsheet through tools persist one row each with their block', async () => {
    const sessionId = await newSession()
    const d = await chat(USER, { prompt: `Escreva um documento [fake:tool:create_document] (${RUN})`, sessionId })
    assert.equal(d.events.find((e) => e.type === 'tool_result')?.status, 'ok')
    assert.equal(blocksOf(d, 'document').length, 1)
    assert.ok(blocksOf(d, 'document')[0].documentId)
    assert.equal(await countRows('chat_documents', sessionId), 1)
    const s = await chat(USER, { prompt: `Monte uma planilha excel [fake:tool:create_spreadsheet] (${RUN})`, sessionId })
    assert.equal(s.events.find((e) => e.type === 'tool_result')?.status, 'ok', JSON.stringify(s.events.filter((e) => e.type !== 'token')))
    assert.equal(blocksOf(s, 'spreadsheet').length, 1)
    assert.ok(blocksOf(s, 'spreadsheet')[0].spreadsheetId)
    assert.equal(await countRows('chat_spreadsheets', sessionId), 1)
  })

  test('W2-12 AC-T1/AC-T3: a disconnect during a tool deck generation aborts the slide call within 1 s and persists no artifact row', async () => {
    const sessionId = await newSession()
    const marker = `abort-tooldeck-${RUN}`
    const rid = `w212-deck-${RUN}`
    const args = { title: `Deck ${marker}`, slides: [{ kind: 'cover', headline: 'A' }, { kind: 'content', headline: 'B' }, { kind: 'closing', headline: 'C' }] }
    const hold = gw.hold((r) => isSlideCall(r) && JSON.stringify(r.body).includes(marker))
    const ac = new AbortController()
    const ledgerBefore = await artifactLedger(sessionId)
    try {
      const first = chat(USER, { prompt: `Crie uma apresentação [fake:tool:create_deck] ${fakeArgs(args)} ${marker}`, sessionId }, { signal: ac.signal, headers: { 'x-request-id': rid } }).catch((e) => e)
      await within(hold.entered, 10_000, 'the tool deck generation reaches its first slide call') // in flight
      const t0 = Date.now()
      ac.abort()
      await first
      const seen = await within(hold.aborted, ABORT_BUDGET_MS, 'the tool slide call is aborted')
      assert.ok(seen.at - t0 <= ABORT_BUDGET_MS)
      const span = await waitFor(() => turnSpan(rid))
      assert.equal(span?.attributes.status, 'cancelled')
      hold.release()
      // positive control: the prompt row is there (afterMarker asserts it), nothing after it
      assert.deepEqual(await afterMarker(sessionId, marker), [], 'no assistant row from the cancelled turn')
      assert.equal(await countRows('chat_decks', sessionId), 0, 'no deck row from the tool call')
      assert.equal(await artifactLedger(sessionId), ledgerBefore, 'no artifact ledger row from a cancelled turn')
    } finally {
      hold.release()
    }
  })

  test('W2-12 AC-T1: a cancel after a tool staged a document (answer round in flight) persists no document row', async () => {
    const sessionId = await newSession()
    const marker = `abort-tooldoc-${RUN}`
    // the second streaming round (after the tool result) is held: the document is staged in memory only
    const hold = gw.hold((r) => r.body?.stream && lastUser(r.body).includes(marker) && (r.body.messages || []).some((m) => m.role === 'tool'))
    const ac = new AbortController()
    try {
      const first = chat(USER, { prompt: `Escreva um documento [fake:tool:create_document] ${marker}`, sessionId }, { signal: ac.signal }).catch((e) => e)
      await within(hold.entered, 10_000, 'the answer round after the tool result starts')
      ac.abort()
      await first
      await within(hold.aborted, ABORT_BUDGET_MS, 'the answer round is aborted')
      hold.release()
      await waitFor(async () => (await getJson(`/api/sessions/${sessionId}`, USER)).body?.busy === null)
      assert.deepEqual(await afterMarker(sessionId, marker), [])
      assert.equal(await countRows('chat_documents', sessionId), 0, 'the staged document was never written')
    } finally {
      hold.release()
    }
  })

  test('W2-12 AC-T2: update_document on another user\'s document is a not-found tool error; the turn still answers', async () => {
    const other = await chat(OTHER, { prompt: `Crie um documento com título "Alheio" (${RUN})` })
    const otherDoc = blocksOf(other, 'document')[0]
    assert.ok(otherDoc?.documentId, 'the other user owns a document')
    const sessionId = await newSession()
    // the caller has a document of their own in this chat, so update_document is offered
    const own = await chat(USER, { prompt: `Escreva um documento [fake:tool:create_document] (${RUN})`, sessionId })
    assert.ok(blocksOf(own, 'document')[0]?.documentId)
    const r = await chat(USER, { prompt: `Atualize o documento [fake:tool:update_document] ${fakeArgs({ document_id: otherDoc.documentId, markdown: '# hijack' })} (${RUN})`, sessionId })
    assert.equal(r.status, 200)
    const result = r.events.find((e) => e.type === 'tool_result')
    assert.equal(result.status, 'error')
    assert.match(result.result, /not found/i)
    assert.ok(!result.result.includes('Alheio'), 'nothing of the other document leaks')
    assert.ok(r.events.some((e) => e.type === 'done'))
    assert.ok(!r.events.some((e) => e.type === 'error'), 'a tool error does not fail the turn')
    const msgs = await messages(sessionId)
    assert.equal(msgs.at(-1).role, 'assistant', 'the answer was saved')
    assert.equal(await countRows('chat_documents', sessionId), 1, 'only the caller\'s own document, nothing from the refused update')
    const [row] = await query(`SELECT markdown FROM chat_documents WHERE id = $1`, [otherDoc.documentId])
    assert.ok(!row.markdown.includes('hijack'), 'the other user\'s document is unchanged')
  })

  test('W2-12: update_document on the caller\'s own document stages a new version; the source row is unchanged', async () => {
    const sessionId = await newSession()
    const created = await chat(USER, { prompt: `Escreva um documento [fake:tool:create_document] (${RUN})`, sessionId })
    const src = blocksOf(created, 'document')[0]
    const r = await chat(USER, { prompt: `Atualize o documento [fake:tool:update_document] ${fakeArgs({ document_id: src.documentId, markdown: '# Revised\n\nNew text.' })} (${RUN})`, sessionId })
    assert.equal(r.events.find((e) => e.type === 'tool_result').status, 'ok')
    // the model was told the id: the update tool lists the chat's documents
    const offered = gw.requests.filter((q) => q.body?.stream && lastUser(q.body).includes('update_document')).at(-1)
    const def = offered.body.tools.find((t) => t.function.name === 'update_document')
    assert.match(def.function.description, new RegExp(`document id ${src.documentId}:`))
    const updated = blocksOf(r, 'document')
    assert.equal(updated.length, 1)
    assert.notEqual(updated[0].documentId, src.documentId)
    assert.match(updated[0].markdown, /New text/)
    assert.equal(await countRows('chat_documents', sessionId), 2)
    const [row] = await query(`SELECT markdown FROM chat_documents WHERE id = $1`, [src.documentId])
    assert.ok(!row.markdown.includes('New text'), 'history is immutable: the earlier answer keeps its document')
  })

  // ------------------------------------------------------------ W2-2: abort threading

  test('AC-A1/A3: a disconnect aborts the in-flight gateway request within 1 s; the lock is free at once and nothing is persisted', async () => {
    const sessionId = await newSession()
    const marker = `abort-gw-${RUN}`
    const rid = `w22-gw-${RUN}`
    const hold = gw.hold((r) => r.body?.stream && lastUser(r.body).includes(marker))
    const ac = new AbortController()
    try {
      const first = chat(USER, { prompt: `primeiro ${marker}`, sessionId }, { signal: ac.signal, headers: { 'x-request-id': rid } }).catch((e) => e)
      await hold.entered
      const t0 = Date.now()
      ac.abort()
      await first
      const seen = await within(hold.aborted, ABORT_BUDGET_MS, 'the fake gateway observes the abort')
      assert.ok(seen.at - t0 <= ABORT_BUDGET_MS, `abort seen after ${seen.at - t0} ms`)
      // Stop-then-send: the next message on the session runs, no 409
      const next = await chat(USER, { prompt: `de novo (${RUN})`, sessionId })
      assert.equal(next.status, 200, JSON.stringify(next.body))
      const after = await afterMarker(sessionId, marker)
      assert.equal(after[0]?.role, 'user', 'no assistant row from the cancelled turn')
      const span = await waitFor(() => turnSpan(rid))
      assert.ok(span, 'chat.turn recorded for the cancelled turn')
      assert.equal(span.attributes.status, 'cancelled')
      assert.equal(span.attributes.saved, false, 'a dropped turn records saved=false')
    } finally {
      hold.release()
    }
  })

  test('AC: a disconnect during a tool call ends the turn at once: no further model round, lock free, nothing persisted', async () => {
    const sessionId = await newSession()
    const marker = `abort-tool-${RUN}`
    const hold = gw.hold((r) => r.path.startsWith('/api/2.0/genie/'))
    const ac = new AbortController()
    const usageBefore = (await query(`SELECT count(*)::int AS n FROM usage_ledger WHERE session_id = $1`, [sessionId]))[0].n
    try {
      const first = chat(USER, { prompt: `[fake:tool] ${marker}`, sessionId, enabledTools: [GENIE_REF] }, { signal: ac.signal }).catch((e) => e)
      await hold.entered
      // The completed model round before the held tool must be buffered too:
      // usage rows for an existing session are in-scope persisted turn data.
      // (QA r1 probe, precondition adapted: the held Genie call exists only
      // because round 1 completed and reported its usage. Buffered, that row is
      // never written, so it is not visible mid-turn either.)
      assert.equal(roundsFor(marker).length, 1, 'the first model round completed before the cancel')
      const usageDuring = (await query(`SELECT count(*)::int AS n FROM usage_ledger WHERE session_id = $1`, [sessionId]))[0].n
      assert.equal(usageDuring, usageBefore, 'the turn\'s usage is buffered, not written mid-turn')
      ac.abort()
      await first
      const freed = await waitFor(async () => (await getJson(`/api/sessions/${sessionId}`, USER)).body?.busy === null, { timeoutMs: ABORT_BUDGET_MS })
      assert.ok(freed, 'lock released while the tool backend still hangs')
      const usageAfter = (await query(`SELECT count(*)::int AS n FROM usage_ledger WHERE session_id = $1`, [sessionId]))[0].n
      assert.equal(usageAfter, usageBefore, 'no usage from the cancelled turn is persisted')
      const next = await chat(USER, { prompt: `depois (${RUN})`, sessionId })
      assert.equal(next.status, 200, JSON.stringify(next.body))
      assert.equal(roundsFor(marker).length, 1, 'no model round after the cancelled tool call')
      const after = await afterMarker(sessionId, marker)
      assert.equal(after[0]?.role, 'user', 'no assistant row from the cancelled turn')
      const calls = await query(`SELECT count(*)::int AS n FROM chat_tool_calls t JOIN chat_messages m ON m.id = t.message_id WHERE m.session_id = $1`, [sessionId])
      assert.equal(calls[0].n, 0, 'no tool trace persisted')
    } finally {
      hold.release()
    }
  })

  test('AC-A2: a disconnect during slide generation stops the slide workers and persists nothing', async () => {
    const sessionId = await newSession()
    const marker = `abort-deck-${RUN}`
    const rid = `w22-deck-${RUN}`
    const hold = gw.hold(isSlideCall)
    const ac = new AbortController()
    try {
      const slideCallsBefore = gw.requests.filter(isSlideCall).length
      const first = chat(USER, { prompt: `Crie uma apresentação sobre vendas [fake:deck] ${marker}`, sessionId }, { signal: ac.signal, headers: { 'x-request-id': rid } }).catch((e) => e)
      await hold.entered // slide 0 (the style anchor) is in flight
      const t0 = Date.now()
      ac.abort()
      await first
      const seen = await within(hold.aborted, ABORT_BUDGET_MS, 'the in-flight slide call is aborted')
      assert.ok(seen.at - t0 <= ABORT_BUDGET_MS)
      // the handler has unwound once its chat.turn span ended: from then on no
      // slide call can start (condition, not a fixed wait)
      const span = await waitFor(() => turnSpan(rid))
      assert.equal(span?.attributes.status, 'cancelled', 'the cancelled handler unwound')
      hold.release()
      assert.equal(gw.requests.filter(isSlideCall).length - slideCallsBefore, 1, 'no slide call after the disconnect')
      const freed = await waitFor(async () => (await getJson(`/api/sessions/${sessionId}`, USER)).body?.busy === null, { timeoutMs: ABORT_BUDGET_MS })
      assert.ok(freed)
      assert.deepEqual(await afterMarker(sessionId, marker), [], 'no assistant row from the cancelled turn')
      const decks = await query(`SELECT count(*)::int AS n FROM chat_decks WHERE session_id = $1`, [sessionId])
      assert.equal(decks[0].n, 0, 'no deck row persisted')
    } finally {
      hold.release()
    }
  })

  test('a client that leaves after the answer was committed (during the post-answer tail) aborts the title and embedding requests and writes neither', async () => {
    const marker = `abort-tail-${RUN}`
    const rid = `w22-tail-${RUN}`
    const isTitle = (r) => r.body && !r.body.stream && String(r.body.messages?.[0]?.content || '').includes('You title chat conversations') && lastUser(r.body).includes(marker)
    // the tail's embeds (session doc, message index), not the skill router's `Instruct:` query
    const isEmbed = (r) =>
      r.path === '/serving-endpoints/embeddings' &&
      (r.body?.input || []).some((x) => String(x).includes(marker)) &&
      !(r.body?.input || []).some((x) => String(x).startsWith('Instruct:'))
    const titleHold = gw.hold(isTitle)
    const embedHold = gw.hold(isEmbed)
    const ac = new AbortController()
    try {
      const first = chat(USER, { prompt: `Responda OK ${marker}` }, { signal: ac.signal, headers: { 'x-request-id': rid } }).catch((e) => e)
      await Promise.all([titleHold.entered, embedHold.entered])
      const t0 = Date.now()
      ac.abort()
      await first
      const [ta, ea] = await within(Promise.all([titleHold.aborted, embedHold.aborted]), ABORT_BUDGET_MS, 'tail requests aborted')
      assert.ok(ta.at - t0 <= ABORT_BUDGET_MS && ea.at - t0 <= ABORT_BUDGET_MS)
      titleHold.release()
      embedHold.release()
      const span = await waitFor(() => turnSpan(rid))
      assert.equal(span?.attributes.status, 'cancelled')
      assert.equal(span.attributes.saved, true, 'the answer was committed before the tail')
      const [row] = await query(
        `SELECT s.title, (SELECT count(*)::int FROM chat_message_embeddings e WHERE e.session_id = s.id) AS embedded, s.embedding IS NOT NULL AS session_embedded
           FROM chat_sessions s JOIN chat_messages m ON m.session_id = s.id
          WHERE s.user_email = $1 AND m.role = 'user' AND m.content LIKE $2`,
        [USER, `%${marker}%`]
      )
      assert.equal(row.title, '💬 Nova conversa', 'no title written after the cancel')
      assert.equal(row.embedded, 0, 'no message embedding written after the cancel')
      assert.equal(row.session_embedded, false, 'no session embedding written after the cancel')
    } finally {
      titleHold.release()
      embedHold.release()
    }
  })

  test('usage of a completed turn is recorded; a turn that fails (no cancel) still records what it spent', async () => {
    const ledger = async (sid) => (await query(`SELECT count(*)::int AS n FROM usage_ledger WHERE session_id = $1`, [sid]))[0].n
    const sessionId = await newSession()
    const before = await ledger(sessionId)
    const ok = await chat(USER, { prompt: `Responda OK (${RUN})`, sessionId })
    assert.equal(ok.status, 200)
    assert.ok((await waitFor(async () => (await ledger(sessionId)) > before)), 'the completed turn wrote its usage')

    // the deck intent classifier spends, then loading the template fails the turn
    const real = turn.turnDeps.getSelectedDeckTemplate
    turn.turnDeps.getSelectedDeckTemplate = async () => {
      throw new Error('template store down')
    }
    try {
      const mid = await ledger(sessionId)
      const failed = await chat(USER, { prompt: `Crie uma apresentação sobre vendas (${RUN})`, sessionId })
      assert.equal(failed.status, 200)
      assert.ok(failed.events.some((e) => e.type === 'error'))
      assert.ok((await waitFor(async () => (await ledger(sessionId)) > mid)), 'the failed turn still wrote the classifier usage')
    } finally {
      turn.turnDeps.getSelectedDeckTemplate = real
    }
  })

  test('a cancelled turn does not leak its abort into the next turn on the same session', async () => {
    const sessionId = await newSession()
    const marker = `leak-${RUN}`
    const hold = gw.hold((r) => r.body?.stream && lastUser(r.body).includes(marker))
    const ac = new AbortController()
    try {
      const first = chat(USER, { prompt: marker, sessionId }, { signal: ac.signal }).catch((e) => e)
      await hold.entered
      ac.abort()
      await first
      await within(hold.aborted, ABORT_BUDGET_MS, 'abort observed')
    } finally {
      hold.release()
    }
    const next = await chat(USER, { prompt: `[fake:tool] seguinte (${RUN})`, sessionId, enabledTools: [GENIE_REF] })
    assert.equal(next.status, 200)
    assert.deepEqual(shape(next.events), ['meta', 'reasoning', 'tool_call', 'tool_result', 'reasoning', 'token', 'usage', 'done'])
    assert.equal((await messages(sessionId)).at(-1).role, 'assistant')
  })

  // ------------------------------------------------------------ W2-2: chat.turn + request_id

  test('meta carries the request id and chat.turn is the parent of llm.call and tool.call', async () => {
    const sessionId = await newSession()
    const rid = `w22-span-${RUN}`
    const r = await chat(USER, { prompt: `[fake:tool] span (${RUN})`, sessionId, enabledTools: [GENIE_REF] }, { headers: { 'x-request-id': rid } })
    assert.equal(r.status, 200)
    assert.equal(r.events.find((e) => e.type === 'meta').request_id, rid)
    const span = await waitFor(() => turnSpan(rid))
    assert.ok(span, 'chat.turn recorded')
    assert.deepEqual(
      Object.keys(span.attributes).filter((k) => ['session.id', 'route', 'model', 'caps', 'status', 'request_id'].includes(k)).sort(),
      ['caps', 'model', 'request_id', 'route', 'session.id', 'status']
    )
    assert.equal(span.attributes['session.id'], sessionId)
    assert.equal(span.attributes.route, '/api/chat')
    assert.equal(span.attributes.model, MODEL)
    assert.equal(span.attributes.status, 'ok')
    const id = span.spanContext().spanId
    const llmKids = finished('llm.call').filter((s) => parentId(s) === id)
    const toolKids = finished('tool.call').filter((s) => parentId(s) === id)
    assert.ok(llmKids.length >= 2, `two model rounds under chat.turn (got ${llmKids.length})`)
    assert.equal(toolKids.length, 1, 'the tool call under chat.turn')
    assert.equal(toolKids[0].attributes['tool.kind'], 'genie')
  })

  test('chat.turn status is error when the model call fails, and saved is set only on persisted cancels', async () => {
    const sessionId = await newSession()
    const rid = `w22-err-${RUN}`
    const r = await chat(USER, { prompt: `falha [fake:error] (${RUN})`, sessionId }, { headers: { 'x-request-id': rid } })
    assert.equal(r.status, 200)
    const span = await waitFor(() => turnSpan(rid))
    assert.equal(span?.attributes.status, 'error')
    assert.equal(span.attributes.saved, undefined)
  })

  test('chat.turn is recorded on /continue and /regenerate with their route', async () => {
    const sessionId = await newSession()
    const ridR = `w22-regen-${RUN}`
    const rr = await regen(USER, sessionId, await lastAssistantId(sessionId), { headers: { 'x-request-id': ridR } })
    assert.equal(rr.status, 200)
    await appendUserMessage(sessionId, `continue (${RUN})`)
    const ridC = `w22-cont-${RUN}`
    const rc = await cont(USER, sessionId, { headers: { 'x-request-id': ridC } })
    assert.equal(rc.status, 200)
    const sr = await waitFor(() => turnSpan(ridR))
    const sc = await waitFor(() => turnSpan(ridC))
    assert.equal(sr?.attributes.route, '/api/sessions/:id/messages/:messageId/regenerate')
    assert.equal(sc?.attributes.route, '/api/sessions/:id/continue')
    assert.equal(sr.attributes.status, 'ok')
    assert.equal(sc.attributes['session.id'], sessionId)
  })

  test('a cancel while finishTurn is writing leaves no turn data', async () => {
    const sessionId = await newSession()
    const marker = `commit-abort-${RUN}`
    const requestId = `w22-commit-abort-${RUN}`
    const usageBefore = (await query(`SELECT count(*)::int AS n FROM usage_ledger WHERE session_id = $1`, [sessionId]))[0].n
    const hold = gw.hold((r) => r.body?.stream && lastUser(r.body).includes(marker))
    const blocker = new pg.Client({
      host: env.PGHOST,
      port: Number(env.PGPORT),
      user: env.PGUSER,
      password: env.PGPASSWORD,
      database: env.PGDATABASE,
      ssl: false,
    })
    const ac = new AbortController()
    const infos = []
    const realInfo = logger.info
    logger.info = (msg, fields) => {
      infos.push({ msg, fields })
      return realInfo(msg, fields)
    }
    try {
      const first = chat(USER, { prompt: `Responda OK ${marker}`, sessionId }, {
        signal: ac.signal,
        headers: { 'x-request-id': requestId },
      }).catch((e) => e)
      await hold.entered
      await blocker.connect()
      await blocker.query('SET search_path TO ai_prism, public')
      await blocker.query('BEGIN')
      await blocker.query(`SELECT id FROM chat_sessions WHERE id = $1 FOR UPDATE`, [sessionId])
      hold.release()
      const blockedCommit = await waitFor(
        async () =>
          (await query(
            `SELECT pid FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query LIKE 'UPDATE chat_sessions SET chart_candidates%'`
          ))[0],
        { timeoutMs: 5000 }
      )
      assert.ok(blockedCommit, 'finishTurn reached its first persistence write')
      ac.abort()
      await first
    } finally {
      hold.release()
      if (!ac.signal.aborted) ac.abort()
      await blocker.query('ROLLBACK').catch(() => {})
      await blocker.end().catch(() => {})
      // the rolled-back commit ends the turn (and logs) once the lock is gone
      await waitFor(() => turnSpan(requestId))
      logger.info = realInfo
    }

    const span = await waitFor(() => turnSpan(requestId))
    assert.equal(span?.attributes.status, 'cancelled')
    assert.equal(span.attributes.saved, false, 'a cancel before COMMIT rolls the answer back: saved=false')
    const rolledBack = infos.filter((l) => /rolled back/.test(l.msg))
    assert.equal(rolledBack.length, 1, 'one info line for the rollback')
    assert.equal(rolledBack[0].fields?.request_id, requestId)
    assert.deepEqual(Object.keys(rolledBack[0].fields), ['request_id'], 'no content in the log line')
    assert.ok(!rolledBack[0].msg.includes('Responda'), 'no prompt text in the message')
    const [counts] = await query(
      `SELECT (SELECT count(*)::int FROM chat_messages
                WHERE session_id = $1 AND role = 'user' AND content LIKE $2) AS prompts,
              (SELECT count(*)::int FROM chat_messages u
                JOIN chat_messages a ON a.session_id = u.session_id AND a.id > u.id
               WHERE u.session_id = $1 AND u.role = 'user' AND u.content LIKE $2
                 AND a.role = 'assistant') AS answers,
              (SELECT count(*)::int FROM usage_ledger WHERE session_id = $1) AS usage_rows
        `,
      [sessionId, `%${marker}%`]
    )
    assert.deepEqual(
      { prompts: counts.prompts, answers: counts.answers, usageRows: counts.usage_rows - usageBefore },
      { prompts: 1, answers: 0, usageRows: 0 },
      'the prompt is kept (positive control, same read); nothing of the cancelled answer is persisted'
    )
  })

  test('a cancel after the answer COMMIT was sent keeps the turn: saved=true, usage recorded', async () => {
    const sessionId = await newSession()
    const marker = `commit-then-cancel-${RUN}`
    const requestId = `w214-after-commit-${RUN}`
    const ledger = async () => (await query(`SELECT count(*)::int AS n FROM usage_ledger WHERE session_id = $1`, [sessionId]))[0].n
    const usageBefore = await ledger()
    const real = turn.turnDeps.commitTurnAnswer
    const ac = new AbortController()
    // the real commit runs to COMMIT; the client leaves right after it resolved and
    // before finishTurn sees the result (the server observes the close first)
    turn.turnDeps.commitTurnAnswer = async (email, token, answer, opts) => {
      const row = await real(email, token, answer)
      ac.abort()
      await new Promise((r) => (opts.signal.aborted ? r() : opts.signal.addEventListener('abort', r, { once: true })))
      return row
    }
    try {
      await chat(USER, { prompt: `Responda OK ${marker}`, sessionId }, { signal: ac.signal, headers: { 'x-request-id': requestId } }).catch((e) => e)
      const span = await waitFor(() => turnSpan(requestId))
      assert.equal(span?.attributes.status, 'cancelled')
      assert.equal(span.attributes.saved, true, 'a cancel after COMMIT is not a false rollback')
    } finally {
      turn.turnDeps.commitTurnAnswer = real
    }
    // afterMarker asserts the prompt row first (positive control, same read)
    const after = await afterMarker(sessionId, marker)
    assert.equal(after[0]?.role, 'assistant', 'the committed answer is kept')
    assert.ok(await waitFor(async () => (await ledger()) > usageBefore), 'the saved turn wrote its usage')
  })

  test('a failed finishTurn persistence leaves no deck without its answer', async () => {
    const sessionId = await newSession()
    const marker = `partial-commit-${RUN}`
    const decksBefore = (await query(`SELECT count(*)::int AS n FROM chat_decks WHERE session_id = $1`, [sessionId]))[0].n
    const admin = new pg.Client({
      host: env.PGHOST,
      port: Number(env.PGPORT),
      user: env.PGUSER,
      password: env.PGPASSWORD,
      database: env.PGDATABASE,
      ssl: false,
    })
    await admin.connect()
    try {
      await admin.query(`DROP TRIGGER IF EXISTS qa_reject_assistant ON ai_prism.chat_messages`)
      await admin.query(`DROP FUNCTION IF EXISTS ai_prism.qa_reject_assistant()`)
      await admin.query(`
        CREATE FUNCTION ai_prism.qa_reject_assistant() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.role = 'assistant' THEN
            RAISE EXCEPTION 'QA persistence failure';
          END IF;
          RETURN NEW;
        END $$`)
      await admin.query(`
        CREATE TRIGGER qa_reject_assistant BEFORE INSERT ON ai_prism.chat_messages
        FOR EACH ROW EXECUTE FUNCTION ai_prism.qa_reject_assistant()`)
      const r = await chat(USER, {
        prompt: `Crie uma apresentação curta sobre vendas [fake:deck] ${marker}`,
        sessionId,
      })
      assert.equal(r.status, 200)
      assert.ok(r.events.some((e) => e.type === 'error'), 'the assistant write failed')
      const decksAfter = (await query(`SELECT count(*)::int AS n FROM chat_decks WHERE session_id = $1`, [sessionId]))[0].n
      // positive control through the same read: the prompt row is visible to it
      const prompts = (await query(
        `SELECT count(*)::int AS n FROM chat_messages WHERE session_id = $1 AND role = 'user' AND content LIKE $2`,
        [sessionId, `%${marker}%`]
      ))[0].n
      assert.equal(prompts, 1, 'the prompt row is read by the same helper')
      assert.equal(decksAfter, decksBefore, 'deck creation must roll back with the failed assistant write')
    } finally {
      await admin.query(`DROP TRIGGER IF EXISTS qa_reject_assistant ON ai_prism.chat_messages`).catch(() => {})
      await admin.query(`DROP FUNCTION IF EXISTS ai_prism.qa_reject_assistant()`).catch(() => {})
      await admin.end()
    }
  })
  // ------------------------------------------------------------ W3-7: reasoning effort

  describe('W3-7 reasoning effort', async () => {
    const llm = await import('./llm.js')
    const entry = llm.MODELS.find((m) => m.id === MODEL)
    const FLAG = { param: 'openai', levels: ['low', 'medium', 'high'] }
    const withFlag = async (fn) => {
      const saved = entry.reasoning
      entry.reasoning = FLAG
      try {
        return await fn()
      } finally {
        if (saved) entry.reasoning = saved
        else delete entry.reasoning
      }
    }
    const bodiesFor = (marker) => roundsFor(marker).map((r) => r.body)

    test('AC3: /chat, /continue and /regenerate all forward reasoning_effort to a capable model', async () => {
      await withFlag(async () => {
        const marker = `eff3-${RUN}`
        const { viaChat, viaRegen, viaCont } = await threeRoutes(`Responda OK ${marker}`, { reasoning_effort: 'high' })
        for (const r of [viaChat, viaRegen, viaCont]) assert.equal(r.status, 200)
        const bodies = bodiesFor(marker)
        assert.equal(bodies.length, 3, 'one streamed round per route')
        for (const b of bodies) assert.equal(b.reasoning_effort, 'high')
      })
    })

    test('AC1: with no effort (or "default") no route adds a reasoning field, even for a capable model', async () => {
      await withFlag(async () => {
        const marker = `eff1-${RUN}`
        await threeRoutes(`Responda OK ${marker}`)
        const marker2 = `eff1d-${RUN}`
        await threeRoutes(`Responda OK ${marker2}`, { reasoning_effort: 'default' })
        const all = [...bodiesFor(marker), ...bodiesFor(marker2)]
        assert.equal(all.length, 6)
        for (const b of all) {
          assert.equal('reasoning_effort' in b, false)
          assert.equal('thinking' in b, false)
        }
      })
    })

    test('AC2: a model without the flag drops a stale effort silently (200, nothing sent)', async () => {
      const marker = `eff2-${RUN}`
      // Llama 4 Maverick carries no flag (probe: no demonstrable effect)
      const { viaChat } = await threeRoutes(`Responda OK ${marker}`, { model: 'databricks-llama-4-maverick', reasoning_effort: 'high' })
      assert.equal(viaChat.status, 200)
      assert.equal(bodiesFor(marker).length, 3)
      for (const b of bodiesFor(marker)) assert.equal('reasoning_effort' in b, false)
    })

    test('effort never reaches non-streaming calls of the turn (intent classifier, title)', async () => {
      await withFlag(async () => {
        const marker = `eff5-${RUN}`
        await chat(USER, { prompt: `Responda OK ${marker}`, reasoning_effort: 'high' })
        const side = gw.requests.filter((r) => r.path === '/serving-endpoints/chat/completions' && r.body && !r.body.stream && JSON.stringify(r.body).includes(marker))
        for (const r of side) assert.equal('reasoning_effort' in r.body, false)
      })
    })

    test('AC4: an invalid effort is a 400 with a localized message on all three routes; a valid one is 200', async () => {
      await withFlag(async () => {
        const sessionId = await newSession()
        const lang = { pt: /esforço/i, en: /reasoning effort/i, es: /esfuerzo/i }
        for (const bad of ['max', 'HIGH', 7, {}]) {
          const viaChat = await chat(USER, { prompt: `x ${RUN}`, sessionId, reasoning_effort: bad })
          const viaCont = await cont(USER, sessionId, undefined, { reasoning_effort: bad })
          const viaRegen = await regen(USER, sessionId, await lastAssistantId(sessionId), undefined, { reasoning_effort: bad })
          for (const r of [viaChat, viaCont, viaRegen]) {
            assert.equal(r.status, 400, JSON.stringify(bad))
            assert.equal(r.body.error, 'invalid_reasoning_effort')
          }
        }
        for (const [uiLang, re] of Object.entries(lang)) {
          const r = await chat(USER, { prompt: `x ${RUN}`, sessionId, reasoning_effort: 'nope', uiLang })
          assert.match(r.body.message, re, uiLang)
        }
        const ok = await chat(USER, { prompt: `Responda OK ${RUN}`, sessionId, reasoning_effort: 'medium' })
        assert.equal(ok.status, 200)
      })
    })
  })
})
