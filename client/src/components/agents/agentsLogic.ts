// Pure rules of the Agents UI (W4-4e): types, error keys, the tool picker's admitted kinds, the form ↔ request
// mapping, the "this edit voids the approval" rule, row actions, the admin diff and the formatting of instants.
// No React, no DOM, no network, and NO schedule or time-zone math: occurrences come from the server
// (POST /api/agents/schedule-preview) and are only formatted here with Intl.

import type { VersionContent } from '../../../../shared/agentVersionDiff.ts'

export type AgentLang = 'en' | 'pt' | 'es'
export type ScheduleFreq = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
export type AgentStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'revoked'
export type Effort = 'low' | 'medium' | 'high' | null

export interface AgentSchedule {
  freq: ScheduleFreq
  minute: number
  hour?: number
  weekday?: number
  monthday?: number
  tz: string
}
export interface AgentDefinition {
  instructions: string
  prompt: string
  model: string
  reasoningEffort: Effort
  tools: string[]
  schedule: AgentSchedule | null
  lang: AgentLang
}
export interface AgentRow {
  id: string
  ownerEmail: string
  name: string
  description: string
  definition: AgentDefinition
  revision: number
  status: AgentStatus
  approvalExpiresAt: string | null
  decisionReason: string | null
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  consecutiveFailures: number
  disabledReason: string | null
  createdAt: string
  updatedAt: string
}
export interface AgentRunRow {
  id: string
  agentId: string
  trigger: 'schedule' | 'manual'
  slotAt: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped'
  errorCode: string | null
  startedAt: string | null
  finishedAt: string | null
  sessionId: string | null
  costUsd: number | null
  unpriced: boolean
  toolNames: string[]
}
export interface ToolIdentity {
  tool: string
  runsAs: string
  readsWorkspaceData: boolean
}
export interface AdminAgentRow extends AgentRow {
  approvalHash: string | null
  currentHash: string
  toolIdentities: ToolIdentity[]
}
export interface AgentLimits {
  nameMax: number
  descriptionMax: number
  instructionsMax: number
  promptMax: number
  toolsMax: number
  agentsPerOwner: number
  sharesPerAgent: number
}

// ---- versions (migration 0017) -------------------------------------------------------------------------------
export type ShareKind = 'user' | 'group' | 'app'
export type ShareStatus = 'pending' | 'approved' | 'rejected' | 'revoked'
export interface AgentShare {
  kind: ShareKind
  principal: string
  /** the version this audience is pinned to */
  version: number
  createdAt: string
  /** the administrator's decision on THIS audience for that version (a new share is a request: pending) */
  status: ShareStatus
  /** the state of the version it is pinned to */
  versionStatus: AgentStatus
  decisionReason: string | null
  approvedAt: string | null
}
export interface VersionOrigin {
  kind: 'restore' | 'duplicate' | 'shared'
  agentId: string
  version: number
}
/** One saved version, as the owner reads it. */
export interface AgentVersion {
  agentId: string
  version: number
  ownerEmail: string
  name: string
  description: string
  definition: AgentDefinition
  createdBy: string
  createdAt: string
  origin: VersionOrigin | null
  status: AgentStatus
  decisionReason: string | null
  approvedAt: string | null
  hash: string
  isHead: boolean
  /** the audiences pinned to THIS version */
  shares: AgentShare[]
}
/** An approved version somebody shared with the caller. */
export interface SharedAgent {
  agentId: string
  version: number
  ownerEmail: string
  name: string
  description: string
  definition: AgentDefinition
  approvedAt: string | null
}
export interface AdminVersionRow extends AgentVersion {
  /** the reviewing admin owns this agent: approving it is a self-approval (allowed, audited as such) */
  ownedByAdmin: boolean
  currentHash: string
  agentStatus: AgentStatus
  previous: { version: number; name: string; description: string; definition: AgentDefinition } | null
  toolIdentities: ToolIdentity[]
}
export interface AgentSettings {
  enabled: boolean
  maxRunCostUsd: number
  approvalDays: number
  ranges?: { maxRunCostUsd: [number, number]; approvalDays: [number, number] }
}

