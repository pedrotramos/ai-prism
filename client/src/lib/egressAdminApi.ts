// Fetch helpers for the admin "external asset origins" card (md-exfil T3). Own module: the shared api.ts is not touched.
// Contract (server/routes/egress.ts): GET/PUT /api/admin/egress/settings -> { origins, envOrigins, effective, mode };
// a PUT with an origin the policy refuses is a 400 { error:'invalid_origin', rejected:[…] } and nothing is written.
import { parseAllowedOrigins } from '../../../shared/urlEgressPolicy.js'

export interface EgressSettings {
  origins: string[]
  envOrigins: string[]
  effective: string[]
  mode: 'enforce' | 'report'
}

export class EgressSaveError extends Error {
  status: number
  rejected: string[]
  constructor(status: number, rejected: string[], message: string) {
    super(message)
    this.status = status
    this.rejected = rejected
  }
}

const URL_PATH = '/api/admin/egress/settings'

export async function fetchEgressSettings(): Promise<EgressSettings> {
  const r = await fetch(URL_PATH)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export async function saveEgressOrigins(origins: readonly string[]): Promise<EgressSettings> {
  const r = await fetch(URL_PATH, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origins }),
  })
  if (!r.ok) {
    const p = (await r.json().catch(() => ({}))) as { error?: unknown; rejected?: unknown }
    const rejected = Array.isArray(p.rejected) ? p.rejected.filter((x): x is string => typeof x === 'string') : []
    throw new EgressSaveError(r.status, rejected, typeof p.error === 'string' ? p.error : `HTTP ${r.status}`)
  }
  return r.json()
}

/** One typed entry -> its canonical origin, or not ok. Same rules as the server (the server stays the authority). */
export function validateOriginInput(raw: string, appHost?: string): { ok: true; origin: string } | { ok: false } {
  if (!raw.trim()) return { ok: false }
  const { allowed } = parseAllowedOrigins([raw], { appHost })
  const first = allowed[0]
  return first ? { ok: true, origin: first.origin } : { ok: false }
}
