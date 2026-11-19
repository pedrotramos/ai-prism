// Turn-time MCP admission through real turns (W2-11d AC-1, AC-2, AC-5): the
// Express app against the fake AI Gateway (scripts/fake-gateway.mjs) and the
// local pgvector Postgres. A connection to a shared-credential service saved
// BEFORE PR #83 (a user_mcp_connections row) and one written straight into the
// turn's tool refs offer the model NO tools on /api/chat, /continue and
// /regenerate, while a curated per-user connection keeps its tools on all
// three. The MCP listings are primed into the per-turn listing cache (the fake
// gateway does not speak MCP); the background classifier is a fake. Without
// the database these are SKIPPED with the reason; CI runs --fail-on-skip.
//
//   node --test server/mcpTurnAdmissionTurn.test.js
import test, { before, after, beforeEach, describe } from 'node:test'
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
env.APPKIT_BOOT = '1'
env.RATE_LIMIT_API_PER_MIN = '0'
env.RATE_LIMIT_TURNS_PER_MIN = '0'
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET
delete env.DATABRICKS_APP_NAME
delete env.DATABRICKS_APP_PORT
delete env.DATABRICKS_APP_URL
for (const k of ['WEB_SEARCH_DISABLED', 'WEB_SEARCH_BACKEND', 'WEB_SEARCH_MCP_SERVICE', 'WEB_SEARCH_CONNECTION', 'BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY', 'SEARXNG_URL']) delete env[k]

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
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
const gw = SKIP ? null : await startFakeGateway({ port: 0 })
if (gw) env.DATABRICKS_HOST = gw.url

const ext = await import('./externalMcp.js')
const { primeMcpServerCache } = await import('./mcpClient.js')

const RUN = randomUUID().slice(0, 8)
const USER = `mcp-adm-${RUN}@test.invalid`
const MODEL = 'databricks-claude-sonnet-5-5'
const ADOPTED_SHARED = 'acme.tools.adopted_shared' // saved pre-#83 (user_mcp_connections row)
const REF_SHARED = 'acme.tools.session_shared' // written straight into the turn's refs, never classified
const SLACK = 'system.ai.slack' // curated, per_user
const LISTING = { tools: [{ name: 'do_thing', description: 'Does a thing', inputSchema: { type: 'object', properties: {} } }], instructions: '' }

let server
let base

const as = (email, init = {}) => ({ ...init, headers: { ...(init.headers || {}), 'x-forwarded-email': email } })
const parseSse = (text) => text.split('\n\n').map((f) => f.trim()).filter((f) => f.startsWith('data:')).map((f) => JSON.parse(f.slice(5).trim()))
async function readTurn(res) {
  const type = res.headers.get('content-type') || ''
  if (res.status === 200 && type.includes('text/event-stream')) return { status: 200, events: parseSse(await res.text()) }
  return { status: res.status, body: await res.json().catch(() => null) }
}
const REFS = [{ kind: 'mcp-external', connectionName: REF_SHARED }, { kind: 'mcp-external', connectionName: SLACK }]
function chat(email, payload) {
  const form = new FormData()
  form.append('payload', JSON.stringify({ model: MODEL, enabledTools: REFS, ...payload }))
  return fetch(`${base}/api/chat`, as(email, { method: 'POST', body: form })).then(readTurn)
}
function postTurn(email, p, body = {}) {
  return fetch(`${base}${p}`, as(email, { method: 'POST', body: JSON.stringify({ model: MODEL, enabledTools: REFS, ...body }), headers: { 'content-type': 'application/json' } })).then(readTurn)
}
async function query(sql, params) {
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false })
  await c.connect()
  try {
    return (await c.query(sql, params)).rows
  } finally {
    await c.end()
  }
}
async function lastAssistantId(sessionId) {
  const res = await fetch(`${base}/api/sessions/${sessionId}/messages`, as(USER))
  const msgs = (await res.json()).messages
  return [...msgs].reverse().find((m) => m.role === 'assistant').id
}
/** Tool names offered on the streamed completion whose messages contain `tag`. */
const offeredFor = (tag) =>
  gw.requests
    .filter((r) => r.path === '/serving-endpoints/chat/completions' && r.body?.stream && JSON.stringify(r.body?.messages || []).includes(tag))
    .map((r) => (r.body.tools || []).map((t) => t.function.name))

describe('turn-time MCP admission', { skip: SKIP }, () => {
  before(async () => {
    const { app } = await import('./index.js')
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    base = `http://127.0.0.1:${server.address().port}`
    await (await import('./db.js')).ensureSchema(USER, 'x')
    // the row a pre-#83 connect saved: the connect path never classified it
    await query(
      `INSERT INTO user_mcp_connections (user_email, connection_name, comment, status) VALUES ($1, $2, '', 'connected') ON CONFLICT DO NOTHING`,
      [USER, ADOPTED_SHARED]
    )
  })

  after(async () => {
    await new Promise((r) => {
      server?.close(r)
      server?.closeAllConnections()
    })
    await gw?.close()
    await query(`DELETE FROM user_mcp_connections WHERE user_email = $1`, [USER]).catch(() => {})
    await query(`DELETE FROM chat_sessions WHERE user_email = $1`, [USER]).catch(() => {})
    await query(`DELETE FROM usage_ledger WHERE user_email = $1`, [USER]).catch(() => {})
  })

  beforeEach(async () => {
    ext.resetMcpAdmissionCache()
    for (const name of [ADOPTED_SHARED, REF_SHARED, SLACK]) primeMcpServerCache(ext.externalMcpUrl(name), USER, LISTING)
    // the adopted one is warm (classified shared); the session ref stays cold
    const classify = async (name) => ({ credentialClass: name === SLACK ? 'per_user' : 'shared', credentialType: null })
    await ext.admitMcpConnection('x', USER, ADOPTED_SHARED, { catalog: [], classify })
    if (ext.mcpAdmissionDeps) ext.mcpAdmissionDeps.classify = classify
  })

  test('AC-1/AC-2/AC-5: shared-credential refs offer no tools and the curated per-user one keeps its tools, on chat, regenerate and continue', async () => {
    const tag = `adm-${randomUUID().slice(0, 6)}`
    const prompt = `Responda OK (${tag} ${RUN})`
    const viaChat = await chat(USER, { prompt })
    assert.equal(viaChat.status, 200)
    const sessionId = String(viaChat.events.find((e) => e.type === 'meta').sessionId)
    const viaRegen = await postTurn(USER, `/api/sessions/${sessionId}/messages/${await lastAssistantId(sessionId)}/regenerate`)
    assert.equal(viaRegen.status, 200)
    await query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', $2)`, [sessionId, prompt])
    const viaCont = await postTurn(USER, `/api/sessions/${sessionId}/continue`)
    assert.equal(viaCont.status, 200)
    const rounds = offeredFor(tag)
    assert.equal(rounds.length, 3, 'one streamed completion per route')
    for (const [i, route] of ['chat', 'regenerate', 'continue'].entries()) {
      const mcp = rounds[i].filter((n) => n.startsWith('mcp_'))
      assert.deepEqual(mcp, ['mcp_slack__do_thing'], `${route}: ${rounds[i].join(',')}`)
    }
  })
})
