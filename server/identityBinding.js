// Identity binding: the e-mail in x-forwarded-email must belong to the token in
// x-forwarded-access-token.
//
// Why: every query is scoped by the e-mail header (WHERE user_email) and the
// Lakebase pool authenticates as the app's service principal, not as the user.
// The Apps proxy sets both headers, but nothing checked that they agree. A
// request that reaches the process without going through the proxy (or a proxy
// that ever passed a client header through) could pair `x-forwarded-email:
// <anyone, the owner included>` with any token string and read that person's
// chats. Resolving the token's owner through the workspace (SCIM /Me, the same
// call authz.js uses for groups) closes that: a forged header with a garbage
// or someone else's token gets 401.
//
// Availability first: when the workspace can't answer (timeout, 5xx, a 403 for
// a missing scope, no DATABRICKS_HOST), the request goes through and a
// rate-limited warning is logged. Only a definite answer ("this token is
// invalid" or "this token belongs to someone else") blocks.
//
// IDENTITY_BINDING=enforce|warn|off. Default: enforce inside the Apps runtime,
// off in local dev (LOCAL_DEV_MODE has no real token to check).
import { createHash } from 'node:crypto'
import { APPS_RUNTIME_MARKERS, identityKey } from './requestIdentity.js'
import { fetchScimMe, workspaceHost } from './authz.js'

const MODES = new Set(['enforce', 'warn', 'off'])
export const RESOLVED_TTL_MS = 5 * 60 * 1000
// "couldn't verify" is cached briefly so an outage costs one lookup per token
// per 30 s instead of one per request, and recovers on its own
export const UNVERIFIED_TTL_MS = 30 * 1000
export const MAX_ENTRIES = 5000
export const WARN_EVERY_MS = 60 * 1000
const RESOLVE_TIMEOUT_MS = 3000

export function identityBindingMode(env = process.env) {
  const v = String(env.IDENTITY_BINDING ?? '').trim().toLowerCase()
  if (MODES.has(v)) return v
  // unset or a typo: the safe default for where we are running
  return APPS_RUNTIME_MARKERS.some((name) => String(env[name] ?? '').trim()) ? 'enforce' : 'off'
}

/**
 * Default resolver: SCIM /Me with the token itself.
 * → { ok: true, identities: [...] } | { ok: false, invalid: true }; throws when
 * the answer is not definite (the caller treats that as "can't verify").
 * Classification from live workspace responses: 401 for a garbage or forged
 * token, 403 "Invalid access token" for a well-formed unknown one.
 */
export function scimMeResolver({ fetchImpl = fetch, host = workspaceHost, timeoutMs = RESOLVE_TIMEOUT_MS } = {}) {
  return async function resolve(token) {
    const base = host()
    if (!base) throw new Error('DATABRICKS_HOST not set')
    const res = await fetchScimMe(token, {
      attributes: 'userName,emails',
      fetchImpl,
      base,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.ok) {
      const d = await res.json()
      // only userName and emails[].value prove ownership of the forwarded e-mail;
      // applicationId (service principals) is deliberately not accepted
      const identities = [d.userName, ...(d.emails || []).map((e) => e?.value)]
        .filter((v) => typeof v === 'string' && v.trim())
      if (!identities.length) throw new Error('SCIM /Me returned no identity')
      return { ok: true, identities }
    }
    if (res.status === 401) return { ok: false, invalid: true }
    if (res.status === 403) {
      const text = await res.text().catch(() => '')
      if (/invalid access token/i.test(text)) return { ok: false, invalid: true }
    }
    throw new Error(`SCIM /Me HTTP ${res.status}`)
  }
}

function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

export function createIdentityBinding({
  resolve = scimMeResolver(),
  mode = () => identityBindingMode(),
  now = Date.now,
  log = (msg) => console.warn(msg),
  maxEntries = MAX_ENTRIES,
} = {}) {
  // sha256(token) -> { exp, value: Promise<{ kind, identities? }> }; Map order = LRU order
  const cache = new Map()
  const lastWarn = new Map()

  function warn(kind, msg) {
    const t = now()
    if (t - (lastWarn.get(kind) ?? -Infinity) < WARN_EVERY_MS) return
    lastWarn.set(kind, t)
    log(`identity-binding: ${msg}`)
  }

  function lookup(token) {
    const key = tokenHash(token)
    const hit = cache.get(key)
    if (hit && hit.exp > now()) {
      cache.delete(key) // refresh recency
      cache.set(key, hit)
      return hit.value
    }
    if (hit) cache.delete(key)
    const entry = { exp: now() + RESOLVED_TTL_MS, value: null }
    entry.value = Promise.resolve()
      .then(() => resolve(token))
      .then(
        (r) => (r?.ok ? { kind: 'resolved', identities: r.identities.map(identityKey) } : { kind: r?.invalid ? 'invalid' : 'unverified', error: 'resolver returned no answer' }),
        (e) => ({ kind: 'unverified', error: e?.message || String(e) })
      )
      .then((result) => {
        if (result.kind === 'unverified') entry.exp = Math.min(entry.exp, now() + UNVERIFIED_TTL_MS)
        return result
      })
    cache.set(key, entry)
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value)
    return entry.value
  }

  async function middleware(req, res, next) {
    const m = mode()
    if (m === 'off') return next()
    const result = await lookup(req.token)
    if (result.kind === 'unverified') {
      warn('unverified', `could not verify the forwarded token, allowing the request (${result.error})`)
      return next()
    }
    const claimed = identityKey(req.email)
    // satisfied when the header e-mail equals /Me userName OR any emails[].value
    // (both sides via identityKey: case-insensitive); only "none matches" rejects
    if (result.kind === 'resolved' && result.identities.includes(claimed)) return next()
    const code = result.kind === 'invalid' ? 'invalid_token' : 'identity_mismatch'
    if (m === 'warn') {
      warn(code, `${code}: ${code === 'invalid_token' ? 'invalid forwarded token' : 'x-forwarded-email does not match the token owner (userName or emails[])'} (IDENTITY_BINDING=warn, allowed)`)
      return next()
    }
    warn(`reject:${code}`, `rejected a request: ${code}`)
    return res.status(401).json(
      code === 'invalid_token'
        ? { error: 'Token de acesso inválido.', code }
        : { error: 'A identidade do cabeçalho não confere com o token de acesso.', code }
    )
  }

  return { middleware, lookup }
}

// the app-wide instance used by auth() in server/index.js
const appBinding = createIdentityBinding()
export function bindIdentity(req, res, next) {
  appBinding.middleware(req, res, next).catch(next)
}
