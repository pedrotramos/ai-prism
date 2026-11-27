// A2A data layer (migration 0019): the org catalog of remote agents and each user's sealed OAuth tokens.
//
// Every function runs inside withTx with the caller's identity, so RLS decides what it sees:
//   a2a_agents          any identity reads; the write functions open the admin flag themselves and each records its
//                       admin_audit row in the same transaction. The ROUTE decides who may call them (requireAdmin),
//                       exactly like server/db/admin.ts and server/db/mcpApps.ts.
//   a2a_oauth_tokens    the owner's rows only. The columns hold ciphertext (server/a2aAuth.ts seals them with the row
//                       identity as AAD); this module never sees a plaintext token.
// The per-(chat, agent) A2A conversation (contextId, and the taskId of an interrupted task) rides the table Genie
// uses (chat_genie_conversations: owner-scoped through the chat), under the key `a2a:<agent id>`.
import { actorHash, recordAdminAction } from '../audit.ts'
import { withTx } from './pool.ts'
import type { DbClient, Ident } from './pool.ts'
import { getOwnedGenieConversationId, setOwnedGenieConversation } from '../ownerScopedWrites.ts'
import type { TokenRow, TokenRowSummary, TokenStore } from '../a2aAuth.ts'

export type ConfigStatus = 'ok' | 'card_requires_auth' | 'invalid_card' | 'unavailable' | 'unknown'

/** The card summary kept with an agent (server/a2aClient.ts validateAgentCard). */
export interface CardSummary {
  name?: string
  description?: string
  version?: string
  provider?: string
  streaming?: boolean
  extendedAgentCard?: boolean
  securitySchemes?: { name: string; kind: string | null }[]
  skills?: { id: string; name: string; description: string; tags: string[]; examples: string[] }[]
}

export interface A2aAgentRow {
  id: string
  slug: string
  displayName: string
  cardUrl: string
  appName: string
  authStrategy: string
  authProvider: string | null
  card: CardSummary
  cardPublic: boolean
  enabled: boolean
  configStatus: ConfigStatus
  configError: string | null
  configCheckedAt: string | null
  addedByHash: string | null
  createdAt: string
}

const COLUMNS = `id::text AS id, slug, display_name, card_url, app_name, auth_strategy, auth_provider, card, card_public, enabled,
  config_status, config_error, config_checked_at, added_by_hash, created_at`

