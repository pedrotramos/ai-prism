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
//   The CSP is deliberately conservative: srcdoc iframes INHERIT the page's
//   policy, and the deck/DS previews need inline scripts (slide editor runtime,
//   imported design-system scripts), inline styles and fonts/images from any
//   host the customer's design system references. A script-src/style-src/
//   img-src/font-src restriction would break them; tightening needs those
//   frames on their own origin first (see SECURITY.md).
// - numeric ids: every :id/:messageId route reads a BIGINT key. A malformed id
//   used to reach Postgres and come back as a 500 with the raw driver message
//   ("invalid input syntax for type bigint"). Now the route is skipped and the
//   request ends in the usual 404.
// - final error handler: errors no route caught (malformed JSON, oversized
//   bodies, upload limits, anything thrown) answer with a generic JSON body; the
//   detail goes to the server log only. Express's default page carries the stack
//   trace whenever NODE_ENV isn't "production".
import { logger } from './log.js'

export const CONTENT_SECURITY_POLICY = [
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ')

export function securityHeaders() {
  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    next()
  }
}

const NUMERIC_ID = /^\d{1,18}$/

/** app.param callback: a non-numeric id skips the route, as if it never matched. */
export function numericIdParam(req, res, next, value) {
  if (NUMERIC_ID.test(String(value))) return next()
  next('route')
}

const MESSAGES = {
  400: { error: 'Requisição inválida.', code: 'bad_request' },
  411: { error: 'O corpo JSON precisa declarar o tamanho (Content-Length).', code: 'length_required' },
  413: { error: 'Arquivo ou corpo da requisição grande demais.', code: 'payload_too_large' },
  500: { error: 'Erro interno do servidor.', code: 'internal_error' },
}

function statusOf(err) {
  if (err?.name === 'MulterError') return err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
  const s = Number(err?.status || err?.statusCode)
  if (s === 413 || s === 411) return s
  if (s >= 400 && s < 500) return 400
  return 500
}

export function finalErrorHandler({ log = (msg) => logger.error(msg) } = {}) {
  // eslint-disable-next-line no-unused-vars
  return function finalErrorHandlerMiddleware(err, req, res, next) {
    // a streaming (SSE) response already started: only Express can end it
    if (res.headersSent) return next(err)
    const status = statusOf(err)
    log(`unhandled error on ${req.method || '?'} ${String(req.originalUrl || req.url || '?').split('?')[0]} -> ${status}: ${err?.message || err}`)
    res.status(status).json(MESSAGES[status])
  }
}
