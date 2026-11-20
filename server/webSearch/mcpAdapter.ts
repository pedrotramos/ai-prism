// Managed (`system.ai.web_search`) and external (WEB_SEARCH_MCP_SERVICE) MCP
// search, both through Unity Gateway at /ai-gateway/mcp-services/<name> with
// the USER's token (on-behalf-of): UC grants, gateway rate limits and audit
// apply per user; the provider key of an external service stays in its UC
// connection. Lists (cached per user) → identifies ONE search tool → builds
// the arguments → tools/call with throwOnError. The server's tool
// descriptions and instructions are read here only to pick the tool; nothing
// from them is returned (invariant 3).
import { externalMcpUrl } from '../externalMcp.ts'
import { webSearchDeps } from './deps.ts'
import type { WebSearchDeps } from './deps.ts'
import { webSearchError, WebSearchError, isAbort } from './errors.ts'
import { identifySearchTool, buildSearchArgs, normaliseMcpResult, MANAGED_WEB_SEARCH_SERVICE } from './mcpProviders.ts'
import type { WebSearchResult } from './mcpProviders.ts'
import type { Candidate } from './availability.ts'

export const DEFAULT_MCP_TIMEOUT_MS = 20_000

const defaultProvider = (candidate: Candidate): string => (candidate.service === MANAGED_WEB_SEARCH_SERVICE ? 'databricks' : 'mcp')

/** Upstream MCP error → WebSearchError with the design's code. */
export function classifyMcpError(e: unknown, provider: string): WebSearchError {
  if (e instanceof WebSearchError) return e
  const err = e as { message?: unknown; code?: unknown } | null | undefined
  const msg = String(err?.message || '')
  const code = err?.code
  let out: string
  if (code === -32007 || /-32007|not authorized to invoke|permission[_ ]denied/i.test(msg)) out = 'forbidden'
  else if (/tool not allowed by mcp service configuration/i.test(msg)) out = 'unconfigured'
  else if (code === 429 || /\b429\b|rate.?limit|too many requests|quota/i.test(msg)) out = 'quota'
  else if (code === 'timeout' || code === -32001 || /excedeu|timed? ?out|timeout/i.test(msg)) out = 'timeout'
  else if (code === 401 || code === 403 || /unauth|unauthenticated|\b40[13]\b|consent|login|authorize/i.test(msg)) {
    return webSearchError('forbidden', { provider, cause: e, reason: 'needs_login' })
  } else out = 'unavailable'
  return webSearchError(out, { provider, cause: e })
}

/** Lists the service and identifies its search tool. → { url, tool, provider }; throws WebSearchError. */
export async function identify({ token, email, candidate, deps = webSearchDeps }: { token: string; email: string; candidate: Candidate; deps?: WebSearchDeps }): Promise<{ url: string; tool: { name: string; inputSchema?: unknown }; provider: string }> {
  const url = externalMcpUrl(candidate.service)
  let server
  try {
    server = await deps.listServer(url, token, email)
  } catch (e) {
    if (isAbort(e)) throw e
    throw classifyMcpError(e, defaultProvider(candidate))
  }
  const found = identifySearchTool(server?.tools, { service: candidate.service, pinned: candidate.tool })
  if (!found) throw webSearchError('unconfigured', { provider: defaultProvider(candidate), reason: 'no_search_tool' })
  return { url, tool: found.tool, provider: found.provider }
}

export async function search(
  query: string,
  { limit = 5, signal = null, token, email, candidate, deps = webSearchDeps, timeoutMs = DEFAULT_MCP_TIMEOUT_MS }: { limit?: number; signal?: AbortSignal | null; token: string; email: string; candidate: Candidate; deps?: WebSearchDeps; timeoutMs?: number } = {} as { token: string; email: string; candidate: Candidate } // typed cast: the .js default is `= {}` (keeps search.length === 1)
): Promise<WebSearchResult> {
  const { url, tool, provider } = await identify({ token, email, candidate, deps })
  const args = buildSearchArgs(tool.inputSchema, query, limit)
  let raw
  try {
    raw = await deps.callTool(url, token, tool.name, args, { timeoutMs, throwOnError: true, signal })
  } catch (e) {
    if (isAbort(e)) throw e
    throw classifyMcpError(e, provider)
  }
  const result = normaliseMcpResult(raw, { provider, query })
  return Object.defineProperty(result, 'tool', { value: tool.name, enumerable: false })
}
