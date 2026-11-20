// Vendor detection and the schema-driven mapping for MCP search tools (design
// §External MCP). Data, not one parser per vendor: a new vendor is one row.
// Invariant 1: exactly ONE tool is ever called — the pinned one, else a known
// search tool name, else a name matching web[_-]?search. Never "the first tool".
// Invariant 2: only the query and the limit reach the server.
import { webSearchError } from './errors.ts'

export interface SearchResultItem {
  title: string
  url: string
  snippet: string
  publishedAt?: string
}

interface ResultsResult {
  kind: 'results'
  provider: string
  query: string
  results: SearchResultItem[]
}
interface AnswerResult {
  kind: 'answer'
  provider: string
  query: string
  answer: string
  sources: { url: string; title?: string }[]
}
/** `tool` is a non-enumerable property set by the MCP adapter. */
export type WebSearchResult = (ResultsResult | AnswerResult) & { tool?: string }

interface ProviderRow {
  id: string
  toolNames: string[]
}
interface McpTool {
  name: string
  inputSchema?: unknown
}
type Json = any // upstream MCP payloads are untrusted and walked defensively

export const MANAGED_WEB_SEARCH_SERVICE = 'system.ai.web_search'

export const MCP_SEARCH_PROVIDERS: ProviderRow[] = [
  // managed: the tool name is not documented, so identification falls back to the pattern
  { id: 'databricks', toolNames: ['web_search'] },
  { id: 'firecrawl-mcp', toolNames: ['firecrawl_search'] },
  { id: 'you-mcp', toolNames: ['you-search'] },
  { id: 'tavily-mcp', toolNames: ['tavily-search', 'tavily_search'] },
  { id: 'exa-mcp', toolNames: ['web_search_exa'] },
  { id: 'brave-mcp', toolNames: ['brave_web_search'] },
  { id: 'mcp', toolNames: [] }, // generic: pinned tool or pattern match
]

const SEARCH_PATTERN = /web[_-]?search/i
const VENDORS = MCP_SEARCH_PROVIDERS.filter((p) => p.id !== 'databricks' && p.id !== 'mcp')

function providerOfName(name: string, service: string | undefined): string {
  if (service === MANAGED_WEB_SEARCH_SERVICE) return 'databricks'
  return VENDORS.find((p) => p.toolNames.includes(name))?.id || 'mcp'
}

/** → { tool, provider } or null (→ `unconfigured`). */
export function identifySearchTool(tools: unknown, { service, pinned }: { service?: string; pinned?: string } = {}): { tool: McpTool; provider: string } | null {
  const list: McpTool[] = Array.isArray(tools) ? tools.filter((t) => t && typeof t.name === 'string') : []
  if (pinned) {
    const tool = list.find((t) => t.name === pinned)
    return tool ? { tool, provider: providerOfName(tool.name, service) } : null
  }
  if (service !== MANAGED_WEB_SEARCH_SERVICE) {
    for (const p of VENDORS) {
      const tool = list.find((t) => p.toolNames.includes(t.name))
      if (tool) return { tool, provider: p.id }
    }
  }
  const tool = list.find((t) => t.name === 'web_search') || list.find((t) => SEARCH_PATTERN.test(t.name))
  return tool ? { tool, provider: providerOfName(tool.name, service) } : null
}

const QUERY_KEYS = ['query', 'q', 'search_query', 'text']
const LIMIT_KEYS = ['limit', 'count', 'max_results', 'num_results', 'numResults']

