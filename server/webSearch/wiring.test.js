// Web search wiring (W2-11a): the grounding directive follows the per-turn
// decision (neutral text byte-identical to main when the tool is not
// registered), buildToolDefs registers web_search/web_fetch from the decision
// alone (no environment read) and skips the user's own refs to the shadowed
// services, callMcpTool's new options against a real MCP server built with the
// SDK the app ships (no options = unchanged), a keyed provider redirecting to
// 127.0.0.1 is refused, and the admin status/verify routes. No database.
//
//   node --test server/webSearch/wiring.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import express from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'

process.env.APPKIT_BOOT = '1'
process.env.LOCAL_DEV_MODE = '1'

const { buildBlocksInstruction } = await import('../blocks.js')
const { buildToolDefs, TOOL_GROUP_KEYS } = await import('../tools.js')
const { callMcpTool, McpToolError } = await import('../mcpClient.js')
const { search: braveSearch } = await import('./braveAdapter.js')
const { default: registerWebSearchRoutes } = await import('../routes/webSearch.js')
const ws = await import('./index.js')

const sha = (s) => createHash('sha256').update(s).digest('hex')

// ------------------------------------------------------------ AC4: directive

// sha256 of buildBlocksInstruction([], null, caps) on main@dcf4e68 (before W2-11a)
const MAIN_HASHES = [
  [{ document: true }, '5de79ad33408c2abba81e3054584186817a167955da7734210248a8e194aa4b7'],
  [{ deck: true }, '34b8440003e3f07d07a2e75a49e278d873e174c568505a91313eb91b066e6e75'],
  [{ deck: true, document: true }, '94dd8484d02d31b44ba2729d377e66788be3938de94d13dab4d69a7959cafc21'],
  [{}, '7a2de309f7d25ed1b8280ac593dc902a58f565acc1da1c57081fc4e3bd03e32b'],
  [undefined, '3128317376fae39cd49bd3bd176b9b4db7ead83eb36230b4a7c27607b68a0ec8'],
]

for (const [caps, hash] of MAIN_HASHES) {
  test(`AC4: without web search the blocks instruction is byte-identical to main (caps ${JSON.stringify(caps)})`, () => {
    assert.equal(sha(buildBlocksInstruction([], null, caps)), hash)
    assert.equal(sha(buildBlocksInstruction([], null, caps, { hasWebSearch: false })), hash)
  })
}

test('grounded directive names web_search and web_fetch only when the tool is registered', () => {
  const on = buildBlocksInstruction([], null, { document: true }, { hasWebSearch: true })
  const off = buildBlocksInstruction([], null, { document: true }, { hasWebSearch: false })
  assert.match(on, /`web_search`/)
  assert.match(on, /`web_fetch`/)
  assert.match(on, /Cite a fonte e a data/)
  assert.doesNotMatch(off, /`web_search`|`web_fetch`/)
  // non-artifact turns carry no grounding section either way
  assert.equal(buildBlocksInstruction([], null, {}, { hasWebSearch: true }), buildBlocksInstruction([], null, {}))
})

// ------------------------------------------------------------ buildToolDefs

const REGISTERED = { registered: true, shadowedServices: new Set(['system.ai.web_search', 'acme.search.firecrawl']), reason: 'test' }
const NOT_REGISTERED = { registered: false, shadowedServices: new Set(), reason: 'test' }
const names = (built) => built.tools.map((t) => t.function.name)

test("'web-search' is a tool group key again (policy toggle)", () => {
  assert.ok(TOOL_GROUP_KEYS.includes('web-search'))
})

test('buildToolDefs: web_search + web_fetch iff the decision registers them; hasWebSearch mirrors it', async () => {
  const on = await buildToolDefs([], 't', 'a@example.com', { includePython: false, webSearch: REGISTERED })
  assert.deepEqual(names(on), ['web_search', 'web_fetch'])
  assert.equal(on.hasWebSearch, true)
  assert.equal(on.resolvers.get('web_search').kind, 'web-search')
  assert.equal(on.resolvers.get('web_fetch').kind, 'web-fetch')
  const off = await buildToolDefs([], 't', 'a@example.com', { includePython: false, webSearch: NOT_REGISTERED })
  assert.deepEqual(names(off), [])
  assert.equal(off.hasWebSearch, false)
  const none = await buildToolDefs([], 't', 'a@example.com', { includePython: false })
  assert.equal(none.hasWebSearch, false, 'no decision → no tool')
  const policyOff = await buildToolDefs([], 't', 'a@example.com', { includePython: false, webSearch: REGISTERED, toolPolicy: { 'web-search': false } })
  assert.equal(policyOff.hasWebSearch, false)
})

