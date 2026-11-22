// Security middleware that sits right after server/securityHeaders.js (which
// keeps nosniff, Referrer-Policy, X-Frame-Options and the enforced CSP):
//
// 1. Permissions-Policy: the microphone stays available to the app itself
//    (voice dictation); the camera is off for the app and every frame.
//
// 2. Content-Security-Policy-Report-Only (REPORT_ONLY_POLICY): the strict policy
//    the app should eventually enforce. Report-only first: nothing is blocked,
//    the browser only POSTs what WOULD have been blocked to /api/csp-report. The
//    deck editor and the design-system previews (srcdoc iframes inherit the
//    page's policy, with inline scripts and fonts/images from the customer's
//    design system) generate those reports today; they are the evidence needed
//    before enforcing. frame-ancestors 'none' here reports whether anything
//    (e.g. the Apps UI) frames the app, while the enforced 'self' stays.
//
// 3. POST /api/csp-report: handled here, BEFORE the CSRF guard: reports from a
//    sandboxed srcdoc frame arrive with `Origin: null` and would be refused.
//    Each violation becomes ONE JSON log line with only the directive, the
//    blocked origin (or a keyword such as inline/eval/data), the document path
//    and the disposition: no query strings, no samples, no identity. A per-user
//    cap (CSP_REPORT_PER_MIN, default 60) keeps a noisy page from flooding logs.
//
// 4. jsonBodyParser(): the JSON body limit per route class, from the explicit
//    table JSON_ROUTE_LIMITS below — 1 MB by default, 40 MB for the design-system
//    import, 46 MiB for the deck studio's media-heavy writes, 4 MB for a workbook save —
//    and enforced even when an upstream parser already read the body.
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { tokenBucket, limitFromEnv, rateLimitKey } from './rateLimit.ts'
import { logger } from '../log.ts'

export const REPORT_ONLY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "frame-ancestors 'none'",
].join('; ')

export const PERMISSIONS_POLICY = 'microphone=(self), camera=()'
export const CSP_REPORT_PATH = '/api/csp-report'
const REPORT_GROUP = 'csp-endpoint'
const REPORT_ONLY_HEADER = `${REPORT_ONLY_POLICY}; report-uri ${CSP_REPORT_PATH}; report-to ${REPORT_GROUP}`

const CSP_REPORT_ROUTE = /^\/api\/csp-report\/?$/i
const CSP_REPORT_TYPES = ['application/csp-report', 'application/reports+json', 'application/json']
const MAX_REPORTS_PER_REQUEST = 20
const KEYWORDS = new Set(['inline', 'eval', 'wasm-eval', 'self', 'data', 'blob', 'trusted-types-policy', 'trusted-types-sink'])

const clip = (s: unknown, n = 120): string => String(s).slice(0, n)

/** The blocked resource reduced to its origin, or a keyword (inline, eval, data, blob…). */
function blockedOf(value: unknown): string {
  const v = typeof value === 'string' ? value.trim() : ''
  if (!v) return 'unknown'
  if (KEYWORDS.has(v.toLowerCase())) return v.toLowerCase()
  try {
    const u = new URL(v)
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'wss:' || u.protocol === 'ws:') return clip(u.origin)
    if (u.protocol === 'data:') return 'data'
    if (u.protocol === 'blob:') return 'blob'
    return 'other'
  } catch {
    return 'other'
  }
}

/** The document reduced to its path (no query, no fragment); about:srcdoc/blank kept. */
function documentOf(value: unknown): string {
  const v = typeof value === 'string' ? value.trim() : ''
  if (v === 'about:srcdoc' || v === 'about:blank') return v
  try {
    const u = new URL(v)
    if (u.protocol === 'http:' || u.protocol === 'https:') return clip(u.pathname)
  } catch {}
  return v ? 'other' : 'unknown'
}

function directiveOf(...candidates: unknown[]): string {
  for (const c of candidates) {
    const d = typeof c === 'string' ? c.trim().split(/\s+/)[0]!.toLowerCase() : ''
    if (/^[a-z-]{1,40}$/.test(d)) return d
  }
  return 'unknown'
}

function summarize({ directive, blocked, document, disposition }: { directive: string; blocked: unknown; document: unknown; disposition: unknown }) {
  return {
    event: 'csp_violation',
    directive,
    blocked: blockedOf(blocked),
    document: documentOf(document),
    disposition: disposition === 'enforce' ? 'enforce' : 'report',
  }
}

/**
 * Both report formats → PII-free summaries: the legacy report-uri body
 * ({"csp-report": {...}}) and the Reporting API batch ([{type:'csp-violation', body}]).
 */
