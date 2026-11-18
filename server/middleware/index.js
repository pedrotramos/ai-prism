// App-level middleware and the pieces the route modules share.
//
// installMiddleware(app) installs, in this order: request id (placeholder),
// security headers, security (Permissions-Policy, report-only CSP and the
// /api/csp-report endpoint), the CSRF guard on /api, the per-user rate limit,
// the numeric :id/:messageId param check, then JSON body parsing with per-route
// limits. The CSRF guard must stay before any body parser (a cross-site write is
// refused before its body is read) and before the rate limit (a cross-site page
// can't drain a victim's budget). /api/csp-report is answered before the CSRF
// guard: sandboxed preview frames report with `Origin: null`.
import multer from 'multer'
import { securityHeaders, numericIdParam, finalErrorHandler } from '../securityHeaders.js'
import { csrfGuard } from '../csrfGuard.js'
import { requestId } from './requestId.js'
import { security, jsonBodyParser } from './security.js'
import { rateLimit } from './rateLimit.js'

export { auth } from './auth.js'
export { requireAdmin } from './requireAdmin.js'
export { ensureReady } from './ensureReady.js'
export { finalErrorHandler }

export function installMiddleware(app) {
  app.disable('x-powered-by')
  app.use(requestId())
  app.use(securityHeaders())
  app.use(security())
  // state-changing /api calls from another site are refused before any parsing
  app.use('/api', csrfGuard())
  // per-user token buckets (RATE_LIMIT_API_PER_MIN / RATE_LIMIT_TURNS_PER_MIN)
  app.use(rateLimit())
  // every :id / :messageId is a BIGINT key: anything else skips the route (404)
  app.param(['id', 'messageId'], numericIdParam)
  // JSON body limit per route class (JSON_ROUTE_LIMITS in security.js: 1mb by
  // default, larger only for the design-system import, the deck studio's
  // media-heavy writes and the workbook save). Under the AppKit boot AppKit's
  // own express.json has already read the body; the limit is still enforced.
  app.use(jsonBodyParser())
}

export const upload = multer({
  storage: multer.memoryStorage(),
  // Brand .pptx decks are routinely large (embedded imagery/fonts); the real
  // "adjust this presentation" use case needs headroom well past 25MB.
  limits: { fileSize: 80 * 1024 * 1024, files: 10 },
})

// Skills accept a SKILL.md or a small .zip/.skill bundle around one: one file,
// 5 MB, instead of the chat's 80 MB / 10 files.
export const skillUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
})

// multer/busboy exposes the multipart filename as a latin1-decoded string, so
// UTF-8 names get mangled (e.g. "ção" -> "cÌ§aÌ o"). Re-decode as UTF-8 and
// compose to NFC (macOS sends decomposed accents).
export function fixFilename(name) {
  try {
    return Buffer.from(name, 'latin1').toString('utf8').normalize('NFC')
  } catch {
    return name
  }
}
