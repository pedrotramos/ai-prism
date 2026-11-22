// The validated shape of `_meta.ui` on a listed MCP tool (SEP-1865). A leaf module: server/mcpClient.ts needs it while listing,
// and server/mcpApps.ts needs mcpClient to read resources, so the shared piece lives on its own.

export type McpUiVisibility = 'model' | 'app'
export interface McpUiMeta {
  resourceUri: string
  visibility: McpUiVisibility[]
}

const URI_MAX = 512
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The `_meta.ui` of a listed tool, validated: `resourceUri` must start with ui:// (at most 512 chars); `visibility` is a non-empty
 * subset of {'model','app'} (default both). Anything else is `null`: the tool is a plain tool.
 */
export function toolUiMeta(tool: { _meta?: unknown } | null | undefined): McpUiMeta | null {
  const meta = tool?._meta
  if (!isObj(meta) || !isObj(meta.ui)) return null
  const { resourceUri, visibility } = meta.ui
  if (typeof resourceUri !== 'string' || !resourceUri.startsWith('ui://') || resourceUri.length > URI_MAX) return null
  if (visibility === undefined) return { resourceUri, visibility: ['model', 'app'] }
  if (!Array.isArray(visibility) || visibility.length === 0 || visibility.some((v) => v !== 'model' && v !== 'app')) return null
  return { resourceUri, visibility: [...new Set(visibility as McpUiVisibility[])] }
}
