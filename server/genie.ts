// Genie Spaces as tools: the model asks a Genie space a natural-language
// question, Genie plans/runs the SQL itself and answers in natural language —
// same on-behalf-of pattern as everything else (the user's own OAuth token,
// so only spaces they can actually see are ever listed or queried).
import { callMcpTool } from './mcpClient.ts'

type Env = Record<string, string | undefined>
type GenieProgress = { elapsedMs: number; status: string }
type OnProgress = ((p: GenieProgress) => void) | undefined
// A plain result row: column name -> string cell (or null).
type QueryRow = Record<string, string | null>
interface GenieResult {
  conversationId: string
  resultText: string
  queryRows: QueryRow[]
}
// Only the response fields this module reads are declared.
interface GenieSpace {
  space_id: string
  title?: string
  description?: string
}
interface TypedValue {
  str?: string | null
  NULL?: unknown
}
interface StatementResponse {
  manifest?: { schema?: { columns?: { name: string }[] } }
  result?: { data_typed_array?: { values?: (TypedValue | null | undefined)[] }[] }
}
// structuredContent of Genie One's genie_ask / genie_poll_response tools.
interface GenieOneState {
  status?: string
  conversation_id: string
  response_id?: string
}
interface GenieApiResponse {
  message?: string
  error?: string
  spaces?: GenieSpace[]
  next_page_token?: string | null
  conversation_id?: string
  message_id?: string
  status?: string
  attachments?: { text?: { content?: string }; query?: { query?: string } }[]
  statement_response?: StatementResponse
}

