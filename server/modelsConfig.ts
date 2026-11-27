// models.json → model catalog (model_catalog_overrides).
//
// The file at the root of the app's code says WHICH chat models the picker shows, in which order (the
// first is the default of new chats) and with which name/description/price; the optional `imageModels`
// key does the same for the image-generation picker (serving endpoints and Model Provider Service
// targets of Unity Catalog). Without the key the image models are not touched; `[]` turns image
// generation off. No file at all = the catalog follows the admin tab alone, as before.
//
// The file is applied by an ADMIN request (the catalog tables are admin-write under row-level
// security), once per process and only when the content hash changed since the last apply, so edits
// made in the admin tab stay until the next deploy that changes the file. The deploy's smoke runs as
// the deployer, who is the bootstrap admin, so the first deploy applies it. The first apply on a
// catalog an admin already curated is additive (rows the file lists and the catalog lacks are
// inserted; nothing is enabled, disabled, renamed or reordered), so installing this version never
// silently drops a model an org was using.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  isModelProviderServiceName,
  isProviderTargetName,
  isServingEndpointName,
  providerImageModelId,
  setConfiguredImageModels,
  setConfiguredChatModels,
  type ConfiguredImageModel,
} from './llm.ts'
import { deriveModality } from './serving.ts'
import { applyModelCatalogConfig } from './db/modelsConfig.ts'
import type { ModelConfigRow } from './db/modelsConfig.ts'
import { logger } from './log.ts'

export type ModelsConfig = {
  rows: ModelConfigRow[]
  /** null = no `imageModels` key */
  imageRows: ModelConfigRow[] | null
  hash: string
}