// ---- errors (AC5) ------------------------------------------------------------------------------------------
/** Every stable code the two route files and validateAgentInput can answer, plus the client-side `network`. */
export const AGENT_ERROR_CODES: readonly string[] = [
  // routes
  'agents_disabled', 'agents_limit', 'agents_setting_off', 'approval_expired', 'not_approved', 'bad_state', 'busy', 'conflict', 'revision_required',
  'no_schedule', 'invalid_setting', 'not_found', 'bad_query', 'admin_required', 'internal_error', 'stale', 'reason_required', 'expected_hash_required',
  'invalid_days', 'bad_status',
  // versions and sharing (0017)
  'invalid_version', 'invalid_kind', 'invalid_principal', 'shares_limit', 'version_not_approved',
  // validateAgentInput (server/agents/definition.ts)
  'field_invalid', 'field_required', 'field_too_long', 'model_not_in_catalog', 'tools_too_many', 'tool_unknown', 'tool_duplicate', 'mcp_not_in_catalog',
  'mcp_class_refused', 'schedule_invalid', 'schedule_too_frequent', 'timezone_invalid',
  // run history: the codes a finished or skipped run can carry (design-w4 §1.8; the run core lands in W4-4b/4c)
  'approval_changed', 'tool_not_admitted', 'model_not_allowed', 'sp_model_denied', 'sp_no_user_credentials', 'sp_permission_denied', 'sp_unavailable',
  'gateway_error', 'timeout', 'lease_lost', 'lease_expired', 'db_error', 'cost_cap', 'shutdown', 'missed', 'overlap',
  // the browser could not reach the server
  'network',
]
const KNOWN = new Set(AGENT_ERROR_CODES)

/** The catalog key for an error code. Anything not in the list (raw server text included) reads as internal_error. */
export function errorKey(code: string | null | undefined): string {
  return `agents.errors.${code && KNOWN.has(code) ? code : 'internal_error'}`
}

// ---- tools (the picker offers only what a headless run may use) ---------------------------------------------
export const FIXED_TOOLS: readonly { ref: string; labelKey: string }[] = [
  { ref: 'web_search', labelKey: 'agents.tool.web_search' },
  { ref: 'generate_image', labelKey: 'agents.tool.generate_image' },
  { ref: 'artifact:deck', labelKey: 'agents.tool.artifact_deck' },
  { ref: 'artifact:spreadsheet', labelKey: 'agents.tool.artifact_spreadsheet' },
  { ref: 'artifact:document', labelKey: 'agents.tool.artifact_document' },
  { ref: 'genie_one', labelKey: 'agents.tool.genie_one' },
]
/** GET /api/agents/tool-options: what the server admits for an agent (its policy and catalog filters already applied). */
export interface ToolOptions {
  kinds: string[]
  mcp: { ref: string; name: string; description?: string }[]
}
export interface SelectableTool {
  ref: string
  kind: 'builtin' | 'mcp'
  /** a catalog key for a built-in, the display name for an MCP service */
  label: string
  labelIsKey: boolean
  /** reads Unity Catalog data with the app's service principal grants (disclosed under the tool) */
  readsWorkspaceData: boolean
}

const MCP_REF = /^mcp:\S+$/

/**
 * The tools an owner may put on an agent: what the server offers, nothing more. A kind the client does not know and
 * an `mcp:` ref that is not shaped `mcp:<name>` are dropped even if the server sent them; no options (not loaded, or
 * the load failed) offers nothing (fail closed). The server filters by class and policy; the client never decides that.
 */