export function summarizeCspReports(payload: unknown): ReturnType<typeof summarize>[] {
  // untrusted browser JSON: read through a loose view, every field is type-checked at use
  const body = payload as any
  const out: ReturnType<typeof summarize>[] = []
  if (Array.isArray(body)) {
    for (const r of body.slice(0, MAX_REPORTS_PER_REQUEST)) {
      if (r?.type !== 'csp-violation' || !r.body || typeof r.body !== 'object') continue
      const b = r.body
      out.push(summarize({ directive: directiveOf(b.effectiveDirective, b.violatedDirective), blocked: b.blockedURL, document: b.documentURL, disposition: b.disposition }))
    }
  } else if (body && typeof body === 'object' && body['csp-report'] && typeof body['csp-report'] === 'object') {
    const b = body['csp-report']
    out.push(summarize({ directive: directiveOf(b['effective-directive'], b['violated-directive']), blocked: b['blocked-uri'], document: b['document-uri'], disposition: b.disposition }))
  }
  return out
}

export function security({ env = process.env, log = (line: string) => logger.warn(`csp report: ${line}`), now = Date.now }: { env?: NodeJS.ProcessEnv; log?: (line: string) => void; now?: () => number } = {}): (req: Request, res: Response, next: NextFunction) => unknown {
  const parseReport = express.json({ type: CSP_REPORT_TYPES, limit: '64kb', strict: false })
  const reportCap = tokenBucket({ perMinute: limitFromEnv(env.CSP_REPORT_PER_MIN, 60), now })

  function handleReport(req: Request, res: Response) {
    parseReport(req, res, (err?: unknown) => {
      // a malformed or oversized report is the browser's problem, never an error page
      if (!err) {
        const key = rateLimitKey(req)
        for (const entry of summarizeCspReports(req.body)) {
          if (!reportCap.take(key).ok) break
          log(JSON.stringify(entry))
        }
      }
      res.status(204).end()
    })
  }

  return function securityMiddleware(req, res, next) {
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY)
    res.setHeader('Content-Security-Policy-Report-Only', REPORT_ONLY_HEADER)
    res.setHeader('Reporting-Endpoints', `${REPORT_GROUP}="${CSP_REPORT_PATH}"`)
    if (req.method === 'POST' && CSP_REPORT_ROUTE.test(req.path || '')) return handleReport(req, res)
    next()
  }
}

// ---- JSON body limits --------------------------------------------------------
//
// Every state-changing route names its class in JSON_ROUTE_LIMITS (a test in
// server/routes/routeTable.test.js fails when a route is missing or an entry is
// stale), so a new route chooses its limit instead of inheriting one. A request
// that matches no entry (GET, unknown path) gets the default.
//
// Sizes behind the classes, measured on the canonical Databricks design-system
// bundle (real asset sizes, real client export code):
//   - export-html, 40 slides (the deck cap) with a brand background on each:
//     25.6 MB; 15 slides: 8.6 MB; a typical 15-slide deck: 1.0 MB. Every image
//     op carries its data: URL, so the body grows with slides x backgrounds,
//     and the importer allows backgrounds up to 2.4 MB each.
//   - deck tweak, the largest studio body: the inputs are capped (W2-16,
//     server/routes/decks.js; over a cap = 413 naming it): at most 4
//     attachments of 6 MiB decoded each (a raster travels once, as a data: URL
//     4/3 its size) and 9 MiB per speaker note, plus the working slides (40 x
//     60,000 chars as the server keeps them). At the caps: 4 x 8.39M chars of
//     base64 + one 9 MiB note + 2.4M chars of slides + a 2,000-char
//     instruction = 45,393,959 bytes. studioMedia is that plus ~6% headroom
//     (JSON escaping of attribute quotes, a selection's outerHTML): 46 MiB.
//     A body with two maxed notes is over the class and gets the generic 413.
//   - workbook save at the sanitizer caps (8 sheets x 500 rows x 20 cols):
//     0.94 MB with plain cells, about twice that with styled cells.
//   - document save: markdown only (the editor embeds no images), and the AI
//     edit refuses documents over 120k characters.
// AppKit's own express.json runs before this app (server/appkit.js) and caps
// every route at this size; no class above may exceed it (security.test.js).
export const APPKIT_BODY_LIMIT = '64mb'

