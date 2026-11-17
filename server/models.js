// The user-facing chat model list (admin-curated overrides over the static
// MODELS catalog), cached per process, and validation of a requested model id.
import { listModelOverrides, clearModelOverridePrices } from './db.js'
import { MODELS } from './llm.js'
import { setPriceOverrides } from './usage.js'
import { buildUserModels, staleSeededPriceIds } from './serving.js'
import { ensureReady } from './middleware/ensureReady.js'

// Cache of the user-facing model list (enabled-only, admin-curated). Refreshed
// from model_catalog_overrides; a short TTL keeps a newly-enabled model showing
// up quickly without a DB hit on every chat turn. Falls back to static MODELS.
let userModelsCache = { list: MODELS, ids: new Set(MODELS.map((m) => m.id)), ts: 0 }
const USER_MODELS_TTL_MS = 30 * 1000

// Once per process: undo curated prices the pre-1.4 seed froze into the
// catalog, so a corrected price in MODELS reaches already-installed orgs
// without an admin action. Best-effort — a failure only means stale prices stay.
let seededPricesReconciled = false
export async function reconcileSeededPrices(req, overrides) {
  if (seededPricesReconciled) return overrides
  seededPricesReconciled = true
  const ids = staleSeededPriceIds(overrides)
  if (!ids.length) return overrides
  try {
    await clearModelOverridePrices(req.email, req.token, ids)
    return await listModelOverrides(req.email, req.token)
  } catch (e) {
    console.warn('seeded price reconcile failed:', e.message)
    return overrides
  }
}

export async function getUserModels(req) {
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
export function resolveModelId(requested) {
  const def = userModelsCache.list[0]?.id || MODELS[0].id
  if (typeof requested !== 'string' || !requested) return def
  return userModelsCache.ids.has(requested) ? requested : def
}

// Forces the next getUserModels() to reload the catalog (after an admin edit).
export function invalidateUserModels() {
  userModelsCache.ts = 0
}