/** Arguments for the search tool from its own inputSchema: the query and the limit, nothing else. */
export function buildSearchArgs(inputSchema: Json, query: unknown, limit: unknown): Record<string, unknown> {
  const props: Json = inputSchema && typeof inputSchema.properties === 'object' && inputSchema.properties ? inputSchema.properties : {}
  const has = (k: string) => Object.prototype.hasOwnProperty.call(props, k)
  let qKey = QUERY_KEYS.find(has)
  if (!qKey) {
    const required = Array.isArray(inputSchema?.required) ? inputSchema.required : []
    const strings = required.filter((k: string) => props[k]?.type === 'string')
    qKey = strings.length === 1 ? strings[0] : 'query'
  }
  const args: Record<string, unknown> = { [qKey as string]: String(query ?? '') } // qKey is always set by here (typed cast)
  const lKey = LIMIT_KEYS.find(has)
  if (lKey && limit != null) args[lKey] = clampLimit(limit)
  return args
}

export function clampLimit(limit: unknown): number {
  return Math.max(1, Math.min(Math.trunc(Number(limit)) || 5, 10))
}

// ---- normalisation ---------------------------------------------------------------
const URL_KEYS = ['url', 'link', 'href']
const TITLE_KEYS = ['title', 'name', 'heading']
const SNIPPET_KEYS = ['description', 'snippet', 'content', 'text', 'excerpt']
const DATE_KEYS = ['publishedAt', 'published_date', 'publishedDate', 'date', 'page_age', 'age']
const LIST_KEYS = new Set(['web', 'results', 'items', 'data', 'organic', 'news', 'hits'])
const EMPTY_TEXTS = new Set(['', '(sem conteúdo retornado)'])

const firstString = (o: Json, keys: string[]): string => {
  for (const k of keys) if (typeof o?.[k] === 'string' && o[k].trim()) return o[k].trim()
  return ''
}
const isResultObject = (o: Json): boolean => o && typeof o === 'object' && !Array.isArray(o) && URL_KEYS.some((k) => typeof o[k] === 'string')

// The first array of result-like objects within three levels (breadth first),
// or an empty array under a well-known list key.
function findResultList(root: unknown): Json[] | null {
  let level: { node: unknown; key: string | null }[] = [{ node: root, key: null }]
  for (let depth = 0; depth <= 3 && level.length; depth++) {
    const next: { node: unknown; key: string | null }[] = []
    for (const { node, key } of level) {
      if (Array.isArray(node)) {
        if (node.some(isResultObject)) return node.filter(isResultObject)
        if (!node.length && LIST_KEYS.has(key as string)) return [] // key is null only at the root, which `has` rejects
        continue
      }
      if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) next.push({ node: v, key: k })
    }
    level = next
  }
  return null
}

function mapResult(o: Json): SearchResultItem {
  const r: SearchResultItem = { title: firstString(o, TITLE_KEYS), url: firstString(o, URL_KEYS), snippet: firstString(o, SNIPPET_KEYS) }
  const date = firstString(o, DATE_KEYS)
  if (date) r.publishedAt = date
  return r
}

const URL_RE = /https?:\/\/[^\s<>"'()[\]{}]+/g
function urlsIn(text: unknown): string[] {
  const out: string[] = []
  for (const m of String(text).matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, '')
    if (!out.includes(url)) out.push(url)
    if (out.length >= 10) break
  }
  return out
}

/** MCP tool output → WebSearchResult. Throws `bad_response` for an empty answer. */
export function normaliseMcpResult(raw: Json, { provider, query }: { provider: string; query: string }): WebSearchResult {
  const text = typeof raw?.text === 'string' ? raw.text.trim() : ''
  if (raw?.structuredContent && typeof raw.structuredContent === 'object') {
    const list = findResultList(raw.structuredContent)
    if (list) return { kind: 'results', provider, query, results: list.map(mapResult) }
  }
  if (/^[[{]/.test(text)) {
    try {
      const list = findResultList(JSON.parse(text))
      if (list) return { kind: 'results', provider, query, results: list.map(mapResult) }
    } catch {
      // not JSON: an answer in prose
    }
  }
  if (EMPTY_TEXTS.has(text)) throw webSearchError('bad_response', { provider })
  return { kind: 'answer', provider, query, answer: text, sources: urlsIn(text).map((url) => ({ url })) }
}