function host(env: Env = process.env): string {
  let h = env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

async function apiFetch(path: string, opts: RequestInit, token: string): Promise<GenieApiResponse> {
  const res = await fetch(`${host()}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts?.headers || {}),
    },
  })
  const json: GenieApiResponse = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.message || json?.error || `HTTP ${res.status}`
    throw new Error(`Genie API: ${msg}`)
  }
  return json
}

// Full space listing has no server-side text filter, so we page through it
// once per user and cache briefly, then filter in-process. Capped generously
// above what any real single-team workspace would have — this specific dev
// workspace happens to be an enormous shared multi-tenant sandbox with
// thousands of demo spaces, which isn't representative of production usage.
const SPACES_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_PAGES = 15
const spacesCache = new Map<string, { ts: number; spaces: GenieSpace[] }>() // userEmail -> { ts, spaces }

async function listAllSpaces(token: string): Promise<GenieSpace[]> {
  const spaces: GenieSpace[] = []
  let pageToken: string | null | undefined = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) })
    const json = await apiFetch(`/api/2.0/genie/spaces?${qs}`, { method: 'GET' }, token)
    spaces.push(...(json.spaces || []))
    pageToken = json.next_page_token
    if (!pageToken) break
  }
  return spaces
}

export async function searchGenieSpaces(
  token: string,
  userEmail: string,
  query: string | null | undefined,
  limit = 20
): Promise<{ kind: 'genie'; spaceId: string; title: string | undefined; description: string }[]> {
  let cached = spacesCache.get(userEmail)
  if (!cached || Date.now() - cached.ts > SPACES_CACHE_TTL_MS) {
    cached = { ts: Date.now(), spaces: await listAllSpaces(token) }
    spacesCache.set(userEmail, cached)
  }
  const q = (query || '').trim().toLowerCase()
  const matches = q
    ? cached.spaces.filter(
        (s) => s.title?.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q)
      )
    : cached.spaces
  return matches.slice(0, limit).map((s) => ({
    kind: 'genie',
    spaceId: s.space_id,
    title: s.title,
    description: s.description || '',
  }))
}

const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'QUERY_RESULT_EXPIRED'])

// A generous ceiling so a legitimately slow Genie query (large warehouse, cold
// start, complex plan) isn't cut off mid-flight — NOT a latency target. It only
// exists so a wedged request can't block the turn forever. The live progress
// events (onProgress → tool_progress SSE) keep the wait from feeling stuck.
const GENIE_DEADLINE_MS = 5 * 60 * 1000

async function pollMessage(
  token: string,
  spaceId: string,
  conversationId: string,
  messageId: string,
  deadlineMs: number,
  onProgress: OnProgress
): Promise<GenieApiResponse> {
  const startedAt = Date.now()
  while (Date.now() < deadlineMs) {
    const msg = await apiFetch(
      `/api/2.0/genie/spaces/${spaceId}/conversations/${conversationId}/messages/${messageId}`,
      { method: 'GET' },
      token
    )
    if (msg.status && TERMINAL_STATES.has(msg.status)) return msg
    // report elapsed time + Genie's own coarse status so the chip shows live
    // progress instead of a silent spinner — doesn't speed anything up, but the
    // wait (up to 90s of blocking poll) stops feeling stuck.
    onProgress?.({ elapsedMs: Date.now() - startedAt, status: msg.status as string })
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('Genie demorou demais para responder.')
}

// Parses the PROTOBUF_ARRAY-shaped statement response the query-result
// endpoint returns (distinct from the JSON_ARRAY shape the plain SQL
// Statement Execution API uses) into a compact markdown table.
// maxRows is a runaway backstop only (a query returning tens of thousands of
// rows shouldn't dump all of them into the prompt), set generously so it never
// truncates a legitimate result — NOT a quality limit. The full rows also live
// in queryRows → chart candidates. Speed comes from prompt caching, not from
// shrinking tool outputs.
function formatQueryResultTable(statementResponse: StatementResponse | undefined, maxRows = 500): string | null {
  const cols = (statementResponse?.manifest?.schema?.columns || []).map((c) => c.name)
  const rows = statementResponse?.result?.data_typed_array || []
  if (!cols.length || !rows.length) return null
  const header = `| ${cols.join(' | ')} |`
  const sep = `| ${cols.map(() => '---').join(' | ')} |`
  const body = rows
    .slice(0, maxRows)
    .map((r) => `| ${(r.values || []).map((v) => (v?.str ?? (v?.NULL ? '' : ''))).join(' | ')} |`)
    .join('\n')
  const truncated = rows.length > maxRows ? `\n_(mostrando ${maxRows} de ${rows.length} linhas)_` : ''
  return `${header}\n${sep}\n${body}${truncated}`
}

// Same PROTOBUF_ARRAY payload as formatQueryResultTable, but kept as an array
// of plain row objects (not markdown) so the caller can turn it into real
// chart candidates via analysis.js's chartCandidatesFromRows.
function parseQueryResultRows(statementResponse: StatementResponse | undefined, maxRows = 2000): QueryRow[] {
  const cols = (statementResponse?.manifest?.schema?.columns || []).map((c) => c.name)
  const rawRows = statementResponse?.result?.data_typed_array || []
  if (!cols.length || !rawRows.length) return []
  return rawRows.slice(0, maxRows).map((r) => {
    const obj: QueryRow = {}
    const values = r.values || []
    cols.forEach((name, i) => {
      const v = values[i]
      obj[name] = v?.NULL || v?.str == null ? null : v.str
    })
    return obj
  })
}

/**
 * Asks a Genie space a question, continuing `conversationId` if given (so
 * follow-ups keep Genie's own context) or starting a fresh conversation.
 * Returns { conversationId, resultText, queryRows } — resultText is Genie's
 * narrative answer plus, when it ran a query, the SQL and a compact result
 * table; queryRows is the same query result as plain row objects (or []),
 * for the caller to turn into real chart candidates.
 */
export async function askGenie(
  token: string,
  spaceId: string,
  question: string,
  conversationId?: string | null,
  onProgress?: OnProgress
): Promise<GenieResult> {
  // The API always returns the ids on success; a missing one is not handled
  // separately (it never was), hence the casts below.
  let convId = conversationId as string
  let messageId: string
  if (!convId) {
    const started = await apiFetch(
      `/api/2.0/genie/spaces/${spaceId}/start-conversation`,
      { method: 'POST', body: JSON.stringify({ content: question }) },
      token
    )
    convId = started.conversation_id as string
    messageId = started.message_id as string
  } else {
    const sent = await apiFetch(
      `/api/2.0/genie/spaces/${spaceId}/conversations/${convId}/messages`,
      { method: 'POST', body: JSON.stringify({ content: question }) },
      token
    )
    messageId = sent.message_id as string
  }

  const msg = await pollMessage(token, spaceId, convId, messageId, Date.now() + GENIE_DEADLINE_MS, onProgress)
  if (msg.status !== 'COMPLETED') {
    throw new Error(`Genie não conseguiu responder (status: ${msg.status}).`)
  }

  const texts: string[] = []
  let query: { query?: string } | null = null
  for (const a of msg.attachments || []) {
    if (a.text?.content) texts.push(a.text.content)
    if (a.query) query = a.query
  }
  let resultText = texts.join('\n\n') || '(Genie não retornou uma resposta em texto.)'
  let queryRows: QueryRow[] = []

  if (query) {
    resultText += `\n\nSQL executado pelo Genie:\n\`\`\`sql\n${query.query}\n\`\`\``
    try {
      const qr = await apiFetch(
        `/api/2.0/genie/spaces/${spaceId}/conversations/${convId}/messages/${messageId}/query-result`,
        { method: 'GET' },
        token
      )
      const table = formatQueryResultTable(qr.statement_response)
      if (table) resultText += `\n\nResultado:\n${table}`
      queryRows = parseQueryResultRows(qr.statement_response)
    } catch {
      // narrative answer + SQL is still useful even if the result table fetch fails
    }
  }

  return { conversationId: convId, resultText, queryRows }
}

// Genie One is the Databricks-provided MCP service `system.ai.genie_one_mcp`,
// served by the Unity AI Gateway (the Beta endpoint /api/2.0/mcp/genie is
// deprecated with end of life on 2026-11-30). Calling it on behalf of the user
// needs the `ai-gateway` OAuth scope (already in databricks.yml) and EXECUTE on
// the service. Tool names and arguments are the same on both endpoints.
export const GENIE_ONE_MCP_SERVICE = 'system.ai.genie_one_mcp'

// Workspace id for the `?o=` query param: the Apps runtime sets
// DATABRICKS_WORKSPACE_ID; the gateway also answers without it.
function genieOneWorkspaceId(env: Env = process.env): string | null {
  const id = String(env.DATABRICKS_WORKSPACE_ID || '').trim()
  return /^\d+$/.test(id) ? id : null
}

// GENIE_ONE_MCP_URL replaces the whole URL — the way to point back at the Beta
// endpoint `<host>/api/2.0/mcp/genie` (`genie` scope) until it is switched off.
export function genieOneUrl(env: Env = process.env): string {
  const override = String(env.GENIE_ONE_MCP_URL || '').trim()
  if (override) return override
  const id = genieOneWorkspaceId(env)
  return `${host(env)}/ai-gateway/mcp-services/${GENIE_ONE_MCP_SERVICE}${id ? `?o=${id}` : ''}`
}

// Splits one markdown table row into trimmed cells, tolerating the optional
// leading/trailing pipes GFM allows. Escaped pipes (\|) inside a cell are kept.
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))
}

