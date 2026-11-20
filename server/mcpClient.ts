// Generic client for Databricks-hosted MCP (Model Context Protocol) endpoints —
// used both for the workspace-wide Genie One managed MCP and for external MCP
// servers proxied through a Unity Catalog HTTP connection. Both are reached
// the same way: Streamable HTTP, on-behalf-of the signed-in user's own OAuth
// token as the bearer credential. Connections are short-lived (open, do one
// thing, close) since these proxies are effectively stateless per request —
// there's no benefit to pooling a persistent session across chat turns.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { sanitizeMetadata } from './toolMetadata.ts'

// A tool as listed to callers: the SDK's Tool with its text neutralized.
type McpListedTool = Tool
interface McpServerListing {
  tools: McpListedTool[]
  instructions: string
}
interface McpToolResult {
  text: string
  structuredContent: Record<string, unknown> | null
}
interface McpCallOptions {
  timeoutMs?: number
  throwOnError?: boolean
  signal?: AbortSignal | null
}
// The slice of the SDK's callTool result that toToolText reads.
interface RawToolResult {
  content?: unknown
  structuredContent?: Record<string, unknown> | undefined
  isError?: boolean | undefined
}
interface CachedServer {
  ts: number
  tools: McpListedTool[]
  instructions: string
}

async function withMcpClient<T>(url: string, token: string, fn: (client: Client) => Promise<T>): Promise<T> {
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} excedeu ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Descriptions and titles inside a tool's JSON Schema are server text that the
// model reads; enum/const/default/examples are values the model must emit as they
// are, so they are left alone (names stay raw: calls are routed by them).
const SCHEMA_TEXT_KEYS = new Set(['description', 'title'])
function sanitizeSchemaText(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchemaText)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (SCHEMA_TEXT_KEYS.has(k) && typeof v === 'string') out[k] = sanitizeMetadata(v, 500)
    else out[k] = sanitizeSchemaText(v)
  }
  return out
}

/**
 * Lists the tools an MCP server exposes: [{name, description, inputSchema}].
 * The text (description, schema descriptions) is neutralized here, once, for
 * every consumer: it goes to the model (toolMetadata.js).
 * `timeoutMs` defaults to the hot-path bound; on-demand callers (the connect /
 * admin-inspect probes, never a turn's TTFT) can afford a longer wait.
 */
export async function listMcpTools(url: string, token: string, opts?: { timeoutMs?: number }): Promise<McpListedTool[]> {
  return (await listMcpServer(url, token, opts)).tools
}

/**
 * Same round trip as listMcpTools, but also keeps the server's own
 * `instructions` (sent in the MCP initialize result — e.g. Firecrawl explains
 * when to use search vs scrape vs crawl). Those are written FOR the model, so
 * the chat turn hands them over instead of discarding them.
 * → { tools: [{name, description, inputSchema}], instructions: string }
 */