// pg rows are untyped
function toAgent(r: any): A2aAgentRow {
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    cardUrl: r.card_url,
    appName: r.app_name || '',
    authStrategy: r.auth_strategy,
    authProvider: r.auth_provider ?? null,
    card: (r.card || {}) as CardSummary,
    cardPublic: r.card_public === true,
    enabled: r.enabled !== false,
    configStatus: r.config_status,
    configError: r.config_error ?? null,
    configCheckedAt: r.config_checked_at ? new Date(r.config_checked_at).toISOString() : null,
    addedByHash: r.added_by_hash ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

const ID = /^\d{1,18}$/

/** Every agent of the catalog (the caller filters the disabled ones for a non-admin). */
export async function listA2aAgents(email: Ident, token: Ident): Promise<A2aAgentRow[]> {
  return withTx(email, token, async (c: DbClient) => (await c.query(`SELECT ${COLUMNS} FROM a2a_agents ORDER BY display_name ASC, id ASC`)).rows.map(toAgent))
}

export async function getA2aAgent(email: Ident, token: Ident, id: string): Promise<A2aAgentRow | null> {
  if (!ID.test(String(id))) return null
  return withTx(email, token, async (c: DbClient) => {
    const r = await c.query(`SELECT ${COLUMNS} FROM a2a_agents WHERE id = $1`, [id])
    return r.rows[0] ? toAgent(r.rows[0]) : null
  })
}

export interface NewA2aAgent {
  slug: string
  displayName: string
  cardUrl: string
  appName: string
  authStrategy: string
  authProvider: string | null
  card: CardSummary
  cardPublic: boolean
  enabled: boolean
  configStatus: ConfigStatus
  configError: string | null
}

/** Registers an agent and writes its audit row ('a2a.agent.add') in one transaction. Throws { code: '23505' } for a duplicate slug / card URL. */
export async function createA2aAgent(adminEmail: string, token: Ident, a: NewA2aAgent): Promise<A2aAgentRow> {
  return withTx(
    adminEmail,
    token,
    async (c: DbClient) => {
      const r = await c.query(
        `INSERT INTO a2a_agents (slug, display_name, card_url, app_name, auth_strategy, auth_provider, card, card_public, enabled,
                                 config_status, config_error, config_checked_at, added_by_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, NOW(), $12)
         RETURNING ${COLUMNS}`,
        [a.slug, a.displayName, a.cardUrl, a.appName, a.authStrategy, a.authProvider, JSON.stringify(a.card || {}), a.cardPublic, a.enabled, a.configStatus, a.configError, actorHash(adminEmail)]
      )
      await recordAdminAction(c, adminEmail, {
        action: 'a2a.agent.add',
        target: a.slug,
        details: { authStrategy: a.authStrategy, authProvider: a.authProvider, enabled: a.enabled, configStatus: a.configStatus },
      })
      return toAgent(r.rows[0])
    },
    { admin: true }
  )
}

export interface CatalogPatch {
  enabled?: boolean
  displayName?: string
  card?: CardSummary
  cardPublic?: boolean
  configStatus?: ConfigStatus
  configError?: string | null
}

/** Changes the catalog's own fields (enabled, the configuration check's outcome) and writes ONE audit row ('a2a.agent.update'). */
export async function updateA2aCatalogEntry(adminEmail: string, token: Ident, id: string, patch: CatalogPatch): Promise<A2aAgentRow | null> {
  if (!ID.test(String(id))) return null
  return withTx(
    adminEmail,
    token,
    async (c: DbClient) => {
      const sets: string[] = []
      const params: unknown[] = [id]
      const add = (col: string, v: unknown, cast = '') => {
        params.push(v)
        sets.push(`${col} = $${params.length}${cast}`)
      }
      if (patch.enabled !== undefined) add('enabled', patch.enabled)
      if (patch.displayName !== undefined) add('display_name', patch.displayName)
      if (patch.card !== undefined) add('card', JSON.stringify(patch.card), '::jsonb')
      if (patch.cardPublic !== undefined) add('card_public', patch.cardPublic)
      if (patch.configStatus !== undefined) {
        add('config_status', patch.configStatus)
        sets.push('config_checked_at = NOW()')
      }
      if (patch.configError !== undefined) add('config_error', patch.configError)
      if (!sets.length) {
        const r = await c.query(`SELECT ${COLUMNS} FROM a2a_agents WHERE id = $1`, [id])
        return r.rows[0] ? toAgent(r.rows[0]) : null
      }
      sets.push('updated_at = NOW()')
      const r = await c.query(`UPDATE a2a_agents SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`, params)
      if (!r.rows[0]) return null
      const row = toAgent(r.rows[0])
      await recordAdminAction(c, adminEmail, {
        action: 'a2a.agent.update',
        target: row.slug,
        details: { enabled: patch.enabled, configStatus: patch.configStatus },
      })
      return row
    },
    { admin: true }
  )
}

/** Removes an agent and writes its audit row ('a2a.agent.remove'). False when it does not exist. */
export async function deleteA2aAgent(adminEmail: string, token: Ident, id: string): Promise<boolean> {
  if (!ID.test(String(id))) return false
  return withTx(
    adminEmail,
    token,
    async (c: DbClient) => {
      const r = await c.query(`DELETE FROM a2a_agents WHERE id = $1 RETURNING slug`, [id])
      if (!r.rows[0]) return false
      await recordAdminAction(c, adminEmail, { action: 'a2a.agent.remove', target: r.rows[0].slug, details: {} })
      return true
    },
    { admin: true }
  )
}

// ---- the user's sealed OAuth tokens (TokenStore of the vault) ----------------------------------

const TOKEN_COLUMNS = `access_token_enc, refresh_token_enc, id_token_enc, expires_at, scope, idp_email_verified, external_subject_hmac`

function toTokenRow(r: any): TokenRow {
  return {
    accessTokenEnc: r.access_token_enc,
    refreshTokenEnc: r.refresh_token_enc ?? null,
    idTokenEnc: r.id_token_enc ?? null,
    expiresAt: r.expires_at ?? null,
    scope: r.scope || '',
    idpEmailVerified: r.idp_email_verified === true,
    externalSubjectHmac: r.external_subject_hmac || '',
  }
}

/** The vault's row store over Postgres: every statement runs under the caller's identity AND filters on it. */
export const a2aTokenStore: TokenStore = {
  async get(email, token, providerId) {
    return withTx(email, token, async (c: DbClient) => {
      const r = await c.query(`SELECT ${TOKEN_COLUMNS} FROM a2a_oauth_tokens WHERE user_email = $1 AND provider_id = $2`, [email, providerId])
      return r.rows[0] ? toTokenRow(r.rows[0]) : null
    })
  },
  async put(email, token, providerId, row) {
    await withTx(email, token, async (c: DbClient) => {
      await c.query(
        `INSERT INTO a2a_oauth_tokens (user_email, provider_id, access_token_enc, refresh_token_enc, id_token_enc, expires_at, scope, idp_email_verified, external_subject_hmac)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_email, provider_id) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
           id_token_enc = EXCLUDED.id_token_enc, expires_at = EXCLUDED.expires_at, scope = EXCLUDED.scope,
           idp_email_verified = EXCLUDED.idp_email_verified, external_subject_hmac = EXCLUDED.external_subject_hmac, updated_at = NOW()`,
        [email, providerId, row.accessTokenEnc, row.refreshTokenEnc, row.idTokenEnc, row.expiresAt, row.scope, row.idpEmailVerified, row.externalSubjectHmac]
      )
    })
  },
  async updateIfMatches(email, token, providerId, expectedAccessTokenEnc, row) {
    return withTx(email, token, async (c: DbClient) => {
      const r = await c.query(
        `UPDATE a2a_oauth_tokens SET access_token_enc = $4, refresh_token_enc = $5, id_token_enc = $6, expires_at = $7, scope = $8,
                idp_email_verified = $9, external_subject_hmac = $10, updated_at = NOW()
          WHERE user_email = $1 AND provider_id = $2 AND access_token_enc = $3`,
        [email, providerId, expectedAccessTokenEnc, row.accessTokenEnc, row.refreshTokenEnc, row.idTokenEnc, row.expiresAt, row.scope, row.idpEmailVerified, row.externalSubjectHmac]
      )
      return r.rowCount || 0
    })
  },
  async remove(email, token, providerId) {
    await withTx(email, token, async (c: DbClient) => {
      await c.query(`DELETE FROM a2a_oauth_tokens WHERE user_email = $1 AND provider_id = $2`, [email, providerId])
    })
  },
  async list(email, token) {
    return withTx(email, token, async (c: DbClient): Promise<TokenRowSummary[]> => {
      const r = await c.query(`SELECT provider_id, ${TOKEN_COLUMNS} FROM a2a_oauth_tokens WHERE user_email = $1`, [email])
      return r.rows.map((x: any) => ({ ...toTokenRow(x), providerId: x.provider_id as string }))
    })
  },
}

// ---- the per-(chat, agent) conversation ------------------------------------------------------------

export interface A2aContext {
  contextId: string
  taskId: string
}

export const a2aContextKey = (agentId: string): string => `a2a:${agentId}`

export async function getA2aContext(email: Ident, token: Ident, sessionId: string | number, agentId: string): Promise<A2aContext | null> {
  const v = await withTx(email, token, (c: DbClient) => getOwnedGenieConversationId(c, email, sessionId, a2aContextKey(agentId)))
  if (!v) return null
  try {
    const o = JSON.parse(v) as { c?: string; t?: string }
    return { contextId: o.c || '', taskId: o.t || '' }
  } catch {
    return { contextId: v, taskId: '' }
  }
}

export async function setA2aContext(email: Ident, token: Ident, sessionId: string | number, agentId: string, { contextId, taskId }: A2aContext): Promise<void> {
  await withTx(email, token, async (c: DbClient) => {
    await setOwnedGenieConversation(c, email, sessionId, a2aContextKey(agentId), JSON.stringify({ c: contextId || '', t: taskId || '' }))
  })
}
