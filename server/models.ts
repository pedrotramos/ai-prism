// The user-facing chat model list (admin-curated overrides over the static
// MODELS catalog), cached per process, and validation of a requested model id.
import { listModelOverrides, clearModelOverridePrices, getSelectedImageModel } from './db.ts'
import { MODELS, setDefaultChatModelSource } from './llm.ts'
import { modelsConfigSyncPending, syncModelsConfigOnce } from './modelsConfig.ts'
import { setPriceOverrides } from './usage.ts'
import { buildUserModels, buildUserImageModels, staleSeededPriceIds } from './serving.ts'
import { imageModelsResponse, imageModelReady, preferredImageModelId, refreshImageAvailabilityFor } from './imageAvailability.ts'
import { ensureReady } from './middleware/ensureReady.ts'
import { isAdmin } from './authz.ts'
import { logger } from './log.ts'

// the request fields the catalog code reads (an Express request in the app)
interface ModelsReq {
  email: string
  token: string
  isAdmin?: boolean
}
type CatalogModel = (typeof MODELS)[number] | ReturnType<typeof buildUserModels>[number]

// Cache of the user-facing model list (enabled-only, admin-curated). Refreshed
// from model_catalog_overrides; a short TTL keeps a newly-enabled model showing
// up quickly without a DB hit on every chat turn. Falls back to static MODELS.
let userModelsCache: { list: CatalogModel[]; ids: Set<string>; ts: number } = { list: MODELS, ids: new Set(MODELS.map((m) => m.id)), ts: 0 }
const USER_MODELS_TTL_MS = 30 * 1000
// the auxiliary calls (title, intent, memory) fall back to the first enabled model when a turn names none
setDefaultChatModelSource(() => userModelsCache.list[0]?.id)

// The deployer's models file, applied by the first ADMIN request to the admin catalog route (the catalog
// is admin-write, and that route is the one the audit map lists for model_endpoints.config_apply); until
// then the picker follows the catalog (or the file's list on a fresh install).
async function applyModelsConfig(req: ModelsReq): Promise<void> {
  if (!modelsConfigSyncPending()) return
  const admin = req.isAdmin === true || (await isAdmin(req.email, req.token).catch(() => false))
  if (admin && (await syncModelsConfigOnce(req.email, req.token, { admin: true }))) invalidateUserModels()
}

// Once per process: undo curated prices the pre-1.4 seed froze into the
// catalog, so a corrected price in MODELS reaches already-installed orgs.
// model_catalog_overrides is an admin table (row-level security, 0003): only a
// request of an admin can write it, so this runs on the first admin request
// (the admin catalog tab or any admin's model list) and is marked done only
// after it ran. Best-effort — a failure only means stale prices stay.
let seededPricesReconciled = false
// `overrides` is the db.js model_catalog_overrides map (untyped JS) and is handed back as is
export async function reconcileSeededPrices(req: ModelsReq, overrides: any) {
  if (seededPricesReconciled) return overrides
  const ids = staleSeededPriceIds(overrides)
  if (!ids.length) {
    seededPricesReconciled = true
    return overrides
  }
  const admin = req.isAdmin === true || (await isAdmin(req.email, req.token).catch(() => false))
  if (!admin) return overrides
  try {
    await clearModelOverridePrices(req.email, req.token, ids, { admin: true })
    seededPricesReconciled = true
    return await listModelOverrides(req.email, req.token)
  } catch (e) {
    logger.warn('seeded price reconcile failed', { err: e })
    return overrides
  }
}

export { applyModelsConfig }

export async function getUserModels(req: ModelsReq) {
  if (Date.now() - userModelsCache.ts < USER_MODELS_TTL_MS) return userModelsCache.list
  try {
    await ensureReady(req)
    const overrides = await reconcileSeededPrices(req, await listModelOverrides(req.email, req.token))
    setPriceOverrides(overrides) // the cost ledger prices with the same catalog
    const list = buildUserModels(overrides)
    userModelsCache = { list, ids: new Set(list.map((m) => m.id)), ts: Date.now() }
  } catch (e) {
    // never fail the picker — keep whatever we last had (or static MODELS)
    userModelsCache = { ...userModelsCache, ts: Date.now() }
  }
  return userModelsCache.list
}

// Validate a requested model id against the enabled set (falls back to the
// default). Uses the cache populated by getUserModels — call after it, or it
// simply allows only what was last cached (safe: worst case the default).
export function resolveModelId(requested?: unknown) {
  const def = userModelsCache.list[0]?.id || MODELS[0]!.id
  if (typeof requested !== 'string' || !requested) return def
  return userModelsCache.ids.has(requested) ? requested : def
}

// Forces the next getUserModels() to reload the catalog (after an admin edit).
export function invalidateUserModels() {
  userModelsCache.ts = 0
}

// What the image picker reads from outside (the database and the availability monitor); a test swaps them.
export interface ImageModelsDeps {
  listOverrides: (req: ModelsReq) => Promise<Parameters<typeof buildUserImageModels>[0]>
  getSelected: (req: ModelsReq) => Promise<string | null>
  refreshFor: (ids: string[], userToken: string | null) => Promise<boolean>
  isReady: (id: string) => boolean
}
const imageModelsDeps: ImageModelsDeps = {
  listOverrides: (req) => listModelOverrides(req.email, req.token).catch(() => ({})),
  getSelected: (req) => getSelectedImageModel(req.email, req.token).catch(() => null),
  refreshFor: (ids, userToken) => refreshImageAvailabilityFor(ids, userToken),
  isReady: imageModelReady,
}

/**
 * The image-model picker of a user: the enabled models that are ready, the default, and the saved
 * choice when it is still on the list (`saved` overrides what is read from the database, `null` skips
 * it). Availability is probed (cached) on the way, with the user's token for the providers the app's
 * service principal cannot read.
 */
export async function imageModelsFor(req: ModelsReq, { saved }: { saved?: string | null } = {}, deps: ImageModelsDeps = imageModelsDeps) {
  const enabled = buildUserImageModels(await deps.listOverrides(req))
  await deps.refreshFor(enabled.map((m) => m.id), req.token).catch(() => false)
  const choice = saved !== undefined ? saved : await deps.getSelected(req)
  return imageModelsResponse({ models: enabled, saved: choice, preferredId: preferredImageModelId(), ready: deps.isReady })
}

/**
 * The image model a turn generates with: the client's per-turn choice or the user's saved one while it
 * is on the list of enabled, ready models, else the default (the first listed; the curated default when
 * no models.json speaks for images). undefined when no enabled model is ready: the turn then offers no
 * image tool. The enabled catalog is registered and probed here, so a model enabled a moment ago needs
 * no picker request first.
 */
export async function resolveImageModelForTurn(req: ModelsReq, requested?: string | null, deps: ImageModelsDeps = imageModelsDeps): Promise<string | undefined> {
  const saved = requested || (await deps.getSelected(req))
  const { selected } = await imageModelsFor(req, { saved }, deps)
  return selected || undefined
}