export const BODY_LIMIT_CLASSES = {
  default: { env: 'BODY_LIMIT_JSON', fallback: '1mb', why: 'small JSON: settings, titles, prompts, ids' },
  deckTemplates: { env: 'BODY_LIMIT_DECK_TEMPLATES', fallback: '40mb', why: 'a full design-system bundle import (fonts, specimen cards, backgrounds)' },
  studioMedia: {
    env: 'BODY_LIMIT_STUDIO_MEDIA',
    fallback: '46mb',
    why: 'deck studio save/AI edit/native export and spreadsheet AI edit: slides, speaker notes and attachments as data: URLs (export 25.6 MB at the 40-slide cap; tweak at the input caps, 4 x 6 MiB attachments + a 9 MiB note + 40 full slides = 45.4 MB, plus ~6% headroom)',
  },
  workbook: { env: 'BODY_LIMIT_WORKBOOK', fallback: '4mb', why: 'a whole workbook spec (0.94 MB at the sanitizer caps with plain cells)' },
}

const route = (method: string, path: string, cls: string) => ({ method, path, class: cls })

export const JSON_ROUTE_LIMITS = [
  // admin
  route('POST', '/api/admins', 'default'),
  route('DELETE', '/api/admins/:principal', 'default'),
  route('PUT', '/api/admin/tool-policy/:key', 'default'),
  route('PUT', '/api/admin/model-endpoints/:endpointId', 'default'),
  route('PUT', '/api/admin/model-endpoints-order', 'default'),
  route('PUT', '/api/admin/tool-prices/:key', 'default'),
  route('POST', '/api/admin/mcp-catalog/inspect', 'default'),
  route('PUT', '/api/admin/mcp-catalog/:name', 'default'),
  route('DELETE', '/api/admin/mcp-catalog/:name', 'default'),
  route('PUT', '/api/admin/settings', 'default'),
  route('POST', '/api/admin/web-search/verify', 'default'),
  // models, sessions, messages
  route('PUT', '/api/image-models/selected', 'default'),
  route('POST', '/api/sessions/:id/compact', 'default'),
  route('PATCH', '/api/sessions/:id', 'default'),
  route('DELETE', '/api/sessions/:id', 'default'),
  route('POST', '/api/sessions/:id/continue', 'default'),
  route('POST', '/api/sessions/:id/messages/:messageId/regenerate', 'default'),
  route('POST', '/api/sessions/:id/messages/:messageId/edit', 'default'),
  route('POST', '/api/sessions/:id/messages/:messageId/question-answers', 'default'),
  route('PATCH', '/api/messages/:id/activate', 'default'),
  // multipart routes: the files go through multer and its per-route limits
  // (server/middleware/index.ts); a JSON body there stays small
  route('POST', '/api/chat', 'default'),
  route('POST', '/api/skills/upload', 'default'),
  // MCP connections, skills
  route('POST', '/api/mcp/connections/:name/probe', 'default'),
  route('POST', '/api/mcp/connections/:name', 'default'),
  route('DELETE', '/api/mcp/connections/:name', 'default'),
  route('POST', '/api/skills', 'default'),
  route('PUT', '/api/skills/:id', 'default'),
  route('DELETE', '/api/skills/:id', 'default'),
  // memory (W2-4): one entry is ≤ 500 characters
  route('POST', '/api/memory', 'default'),
  route('PATCH', '/api/memory/:id', 'default'),
  route('DELETE', '/api/memory/:id', 'default'),
  route('DELETE', '/api/memory', 'default'),
  // design systems: import, update and asset labelling carry the bundle's
  // assets; select, scope and delete carry an id or a flag
  route('POST', '/api/deck-templates', 'deckTemplates'),
  route('POST', '/api/deck-templates/label-assets', 'deckTemplates'),
  route('PATCH', '/api/deck-templates/:id', 'deckTemplates'),
  route('POST', '/api/deck-templates/:id/select', 'default'),
  route('DELETE', '/api/deck-templates/:id', 'default'),
  route('POST', '/api/deck-templates/:id/scope', 'default'),
  // studios
  route('PATCH', '/api/decks/:id', 'studioMedia'),
  route('POST', '/api/decks/:id/tweak', 'studioMedia'),
  route('POST', '/api/decks/:id/export-html', 'studioMedia'),
  route('POST', '/api/spreadsheets/:id/tweak', 'studioMedia'),
  route('PATCH', '/api/spreadsheets/:id', 'workbook'),
  route('PATCH', '/api/documents/:id', 'default'),
  route('POST', '/api/documents/:id/tweak', 'default'),
  // projects (W2-3): small JSON; the file upload is multipart (PROJECT_FILE_LIMITS
  // in server/middleware/index.ts)
  route('POST', '/api/projects', 'default'),
  route('PATCH', '/api/projects/:id', 'default'),
  route('DELETE', '/api/projects/:id', 'default'),
  route('POST', '/api/projects/:id/members', 'default'),
  route('PATCH', '/api/projects/:id/members/:kind/:principal', 'default'),
  route('DELETE', '/api/projects/:id/members/:kind/:principal', 'default'),
  route('POST', '/api/projects/:id/files', 'default'),
  route('DELETE', '/api/projects/:id/files/:fileId', 'default'),
  route('POST', '/api/projects/:id/sessions', 'default'),
  route('DELETE', '/api/projects/:id/sessions/:sessionId', 'default'),
  // scheduled agents (W4-4d): a definition is ≤ 8000 + 4000 characters of text plus a few fields, well inside 1 MB
  route('POST', '/api/agents', 'default'),
  route('PATCH', '/api/agents/:id', 'default'),
  route('DELETE', '/api/agents/:id', 'default'),
  route('POST', '/api/agents/:id/submit', 'default'),
  route('POST', '/api/agents/:id/enable', 'default'),
  route('POST', '/api/agents/:id/disable', 'default'),
  route('POST', '/api/agents/:id/run', 'default'),
  route('POST', '/api/admin/agents/:id/approve', 'default'),
  route('POST', '/api/admin/agents/:id/reject', 'default'),
  route('POST', '/api/admin/agents/:id/revoke', 'default'),
  route('PUT', '/api/admin/agents/settings', 'default'),
]

