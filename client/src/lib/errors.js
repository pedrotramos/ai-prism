// Friendly error copy for backend and network failures.
//
// The server relays raw messages (`res.status(500).json({ error: e.message })`)
// and api.js throws `new Error(body.error || 'HTTP <status>')`, so what reaches
// the UI can be a Postgres error, a gateway status line or a stack-ish string.
// Showing that verbatim is confusing and can leak internals (a workspace URL, a
// table name). classifyError() turns it into one of a few kinds the UI has copy
// for; the raw text stays available as `detail`, shown only behind "Details".
//
// Pure (no React, no DOM): unit-tested in errors.test.js.

const MAX_DETAIL = 2000

// first match wins; ordered from the most specific signal to the vaguest
const TEXT_RULES = [
  // the browser could not reach our own server (offline, VPN, proxy reset)
  ['network', /^(Failed to fetch|Load failed)$|NetworkError when attempting|ERR_NETWORK|ERR_INTERNET_DISCONNECTED/i],
  // the server could not reach a dependency (gateway, workspace, Lakebase)
  ['unavailable', /Failed to parse URL|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|temporarily unavailable|overloaded|Service Unavailable/i],
  ['rateLimited', /rate.?limit|too many requests|REQUEST_LIMIT_EXCEEDED/i],
  ['unauthorized', /unauthori[sz]ed|invalid token|token (has )?expired|expired token|not authenticated/i],
  ['forbidden', /forbidden|permission denied|PERMISSION_DENIED|not allowed/i],
  ['tooLarge', /too large|LIMIT_FILE_SIZE|request entity/i],
  ['timeout', /timed? ?out|timeout|ETIMEDOUT|deadline exceeded/i],
  // a session id Postgres cannot parse is a URL that points at nothing
  ['notFound', /not found|invalid input syntax for type (bigint|integer|uuid)/i],
  // database and runtime internals: never worth showing as the message
  ['server', /relation "[^"]*" does not exist|column "[^"]*"|syntax error at|violates .* constraint|duplicate key|(Type|Reference|Range)Error|Cannot read propert|is not a function|is not defined|\bat \S+ \(\S+:\d+/i],
]

const STATUS_KIND = { 401: 'unauthorized', 403: 'forbidden', 404: 'notFound', 408: 'timeout', 413: 'tooLarge', 429: 'rateLimited', 502: 'unavailable', 503: 'unavailable', 504: 'timeout' }

function rawText(input) {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (typeof input.message === 'string') return input.message
  if (typeof input.error === 'string') return input.error
  return String(input)
}

function statusOf(input, text) {
  const s = Number(input?.status)
  if (Number.isInteger(s) && s >= 400 && s < 600) return s
  const m = text.match(/\bHTTP (\d{3})\b/i) || text.match(/\breturned (\d{3})\b/i) || text.match(/\bstatus(?: code)?:? (\d{3})\b/i)
  return m ? Number(m[1]) : null
}

/**
 * @param {unknown} input an Error, a string, or `{ error }` from a JSON body
 * @returns {{ kind: string, status: number|null, detail: string }}
 *   kind: network | unavailable | rateLimited | unauthorized | forbidden |
 *         tooLarge | timeout | notFound | server | aborted | unknown
 */
export function classifyError(input) {
  const text = rawText(input).trim()
  const detail = text.slice(0, MAX_DETAIL)
  if (input?.name === 'AbortError') return { kind: 'aborted', status: null, detail }
  const status = statusOf(input, text)
  if (status && STATUS_KIND[status]) return { kind: STATUS_KIND[status], status, detail }
  for (const [kind, re] of TEXT_RULES) if (re.test(text)) return { kind, status, detail }
  if (status && status >= 500) return { kind: 'server', status, detail }
  return { kind: 'unknown', status, detail }
}

/**
 * Localized copy for an error: `message` is the friendly sentence
 * (`appError.<kind>` in the common catalog), `detail` the raw text for the
 * "Details" disclosure ('' when it would only repeat the message).
 */
export function friendlyError(t, input) {
  const { kind, detail } = classifyError(input)
  const message = t(`appError.${kind}`)
  return { kind, message, detail: detail && detail !== message ? detail : '' }
}

/**
 * For toasts fed by callers that may already pass human copy (the studios call
 * `pushToast(e.message || t('docStudio.saveError'))`): text that matches no
 * known failure is kept as written; everything else gets the friendly copy.
 */
export function userFacingError(t, input) {
  const { kind, detail } = classifyError(input)
  if (kind === 'unknown' && detail) return { kind, message: detail, detail: '' }
  return friendlyError(t, input)
}
