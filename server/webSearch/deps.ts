// Injection points of the web search backend (tests swap them; production uses
// the defaults). One shared object so the plan, the availability cache and the
// adapters all see the same clock and the same MCP/HTTP layer.
import { listMcpServerCached, callMcpTool } from '../mcpClient.ts'

// a listing at call time / in a background probe may wait longer than the
// turn's 4 s hot-path bound: it is never on TTFT (design §Resolution)
const LIST_TIMEOUT_MS = 20_000

type ListServer = typeof listMcpServerCached
type CallTool = typeof callMcpTool
type FetchImpl = (url: string, opts: { method: string; headers: Record<string, string>; body: string | null; timeoutMs?: number; signal: AbortSignal | null }) => Promise<{ status: number; headers?: Record<string, unknown>; body?: unknown }>

export interface WebSearchDeps {
  listServer: ListServer
  callTool: CallTool
  fetchImpl: FetchImpl | null
  now: () => number
}

export function defaultDeps(): WebSearchDeps {
  return {
    /** (url, token, cacheKey) → { tools, instructions } — cached per user + URL (mcpClient.js) */
    listServer: (url: string, token: string, key: string) => listMcpServerCached(url, token, key, { timeoutMs: LIST_TIMEOUT_MS }),
    /** (url, token, toolName, args, { timeoutMs, throwOnError, signal }) → { text, structuredContent } */
    callTool: (url: string, token: string, name: string, args?: Record<string, unknown> | null, opts?: Parameters<CallTool>[4]) => callMcpTool(url, token, name, args, opts),
    /** keyed adapters' HTTP layer; null = safeGet/safePost (server/web.js) */
    fetchImpl: null,
    /** clock (ms) of the availability cache and of the chain walk's deadline */
    now: () => Date.now(),
  }
}

export const webSearchDeps: WebSearchDeps = defaultDeps()

export function resetDeps(): void {
  Object.assign(webSearchDeps, defaultDeps())
}
