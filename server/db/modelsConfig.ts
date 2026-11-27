// Applies the deploy-time models.json to the model catalog (server/modelsConfig.ts).
//
// The catalog is model_catalog_overrides (global table, admin-write under row-level security), so
// this runs with the admin flag. The content hash of the last applied file lives in app_settings
// (key models_json_hash, jsonb string), so a restart or a second instance does not apply it again,
// and an edit made in the admin tab survives until the file changes. The apply and its admin_audit
// row share one transaction.
import { withTx } from './pool.ts'
import type { DbClient, Ident } from './pool.ts'
import { actorHash, recordAdminAction } from '../audit.ts'

export const MODELS_JSON_HASH_KEY = 'models_json_hash'
export const MODELS_JSON_UPDATED_BY = 'models.json'

/** One model of the file as a catalog row (`provider`/`model` only on an image model of a Model Provider Service). */
export interface ModelConfigRow {
  id: string
  displayName: string
  blurb: string
  sortOrder: number
  priceIn: number | null
  priceOut: number | null
  provider?: string
  model?: string
}

interface ApplyInput {
  rows: ModelConfigRow[]
  imageRows: ModelConfigRow[] | null
  hash: string
  /** the ids the file turns off among the enabled ones */
  toDisable: (enabledIds: string[]) => string[]
}

/**
 * Applies the file when its hash differs from the stored one; true when it changed the catalog.
 *
 * Normal apply (the file changed, or the catalog was empty): the listed models are enabled with the
 * file's order and, where it gives them, name, description and price (what the file omits keeps the
 * value an admin set, or follows the curated one), and the enabled ones it does not list are disabled.
 * First apply on a catalog an admin already curated (no stored hash, rows exist): additive only; rows
 * the file lists and the catalog lacks are inserted DISABLED (visible in the admin tab, off for users),
 * nothing else changes, so it never silently drops or adds a model an org was using.
 */
export async function applyModelCatalogConfig(userEmail: Ident, userToken: Ident, input: ApplyInput): Promise<boolean> {
  return withTx(userEmail, userToken, (c: DbClient) => applyConfigOn(c, userEmail, input), { admin: true })
}

/** The apply on an open transaction (exported for the tests, which hand it a stand-in client). */
export async function applyConfigOn(c: DbClient, userEmail: Ident, { rows, imageRows, hash, toDisable }: ApplyInput): Promise<boolean> {
  const prev = await c.query(`SELECT value FROM app_settings WHERE key = $1`, [MODELS_JSON_HASH_KEY])
  if (prev.rows[0]?.value === hash) return false
  const existing = await c.query(`SELECT endpoint_id, enabled FROM model_catalog_overrides`)
  const additive = prev.rows.length === 0 && existing.rows.length > 0
  const known = new Set<string>(existing.rows.map((x: { endpoint_id: string }) => x.endpoint_id))
  const disabled = additive ? [] : toDisable(existing.rows.filter((x: { enabled: boolean }) => x.enabled).map((x: { endpoint_id: string }) => x.endpoint_id))
  if (disabled.length) {
    await c.query(`UPDATE model_catalog_overrides SET enabled = false, updated_by = $2, updated_at = NOW() WHERE endpoint_id = ANY($1)`, [disabled, MODELS_JSON_UPDATED_BY])
  }
  const upsert = additive
    ? `INSERT INTO model_catalog_overrides (endpoint_id, enabled, display_name, blurb, sort_order, price_in, price_out, updated_by, updated_at)
         VALUES ($1, FALSE, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (endpoint_id) DO NOTHING`
    : `INSERT INTO model_catalog_overrides (endpoint_id, enabled, display_name, blurb, sort_order, price_in, price_out, updated_by, updated_at)
         VALUES ($1, TRUE, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (endpoint_id) DO UPDATE SET
         enabled = TRUE,
         display_name = COALESCE(EXCLUDED.display_name, model_catalog_overrides.display_name),
         blurb = COALESCE(EXCLUDED.blurb, model_catalog_overrides.blurb),
         sort_order = EXCLUDED.sort_order,
         price_in = COALESCE(EXCLUDED.price_in, model_catalog_overrides.price_in),
         price_out = COALESCE(EXCLUDED.price_out, model_catalog_overrides.price_out),
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`
  for (const r of [...rows, ...(imageRows || [])]) {
    await c.query(upsert, [r.id, r.displayName || null, r.blurb || null, r.sortOrder, r.priceIn, r.priceOut, MODELS_JSON_UPDATED_BY])
  }
  await c.query(
    `INSERT INTO app_settings (key, value, updated_by_hash, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_hash = EXCLUDED.updated_by_hash, updated_at = NOW()`,
    [MODELS_JSON_HASH_KEY, JSON.stringify(hash), actorHash(userEmail)]
  )
  await recordAdminAction(c, userEmail, {
    action: 'model_endpoints.config_apply',
    target: MODELS_JSON_UPDATED_BY,
    details: {
      hash,
      chat: rows.length,
      image: imageRows ? imageRows.length : null,
      mode: additive ? 'additive' : 'full',
      disabled: disabled.length,
      inserted: [...rows, ...(imageRows || [])].filter((r) => !known.has(r.id)).length,
    },
  })
  return true
}
