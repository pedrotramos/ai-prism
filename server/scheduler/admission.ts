// Which tools an unattended run may offer the model (W4-4b). A scheduled agent runs as the app's service principal,
// so the tools of its APPROVED snapshot are re-checked against today's org policy and MCP catalog at the start of
// every run (an admin may have switched a group off, or reclassified a service, since the approval).
//
// The table below is the one place that maps an AgentToolRef (the definition's vocabulary) to the turn's tool-ref
// vocabulary: the group keys of the org tool policy (server/tools.ts TOOL_GROUP_KEYS, what the ToolsPicker sends as
// `kind`), plus `artifact:*` (a capability the interactive turn infers from the prompt, here an explicit grant) and
// `mcp-external:<service>` (the picker's { kind: 'mcp-external', connectionName }). parseTurnToolRefs is its inverse,
// used by runTurnHeadless, so a ref cannot be admitted without being understood by the turn.
import type { AgentDefinition, AgentToolRef } from '../agents/definition.ts'

export type AdmissionCode = 'tool_not_allowed' | 'mcp_not_in_catalog' | 'mcp_class_refused' | 'web_search_off' | 'model_not_allowed'

export interface AdmissionContext {
  /** the org tool policy (app_tool_policy as a map): only an explicit `false` disables a group */
  toolPolicy: unknown
  /** the admin MCP catalog keyed by `<catalog>.<schema>.<service>` */
  catalog: ReadonlyMap<string, { credentialClass: string | null }>
}

export type AdmissionResult = { ok: true; turnToolRefs: string[] } | { ok: false; refused: { tool: AgentToolRef; code: AdmissionCode }[] }

/** AgentToolRef (fixed kinds) → the turn's ref. `group` is the org policy key that can switch it off. */
export const FIXED_TOOL_REFS = {
  web_search: { turn: 'web-search', group: 'web-search' },
  generate_image: { turn: 'image-gen', group: 'image-gen' },
  genie_one: { turn: 'genie-one', group: 'genie-one' },
  'artifact:deck': { turn: 'artifact:deck', group: null },
  'artifact:spreadsheet': { turn: 'artifact:spreadsheet', group: null },
  'artifact:document': { turn: 'artifact:document', group: null },
} as const satisfies Record<string, { turn: string; group: string | null }>

const MCP_PREFIX = 'mcp:'
export const TURN_MCP_PREFIX = 'mcp-external:'

const isFixed = (t: string): t is keyof typeof FIXED_TOOL_REFS => Object.hasOwn(FIXED_TOOL_REFS, t)
const policyOff = (policy: unknown, key: string): boolean =>
  !!policy && typeof policy === 'object' && (policy as Record<string, unknown>)[key] === false

export function admitAgentTools(def: Pick<AgentDefinition, 'tools'>, ctx: AdmissionContext): AdmissionResult {
  const refused: { tool: AgentToolRef; code: AdmissionCode }[] = []
  const turnToolRefs: string[] = []
  for (const tool of def.tools ?? []) {
    if (isFixed(tool)) {
      const { turn, group } = FIXED_TOOL_REFS[tool]
      if (group && policyOff(ctx.toolPolicy, group)) refused.push({ tool, code: tool === 'web_search' ? 'web_search_off' : 'tool_not_allowed' })
      else turnToolRefs.push(turn)
      continue
    }
    if (typeof tool === 'string' && tool.startsWith(MCP_PREFIX)) {
      const name = tool.slice(MCP_PREFIX.length)
      const entry = ctx.catalog.get(name)
      if (!entry) refused.push({ tool, code: 'mcp_not_in_catalog' })
      // only the caller's own Databricks identity is ours to lend: per_user, shared and unverified services are refused
      else if (entry.credentialClass !== 'databricks') refused.push({ tool, code: 'mcp_class_refused' })
      else if (policyOff(ctx.toolPolicy, 'mcp-external')) refused.push({ tool, code: 'tool_not_allowed' })
      else turnToolRefs.push(TURN_MCP_PREFIX + name)
      continue
    }
    refused.push({ tool: tool as AgentToolRef, code: 'tool_not_allowed' })
  }
  return refused.length ? { ok: false, refused } : { ok: true, turnToolRefs: [...new Set(turnToolRefs)] }
}

export interface ParsedTurnRefs {
  /** the refs buildToolDefs takes (the ToolsPicker's objects) */
  refs: { kind: string; connectionName?: string }[]
  /** the capabilities the turn's tools hang on; everything not granted is off, whatever the prompt says */
  caps: { deck: boolean; spreadsheet: boolean; document: boolean; image: boolean }
  webSearch: boolean
}

/** Inverse of the table: the turn's string refs → buildToolDefs refs + the capabilities they grant. Unknown refs throw. */
export function parseTurnToolRefs(turnRefs: readonly string[]): ParsedTurnRefs {
  const out: ParsedTurnRefs = { refs: [], caps: { deck: false, spreadsheet: false, document: false, image: false }, webSearch: false }
  for (const r of turnRefs) {
    if (r === 'genie-one') out.refs.push({ kind: 'genie-one' })
    else if (r === 'image-gen') out.caps.image = true
    else if (r === 'web-search') out.webSearch = true
    else if (r === 'artifact:deck') out.caps.deck = true
    else if (r === 'artifact:spreadsheet') out.caps.spreadsheet = true
    else if (r === 'artifact:document') out.caps.document = true
    else if (r.startsWith(TURN_MCP_PREFIX) && r.length > TURN_MCP_PREFIX.length) out.refs.push({ kind: 'mcp-external', connectionName: r.slice(TURN_MCP_PREFIX.length) })
    else throw Object.assign(new Error(`tool_not_admitted: ${r}`), { code: 'tool_not_admitted' })
  }
  return out
}