export async function listMcpServer(url: string, token: string, { timeoutMs = LIST_TOOLS_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<McpServerListing> {
  const { tools, instructions } = await withTimeout(
    withMcpClient(url, token, async (client) => ({
      tools: (await client.listTools()).tools,
      instructions: client.getInstructions?.() || '',
    })),
    timeoutMs,
    'listagem de tools MCP'
  )
  return {
    tools: (tools || []).map((t) => ({
      ...t,
      description: sanitizeMetadata(t.description || '', 1000),
      inputSchema: (t.inputSchema ? sanitizeSchemaText(t.inputSchema) : t.inputSchema) as McpListedTool['inputSchema'],
    })),
    // written for the model, but authored by the server: neutralized like the rest
    instructions: sanitizeMetadata(instructions || '', 4000),
  }
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
export async function callMcpTool(
  url: string,
  token: string,
  toolName: string,
  args?: Record<string, unknown> | null,
  options?: McpCallOptions
): Promise<McpToolResult> {
  // No options: exactly the historical behaviour (no bound, every error as
  // `ERROR:` text) for the existing callers (Genie One, user MCP tools).
  if (options === undefined) {
    try {
      return toToolText(await withMcpClient(url, token, (client) => callRaw(client, toolName, args)))
    } catch (e) {
      return { text: `ERROR: ${(e as Error).message}`, structuredContent: null }
    }
  }
  const { timeoutMs = 20_000, throwOnError = false, signal = null } = options || {}
  try {
    const result = await boundedCall(url, token, toolName, args, { timeoutMs, signal })
    if (throwOnError && result.isError) {
      const { text } = toToolText(result)
      throw new McpToolError('tool_error', text)
    }
    return toToolText(result)
  } catch (e) {
    // a cancelled turn is never turned into a result
    const err = e as { name?: string; message?: string } | null | undefined
    if (err?.name === 'AbortError') throw e
    if (throwOnError) throw e instanceof McpToolError ? e : new McpToolError(errorCode(e), String(err?.message || e))
    return { text: `ERROR: ${err?.message || e}`, structuredContent: null }
  }
}

/** A failed MCP call when `throwOnError` is set: `code` is the JSON-RPC code, the HTTP status, 'timeout' or 'tool_error'. */
export class McpToolError extends Error {
  declare code: string | number
  constructor(code: string | number, message: string) {
    super(message)
    this.name = 'McpToolError'
    this.code = code
  }
}

// The SDK types callTool as a union that includes a legacy `toolResult` shape;
// narrowing it to the fields toToolText reads is a type-only cast.
function callRaw(
  client: Client,
  toolName: string,
  args: Record<string, unknown> | null | undefined,
  requestOptions?: { signal: AbortSignal; timeout: number }
): Promise<RawToolResult> {
  return client.callTool({ name: toolName, arguments: args || {} }, undefined, requestOptions) as Promise<RawToolResult>
}

function toToolText(result: RawToolResult): McpToolResult {
  const text = ((result.content || []) as { type: string; text?: string; resource?: unknown }[])
    .map((c) => (c.type === 'text' ? c.text : c.type === 'resource' ? JSON.stringify(c.resource) : ''))
    .filter(Boolean)
    .join('\n\n')
  return {
    text: text || (result.isError ? 'ERROR: a tool MCP não retornou detalhes do erro.' : '(sem conteúdo retornado)'),
    structuredContent: result.structuredContent || null,
  }
}

// JSON-RPC errors (McpError) carry a numeric `code`; transport errors
// (StreamableHTTPError) carry the HTTP status as `code`.
function errorCode(e: unknown): string | number {
  const c = (e as { code?: unknown } | null | undefined)?.code
  if (typeof c === 'number' || typeof c === 'string') return c
  return 'unavailable'
}

const abortError = (signal: AbortSignal | null | undefined): Error => signal?.reason instanceof Error && signal.reason.name === 'AbortError'
  ? signal.reason
  : new DOMException('The operation was aborted.', 'AbortError')

// The whole round trip (connect + call + close) under one bound and the
// caller's signal; the connection is closed on either. The SDK also gets the
// signal and the bound, so its own request is cancelled, not left running.
async function boundedCall(
  url: string,
  token: string,
  toolName: string,
  args: Record<string, unknown> | null | undefined,
  { timeoutMs, signal }: { timeoutMs: number; signal: AbortSignal | null }
): Promise<RawToolResult> {
  if (signal?.aborted) throw abortError(signal)
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const onAbort = () => ac.abort(abortError(signal))
  signal?.addEventListener('abort', onAbort, { once: true })
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new McpToolError('timeout', `MCP tool call exceeded ${timeoutMs}ms`))
      ac.abort(new McpToolError('timeout', `MCP tool call exceeded ${timeoutMs}ms`))
    }, timeoutMs)
    ac.signal.addEventListener('abort', () => {
      if (signal?.aborted) reject(abortError(signal))
    }, { once: true })
  })
  stop.catch(() => {})
  try {
    return await Promise.race([
      withMcpClient(url, token, (client) =>
        callRaw(client, toolName, args, { signal: ac.signal, timeout: timeoutMs })
      ),
      stop,
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (!ac.signal.aborted) ac.abort()
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
const serverCache = new Map<string, CachedServer>() // `${key}\n${url}` -> { ts, tools, instructions }
const inflight = new Map<string, Promise<CachedServer | undefined>>()

export function primeMcpServerCache(url: string, key: string, server: Partial<McpServerListing>): void {
  serverCache.set(`${key}\n${url}`, { ts: Date.now(), tools: server.tools || [], instructions: server.instructions || '' })
}

export async function listMcpServerCached(url: string, token: string, key: string, { timeoutMs = LIST_TOOLS_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<CachedServer | undefined> {
  const k = `${key}\n${url}`
  const hit = serverCache.get(k)
  const age = hit ? Date.now() - hit.ts : Infinity
  if (hit && age < SERVER_FRESH_MS) return hit
  const refresh = (): Promise<CachedServer | undefined> => {
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
    return inflight.get(k) as Promise<CachedServer | undefined>
  }
  if (hit && age < SERVER_STALE_MAX_MS) {
    refresh().catch(() => {})
    return hit
  }
  return withTimeout(refresh(), timeoutMs, 'listagem de tools MCP')
}