test('buildToolDefs reads no environment variable for web search', async () => {
  const saved = { ...process.env }
  try {
    process.env.WEB_SEARCH_DISABLED = '1'
    const on = await buildToolDefs([], 't', 'a@example.com', { includePython: false, webSearch: REGISTERED })
    assert.equal(on.hasWebSearch, true, 'the decision already applied the kill-switch')
    delete process.env.WEB_SEARCH_DISABLED
    process.env.BRAVE_SEARCH_API_KEY = 'k'
    process.env.WEB_SEARCH_CONNECTION = 'a.b.c'
    const off = await buildToolDefs([], 't', 'a@example.com', { includePython: false, webSearch: NOT_REGISTERED })
    assert.equal(off.hasWebSearch, false)
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
})

test('AC10: with the native tool registered, user refs to the managed or designated service add no mcp_ tools', async () => {
  const refs = [
    { kind: 'mcp-external', connectionName: 'system.ai.web_search' },
    { kind: 'mcp-external', connectionName: 'acme.search.firecrawl' },
  ]
  const built = await buildToolDefs(refs, 't', 'a@example.com', { includePython: false, webSearch: REGISTERED })
  assert.deepEqual(names(built), ['web_search', 'web_fetch'])
  assert.ok(!names(built).some((n) => n.startsWith('mcp_')))
  assert.equal(built.guide, '', 'the designated server is not part of the MCP guide (invariant 3)')
})

test('the legacy web-search-mcp resolver and webSearchConnectionName are gone', async () => {
  const tools = await import('../tools.js')
  assert.equal(tools.webSearchConnectionName, undefined)
  const web = await import('../web.js')
  assert.equal(web.searchWeb, undefined, 'search moved to server/webSearch')
  assert.equal(web.webSearchConfigured, undefined)
  assert.equal(typeof web.fetchWebPage, 'function', 'web_fetch stays in web.js')
})

test('web_search tool description forbids internal data in the query', async () => {
  const on = await buildToolDefs([], 't', 'a@example.com', { includePython: false, webSearch: REGISTERED })
  assert.match(on.tools[0].function.description, /Não inclua na consulta dados internos, nomes de clientes ou conteúdo de anexos: a consulta sai do workspace para o provedor de busca\./)
})

// ------------------------------------------------------------ callMcpTool options (real MCP server)

async function startMcpServer() {
  const calls = []
  const app = http.createServer(async (req, res) => {
    const server = new Server({ name: 'fake-search', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ['echo', 'slow', 'fails', 'rpc_error'].map((name) => ({ name, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      calls.push(r.params)
      if (r.params.name === 'slow') await new Promise((resolve) => setTimeout(resolve, 2000))
      if (r.params.name === 'fails') return { isError: true, content: [{ type: 'text', text: 'provider exploded' }] }
      if (r.params.name === 'rpc_error') throw new McpError(-32007, 'Not authorized to invoke MCP service')
      return { content: [{ type: 'text', text: `echo:${r.params.arguments?.query}` }] }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close()
      server.close()
    })
    await server.connect(transport)
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => transport.handleRequest(req, res, body ? JSON.parse(body) : undefined))
  })
  await new Promise((r) => app.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${app.address().port}/mcp`,
    calls,
    close: () => new Promise((r) => {
      app.closeAllConnections?.()
      app.close(r)
    }),
  }
}

test('callMcpTool without options: unchanged (text result, errors as ERROR: text, no throw)', async () => {
  const s = await startMcpServer()
  try {
    assert.deepEqual(await callMcpTool(s.url, 'tok', 'echo', { query: 'x' }), { text: 'echo:x', structuredContent: null })
    const failed = await callMcpTool(s.url, 'tok', 'fails', {})
    assert.equal(failed.text, 'provider exploded')
    const rpc = await callMcpTool(s.url, 'tok', 'rpc_error', {})
    assert.match(rpc.text, /^ERROR: .*Not authorized/)
  } finally {
    await s.close()
  }
})

test('callMcpTool throwOnError: JSON-RPC errors and isError results throw McpToolError with a code', async () => {
  const s = await startMcpServer()
  try {
    await assert.rejects(callMcpTool(s.url, 'tok', 'rpc_error', {}, { throwOnError: true }), (e) => e instanceof McpToolError && e.code === -32007 && /Not authorized/.test(e.message))
    await assert.rejects(callMcpTool(s.url, 'tok', 'fails', {}, { throwOnError: true }), (e) => e instanceof McpToolError && e.code === 'tool_error')
    assert.deepEqual(await callMcpTool(s.url, 'tok', 'echo', { query: 'y' }, { throwOnError: true }), { text: 'echo:y', structuredContent: null })
  } finally {
    await s.close()
  }
})

test('callMcpTool timeoutMs: a slow tool throws McpToolError timeout (with throwOnError)', async () => {
  const s = await startMcpServer()
  try {
    await assert.rejects(callMcpTool(s.url, 'tok', 'slow', {}, { timeoutMs: 100, throwOnError: true }), (e) => e instanceof McpToolError && e.code === 'timeout')
    const soft = await callMcpTool(s.url, 'tok', 'slow', {}, { timeoutMs: 100 })
    assert.match(soft.text, /^ERROR: /, 'without throwOnError a timeout is ERROR: text, like any other error')
  } finally {
    await s.close()
  }
})

test('callMcpTool signal: an abort rejects with AbortError even without throwOnError', async () => {
  const s = await startMcpServer()
  try {
    const ac = new AbortController()
    const p = callMcpTool(s.url, 'tok', 'slow', {}, { signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    await assert.rejects(p, (e) => e.name === 'AbortError')
  } finally {
    await s.close()
  }
})

// ------------------------------------------------------------ AC14: keyed redirect

test('AC14: a keyed provider answering a redirect to 127.0.0.1 is refused before any second request', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.215.14', family: 4 }])
  for (const location of ['http://127.0.0.1:9/', 'https://127.0.0.1/', 'http://[::ffff:7f00:1]/']) {
    const request = t.mock.method(https, 'request', (opts, onResponse) => {
      assert.equal(opts.hostname, 'api.search.brave.com')
      const req = new EventEmitter()
      req.setTimeout = () => req
      req.destroy = () => {}
      req.end = () => {
        const res = new EventEmitter()
        res.statusCode = 302
        res.headers = { location }
        onResponse(res)
        res.emit('end')
      }
      return req
    })
    const plain = t.mock.method(http, 'request')
    await assert.rejects(braveSearch('q', { limit: 3, env: { BRAVE_SEARCH_API_KEY: 'k' } }), (e) => e instanceof ws.WebSearchError)
    assert.equal(request.mock.callCount(), 1, `only the provider hop (${location})`)
    assert.equal(plain.mock.callCount(), 0, 'nothing reached the loopback target')
    request.mock.restore()
    plain.mock.restore()
  }
})

// ------------------------------------------------------------ AC15: admin routes

const ADMIN = 'admin@example.com'
const USER = 'user@example.com'
function fakeAuth(req, res, next) {
  const email = req.headers['x-test-email']
  if (!email) return res.status(401).json({ error: 'no identity' })
  req.email = email
  req.token = 'fake-obo-token-not-a-secret'
  next()
}
function fakeRequireAdmin(req, res, next) {
  if (req.email === ADMIN) return next()
  res.status(403).json({ error: 'apenas administradores' })
}

async function serveRoutes(deps = {}) {
  const app = express()
  app.use(express.json())
  registerWebSearchRoutes(app, { auth: fakeAuth, requireAdmin: fakeRequireAdmin, ...deps })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (method, p, email = ADMIN) => fetch(base + p, { method, headers: { 'x-test-email': email } })
  return { call, close: () => new Promise((r) => server.close(r)) }
}

test('AC15: GET status returns the chain with states and never a key value; non-admins get 403', async () => {
  ws.resetWebSearchForTests()
  const env = { WEB_SEARCH_MCP_SERVICE: 'acme.search.firecrawl', BRAVE_SEARCH_API_KEY: 'brave-secret-value', TAVILY_API_KEY: 'tavily-secret-value' }
  const s = await serveRoutes({ env })
  try {
    const r = await s.call('GET', '/api/admin/web-search/status')
    assert.equal(r.status, 200)
    const text = await r.text()
    const body = JSON.parse(text)
    assert.deepEqual(body.chain.map((c) => c.kind), ['managed-mcp', 'external-mcp', 'brave', 'tavily'])
    assert.ok(body.chain.every((c) => ['up', 'down', 'unknown'].includes(c.state)))
    assert.ok(!text.includes('brave-secret-value') && !text.includes('tavily-secret-value'))
    assert.equal(body.chain[2].keyPresent, true)
    for (const [m, p] of [['GET', '/api/admin/web-search/status'], ['POST', '/api/admin/web-search/verify']]) {
      assert.equal((await s.call(m, p, USER)).status, 403, `${m} ${p}`)
    }
  } finally {
    await s.close()
  }
})

test('POST verify: as the admin, counts only; at most one call per 10 s per admin', async () => {
  ws.resetWebSearchForTests()
  let verifies = 0
  const status = async ({ verify }) => {
    if (verify) verifies++
    return { mode: 'list', enabled: true, chain: [], last24h: { calls: 0, errors: 0, byCode: {} } }
  }
  let now = 1_000_000
  const s = await serveRoutes({ env: {}, status, now: () => now })
  try {
    assert.equal((await s.call('POST', '/api/admin/web-search/verify')).status, 200)
    assert.equal((await s.call('POST', '/api/admin/web-search/verify')).status, 429)
    now += 10_001
    assert.equal((await s.call('POST', '/api/admin/web-search/verify')).status, 200)
    assert.equal(verifies, 2)
  } finally {
    await s.close()
  }
})