export function selectableTools(options: ToolOptions | null | undefined): SelectableTool[] {
  if (!options) return []
  const offered = new Set(options.kinds)
  const fixed = FIXED_TOOLS.filter((t) => offered.has(t.ref)).map((t): SelectableTool => ({ ref: t.ref, kind: 'builtin', label: t.labelKey, labelIsKey: true, readsWorkspaceData: t.ref === 'genie_one' }))
  const services = options.mcp
    .filter((m) => typeof m.ref === 'string' && MCP_REF.test(m.ref))
    .map((m): SelectableTool => ({ ref: m.ref, kind: 'mcp', label: m.name || m.ref.slice(4), labelIsKey: false, readsWorkspaceData: true }))
  return [...fixed, ...services]
}

// ---- the form ------------------------------------------------------------------------------------------------
export interface AgentForm {
  name: string
  description: string
  instructions: string
  prompt: string
  model: string
  reasoningEffort: Effort
  tools: string[]
  schedule: AgentSchedule | null
  lang: AgentLang
}

/** `resolved` when it is a valid IANA zone, otherwise UTC. */
export function defaultTimeZone(resolved: string | null | undefined): string {
  if (!resolved) return 'UTC'
  try {
    new Intl.DateTimeFormat('en', { timeZone: resolved })
    return resolved
  } catch {
    return 'UTC'
  }
}

/** The browser's time zone (AC4: the selector's default), or UTC when it cannot be read. */
export function browserTimeZone(): string {
  try {
    return defaultTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
  } catch {
    return 'UTC'
  }
}

export function emptyForm(o: { model: string; lang: AgentLang; tz: string }): AgentForm {
  return {
    name: '',
    description: '',
    instructions: '',
    prompt: '',
    model: o.model,
    reasoningEffort: null,
    tools: [],
    schedule: { freq: 'weekly', minute: 0, hour: 8, weekday: 1, tz: o.tz },
    lang: o.lang,
  }
}

export function formFromRow(row: AgentRow): AgentForm {
  const d = row.definition
  return {
    name: row.name,
    description: row.description,
    instructions: d.instructions,
    prompt: d.prompt,
    model: d.model,
    reasoningEffort: d.reasoningEffort,
    tools: [...d.tools],
    schedule: d.schedule ? { ...d.schedule } : null,
    lang: d.lang,
  }
}

/** The schedule inputs a frequency uses, in display order (progressive disclosure: the others are not shown). */
export function scheduleFields(freq: ScheduleFreq): ('weekday' | 'monthday' | 'hour' | 'minute')[] {
  switch (freq) {
    case 'hourly':
      return ['minute']
    case 'daily':
    case 'weekdays':
      return ['hour', 'minute']
    case 'weekly':
      return ['weekday', 'hour', 'minute']
    case 'monthly':
      return ['monthday', 'hour', 'minute']
  }
}

/** Only the fields the frequency uses (the server keeps the same ones, so the hash stays stable). */
function cleanSchedule(s: AgentSchedule): AgentSchedule {
  const out: AgentSchedule = { freq: s.freq, minute: s.minute, tz: s.tz }
  const used = scheduleFields(s.freq)
  if (used.includes('hour') && s.hour !== undefined) out.hour = s.hour
  if (used.includes('weekday') && s.weekday !== undefined) out.weekday = s.weekday
  if (used.includes('monthday') && s.monthday !== undefined) out.monthday = s.monthday
  return out
}

/** The request body of create/update: the definition's own keys only, never an owner, status or approval. */
export function formToBody(f: AgentForm): Record<string, unknown> {
  return {
    name: f.name.trim(),
    description: f.description.trim(),
    instructions: f.instructions.trim(),
    prompt: f.prompt.trim(),
    model: f.model,
    reasoningEffort: f.reasoningEffort,
    tools: [...f.tools],
    schedule: f.schedule ? cleanSchedule(f.schedule) : null,
    lang: f.lang,
  }
}

