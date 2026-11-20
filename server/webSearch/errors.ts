// The one error type of the web search backend. `message` is a FIXED,
// model-facing sentence (it becomes the tool result `ERROR: <message>`): it
// never carries the query or upstream text. The upstream error goes to
// `cause` and is never logged.

export const WEB_SEARCH_ERROR_CODES = ['unconfigured', 'unavailable', 'forbidden', 'timeout', 'quota', 'bad_response'] as const

export type WebSearchErrorCode = (typeof WEB_SEARCH_ERROR_CODES)[number]

// Tells the model what to do instead of inventing the number (design: "the
// model receives the estimate sentence").
const ESTIMATE =
  'Não invente o dado: responda sem ele ou sinalize claramente o número como estimativa não confirmada.'

const MESSAGES: Record<WebSearchErrorCode, string> = {
  unconfigured: 'A busca na web não está configurada para este usuário.',
  forbidden: 'A busca na web não está autorizada para este usuário (sem permissão ou serviço inexistente).',
  unavailable: 'A busca na web está indisponível no momento.',
  timeout: 'A busca na web excedeu o tempo limite.',
  quota: 'A cota da busca na web foi atingida.',
  bad_response: 'O provedor de busca respondeu num formato inesperado.',
}

export function webSearchMessage(code: string): string {
  // an unknown code falls back to `unavailable` at runtime
  return `${MESSAGES[code as WebSearchErrorCode] || MESSAGES.unavailable} ${ESTIMATE}`
}

export interface WebSearchErrorOpts {
  code?: string
  retryable?: boolean
  provider?: string | null
  cause?: unknown
  retryAfterMs?: number | null
  reason?: string
}

export class WebSearchError extends Error {
  // assigned in the constructor, as in the original .js (a plain field would be emitted and reorder own keys)
  declare code: WebSearchErrorCode
  declare retryable: boolean
  declare provider: string | null
  declare retryAfterMs?: number
  declare reason?: string

  /** @param message fixed model-facing sentence */
  constructor(message: string, { code, retryable, provider, cause, retryAfterMs, reason }: WebSearchErrorOpts = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'WebSearchError'
    this.code = (WEB_SEARCH_ERROR_CODES as readonly unknown[]).includes(code) ? (code as WebSearchErrorCode) : 'unavailable'
    this.retryable = retryable ?? ['unavailable', 'timeout', 'quota'].includes(this.code)
    this.provider = provider || null
    if (retryAfterMs != null) this.retryAfterMs = retryAfterMs
    if (reason) this.reason = reason
  }
}

/** A WebSearchError with the fixed message for `code`. */
export function webSearchError(code: string, extra: Omit<WebSearchErrorOpts, 'code'> = {}): WebSearchError {
  return new WebSearchError(webSearchMessage(code), { code, ...extra })
}

export function isAbort(e: unknown): boolean {
  return (e as { name?: unknown } | null | undefined)?.name === 'AbortError'
}
