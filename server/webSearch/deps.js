// Injection points of the web search backend (tests swap them; production uses
// the defaults). One shared object so the plan, the availability cache and the
// adapters all see the same clock and the same MCP/HTTP layer.
import { listMcpServerCached, callMcpTool } from '../mcpClient.js'

// a listing at call time / in a background probe may wait longer than the
// turn's 4 s hot-path bound: it is never on TTFT (design §Resolution)
const LIST_TIMEOUT_MS = 20_000

export function defaultDeps() {
  return {
    /** (url, token, cacheKey) → { tools, instructions } — cached per user + URL (mcpClient.js) */
    listServer: (url, token, key) => listMcpServerCached(url, token, key, { timeoutMs: LIST_TIMEOUT_MS }),
    /** (url, token, toolName, args, { timeoutMs, throwOnError, signal }) → { text, structuredContent } */
    callTool: (url, token, name, args, opts) => callMcpTool(url, token, name, args, opts),
    /** keyed adapters' HTTP layer; null = safeGet/safePost (server/web.js) */
    fetchImpl: null,
    /** clock of the availability cache (ms) */
    now: () => Date.now(),
  }
}

export const webSearchDeps = defaultDeps()

export function resetDeps() {
  Object.assign(webSearchDeps, defaultDeps())
}
