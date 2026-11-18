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
// 4. jsonBodyParser(): the JSON body limit per route — 1 MB by default
//    (BODY_LIMIT_JSON), 40 MB on /api/deck-templates* for a full design-system
//    bundle import (BODY_LIMIT_DECK_TEMPLATES), and 15 MB on the deck editor save
//    PATCH /api/decks/:id only (BODY_LIMIT_DECK_EDIT): the editor embeds a picked
//    image into the slide HTML as a data: URL. Nothing else gets the exceptions.
import express from 'express'
import { tokenBucket, limitFromEnv, rateLimitKey } from './rateLimit.js'

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

const clip = (s, n = 120) => String(s).slice(0, n)

/** The blocked resource reduced to its origin, or a keyword (inline, eval, data, blob…). */
function blockedOf(value) {
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
function documentOf(value) {
  const v = typeof value === 'string' ? value.trim() : ''
  if (v === 'about:srcdoc' || v === 'about:blank') return v
  try {
    const u = new URL(v)
    if (u.protocol === 'http:' || u.protocol === 'https:') return clip(u.pathname)
  } catch {}
  return v ? 'other' : 'unknown'
}

function directiveOf(...candidates) {
  for (const c of candidates) {
    const d = typeof c === 'string' ? c.trim().split(/\s+/)[0].toLowerCase() : ''
    if (/^[a-z-]{1,40}$/.test(d)) return d
  }
  return 'unknown'
}

function summarize({ directive, blocked, document, disposition }) {
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
export function summarizeCspReports(payload) {
  const out = []
  if (Array.isArray(payload)) {
    for (const r of payload.slice(0, MAX_REPORTS_PER_REQUEST)) {
      if (r?.type !== 'csp-violation' || !r.body || typeof r.body !== 'object') continue
      const b = r.body
      out.push(summarize({ directive: directiveOf(b.effectiveDirective, b.violatedDirective), blocked: b.blockedURL, document: b.documentURL, disposition: b.disposition }))
    }
  } else if (payload && typeof payload === 'object' && payload['csp-report'] && typeof payload['csp-report'] === 'object') {
    const b = payload['csp-report']
    out.push(summarize({ directive: directiveOf(b['effective-directive'], b['violated-directive']), blocked: b['blocked-uri'], document: b['document-uri'], disposition: b.disposition }))
  }
  return out
}

export function security({ env = process.env, log = (line) => console.log(line), now = Date.now } = {}) {
  const parseReport = express.json({ type: CSP_REPORT_TYPES, limit: '64kb', strict: false })
  const reportCap = tokenBucket({ perMinute: limitFromEnv(env.CSP_REPORT_PER_MIN, 60), now })

  function handleReport(req, res) {
    parseReport(req, res, (err) => {
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

const DECK_TEMPLATES_PATH = /^\/api\/deck-templates(?:\/|$)/i
const DECK_EDIT_PATH = /^\/api\/decks\/[^/]+\/?$/i
const BODY_DEFAULTS = { json: '1mb', deckTemplates: '40mb', deckEdit: '15mb' }

const UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }

/** "1mb", "512kb", "2048" → bytes; anything else → null. */
export function parseBytes(value) {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(value ?? '').trim())
  if (!m) return null
  const n = Math.floor(Number(m[1]) * UNITS[(m[2] || 'b').toLowerCase()])
  return n > 0 ? n : null
}

function bytesFromEnv(value, fallback) {
  return parseBytes(value) ?? parseBytes(fallback)
}

/** The JSON body limit (bytes) for a request. */
export function jsonLimitFor(req, env = process.env) {
  const path = req.path || ''
  if (DECK_TEMPLATES_PATH.test(path)) return bytesFromEnv(env.BODY_LIMIT_DECK_TEMPLATES, BODY_DEFAULTS.deckTemplates)
  if (req.method === 'PATCH' && DECK_EDIT_PATH.test(path)) return bytesFromEnv(env.BODY_LIMIT_DECK_EDIT, BODY_DEFAULTS.deckEdit)
  return bytesFromEnv(env.BODY_LIMIT_JSON, BODY_DEFAULTS.json)
}

/** express.json with the per-route limit from jsonLimitFor (an oversized body → 413). */
export function jsonBodyParser({ env = process.env } = {}) {
  const parsers = new Map()
  const parserFor = (limit) => {
    if (!parsers.has(limit)) parsers.set(limit, express.json({ limit }))
    return parsers.get(limit)
  }
  return function jsonBodyParserMiddleware(req, res, next) {
    parserFor(jsonLimitFor(req, env))(req, res, next)
  }
}