// A markdown separator row: | --- | :--: | --- | (dashes, optional colons).
const MD_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

// Genie One answers only in markdown (its managed MCP exposes no query-result
// endpoint, unlike per-space Genie). When it runs a query the result is a
// GFM table embedded in that markdown — this pulls the LARGEST such table back
// into plain row objects (same shape parseQueryResultRows produces for Genie
// Spaces) so the caller can build real chart candidates from it. Cells stay
// strings; analysis.js does the numeric/date inference, exactly as it does for
// the per-space Genie rows. Returns [] when there's no ≥2-data-row table.
export function parseMarkdownTableRows(markdown: unknown, maxRows = 2000): QueryRow[] {
  if (typeof markdown !== 'string' || !markdown.includes('|')) return []
  const lines = markdown.split('\n')
  let best: QueryRow[] = []
  let i = 0
  while (i < lines.length) {
    // a table is a header line, a separator line, then ≥1 body lines
    if ((lines[i] as string).includes('|') && i + 1 < lines.length && MD_SEPARATOR_RE.test(lines[i + 1] as string)) {
      const headers = splitTableRow(lines[i] as string)
      const sep = splitTableRow(lines[i + 1] as string)
      // header and separator must have matching column counts to be a real table
      if (headers.length >= 2 && headers.length === sep.length) {
        const rows: QueryRow[] = []
        let j = i + 2
        while (j < lines.length && (lines[j] as string).includes('|') && !MD_SEPARATOR_RE.test(lines[j] as string)) {
          const cells = splitTableRow(lines[j] as string)
          // stop at a line that clearly isn't part of the grid (prose)
          if (cells.length < 2) break
          const obj: QueryRow = {}
          headers.forEach((name, k) => {
            const key = name || `col${k + 1}`
            obj[key] = cells[k] === undefined || cells[k] === '' ? null : cells[k]
          })
          rows.push(obj)
          if (rows.length >= maxRows) break
          j++
        }
        if (rows.length > best.length) best = rows
        i = j
        continue
      }
    }
    i++
  }
  return best.length >= 2 ? best : []
}