const sorted = (xs: readonly string[]) => [...xs].sort()
/** The form's definition in the server's canonical shape (tools sorted, trimmed text, schedule cleaned). */
function canonicalOfForm(f: AgentForm): AgentDefinition {
  return {
    instructions: f.instructions.trim(),
    prompt: f.prompt.trim(),
    model: f.model,
    reasoningEffort: f.reasoningEffort,
    tools: sorted(f.tools),
    schedule: f.schedule ? cleanSchedule(f.schedule) : null,
    lang: f.lang,
  }
}
function canonicalOfDefinition(d: AgentDefinition): AgentDefinition {
  return { ...d, instructions: d.instructions.trim(), prompt: d.prompt.trim(), tools: sorted(d.tools), schedule: d.schedule ? cleanSchedule(d.schedule) : null }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** True when the form changes the definition (the approval scope). Name and description are not part of it. */
export function definitionChanged(saved: AgentRow, f: AgentForm): boolean {
  return !same(canonicalOfDefinition(saved.definition), canonicalOfForm(f))
}

/** AC3: saving would void an approval (approved or waiting for one) — the editor says so BEFORE it saves. */
export function needsVoidWarning(saved: AgentRow | null, f: AgentForm): boolean {
  return !!saved && (saved.status === 'approved' || saved.status === 'pending') && definitionChanged(saved, f)
}

// ---- rows ----------------------------------------------------------------------------------------------------
export const approvalExpired = (row: AgentRow, nowMs: number): boolean => !row.approvalExpiresAt || Date.parse(row.approvalExpiresAt) <= nowMs

export function rowActions(row: AgentRow, nowMs: number) {
  const live = row.status === 'approved' && !approvalExpired(row, nowMs)
  return {
    edit: true,
    submit: row.status === 'draft' || row.status === 'rejected' || row.status === 'revoked',
    enable: live && !row.enabled && !!row.definition.schedule,
    disable: row.enabled,
    run: live,
    delete: true,
  }
}

/** The text chip of a row (a word, never color alone). */
export function chipKey(row: Pick<AgentRow, 'status' | 'enabled'>): string {
  return row.status === 'approved' && row.enabled ? 'agents.chip.scheduled' : `agents.chip.${row.status}`
}

// ---- the admin diff ------------------------------------------------------------------------------------------
export interface DefinitionChange {
  field: keyof AgentDefinition
  before: unknown
  after: unknown
  added?: string[]
  removed?: string[]
}
const FIELDS: (keyof AgentDefinition)[] = ['instructions', 'prompt', 'model', 'reasoningEffort', 'tools', 'schedule', 'lang']

/** What changed between an earlier approved definition and the one waiting for review (empty without an earlier one). */
export function diffDefinitions(prev: AgentDefinition | null, next: AgentDefinition): DefinitionChange[] {
  if (!prev) return []
  const a = canonicalOfDefinition(prev)
  const b = canonicalOfDefinition(next)
  const out: DefinitionChange[] = []
  for (const field of FIELDS) {
    if (same(a[field], b[field])) continue
    const c: DefinitionChange = { field, before: a[field], after: b[field] }
    if (field === 'tools') {
      c.added = b.tools.filter((t) => !a.tools.includes(t))
      c.removed = a.tools.filter((t) => !b.tools.includes(t))
    }
    out.push(c)
  }
  return out
}

// ---- versions ------------------------------------------------------------------------------------------------
const DEFINITION_LABELS: Record<string, string> = {
  name: 'agents.field.name',
  description: 'agents.field.description',
  instructions: 'agents.field.instructions',
  prompt: 'agents.field.prompt',
  model: 'agents.field.model',
  reasoningEffort: 'agents.field.reasoningEffort',
  tools: 'agents.field.tools',
  schedule: 'agents.field.schedule',
  lang: 'agents.field.lang',
}
/** The catalog key naming a field of an agent's content, or null for a field the UI has no word for (a later payload). */
export const definitionLabel = (field: string): string | null => DEFINITION_LABELS[field] ?? null

/** The catalog key of a version's approval chip (a word, never color alone). */
export const versionChipKey = (v: Pick<AgentVersion, 'status'>): string => `agents.versions.chip.${v.status}`

/** The owner may ask for the sharing approval of a version that is not already waiting or approved. */
export const canSubmitVersion = (v: Pick<AgentVersion, 'status'>): boolean => v.status === 'draft' || v.status === 'rejected' || v.status === 'revoked'

/**
 * Where an audience stands, from what the server sent with it (never from the loaded history: that is paged). `live` needs BOTH
 * decisions, the audience's and its version's; an approved audience whose version is not approved yet is `versionPending`.
 */
export type ShareState = 'live' | 'pending' | 'rejected' | 'revoked' | 'versionPending'
export function shareState(share: Pick<AgentShare, 'status' | 'versionStatus'>): ShareState {
  if (share.status !== 'approved') return share.status
  return share.versionStatus === 'approved' ? 'live' : 'versionPending'
}

/** Adding is allowed below the cap, and always for an audience that is already listed (it only moves the pin). */
export function canAddAudience(shares: readonly Pick<AgentShare, 'kind' | 'principal'>[], kind: ShareKind, principal: string, max: number): boolean {
  const p = kind === 'app' ? '*' : principal.trim().toLowerCase()
  return shares.length < max || shares.some((s) => s.kind === kind && s.principal === p)
}

/** The e-mail or group name to show for an audience ('*' is the whole app, which has no name of its own). */
export const shareName = (s: Pick<AgentShare, 'kind' | 'principal'>, appName: string): string => (s.kind === 'app' ? appName : s.principal)

/** sha256-free canonical form: keys sorted at every level, array order kept (what the server's approvalHash is taken over). */
export function canonicalJson(v: unknown): string {
  const sort = (x: unknown): unknown => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x)
  return JSON.stringify(sort(v))
}
/** Same content as the server counts it (key order never matters). */
export const sameDefinition = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

