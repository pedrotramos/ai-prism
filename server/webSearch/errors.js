// The one error type of the web search backend. `message` is a FIXED,
// model-facing sentence (it becomes the tool result `ERROR: <message>`): it
// never carries the query or upstream text. The upstream error goes to
// `cause` and is never logged.

export const WEB_SEARCH_ERROR_CODES = ['unconfigured', 'unavailable', 'forbidden', 'timeout', 'quota', 'bad_response']

// Tells the model what to do instead of inventing the number (design: "the
// model receives the estimate sentence").
const ESTIMATE =
  'Não invente o dado: responda sem ele ou sinalize claramente o número como estimativa não confirmada.'

const MESSAGES = {
  unconfigured: 'A busca na web não está configurada para este usuário.',
  forbidden: 'A busca na web não está autorizada para este usuário (sem permissão ou serviço inexistente).',
  unavailable: 'A busca na web está indisponível no momento.',
  timeout: 'A busca na web excedeu o tempo limite.',
  quota: 'A cota da busca na web foi atingida.',
  bad_response: 'O provedor de busca respondeu num formato inesperado.',
}

export function webSearchMessage(code) {
  return `${MESSAGES[code] || MESSAGES.unavailable} ${ESTIMATE}`
}

export class WebSearchError extends Error {
  /**
   * @param {string} message fixed model-facing sentence
   * @param {{ code: string, retryable?: boolean, provider?: string, cause?: unknown, retryAfterMs?: number, reason?: string }} opts
   */
  constructor(message, { code, retryable, provider, cause, retryAfterMs, reason } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'WebSearchError'
    this.code = WEB_SEARCH_ERROR_CODES.includes(code) ? code : 'unavailable'
    this.retryable = retryable ?? ['unavailable', 'timeout', 'quota'].includes(this.code)
    this.provider = provider || null
    if (retryAfterMs != null) this.retryAfterMs = retryAfterMs
    if (reason) this.reason = reason
  }
}

/** A WebSearchError with the fixed message for `code`. */
export function webSearchError(code, extra = {}) {
  return new WebSearchError(webSearchMessage(code), { code, ...extra })
}

export function isAbort(e) {
  return e?.name === 'AbortError'
}
