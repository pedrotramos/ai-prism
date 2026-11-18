// Request id + access log, mounted first by installMiddleware (and, header
// only, in front of AppKit's own routes: requestIdHeader).
//
// - Honours an incoming `x-request-id` (an edge proxy's or a client's), when it
//   is a sane token; otherwise mints a uuid. Either way it is set on the
//   response before anything else runs, so even an early 403/404 carries it.
// - Opens the log request context (server/log.js), so every log line written
//   while serving the request carries request_id, route and user_hash.
// - Writes one access line per /api request when the response finishes (and
//   for any 5xx elsewhere); a healthy /api/health probe is not logged.
import { randomUUID } from 'node:crypto'
import { log, runWithRequestContext, routeOf } from '../log.js'

const HEADER = 'x-request-id'
// letters, digits and . _ : - only, 1..128 chars: safe to echo in a header and a log
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/

export function incomingRequestId(value) {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' && SAFE_ID.test(v) ? v : null
}

function shouldLog(req, status) {
  if (status >= 500) return true
  const p = req.originalUrl || req.url || ''
  if (!p.startsWith('/api/')) return false
  return !(status < 400 && /^\/api\/health(?:\?|$)/.test(p))
}

// The id of this request: one an outer layer already chose (AppKit's, see
// requestIdHeader), else a safe incoming header, else a fresh uuid.
function resolveId(req) {
  return incomingRequestId(req.id) || incomingRequestId(req.headers[HEADER]) || randomUUID()
}

/**
 * Header only, for the AppKit server (server/appkit.js): AppKit answers its own
 * routes (/health, its body-parser errors) before our app runs, so this layer
 * goes in front of AppKit's stack and gives those responses the id too. It
 * writes no log line: our app's requestId() reuses the id (req.id) and logs.
 */
export function requestIdHeader() {
  return function requestIdHeaderMiddleware(req, res, next) {
    const id = resolveId(req)
    req.id = id
    res.setHeader(HEADER, id)
    next()
  }
}

export function requestId() {
  return function requestIdMiddleware(req, res, next) {
    const id = resolveId(req)
    req.id = id
    res.setHeader(HEADER, id)
    const started = process.hrtime.bigint()
    const ctx = { requestId: id, req }
    res.on('finish', () => {
      const status = res.statusCode
      if (!shouldLog(req, status)) return
      const duration = Number(process.hrtime.bigint() - started) / 1e6
      // req.route is set by now when a route matched (path pattern, no ids)
      runWithRequestContext(ctx, () =>
        log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request', {
          route: routeOf(req),
          status,
          duration_ms: Math.round(duration * 10) / 10,
        })
      )
    })
    runWithRequestContext(ctx, next)
  }
}