/**
 * Genie One: the workspace-wide managed MCP tool, spanning every Genie Space
 * and Unity Catalog asset the user can see — unlike askGenie() above, which
 * is scoped to one specific space. Genie's own MCP tools are ask-then-poll
 * (`genie_ask` returns immediately with `status: in_progress`; `genie_poll_
 * response` must be called repeatedly until a terminal status), so the
 * polling happens here, server-side, rather than spending the calling
 * model's own tool-call rounds on poll spam — from the tool loop's
 * perspective this is one call that blocks until Genie is done, same as
 * askGenie()'s own internal polling. The final markdown already carries its
 * own "Explore in Databricks" deep link and formatting instructions for
 * whichever model reads it next. Unlike per-space Genie, this managed MCP's
 * tool list exposes no query-result endpoint, so when Genie One runs a query
 * the tabular result comes back only as a markdown table inside `resultText` —
 * parseMarkdownTableRows recovers it into `queryRows` (same shape per-space
 * Genie yields) so the caller can build real chart candidates from it too.
 * Returns { conversationId, resultText, queryRows }.
 */
export async function askGenieOne(
  token: string,
  question: string,
  conversationId?: string | null,
  onProgress?: OnProgress
): Promise<GenieResult> {
  const url = genieOneUrl()
  const asked = await callMcpTool(url, token, 'genie_ask', {
    question,
    ...(conversationId ? { conversation_id: conversationId } : {}),
  })
  let state = asked.structuredContent as GenieOneState | null
  if (!state) throw new Error(asked.text || 'Genie One não respondeu.')

  let resultText = asked.text
  if (state.status === 'in_progress') {
    const startedAt = Date.now()
    const deadline = Date.now() + GENIE_DEADLINE_MS
    while (state.status === 'in_progress' && Date.now() < deadline) {
      onProgress?.({ elapsedMs: Date.now() - startedAt, status: state.status })
      await new Promise((r) => setTimeout(r, 3000))
      const polled = await callMcpTool(url, token, 'genie_poll_response', {
        conversation_id: state.conversation_id,
        response_id: state.response_id,
      })
      if (!polled.structuredContent) throw new Error(polled.text || 'Genie One não respondeu.')
      state = polled.structuredContent as unknown as GenieOneState // SDK type is Record<string, unknown>
      resultText = polled.text
    }
    if (state.status === 'in_progress') {
      throw new Error('Genie One demorou demais para responder.')
    }
  }

  return { conversationId: state.conversation_id, resultText, queryRows: parseMarkdownTableRows(resultText) }
}
