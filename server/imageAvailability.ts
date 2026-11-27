// Which image-generation models can really be called, without a paid call.
//
// Per model, a probe with the app's service principal token:
//  - serving endpoint: GET /api/2.0/serving-endpoints/<id>; READY is up, 404 or any other state is down;
//  - UC Model Provider Service: GET of the provider's metadata
//    (/api/2.1/unity-catalog/model-provider-services/<fqn>), one per provider; the target must be in
//    config.targets[].model, or config.allow_all_targets on.
// A probe that cannot tell (the SP has no grant, no token, a network failure, a 5xx) is 'unknown' and
// does NOT hide the model: the real call, made with the user's token, decides. checkWithUserToken
// repeats the provider read with a user's token (cached for `intervalMs`); only a 200 that lacks the
// target hides the model, since a user's 403/404 depends on their own grant: those answers are not
// cached, so an authorized user can still make their own check.
// A 404 on a generation (markUnavailable: a missing serving endpoint, provider or target) takes the model
// out until the process restarts: the periodic refresh does not bring it back.
// Before the first probe finished every model counts as available (a cold start never hides the tool).
import crypto from 'node:crypto'
import { appServiceToken } from './db.ts'
import {
  DEFAULT_IMAGE_MODEL,
  ENDPOINT_MISSING_CODES,
  getConfiguredImageModels,
  isImageModelId,
  isServingEndpointName,
  parseProviderImageModelId,
} from './llm.ts'

export const IMAGE_AVAILABILITY_INTERVAL_MS = 10 * 60 * 1000

/** IMAGE_GENERATION=off switches image generation off for the whole app. */
export function imageGenerationEnabled(value: string | undefined = process.env.IMAGE_GENERATION): boolean {
  return String(value || '').trim().toLowerCase() !== 'off'
}

// `imageModels: []` in models.json switches generation off like IMAGE_GENERATION=off
function defaultEnabled(): boolean {
  return imageGenerationEnabled() && getConfiguredImageModels()?.length !== 0
}

// The models of models.json or, without the key, the curated default.
function defaultEndpoints(): string[] {
  const configured = getConfiguredImageModels()
  return configured ? configured.map((m) => m.id) : [DEFAULT_IMAGE_MODEL]
}

export type ProbeStatus = 'ready' | 'missing' | 'unknown'

/** Result of reading a Model Provider Service for one target. */
export function providerTargetStatus(httpStatus: number, details: unknown, model: string): ProbeStatus {
  if (httpStatus === 404) return 'missing'
  if (httpStatus !== 200 || !details || typeof details !== 'object') return 'unknown'
  const d = details as { config?: Record<string, unknown> } & Record<string, unknown>
  const config = (d.config || d) as { allow_all_targets?: unknown; targets?: unknown }
  if (config.allow_all_targets === true) return 'ready'
  const targets = Array.isArray(config.targets) ? (config.targets as { model?: string }[]) : []
  return targets.some((t) => t?.model === model) ? 'ready' : 'missing'
}

