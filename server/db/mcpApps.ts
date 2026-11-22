// MCP Apps data (W4-5, migration 0016): the admin setting and the read of one tool call's UI resource.
//
// The setting is app_settings.mcp_apps_enabled (jsonb boolean, absent = off). Everyone may read it (the chat asks whether to show the
// placeholder); a write needs the admin flag and records its admin_audit row in the same transaction.
// The UI resource lives in chat_tool_calls.ui_resource. It is read ONLY by getUiToolCall (the view and context routes): the sessions
// payload (server/db.ts) selects `has_ui`, the service name and the declared domains, never the HTML.
import { withTx } from './pool.ts'
import type { DbClient } from './pool.ts'
import { actorHash, recordAdminAction } from '../audit.ts'
import { sessionAccessSql } from '../ownerScopedWrites.ts'
import type { UiResourceRecord } from '../mcpApps.ts'

export const MCP_APPS_SETTING_KEY = 'mcp_apps_enabled'

/** A tool call that carries an App, as the routes read it. */
export interface UiToolCall {
  id: string
  sessionId: string
  callId: string | null
  toolName: string
  args: unknown
  result: string | null
  status: string
  ui: UiResourceRecord
}

/**
 * One tool call with its UI resource, only when the caller may read its chat: the owner of a personal chat, or a member of the
 * project a project chat belongs to (the same rule as the sessions payload). $1 = the tool call id, $2 = the caller's e-mail.
 * A row with no UI resource is not a view: it returns nothing.
 */
export const GET_UI_TOOL_CALL_SQL = `SELECT tc.id::text AS id, m.session_id::text AS session_id, tc.call_id, tc.tool_name, tc.arguments, tc.result, tc.status, tc.ui_resource
  FROM chat_tool_calls tc
  JOIN chat_messages m ON m.id = tc.message_id
  JOIN chat_sessions s ON s.id = m.session_id AND ${sessionAccessSql('s', '$2')}
 WHERE tc.id = $1 AND tc.ui_resource IS NOT NULL`

const ID = /^\d{1,18}$/

export async function getUiToolCall(email: string, token: string | null, id: string): Promise<UiToolCall | null> {
  if (!ID.test(String(id))) return null
  return withTx(email, token, async (c: DbClient) => {
    const r = await c.query(GET_UI_TOOL_CALL_SQL, [id, email])
    const x = r.rows[0]
    if (!x) return null
    return { id: x.id, sessionId: x.session_id, callId: x.call_id ?? null, toolName: x.tool_name, args: x.arguments, result: x.result ?? null, status: x.status, ui: x.ui_resource as UiResourceRecord } satisfies UiToolCall
  })
}

/** The admin's switch. Any identity may read it. */
export async function readMcpAppsSetting(email: string, token: string | null): Promise<boolean> {
  return withTx(email, token, async (c: DbClient) => {
    const r = await c.query(`SELECT value FROM app_settings WHERE key = $1`, [MCP_APPS_SETTING_KEY])
    return r.rows[0]?.value === true
  })
}

/** Writes the switch and ONE audit row ('mcp_apps.settings') in one transaction. */
export async function writeMcpAppsSetting(adminEmail: string, token: string | null, enabled: boolean): Promise<void> {
  await withTx(
    adminEmail,
    token,
    async (c: DbClient) => {
      await c.query(
        `INSERT INTO app_settings (key, value, updated_by_hash, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_hash = EXCLUDED.updated_by_hash, updated_at = NOW()`,
        [MCP_APPS_SETTING_KEY, JSON.stringify(enabled), actorHash(adminEmail)]
      )
      await recordAdminAction(c, adminEmail, { action: 'mcp_apps.settings', target: 'app_settings', details: { enabled } })
    },
    { admin: true }
  )
}