function configPath(): string {
  return process.env.MODELS_CONFIG_PATH || path.join(process.cwd(), 'models.json')
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
type Json = Record<string, unknown>

// An `imageModels` entry is one of two kinds: `{ id }` (a serving endpoint) or `{ provider, model }` (a
// Model Provider Service of Unity Catalog, whose internal id is derived by providerImageModelId). An
// entry with both, or with a name outside the grammar, is left out (scripts/validate-models-config.mjs
// refuses it at deploy time; this is the runtime backstop).
function imageEntry(m: Json | null | undefined): { id: string; provider?: string; model?: string; error?: string } {
  const hasProvider = m?.provider != null || m?.model != null
  if (m?.id != null && hasProvider) return { id: '', error: 'has "id" and "provider"/"model" at once' }
  if (hasProvider) {
    const provider = text(m?.provider, 800)
    const model = text(m?.model, 100)
    if (!isModelProviderServiceName(provider) || !isProviderTargetName(model)) {
      return { id: '', error: `has an invalid provider/model ${JSON.stringify(`${provider}/${model}`).slice(0, 120)}` }
    }
    return { id: providerImageModelId(provider, model), provider, model }
  }
  const id = text(m?.id, 200)
  if (!id) return { id: '' }
  if (!isServingEndpointName(id)) return { id: '', error: `ignores the id ${JSON.stringify(id).slice(0, 80)} (not a serving endpoint name)` }
  return { id }
}

/** The `imageModels` list as catalog rows; null when the key is absent or not a list. Exported for tests. */
export function normalizeImageModels(list: unknown, chatIds: Set<string>): ModelConfigRow[] | null {
  if (!Array.isArray(list)) return null
  const seen = new Set<string>()
  const rows: ModelConfigRow[] = []
  for (const m of list as Json[]) {
    const entry = imageEntry(m)
    if (entry.error) {
      logger.warn(`models.json: imageModels ${entry.error}`)
      continue
    }
    const { id } = entry
    if (!id || seen.has(id) || chatIds.has(id)) continue
    seen.add(id)
    const row: ModelConfigRow = { id, displayName: text(m.label, 120), blurb: text(m.blurb, 300), sortOrder: rows.length, priceIn: null, priceOut: null }
    if (entry.provider) Object.assign(row, { provider: entry.provider, model: entry.model })
    rows.push(row)
  }
  return rows
}

/** Parses a models.json document into catalog rows + content hash; null when it lists no chat model. */
export function parseModelsConfig(raw: string): ModelsConfig | null {
  const parsed = JSON.parse(raw) as Json
  const rows: ModelConfigRow[] = (Array.isArray(parsed?.models) ? (parsed.models as Json[]) : [])
    .filter((m) => m && typeof m.id === 'string' && m.id.trim())
    .map((m, i) => ({
      id: (m.id as string).trim(),
      displayName: typeof m.label === 'string' ? m.label.slice(0, 120) : '',
      blurb: typeof m.blurb === 'string' ? m.blurb.slice(0, 300) : '',
      sortOrder: i,
      priceIn: typeof m.priceIn === 'number' && m.priceIn >= 0 ? m.priceIn : null,
      priceOut: typeof m.priceOut === 'number' && m.priceOut >= 0 ? m.priceOut : null,
    }))
  if (!rows.length) return null
  // null = key absent; the hash of a file without `imageModels` covers `models` alone
  const imageRows = normalizeImageModels(parsed.imageModels, new Set(rows.map((r) => r.id)))
  const hashed = imageRows ? { models: rows, imageModels: imageRows } : rows
  const hash = crypto.createHash('sha256').update(JSON.stringify(hashed)).digest('hex').slice(0, 16)
  return { rows, imageRows, hash }
}

/** The models.json of this process (MODELS_CONFIG_PATH or ./models.json); null when absent. Throws on invalid JSON. */
export function loadModelsConfig(): ModelsConfig | null {
  let raw: string
  try {
    raw = fs.readFileSync(configPath(), 'utf8')
  } catch {
    return null // no file → the catalog follows the admin tab alone
  }
  return parseModelsConfig(raw)
}

/**
 * Loads the file at boot and registers its models (chat order for a fresh catalog, image list for the
 * picker and the availability probe). An unreadable file counts as absent.
 */
export function bootModelsConfig(): ModelsConfig | null {
  let cfg: ModelsConfig | null = null
  try {
    cfg = loadModelsConfig()
  } catch (e) {
    logger.warn('models.json: invalid file, ignored', { err: e })
  }
  booted = cfg !== null
  synced = false
  syncPromise = null
  setConfiguredChatModels(cfg ? cfg.rows.map((r) => ({ id: r.id, label: r.displayName, blurb: r.blurb })) : null)
  setConfiguredImageModels(
    cfg?.imageRows
      ? cfg.imageRows.map((r): ConfiguredImageModel => ({ id: r.id, label: r.displayName, blurb: r.blurb, provider: r.provider, model: r.model }))
      : null
  )
  return cfg
}

/**
 * Ids enabled in the catalog that the file turns off: the chat models outside `models` and, when
 * `imageModels` exists, the image models outside it. Without the key, no image model is turned off.
 */
export function overridesToDisable(enabledIds: string[], cfg: Pick<ModelsConfig, 'rows' | 'imageRows'>, isImage: (id: string) => boolean = (id) => deriveModality(id) === 'image'): string[] {
  const chatIds = new Set(cfg.rows.map((r) => r.id))
  const imageIds = new Set((cfg.imageRows || []).map((r) => r.id))
  return enabledIds.filter((id) => {
    if (chatIds.has(id) || imageIds.has(id)) return false
    return isImage(id) ? cfg.imageRows !== null : true
  })
}

let syncPromise: Promise<boolean> | null = null
let booted = false // a models.json was loaded at boot
let synced = false // this process already compared it with the catalog (applied or unchanged)

/** Whether the file still has to be compared with the catalog by an admin request (cheap: two flags). */
export function modelsConfigSyncPending(): boolean {
  return booted && !synced
}

/** Test hook: forget that the file was applied by this process. */
export function resetModelsConfigSync(): void {
  syncPromise = null
  synced = false
}

/**
 * Applies the file to the catalog: once per process (a latch), by an ADMIN request (`admin` is the
 * server-side proof from requireAdmin/isAdmin, never read from the request). A failure never breaks the
 * request and is retried by the next admin one.
 */
export function syncModelsConfigOnce(userEmail: string, userToken: string, { admin }: { admin: boolean }): Promise<boolean> {
  if (!admin) return Promise.resolve(false)
  if (!syncPromise) {
    syncPromise = (async () => {
      const cfg = loadModelsConfig()
      if (!cfg) {
        synced = true
        return false
      }
      const applied = await applyModelCatalogConfig(userEmail, userToken, {
        rows: cfg.rows,
        imageRows: cfg.imageRows,
        hash: cfg.hash,
        toDisable: (enabledIds) => overridesToDisable(enabledIds, cfg),
      })
      synced = true
      if (applied) logger.info(`models.json applied (${cfg.rows.length} chat models${cfg.imageRows ? `, ${cfg.imageRows.length} image models` : ''}, hash ${cfg.hash})`)
      return applied
    })().catch((e) => {
      logger.warn('models.json: could not be applied', { err: e })
      syncPromise = null // the next admin request tries again
      return false
    })
  }
  return syncPromise
}
