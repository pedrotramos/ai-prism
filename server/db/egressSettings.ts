// The admin allowlist of remote asset origins (md-exfil T2, decision D42): app_settings.external_asset_origins, a jsonb array of
// origin strings; an absent key is empty. No DDL: the table is key -> jsonb (migration 0007), everyone reads it and a write needs the
// admin flag (RLS), the same shape as mcp_apps_enabled (server/db/mcpApps.ts). The write and its admin_audit row ('egress.settings')
// share one transaction.
import { withTx } from './pool.ts'
import type { DbClient } from './pool.ts'
import { actorHash, recordAdminAction } from '../audit.ts'

export const EXTERNAL_ASSET_ORIGINS_KEY = 'external_asset_origins'

/** The stored list (strings only; validation is the reader's job). Any identity, or none, may read it. */
export async function readExternalAssetOrigins(c: DbClient): Promise<string[]> {
  const r = await c.query(`SELECT value FROM app_settings WHERE key = $1`, [EXTERNAL_ASSET_ORIGINS_KEY])
  const v = r.rows[0]?.value
  return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string') : []
}

/** The body of the write, on a client already bound to the admin identity (so tests can drive it under RLS). */
export async function writeExternalAssetOriginsTx(c: DbClient, adminEmail: string, origins: readonly string[]): Promise<void> {
  await c.query(
    `INSERT INTO app_settings (key, value, updated_by_hash, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_hash = EXCLUDED.updated_by_hash, updated_at = NOW()`,
    [EXTERNAL_ASSET_ORIGINS_KEY, JSON.stringify(origins), actorHash(adminEmail)]
  )
  await recordAdminAction(c, adminEmail, { action: 'egress.settings', target: 'app_settings', details: { origins: [...origins] } })
}

/** Writes the list and ONE audit row in one transaction (the admin flag is what RLS checks). */
export async function writeExternalAssetOrigins(adminEmail: string, token: string | null, origins: readonly string[], { admin }: { admin: boolean }): Promise<void> {
  await withTx(adminEmail, token, (c: DbClient) => writeExternalAssetOriginsTx(c, adminEmail, origins), { admin })
}