/**
 * What a screen can show of a version payload without assuming it is today's recipe: a payload that carries only something else
 * (a flow graph) has no prompt, instructions or tools, and must still render, never throw. `extraKeys` names what the screen does
 * not render so it can say so. The stacked flow-graph branch plugs its own renderer in here.
 */
export interface PayloadSummary {
  instructions: string
  prompt: string
  model: string
  tools: string[]
  extraKeys: string[]
  /** there is something to show or to try in a chat */
  hasRecipe: boolean
}
const RECIPE_KEYS = new Set(['instructions', 'prompt', 'model', 'reasoningEffort', 'tools', 'schedule', 'lang'])
export function payloadSummary(def: unknown): PayloadSummary {
  const d = def && typeof def === 'object' && !Array.isArray(def) ? (def as Record<string, unknown>) : {}
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const tools = Array.isArray(d.tools) ? d.tools.filter((x): x is string => typeof x === 'string') : []
  const out = { instructions: str(d.instructions), prompt: str(d.prompt), model: str(d.model), tools, extraKeys: Object.keys(d).filter((k) => !RECIPE_KEYS.has(k)).sort() }
  return { ...out, hasRecipe: !!(out.prompt || out.instructions) }
}

/** The content of a version in the shape the diff takes. */
export const versionContent = (v: Pick<AgentVersion, 'name' | 'description' | 'definition'>): VersionContent => ({ name: v.name, description: v.description, definition: v.definition as unknown as Record<string, unknown> })

/**
 * The version a given one is compared with: the next older one in the loaded list. `undefined` = the older ones are not
 * loaded yet (and there are some), `null` = this is the first version.
 */
export function previousVersion(versions: readonly AgentVersion[], v: AgentVersion, hasMore: boolean): AgentVersion | null | undefined {
  const older = versions.filter((x) => x.version < v.version).sort((a, b) => b.version - a.version)[0]
  if (older) return older
  return v.version === 1 || !hasMore ? null : undefined
}

// ---- formatting (display only) ------------------------------------------------------------------------------
/** An instant from the server, shown in `tz`. A bad date reads as '' and a bad zone as UTC; it never throws. */
export function formatInstant(iso: string | null | undefined, tz: string, locale: string): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  try {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: tz }).format(ms)
  } catch {
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(ms)
  }
}