// Express path → regex with Express's matching rules here: case-insensitive,
// optional trailing slash, a :param is one path segment.
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const COMPILED_ROUTES = JSON_ROUTE_LIMITS.map((r) => ({
  ...r,
  re: new RegExp('^' + r.path.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : escapeRe(seg))).join('/') + '/?$', 'i'),
}))

const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }

/** "1mb", "512kb", "2048" → bytes; anything else → null. */
export function parseBytes(value: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(value ?? '').trim())
  if (!m) return null
  const n = Math.floor(Number(m[1]) * (UNITS[(m[2] || 'b').toLowerCase()] as number))
  return n > 0 ? n : null
}

function classLimit(name: string, env: NodeJS.ProcessEnv): number {
  const c = BODY_LIMIT_CLASSES[name as keyof typeof BODY_LIMIT_CLASSES] || BODY_LIMIT_CLASSES.default
  return (parseBytes(env[c.env]) ?? parseBytes(c.fallback)) as number // the fallbacks are valid sizes
}

/** The body-limit class of a request ('default' when no entry matches). */
export function jsonLimitClassFor(req: { method?: string; path?: string }): string {
  const method = String(req.method || '').toUpperCase()
  const path = req.path || ''
  return COMPILED_ROUTES.find((r) => r.method === method && r.re.test(path))?.class || 'default'
}

/** The JSON body limit (bytes) for a request. */
export function jsonLimitFor(req: { method?: string; path?: string }, env: NodeJS.ProcessEnv = process.env): number {
  return classLimit(jsonLimitClassFor(req), env)
}

function tooLarge(length: number, limit: number): Error {
  const err = new Error('request entity too large')
  return Object.assign(err, { status: 413, statusCode: 413, expose: true, type: 'entity.too.large', length, limit, expected: length })
}

function lengthRequired(): Error {
  const err = new Error('length required')
  return Object.assign(err, { status: 411, statusCode: 411, expose: true, type: 'length.required' })
}

// Declared size of a body another parser already read, or null without one. The
// parsed object cannot stand in for it: whitespace and escapes vanish on parse,
// so 2 MiB of padding around {"ok":true} would measure a few bytes.
function declaredLength(req: { headers?: Record<string, unknown> }): number | null {
  const v = req.headers?.['content-length']
  if (v == null || String(v).trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * express.json with the per-route limit from jsonLimitFor (an oversized body →
 * 413 through the final error handler).
 *
 * When a parser upstream already read the body (the AppKit boot installs its
 * own express.json at APPKIT_BODY_LIMIT before this app), body-parser would skip the
 * request, so the route's limit is enforced here from the declared
 * Content-Length; a body without one (chunked) gets 411. That check is a policy
 * check, not a memory guard: the bytes were already read. Under the legacy boot
 * body-parser counts the stream itself, chunked or not.
 */
export function jsonBodyParser({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): (req: Request, res: Response, next: NextFunction) => unknown {
  const parsers = new Map<number, ReturnType<typeof express.json>>()
  const parserFor = (limit: number) => {
    if (!parsers.has(limit)) parsers.set(limit, express.json({ limit }))
    return parsers.get(limit) as ReturnType<typeof express.json>
  }
  return function jsonBodyParserMiddleware(req, res, next) {
    const limit = jsonLimitFor(req, env)
    if ((req as { _body?: unknown })._body) { // set by an upstream body-parser
      const size = declaredLength(req)
      if (size == null) return next(lengthRequired())
      return size > limit ? next(tooLarge(size, limit)) : next()
    }
    parserFor(limit)(req, res, next)
  }
}
