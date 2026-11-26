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
// @ts-expect-error multer ships no types and @types/multer is not a dependency; the import stays untyped
import multer from 'multer'
import type { Express } from 'express'
import { securityHeaders, numericIdParam, finalErrorHandler } from '../securityHeaders.ts'
import { csrfGuard } from '../csrfGuard.ts'
import { requestId } from './requestId.ts'
import { security, jsonBodyParser } from './security.ts'
import { rateLimit } from './rateLimit.ts'
import { warnRejectedEnvOrigins } from '../egressSetting.ts'

export { auth } from './auth.ts'
export { requireAdmin } from './requireAdmin.ts'
export { ensureReady } from './ensureReady.ts'
export { finalErrorHandler }

export function installMiddleware(app: Express): void {
  app.disable('x-powered-by')
  app.use(requestId())
  // the egress CSP reads the admin allowlist synchronously (never awaiting the database); the first response starts its
  // background read, so boot makes no database call of its own
  warnRejectedEnvOrigins()
  app.use(securityHeaders())
  app.use(security())
  // state-changing /api calls from another site are refused before any parsing
  app.use('/api', csrfGuard())
  // per-user token buckets (RATE_LIMIT_API_PER_MIN / RATE_LIMIT_TURNS_PER_MIN)
  app.use(rateLimit())
  // every :id / :messageId is a BIGINT key: anything else skips the route (404)
  app.param(['id', 'messageId'], numericIdParam)
  // JSON body limit per route class (JSON_ROUTE_LIMITS in security.ts: 1mb by
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

// Project sources (W2-3, server/routes/projects.js): documents whose text is
// extracted and kept (no bytes are stored). 25 MB per file, 10 per request;
// past either limit the request is 413 and nothing is stored. A project holds
// at most MAX_FILES_PER_PROJECT files (server/db/projects.js).
export const PROJECT_FILE_LIMITS = Object.freeze({ fileSize: 25 * 1024 * 1024, files: 10 })
export const projectFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { ...PROJECT_FILE_LIMITS },
})

// multer/busboy exposes the multipart filename as a latin1-decoded string, so
// UTF-8 names get mangled (e.g. "ção" -> "cÌ§aÌ o"). Re-decode as UTF-8 and
// compose to NFC (macOS sends decomposed accents).
export function fixFilename(name: string): string {
  try {
    return Buffer.from(name, 'latin1').toString('utf8').normalize('NFC')
  } catch {
    return name
  }
}
