// Generic client for Databricks-hosted MCP (Model Context Protocol) endpoints —
// used both for the workspace-wide Genie One managed MCP and for external MCP
// servers proxied through a Unity Catalog HTTP connection. Both are reached
// the same way: Streamable HTTP, on-behalf-of the signed-in user's own OAuth
// token as the bearer credential. Connections are short-lived (open, do one
// thing, close) since these proxies are effectively stateless per request —
// there's no benefit to pooling a persistent session across chat turns.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

async function withMcpClient(url, token, fn) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'ai-prism', version: '1.0.0' })
  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    await client.close().catch(() => {})
  }
}

// tools/list runs on the hot path of building a chat turn (see buildToolDefs),
// BEFORE the model streams its first token. A slow/hung external MCP server
// would otherwise block every turn's TTFT for as long as it takes to connect.
// Bound it: on timeout we reject, and buildToolDefs degrades that connection to
// a one-off "status" tool (surfacing the reason to the user) instead of hanging.
const LIST_TOOLS_TIMEOUT_MS = 4000

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} excedeu ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Lists the tools an MCP server exposes: [{name, description, inputSchema}].
 * `timeoutMs` defaults to the hot-path bound; on-demand callers (the connect /
 * admin-inspect probes, never a turn's TTFT) can afford a longer wait.
 */
export async function listMcpTools(url, token, opts) {
  return (await listMcpServer(url, token, opts)).tools
}

/**
 * Same round trip as listMcpTools, but also keeps the server's own
 * `instructions` (sent in the MCP initialize result — e.g. Firecrawl explains
 * when to use search vs scrape vs crawl). Those are written FOR the model, so
 * the chat turn hands them over instead of discarding them.
 * → { tools: [{name, description, inputSchema}], instructions: string }
 */
export async function listMcpServer(url, token, { timeoutMs = LIST_TOOLS_TIMEOUT_MS } = {}) {
  const { tools, instructions } = await withTimeout(
    withMcpClient(url, token, async (client) => ({
      tools: (await client.listTools()).tools,
      instructions: client.getInstructions?.() || '',
    })),
    timeoutMs,
    'listagem de tools MCP'
  )
  return { tools: tools || [], instructions: instructions || '' }
}

/**
 * Calls one MCP tool and returns `{ text, structuredContent }`: `text` joins
 * any text content blocks (the human/LLM-facing rendering — for Genie's
 * tools this is markdown that already includes its own instructions on how
 * to present the answer, so callers should generally pass it through as-is
 * rather than re-summarizing it), `structuredContent` is the typed JSON
 * result when the server provides one (used for control flow, e.g. reading
 * `status` while polling, without having to re-parse the text). MCP-level
 * errors (isError, JSON-RPC errors) are returned as text too (often with an
 * actionable message, e.g. a connection-login link) rather than thrown, so
 * the model/user can see and act on them.
 */
export async function callMcpTool(url, token, toolName, args) {
  try {
    const result = await withMcpClient(url, token, (client) =>
      client.callTool({ name: toolName, arguments: args || {} })
    )
    const text = (result.content || [])
      .map((c) => (c.type === 'text' ? c.text : c.type === 'resource' ? JSON.stringify(c.resource) : ''))
      .filter(Boolean)
      .join('\n\n')
    return {
      text: text || (result.isError ? 'ERROR: a tool MCP não retornou detalhes do erro.' : '(sem conteúdo retornado)'),
      structuredContent: result.structuredContent || null,
    }
  } catch (e) {
    return { text: `ERROR: ${e.message}`, structuredContent: null }
  }
}

// ---- per-turn cache of server listings (stale-while-revalidate) -------------
// Listing through the AI Gateway is slow (Firecrawl, 28 tools: 2.6–4.4s
// measured) and it sits on the turn's TTFT. So: a fresh entry is used as-is; a
// stale one is served IMMEDIATELY while a background refresh replaces it; only
// a cold miss waits — bounded by `timeoutMs`, and even then the in-flight
// listing keeps running and fills the cache for the next turn instead of being
// thrown away (the old 4s bound + no caching of failures meant a slow server
// was missing from every turn). Probes (connect/verify/admin inspect) prime it.
// Keyed per user + URL: what a server lists can depend on the caller's grants.
const SERVER_FRESH_MS = 10 * 60 * 1000
const SERVER_STALE_MAX_MS = 24 * 60 * 60 * 1000
const SERVER_REFRESH_TIMEOUT_MS = 20_000
const serverCache = new Map() // `${key}\n${url}` -> { ts, tools, instructions }
const inflight = new Map()

export function primeMcpServerCache(url, key, server) {
  serverCache.set(`${key}\n${url}`, { ts: Date.now(), tools: server.tools || [], instructions: server.instructions || '' })
}

export async function listMcpServerCached(url, token, key, { timeoutMs = LIST_TOOLS_TIMEOUT_MS } = {}) {
  const k = `${key}\n${url}`
  const hit = serverCache.get(k)
  const age = hit ? Date.now() - hit.ts : Infinity
  if (hit && age < SERVER_FRESH_MS) return hit
  const refresh = () => {
    if (!inflight.has(k)) {
      inflight.set(
        k,
        listMcpServer(url, token, { timeoutMs: SERVER_REFRESH_TIMEOUT_MS })
          .then((server) => {
            primeMcpServerCache(url, key, server)
            return serverCache.get(k)
          })
          .finally(() => inflight.delete(k))
      )
    }
    return inflight.get(k)
  }
  if (hit && age < SERVER_STALE_MAX_MS) {
    refresh().catch(() => {})
    return hit
  }
  return withTimeout(refresh(), timeoutMs, 'listagem de tools MCP')
}
