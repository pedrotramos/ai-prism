import { useSyncExternalStore } from 'react'
import { EMPTY_EGRESS_POLICY, classifyImageSrc, parseAllowedOrigins } from '../../../shared/urlEgressPolicy.js'
import type { EgressPolicy } from '../../../shared/urlEgressPolicy.js'

// The client side of the image-egress policy (md-exfil T4). The browser's CSP is
// the enforcement; this store only decides what the markdown renderers draw. It
// is EMPTY until /api/me answers, so before that (and if the answer lacks the
// field, or the call fails) every external image is a placeholder: fail closed.
// Nothing here makes a request.

let policy: EgressPolicy = EMPTY_EGRESS_POLICY
const listeners = new Set<() => void>()

const appOrigin = () => (typeof location !== 'undefined' && location.origin) || 'http://localhost'
const appHost = () => (typeof location !== 'undefined' && location.host) || undefined

/** Called with `externalAssetOrigins` from /api/me. Entries are re-validated here (https only, no wildcard). */
export function setExternalAssetOrigins(origins: readonly string[] | undefined | null): void {
  const { allowed } = parseAllowedOrigins(Array.isArray(origins) ? origins : undefined, { appHost: appHost() })
  const same = allowed.length === policy.allowedOrigins.length && allowed.every((o, i) => o.origin === policy.allowedOrigins[i]?.origin)
  if (same) return
  policy = allowed.length ? { allowedOrigins: allowed } : EMPTY_EGRESS_POLICY
  listeners.forEach((l) => l())
}

export const getEgressPolicy = (): EgressPolicy => policy
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export function useEgressPolicy(): EgressPolicy {
  return useSyncExternalStore(subscribe, getEgressPolicy, () => EMPTY_EGRESS_POLICY)
}

/** A data: URL the shared policy classes as a safe inline image (raster or svg+xml). */
export const isInlineDataImage = (src: string): boolean => classifyImageSrc(src, EMPTY_EGRESS_POLICY, appOrigin()).kind === 'data'

export type ImageVerdict = { blocked: boolean; host: string | null }

/** Same-origin, data: and blob: of this app and allowlisted origins render; everything else is blocked. */
export function imageVerdict(src: string | undefined | null, p: EgressPolicy, origin: string = appOrigin()): ImageVerdict {
  if (!src) return { blocked: true, host: null }
  const c = classifyImageSrc(src, p, origin)
  if (c.kind === 'blocked') return { blocked: true, host: c.host }
  return { blocked: false, host: c.kind === 'allowed' ? c.host : null }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * The placeholder as an HTML string, for the rich-text editor (marked output is
 * assigned to innerHTML). Same shape as the React one. The original source rides
 * along as inert text in data-* so turndown can write the image syntax back:
 * editing a document must not silently delete its images.
 */
export function blockedImageHtml(o: { alt: string; host: string | null; src: string; label: string }): string {
  const text = `⌧ ${o.alt}${o.host ? ` · ${o.host}` : ''}`
  return `<span class="md-image-blocked" role="img" aria-label="${esc(o.label)}" data-md-alt="${esc(o.alt)}" data-md-src="${esc(o.src)}">${esc(text)}</span>`
}