/** Result of reading a serving endpoint: READY is up, 404 or another state is down, anything else unknown. */
export function servingStatus(httpStatus: number, details: unknown): ProbeStatus {
  if (httpStatus === 404) return 'missing'
  if (httpStatus !== 200 || !details || typeof details !== 'object') return 'unknown'
  const state = (details as { state?: { ready?: string } }).state
  return state?.ready === 'READY' ? 'ready' : 'missing'
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface ImageAvailabilityOpts {
  endpoints?: string[] | (() => string[])
  enabled?: boolean | (() => boolean)
  getToken?: () => Promise<string | null>
  fetchImpl?: FetchLike
  timeoutSignal?: (ms: number) => AbortSignal
  now?: () => number
  intervalMs?: number
}

export function createImageAvailability({
  endpoints = defaultEndpoints,
  enabled = defaultEnabled,
  getToken = appServiceToken,
  fetchImpl = (url, init) => fetch(url, init),
  timeoutSignal = (ms) => AbortSignal.timeout(ms),
  now = Date.now,
  intervalMs = IMAGE_AVAILABILITY_INTERVAL_MS,
}: ImageAvailabilityOpts = {}) {
  let status = new Map<string, ProbeStatus>() // id → probe result of the SP
  const userStatus = new Map<string, { status: ProbeStatus; at: number }>()
  // A user's own non-200 answer (the on-behalf-of token usually has no unity-catalog scope, so it is a 403) is
  // remembered for `intervalMs` PER USER (a hash of the token, never shared) so the next turns of that user
  // do not repeat the same failing GET on their critical path.
  const userInconclusive = new Map<string, number>()
  const userKey = (token: string, id: string): string => `${crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)}|${id}`
  const missing = new Set<string>() // 404 on a real generation: down until restart
  let probed = new Set<string>()
  let tracked: string[] = []
  let trackedKnown = false // the enabled catalog has been registered: from then on only it counts
  let checkedAt = 0
  let checkVersion = 0
  let pending: Promise<boolean> | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  const isEnabled = (): boolean => (typeof enabled === 'function' ? enabled() : enabled)
  const baseEndpoints = (): string[] => (typeof endpoints === 'function' ? endpoints() : endpoints) || []
  // Before the catalog is known (boot) the file/default models are probed; once it is, a model the admin
  // disabled (or the file dropped) stops counting, so it can neither keep the tool on nor be a fallback.
  const probeList = (): string[] => [...new Set((trackedKnown ? tracked : [...baseEndpoints(), ...tracked]).filter(isImageModelId))]
  const baseUrl = (): string => {
    const host = (process.env.DATABRICKS_HOST || '').replace(/\/$/, '')
    return host ? (host.startsWith('http') ? host : `https://${host}`) : ''
  }

  async function readJson(url: string, token: string): Promise<{ status: number; details: unknown }> {
    try {
      const response = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${token}` }, signal: timeoutSignal(10_000) })
      if (!response.ok) return { status: response.status, details: null }
      return { status: 200, details: await response.json() }
    } catch {
      return { status: 0, details: null }
    }
  }

  async function probeServing(base: string, token: string, name: string): Promise<ProbeStatus> {
    const r = await readJson(`${base}/api/2.0/serving-endpoints/${encodeURIComponent(name)}`, token)
    return servingStatus(r.status, r.details)
  }

  // one read per provider, a status per provider id
  // `userToken`: a non-200 answer (404 included) only says what THIS user may see, so it stays 'unknown'.
  async function probeProviders(base: string, token: string | null, ids: string[], userToken = false): Promise<Map<string, ProbeStatus>> {
    const byProvider = new Map<string, [string, string][]>()
    for (const id of ids) {
      const ref = parseProviderImageModelId(id)
      if (!ref) continue
      if (!byProvider.has(ref.provider)) byProvider.set(ref.provider, [])
      byProvider.get(ref.provider)!.push([id, ref.model])
    }
    const result = new Map<string, ProbeStatus>()
    await Promise.all(
      [...byProvider].map(async ([fqn, targets]) => {
        const r = token && base ? await readJson(`${base}/api/2.1/unity-catalog/model-provider-services/${encodeURIComponent(fqn)}`, token) : { status: 0, details: null }
        for (const [id, model] of targets) result.set(id, userToken && r.status !== 200 ? 'unknown' : providerTargetStatus(r.status, r.details, model))
      })
    )
    return result
  }

  async function refresh(): Promise<boolean> {
    if (!isEnabled()) {
      checkVersion++
      pending = null
      status = new Map()
      checkedAt = now()
      return false
    }
    if (pending) return pending
    const version = ++checkVersion
    pending = (async () => {
      const names = probeList()
      const servingNames = names.filter(isServingEndpointName)
      const providerIds = names.filter((id) => parseProviderImageModelId(id))
      const next = new Map<string, ProbeStatus>(names.map((id) => [id, 'unknown']))
      try {
        const token = await getToken()
        const base = baseUrl()
        const [servingResults, providerResults] = await Promise.all([
          token && base ? Promise.all(servingNames.map((name) => probeServing(base, token, name))) : [],
          probeProviders(base, token, providerIds),
        ])
        servingNames.forEach((name, i) => next.set(name, servingResults[i] ?? 'unknown'))
        for (const [id, s] of providerResults) next.set(id, s)
      } catch {
        // a probe that fails as a whole tells nothing: every model stays 'unknown'
      }
      if (version === checkVersion) {
        status = next
        probed = new Set(names)
        checkedAt = now()
      }
      return version === checkVersion ? readyIds().length > 0 : false
    })().finally(() => {
      if (version === checkVersion) pending = null
    })
    return pending
  }

  function freshUserStatus(id: string): ProbeStatus | null {
    const u = userStatus.get(id)
    return u && now() - u.at < intervalMs ? u.status : null
  }

  function isUp(id: string): boolean {
    if (missing.has(id)) return false
    // not probed yet (a cold start): do not hide anything
    const s = status.get(id)
    if (s === undefined) return !checkedAt
    if (s !== 'unknown') return s === 'ready'
    return freshUserStatus(id) !== 'missing'
  }

  // Reads again, with a user's token, the providers the SP could not read. true when it queried any.
  async function checkWithUserToken(token: string | null | undefined): Promise<boolean> {
    if (!token || !isEnabled()) return false
    const base = baseUrl()
    const at0 = now()
    for (const [k, t] of userInconclusive) if (at0 - t >= intervalMs) userInconclusive.delete(k)
    const ids = probeList().filter(
      (id) => parseProviderImageModelId(id) && status.get(id) === 'unknown' && freshUserStatus(id) === null && !userInconclusive.has(userKey(token, id))
    )
    if (!base || !ids.length) return false
    const result = await probeProviders(base, token, ids, true)
    const at = now()
    // only a 200 answer is cached for everyone; a user's 403/404 (or a failure) is not evidence about the target:
    // it is remembered for that user alone
    for (const [id, s] of result) {
      if (s !== 'unknown') userStatus.set(id, { status: s, at })
      else userInconclusive.set(userKey(token, id), at)
    }
    return true
  }

  function readyIds(): string[] {
    if (!isEnabled()) return []
    return probeList().filter(isUp)
  }

  // A 404 on a generation takes the model out until restart: a serving endpoint with a missing-endpoint
  // code, or a provider target with any 404 (the provider or the target does not exist). A 403 or another
  // error changes nothing.
  function markUnavailable(error: { status?: unknown; code?: unknown } | null | undefined, id: string | null | undefined): boolean {
    if (!id || Number(error?.status) !== 404) return false
    if (!parseProviderImageModelId(id) && !ENDPOINT_MISSING_CODES.includes(String(error?.code))) return false
    missing.add(id)
    return true
  }

  // Registers the image models enabled in the catalog; one that left the list stops counting at once
  // (and so do the file/default ones that are not enabled).
  // true when one of them has not been probed yet (the caller decides whether to refresh).
  function track(ids: string[] | null | undefined): boolean {
    tracked = [...new Set((ids || []).filter(isImageModelId))]
    trackedKnown = true
    return probeList().some((id) => !probed.has(id))
  }

  function start(): () => void {
    if (timer) return () => clearInterval(timer!)
    void refresh()
    timer = setInterval(() => void refresh(), intervalMs)
    timer.unref?.()
    return () => {
      if (timer) clearInterval(timer)
      timer = null
    }
  }

  return {
    refresh,
    checkWithUserToken,
    isAvailable: (): boolean => readyIds().length > 0,
    isReady: (id: string): boolean => readyIds().includes(id),
    readyIds,
    markUnavailable,
    track,
    start,
    get checkedAt(): number {
      return checkedAt
    },
  }
}

const imageAvailability = createImageAvailability()

export function refreshImageAvailability(): Promise<boolean> {
  return imageAvailability.refresh()
}

async function refreshImageAvailabilityIfStale(): Promise<boolean> {
  if (!imageAvailability.checkedAt || Date.now() - imageAvailability.checkedAt >= IMAGE_AVAILABILITY_INTERVAL_MS) {
    await imageAvailability.refresh()
  }
  return imageAvailability.isAvailable()
}

/**
 * Probes again when an enabled model has not been probed yet; otherwise only when the last probe went
 * stale. With `userToken`, the providers the SP could not read are checked with that user's token.
 */
export async function refreshImageAvailabilityFor(ids: string[], userToken: string | null = null): Promise<boolean> {
  if (imageAvailability.track(ids)) await imageAvailability.refresh()
  await refreshImageAvailabilityIfStale()
  if (userToken) await imageAvailability.checkWithUserToken(userToken).catch(() => false)
  return imageAvailability.isAvailable()
}

export function imageGenerationAvailable(): boolean {
  return imageAvailability.isAvailable()
}

export function imageModelReady(id: string): boolean {
  return imageAvailability.isReady(id)
}

export function markImageEndpointUnavailable(error: { status?: unknown; code?: unknown } | null | undefined, id: string | null | undefined): boolean {
  return imageAvailability.markUnavailable(error, id)
}

export function startImageAvailabilityMonitoring(): () => void {
  return imageAvailability.start()
}

type Ready = Iterable<string> | ((id: string) => boolean) | null | undefined
const readyCheck = (ready: Ready): ((id: string) => boolean) => {
  if (typeof ready === 'function') return ready
  const set = new Set(ready || [])
  return (id) => set.has(id)
}

/** The enabled models that are ready, in the order received. */
export function imageModelsForAvailability<T extends { id: string }>(models: T[] | null | undefined, ready: Ready = imageModelReady): T[] {
  const isReady = readyCheck(ready)
  return (models || []).filter((m) => isReady(m.id))
}

/** The choice counts only when it is on the list; otherwise the default does. */
export function resolveImageModelChoice(models: { id: string }[], requested: unknown, defaultId: string | null = models?.[0]?.id || null): string | null {
  return typeof requested === 'string' && models.some((m) => m.id === requested) ? requested : defaultId
}

/** Without `imageModels` in models.json the curated default stays preferred when listed; with the key the first one is. */
export function preferredImageModelId(): string | null {
  return getConfiguredImageModels() ? null : DEFAULT_IMAGE_MODEL
}

/**
 * Body of GET /api/image-models: `models` = enabled ∩ ready, in catalog order; `defaultId` = the preferred
 * one if listed, else the first; `selected` = the saved choice if listed, else `defaultId`.
 */
export function imageModelsResponse<T extends { id: string }>({
  models,
  ready = imageModelReady,
  saved = null,
  preferredId = null,
}: {
  models: T[]
  ready?: Ready
  saved?: string | null
  preferredId?: string | null
}) {
  const list = imageModelsForAvailability(models, ready)
  const defaultId = preferredId && list.some((m) => m.id === preferredId) ? preferredId : list[0]?.id || null
  return {
    models: list,
    selected: list.length ? resolveImageModelChoice(list, saved, defaultId) : null,
    defaultId,
    available: list.length > 0,
  }
}
