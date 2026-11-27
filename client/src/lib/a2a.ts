// Client side of the A2A agents and of the in-chat authorization: the shapes the server sends, the marker a failed
// a2a__ tool call carries in its result, and the popup login (authorization code + PKCE, run by the server).

/** What a tool asked of the user (server/userAuth.ts). Never carries a token. */
export interface AuthDescriptor {
  kind: 'a2a' | 'mcp'
  id: string
  name: string
  reason: 'missing' | 'expired' | 'revoked' | 'insufficient_scope'
  provider?: string
  providerName?: string
  loginUrl?: string
}

export interface A2aAgent {
  id: string
  slug: string
  toolName: string
  displayName: string
  cardUrl: string
  appName: string
  authStrategy: 'databricks-obo' | 'oauth2-user' | 'none' | string
  authProvider: string | null
  authProviderName: string | null
  enabled: boolean
  status: string
  lastError: string
  lastCheckedAt: string | null
  cardPublic: boolean
  card: { description: string; version: string; provider: string; streaming: boolean; skills: { id: string; name: string; description: string; tags: string[] }[] }
  configStatus?: string
  configError?: string
  configCheckedAt?: string | null
}

export interface A2aProvider {
  id: string
  name: string
  type: string | null
  disabled: boolean
  connected: boolean
  idpEmailVerified: boolean
  expiresAt: string | null
}

export interface A2aAdminProvider {
  id: string
  name: string
  type: string | null
  error: string | null
  disabled: boolean
  scopes: string[]
  hostPatterns: { pattern: string; send: string }[]
  redirectUri: string
}

export type A2aFailure = 'auth_required' | 'no_access' | 'front_door_forbidden' | 'invalid_card' | 'unavailable' | 'canceled'

// `ERROR [a2a:<status>(:<provider>)?]: …` — the first line of a failed a2a__ tool result (server/a2aClient.ts failureText)
const MARKER = /^ERROR \[a2a:([a-z_]+)(?::([A-Za-z0-9_.-]+))?\]:\s*/

/** The failure a tool result reports, or null when it is not an A2A failure. */
export function parseA2aMarker(result: unknown): { failure: A2aFailure; provider: string | null; text: string } | null {
  const m = MARKER.exec(String(result ?? ''))
  if (!m) return null
  const failure = m[1] as A2aFailure
  if (!['auth_required', 'no_access', 'front_door_forbidden', 'invalid_card', 'unavailable', 'canceled'].includes(failure)) return null
  return { failure, provider: m[2] && m[2] !== 'databricks' ? m[2] : null, text: String(result).replace(MARKER, '').split('\n')[0] as string }
}

export type OAuthOutcome = { ok: true; idpEmailVerified: boolean } | { ok: false; reason: string; closed?: boolean; blocked?: boolean }

interface CallbackMessage {
  type?: string
  provider?: string
  ok?: boolean
  reason?: string | null
  idpEmailVerified?: boolean
}

/**
 * Runs the provider's login in a popup and resolves when the server's callback page reports the outcome (a
 * same-origin postMessage) or the popup was closed. The popup page only ever carries fixed reason codes.
 */
export function authorizeProvider(providerId: string): Promise<OAuthOutcome> {
  return new Promise((resolve) => {
    const popup = window.open(`/api/a2a/oauth/${encodeURIComponent(providerId)}/start`, 'a2a-oauth', 'popup=yes,width=520,height=720')
    if (!popup) return resolve({ ok: false, reason: 'popup_blocked', blocked: true })
    let done = false
    const finish = (outcome: OAuthOutcome) => {
      if (done) return
      done = true
      window.removeEventListener('message', onMessage)
      clearInterval(timer)
      resolve(outcome)
    }
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return
      const d = ev.data as CallbackMessage | null
      if (!d || d.type !== 'a2a-oauth' || d.provider !== providerId) return
      finish(d.ok ? { ok: true, idpEmailVerified: d.idpEmailVerified === true } : { ok: false, reason: d.reason || 'internal' })
    }
    window.addEventListener('message', onMessage)
    // a popup the user closes without finishing; a short grace lets a just-posted message arrive first
    const timer = setInterval(() => {
      if (popup.closed) setTimeout(() => finish({ ok: false, reason: 'closed', closed: true }), 400)
    }, 500)
  })
}

/** Disconnects a provider. `force` removes the sealed tokens here even when the provider did not confirm the revocation. */
export async function disconnectProvider(providerId: string, force = false): Promise<{ ok: boolean; revoked?: boolean; reason?: string; error?: string }> {
  const r = await fetch(`/api/a2a/oauth/${encodeURIComponent(providerId)}${force ? '?force=1' : ''}`, { method: 'DELETE' })
  const body = (await r.json().catch(() => ({}))) as { ok?: boolean; revoked?: boolean; reason?: string; error?: string }
  return r.ok ? { ok: true, ...(body.revoked !== undefined ? { revoked: body.revoked } : {}) } : { ok: false, ...(body.reason ? { reason: body.reason } : {}), ...(body.error ? { error: body.error } : {}) }
}
