// Web search through real turns (W2-11a acceptance 1-4, 6, 9, 10, 12, 14): the
// Express app against the fake AI Gateway (scripts/fake-gateway.mjs) and the
// local pgvector Postgres, with the MCP layer injected (webSearchDeps) — the
// fake gateway does not speak MCP, and no real provider is ever called. Without
// the database these are SKIPPED with the reason; CI runs --fail-on-skip.
//
//   node --test server/webSearch/webSearchTurn.test.ts
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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
const WS_KEYS = ['WEB_SEARCH_DISABLED', 'WEB_SEARCH_BACKEND', 'WEB_SEARCH_MCP_SERVICE', 'WEB_SEARCH_MCP_TOOL', 'WEB_SEARCH_CONNECTION', 'BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY', 'SEARXNG_URL', 'WEB_SEARCH_PRICE_PER_1K_USD']
for (const k of WS_KEYS) delete env[k]

type Loose = any // gateway/SSE payloads and fakes are read field by field

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
async function skipReason() {
  if (!LOCAL_HOSTS.has(env.PGHOST as string) && env.ISOLATION_TEST_ANY_HOST !== '1') return `PGHOST=${env.PGHOST} is not local`
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false, connectionTimeoutMillis: 2000 })
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    return ext.rows.length ? null : 'pgvector is not installed in this Postgres'
  } catch (e) {
    return `no Postgres at ${env.PGHOST}:${env.PGPORT} (${(e as Loose).code || (e as Error).message}); run npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}
const SKIP = (await skipReason()) || false
const gw = SKIP ? null : await startFakeGateway({ port: 0 })
if (gw) env.DATABRICKS_HOST = gw.url

const ws = await import('./index.ts')
const { candidateState } = await import('./availability.ts')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): Loose => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8'))
const FIRECRAWL_TOOLS = fixture('firecrawl-tools.json').tools
const FIRECRAWL_SEARCH = fixture('firecrawl-search.json')
const FIRECRAWL_INSTRUCTIONS = 'FIRECRAWL-SERVER-INSTRUCTIONS: always crawl the whole site'

const RUN = randomUUID().slice(0, 8)
const USER = `ws-a-${RUN}@test.invalid`
const OTHER = `ws-b-${RUN}@test.invalid`
const MODEL = 'databricks-claude-sonnet-5-5'
const EXT = 'acme.search.firecrawl'
const MANAGED = 'system.ai.web_search'
const QUERY = `selic copom ${RUN}`

let server: Server | undefined
let base: string

const as = (email: string, init: Loose = {}) => ({ ...init, headers: { ...(init.headers || {}), 'x-forwarded-email': email } })
const parseSse = (text: string): Loose[] => text.split('\n\n').map((f) => f.trim()).filter((f) => f.startsWith('data:')).map((f) => JSON.parse(f.slice(5).trim()))
async function readTurn(res: Response): Promise<Loose> {
  const type = res.headers.get('content-type') || ''
  if (res.status === 200 && type.includes('text/event-stream')) return { status: 200, events: parseSse(await res.text()) }
  return { status: res.status, body: await res.json().catch(() => null) }
}
function chat(email: string, payload: Loose, init: Loose = {}): Promise<Loose> {
  const form = new FormData()
  form.append('payload', JSON.stringify({ model: MODEL, enabledTools: [], ...payload }))
  return fetch(`${base}/api/chat`, as(email, { method: 'POST', body: form, ...init })).then(readTurn)
}
function postTurn(email: string, p: string, body = {}): Promise<Loose> {
  return fetch(`${base}${p}`, as(email, { method: 'POST', body: JSON.stringify({ model: MODEL, enabledTools: [], ...body }), headers: { 'content-type': 'application/json' } })).then(readTurn)
}
async function query(sql: string, params?: unknown[]): Promise<Loose[]> {
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE, ssl: false })
  await c.connect()
  try {
    return (await c.query(sql, params)).rows
  } finally {
    await c.end()
  }
}
async function getJson(p: string, email = USER): Promise<Loose> {
  const res = await fetch(`${base}${p}`, as(email))
  return { status: res.status, body: await res.json().catch(() => null) }
}
async function lastAssistantId(sessionId: string) {
  const msgs = (await getJson(`/api/sessions/${sessionId}/messages`)).body.messages
  return [...msgs].reverse().find((m: Loose) => m.role === 'assistant').id
}
async function newSession(): Promise<string> {
  const r = await chat(USER, { prompt: `Responda apenas OK. (${RUN})` })
  assert.equal(r.status, 200)
  return String(r.events.find((e: Loose) => e.type === 'meta').sessionId)
}
async function waitFor<T>(fn: () => T | Promise<T>, { timeoutMs = 5000, stepMs = 25 } = {}): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v || Date.now() > until) return v
    await new Promise((r) => setTimeout(r, stepMs))
  }
}
const fakeArgs = (obj: unknown) => `[fake:args:${Buffer.from(JSON.stringify(obj)).toString('base64url')}]`
const searchPrompt = (tag: string) => `Pesquise na web [fake:tool:web_search] ${fakeArgs({ query: QUERY, limit: 4 })} (${tag} ${RUN})`
const ledger = (sessionId: string) => query(`SELECT kind, model, cost_usd, prompt_tokens, completion_tokens FROM usage_ledger WHERE session_id = $1 AND kind = 'web_search' ORDER BY id`, [sessionId])
const sessionOf = (r: Loose) => String(r.events.find((e: Loose) => e.type === 'meta').sessionId)
const toolResult = (r: Loose) => r.events.find((e: Loose) => e.type === 'tool_result')
/** Chat-completion requests whose last user message contains `tag`. */
function requestsFor(tag: string): Loose[] {
  // only called inside the (non-skipped) suite, where the gateway exists
  return gw!.requests.filter((r: Loose) => r.path === '/serving-endpoints/chat/completions' && JSON.stringify(r.body?.messages || []).includes(tag))
}

const mcpError = (message: string, code: unknown) => Object.assign(new Error(message), { code })
function installMcp(servers: Record<string, Loose>) {
  const lists: Loose[] = []
  const calls: Loose[] = []
  const serviceOf = (url: unknown) => decodeURIComponent(String(url).split('/ai-gateway/mcp-services/')[1] || '')
  ws.webSearchDeps.listServer = (async (url: string, token: string, key: string) => {
    const service = serviceOf(url)
    lists.push({ service, key })
    const s = servers[service]
    if (!s) throw mcpError('Not authorized to invoke MCP service (-32007)', -32007)
    if (s.list) return s.list()
    return { tools: s.tools, instructions: s.instructions || '' }
  }) as unknown as typeof ws.webSearchDeps.listServer // the fakes return the fields the adapter reads
  ws.webSearchDeps.callTool = (async (url: string, token: string, name: string, args?: Loose, opts?: Loose) => {
    const service = serviceOf(url)
    calls.push({ service, name, args })
    const s = servers[service]
    if (!s) throw mcpError('Not authorized to invoke MCP service (-32007)', -32007)
    return s.call(name, args, opts)
  }) as unknown as typeof ws.webSearchDeps.callTool
  return { lists, calls }
}
const managedServer = (): Loose => ({
  tools: [{ name: 'web_search', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
  call: () => ({ text: 'A Selic está em 15% (fonte: https://www.bcb.gov.br/).', structuredContent: null }),
})
const firecrawlServer = (call: Loose = () => ({ text: FIRECRAWL_SEARCH.text, structuredContent: null })) => ({ tools: FIRECRAWL_TOOLS, instructions: FIRECRAWL_INSTRUCTIONS, call })

describe('web search turns', { skip: SKIP }, () => {
  before(async () => {
    const { app } = await import('../index.js')
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    base = `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}`
  })

  after(async () => {
    ws.resetWebSearchForTests()
    await new Promise((r: Loose) => {
      server?.close(r)
      server?.closeAllConnections()
    })
    await gw?.close()
    await query(`DELETE FROM chat_sessions WHERE user_email = ANY($1)`, [[USER, OTHER]]).catch(() => {})
    await query(`DELETE FROM usage_ledger WHERE user_email = ANY($1)`, [[USER, OTHER]]).catch(() => {})
  })

  beforeEach(() => {
    ws.resetWebSearchForTests()
    for (const k of WS_KEYS) delete env[k]
  })

  test('AC1: managed fake only — prewarm on /api/tool-policy, one databricks ledger row, envelope, status ok', async () => {
    installMcp({ [MANAGED]: managedServer() })
    assert.equal((await getJson('/api/tool-policy')).status, 200)
    assert.equal(await waitFor(() => candidateState(USER, { kind: 'managed-mcp', service: MANAGED }).state === 'up'), true, 'the prewarm probed the managed service')
    const r = await chat(USER, { prompt: searchPrompt('ac1') })
    assert.equal(r.status, 200)
    const tr = toolResult(r)
    assert.equal(tr.status, 'ok')
    const lines = tr.result.split('\n')
    assert.equal(lines[0], ws.UNTRUSTED_HEADER)
    assert.equal(lines.at(-1), ws.UNTRUSTED_FOOTER)
    const rows = await waitFor(async () => ((await ledger(sessionOf(r))).length ? ledger(sessionOf(r)) : null))
    assert.deepEqual(rows!.map((x: Loose) => [x.kind, x.model, x.cost_usd]), [['web_search', 'databricks', null]])
    assert.equal(Number(rows![0].prompt_tokens), 0)
  })

  test('AC2 + AC9: managed -32007, the designated firecrawl service answers with one call; server metadata never reaches the gateway', async () => {
    env.WEB_SEARCH_MCP_SERVICE = EXT
    const mcp = installMcp({ [EXT]: firecrawlServer() })
    const tag = `ac2-${randomUUID().slice(0, 6)}`
    const r = await chat(USER, { prompt: searchPrompt(tag) })
    assert.equal(toolResult(r).status, 'ok', JSON.stringify(toolResult(r)))
    assert.deepEqual(mcp.calls, [{ service: EXT, name: 'firecrawl_search', args: { query: QUERY, limit: 4 } }])
    const rows = await waitFor(async () => ((await ledger(sessionOf(r))).length ? ledger(sessionOf(r)) : null))
    assert.deepEqual(rows!.map((x: Loose) => x.model), ['firecrawl-mcp'])
    assert.equal(candidateState(USER, { kind: 'managed-mcp', service: MANAGED }).state, 'down')
    assert.equal(candidateState(USER, { kind: 'managed-mcp', service: MANAGED }).code, 'forbidden')
    assert.equal(candidateState(OTHER, { kind: 'managed-mcp', service: MANAGED }).state, 'unknown')
    // AC9: the designated service's tool descriptions and instructions appear in no gateway request
    const bodies = requestsFor(tag).map((q: Loose) => JSON.stringify(q.body))
    assert.ok(bodies.length >= 2, 'the tool round and the answer round')
    for (const b of bodies) {
      assert.ok(!b.includes(FIRECRAWL_INSTRUCTIONS))
      for (const t of FIRECRAWL_TOOLS) assert.ok(!b.includes(t.description), `description of ${t.name} leaked`)
      assert.ok(!b.includes('firecrawl_crawl') && !b.includes('firecrawl_scrape'))
    }
    // the tool offered to the model is the native one
    const offered = requestsFor(tag)[0].body.tools.map((t: Loose) => t.function.name)
    assert.ok(offered.includes('web_search') && offered.includes('web_fetch'))
  })

  test('AC3: both MCP candidates fail → brave answers, cost 0.005', async () => {
    env.WEB_SEARCH_MCP_SERVICE = EXT
    env.BRAVE_SEARCH_API_KEY = 'fake-brave-key'
    installMcp({ [EXT]: firecrawlServer(() => { throw mcpError('Error POSTing to endpoint: too many requests', 429) }) })
    ws.webSearchDeps.fetchImpl = async () => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(fixture('brave-search.json'))) })
    const r = await chat(USER, { prompt: searchPrompt('ac3') })
    assert.equal(toolResult(r).status, 'ok')
    const rows = await waitFor(async () => ((await ledger(sessionOf(r))).length ? ledger(sessionOf(r)) : null))
    assert.deepEqual(rows!.map((x: Loose) => [x.model, Number(x.cost_usd)]), [['brave', 0.005]])
  })

  test('AC4: auto with nothing configured and the probe not up — no web tools, neutral directive, no awaited MCP call', async () => {
    let listings = 0
    let calls = 0
    ws.webSearchDeps.listServer = () => {
      listings++
      return new Promise(() => {}) // never answers: a turn that waited would hang
    }
    ws.webSearchDeps.callTool = (async () => {
      calls++
      return { text: 'x' }
    }) as unknown as typeof ws.webSearchDeps.callTool
    const tag = `ac4-${randomUUID().slice(0, 6)}`
    const r = await chat(USER, { prompt: `Escreva um documento sobre a Selic (${tag})` })
    assert.equal(r.status, 200)
    assert.ok(r.events.some((e: Loose) => e.type === 'done'))
    const reqs = requestsFor(tag).filter((q: Loose) => q.body?.stream)
    assert.ok(reqs.length >= 1)
    for (const q of reqs) {
      const offered = (q.body.tools || []).map((t: Loose) => t.function.name)
      assert.ok(!offered.includes('web_search') && !offered.includes('web_fetch'), offered.join(','))
      const text = JSON.stringify(q.body.messages)
      assert.ok(!text.includes('`web_search`'), 'the grounded directive must not name a tool that is not there')
      assert.ok(text.includes('DADOS REAIS E FONTES'), 'the neutral grounding directive is still there')
    }
    assert.equal(calls, 0)
    assert.ok(listings <= 1, 'at most the one background probe')
  })

  test('AC6: every candidate failing → tool_result error and the model receives the estimate sentence, no query, no upstream text', async () => {
    env.WEB_SEARCH_MCP_SERVICE = EXT
    installMcp({ [EXT]: firecrawlServer(() => { throw mcpError(`upstream-detail-${RUN} ${QUERY}`, 'ECONNRESET') }) })
    const tag = `ac6-${randomUUID().slice(0, 6)}`
    const r = await chat(USER, { prompt: searchPrompt(tag) })
    const tr = toolResult(r)
    assert.equal(tr.status, 'error')
    assert.match(tr.result, /estimativa/)
    assert.ok(!tr.result.includes(QUERY) && !tr.result.includes(`upstream-detail-${RUN}`))
    const answerRound = requestsFor(tag).filter((q: Loose) => q.body?.stream).at(-1).body.messages
    const toolMsg = answerRound.find((m: Loose) => m.role === 'tool')
    // a prompt-cached message arrives as text blocks
    const content = typeof toolMsg.content === 'string' ? toolMsg.content : toolMsg.content.map((b: Loose) => b?.text || '').join('')
    assert.match(content, /^ERROR: .*estimativa/)
    assert.ok(!content.includes(QUERY) && !content.includes(`upstream-detail-${RUN}`))
    assert.equal((await ledger(sessionOf(r))).length, 0, 'a failed search writes no row')
  })

  test('AC10: with the native tool registered, the user\'s own refs to the managed and designated service add no mcp_ tools', async () => {
    env.WEB_SEARCH_MCP_SERVICE = EXT
    installMcp({ [MANAGED]: managedServer(), [EXT]: firecrawlServer() })
    const tag = `ac10-${randomUUID().slice(0, 6)}`
    const r = await chat(USER, {
      prompt: `Responda OK (${tag})`,
      enabledTools: [{ kind: 'mcp-external', connectionName: MANAGED }, { kind: 'mcp-external', connectionName: EXT }],
    })
    assert.equal(r.status, 200)
    const offered = (requestsFor(tag).find((q: Loose) => q.body?.stream).body.tools || []).map((t: Loose) => t.function.name)
    assert.ok(offered.includes('web_search'))
    assert.ok(!offered.some((n: Loose) => n.startsWith('mcp_')), offered.join(','))
  })

  test('AC12: a cancelled turn writes no web_search row, even when the search answers after the cancel', async () => {
    env.WEB_SEARCH_MCP_SERVICE = EXT
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    let entered!: () => void
    const enteredP = new Promise<void>((r) => (entered = r))
    installMcp({ [EXT]: firecrawlServer(async () => {
      entered()
      await gate
      return { text: FIRECRAWL_SEARCH.text, structuredContent: null }
    }) })
    const sessionId = await newSession()
    const ac = new AbortController()
    const p = chat(USER, { prompt: searchPrompt('ac12'), sessionId }, { signal: ac.signal }).catch((e: Loose) => e)
    await enteredP
    ac.abort()
    await p
    await new Promise((r) => setTimeout(r, 200))
    open()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal((await ledger(sessionId)).length, 0)
  })

  test('AC14: identical behaviour on chat, continue and regenerate', async () => {
    installMcp({ [MANAGED]: managedServer() })
    await ws.warmWebSearch({ token: 'x', email: USER })
    const sessionId = await newSession()
    const prompt = searchPrompt('ac14')
    const viaChat = await chat(USER, { prompt, sessionId })
    const viaRegen = await postTurn(USER, `/api/sessions/${sessionId}/messages/${await lastAssistantId(sessionId)}/regenerate`)
    await query(`INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', $2)`, [sessionId, prompt])
    const viaCont = await postTurn(USER, `/api/sessions/${sessionId}/continue`)
    const ENVELOPE = new Set(['meta', 'title', 'variant'])
    const shape = (r: Loose) => {
      const out: string[] = []
      for (const e of r.events.filter((x: Loose) => !ENVELOPE.has(x.type))) if (out.at(-1) !== e.type) out.push(e.type)
      return out
    }
    for (const [name, r] of ([['chat', viaChat], ['regenerate', viaRegen], ['continue', viaCont]] as [string, Loose][])) {
      assert.equal(r.status, 200, name)
      const call = r.events.find((e: Loose) => e.type === 'tool_call')
      assert.equal(call?.name, 'web_search', name)
      assert.equal(toolResult(r).status, 'ok', name)
      assert.equal(toolResult(r).result.split('\n')[0], ws.UNTRUSTED_HEADER, name)
    }
    assert.deepEqual(shape(viaRegen), shape(viaChat))
    assert.deepEqual(shape(viaCont), shape(viaChat))
    const rows = await waitFor(async () => ((await ledger(sessionId)).length === 3 ? ledger(sessionId) : null))
    assert.equal(rows?.length, 3, 'one row per answered search on each route')
  })
})
