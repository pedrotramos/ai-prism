// Per-user rate limits for /api: a token bucket per identity.
//
// Why: every turn spends the customer's model budget, and one runaway script
// or stuck client retry loop could burn it (or starve the app's pool for the
// rest of the workspace) in minutes. Two buckets per user:
//   - API:   RATE_LIMIT_API_PER_MIN   (default 120) — every /api request;
//   - turns: RATE_LIMIT_TURNS_PER_MIN (default 12)  — requests that start a model
//            call: chat, continue, regenerate, compact, and the studio tweaks.
// `0` turns a bucket off; an unparseable value keeps the default.
//
// The key is the identity the Databricks Apps proxy forwards (x-forwarded-email,
// overwritten by the proxy on every request), never the raw IP alone: many users
// share one egress IP, and one user moves between IPs. Only a request without
// that header (local dev, an unauthenticated probe) falls back to the IP.
//
// An empty bucket answers 429 JSON with Retry-After (whole seconds until the
// next token). Buckets live in process memory: with several app instances the
// limit applies per instance. /api/csp-report is not charged here; it has its
// own cap in security.js.
import { identityKey } from '../requestIdentity.ts'

const DEFAULTS = { api: 120, turns: 12 }
const MAX_KEYS = 50_000

const API_PATH = /^\/api\//i
const CSP_REPORT_PATH = /^\/api\/csp-report\/?$/i
const TURN_PATH =
  /^\/api\/(?:chat|sessions\/[^/]+\/(?:continue|compact|messages\/[^/]+\/regenerate)|(?:decks|spreadsheets|documents)\/[^/]+\/tweak)\/?$/i

/** Parses a per-minute limit: positive integer, 0 = off (Infinity), else the fallback. */
export function limitFromEnv(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback
  const n = Number(String(value).trim())
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return fallback
  return n === 0 ? Infinity : n
}

/** True for the POST routes that start a model call (the turn routes and the studio tweaks). */
export function isTurnRequest(req) {
  return req.method === 'POST' && TURN_PATH.test(req.path || '')
}

/**
 * A map of token buckets, `perMinute` tokens of capacity refilled continuously.
 * take(key) → { ok: true } or { ok: false, retryAfterSec }.
 */
export function tokenBucket({ perMinute, now = Date.now, maxKeys = MAX_KEYS }) {
  const buckets = new Map()
  const ratePerMs = perMinute / 60_000

  function prune(t) {
    // drop buckets that are full again (they carry no state), then the oldest
    for (const [k, b] of buckets) {
      if (b.tokens + (t - b.at) * ratePerMs >= perMinute) buckets.delete(k)
    }
    while (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value)
  }

  return {
    size: () => buckets.size,
    take(key) {
      if (perMinute === Infinity) return { ok: true }
      const t = now()
      let b = buckets.get(key)
      if (!b) {
        if (buckets.size >= maxKeys) prune(t)
        b = { tokens: perMinute, at: t }
        buckets.set(key, b)
      } else {
        b.tokens = Math.min(perMinute, b.tokens + (t - b.at) * ratePerMs)
        b.at = t
      }
      if (b.tokens >= 1) {
        b.tokens -= 1
        return { ok: true }
      }
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / ratePerMs / 1000)) }
    },
  }
}

/** The limiter key: the forwarded user (case-insensitive), else the client IP. */
export function rateLimitKey(req) {
  // same canonical key as credentials, caches and pools (requestIdentity.js)
  const key = identityKey(req.headers?.['x-forwarded-email'])
  if (key) return `user:${key}`
  return `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`
}

export function rateLimit({ env = process.env, now = Date.now } = {}) {
  const api = tokenBucket({ perMinute: limitFromEnv(env.RATE_LIMIT_API_PER_MIN, DEFAULTS.api), now })
  const turns = tokenBucket({ perMinute: limitFromEnv(env.RATE_LIMIT_TURNS_PER_MIN, DEFAULTS.turns), now })

  function reject(res, retryAfterSec) {
    res.setHeader('Retry-After', String(retryAfterSec))
    return res.status(429).json({ error: 'Muitas requisições. Tente novamente em instantes.', code: 'rate_limited', retryAfter: retryAfterSec })
  }

  return function rateLimitMiddleware(req, res, next) {
    const path = req.path || ''
    if (!API_PATH.test(path) || CSP_REPORT_PATH.test(path)) return next()
    const key = rateLimitKey(req)
    const a = api.take(key)
    if (!a.ok) return reject(res, a.retryAfterSec)
    if (isTurnRequest(req)) {
      const t = turns.take(key)
      if (!t.ok) return reject(res, t.retryAfterSec)
    }
    next()
  }
}
