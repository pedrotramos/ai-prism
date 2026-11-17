// App-level middleware and the pieces the route modules share.
//
// installMiddleware(app) installs, in this order: request id (placeholder),
// security headers, the security placeholder, the CSRF guard on /api, the
// numeric :id/:messageId param check, then JSON body parsing. The CSRF guard
// must stay before any body parser: a cross-site write is refused before its
// body is read.
import express from 'express'
import multer from 'multer'
import { securityHeaders, numericIdParam, finalErrorHandler } from '../securityHeaders.js'
import { csrfGuard } from '../csrfGuard.js'
import { requestId } from './requestId.js'
import { security } from './security.js'

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
  // every :id / :messageId is a BIGINT key: anything else skips the route (404)
  app.param(['id', 'messageId'], numericIdParam)
  // 40mb to fit a full design-system BUNDLE import (fonts + specimen cards +
  // downscaled backgrounds — see dsImport.js caps); plain mined templates stay
  // well under the old 15mb in practice
  app.use(express.json({ limit: '40mb' }))
}

export const upload = multer({
  storage: multer.memoryStorage(),
  // Brand .pptx decks are routinely large (embedded imagery/fonts); the real
  // "adjust this presentation" use case needs headroom well past 25MB.
  limits: { fileSize: 80 * 1024 * 1024, files: 10 },
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
