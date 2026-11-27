// Pure rules of the Agents UI (W4-4e): types, error keys, the tool picker's admitted kinds, the form ↔ request
// mapping, the "this edit voids the approval" rule, row actions, the admin diff and the formatting of instants.
// No React, no DOM, no network, and NO schedule or time-zone math: occurrences come from the server
// (POST /api/agents/schedule-preview) and are only formatted here with Intl.

import { presetToCron } from '../../../../shared/cron.ts'

export type AgentLang = 'en' | 'pt' | 'es'
export type PresetFreq = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
export type ScheduleFreq = PresetFreq | 'custom'
export type AgentStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'revoked'
export type Effort = 'low' | 'medium' | 'high' | null

export interface PresetSchedule {
  freq: PresetFreq
  minute: number
  hour?: number
  weekday?: number
  monthday?: number
  tz: string
}
/** "Custom (advanced)": a 5-field cron for what the presets do not cover (the server never accepts one more often than hourly). */
export interface CustomSchedule {
  freq: 'custom'
  cron: string
  tz: string
}
export type AgentSchedule = PresetSchedule | CustomSchedule
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
  // validateAgentInput (server/agents/definition.ts)
  'field_invalid', 'field_required', 'field_too_long', 'model_not_in_catalog', 'tools_too_many', 'tool_unknown', 'tool_duplicate', 'mcp_not_in_catalog',
  'mcp_class_refused', 'schedule_invalid', 'schedule_too_frequent', 'timezone_invalid', 'cron_invalid', 'cron_fields', 'cron_never',
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

/**
 * The schedule after the owner picks `freq` in the Repeat selector. Picking a preset keeps the time zone and any
 * field it shares; picking Custom starts from the cron the current preset is the same as ("0 8 * * 1"), so nothing
 * typed is lost and the owner edits a working expression instead of an empty box.
 */
export function scheduleForFreq(current: AgentSchedule | null, freq: ScheduleFreq, tz: string): AgentSchedule {
  const zone = current?.tz ?? tz
  if (freq === 'custom') {
    if (current?.freq === 'custom') return current
    return { freq: 'custom', cron: current ? presetToCron(current) : '0 8 * * 1', tz: zone }
  }
  const base = current && current.freq !== 'custom' ? current : { freq, minute: 0, tz: zone }
  return { ...base, freq, hour: base.hour ?? 8, weekday: base.weekday ?? 1, monthday: base.monthday ?? 1 }
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

/** One line for the admin's review card: "Every week · 08:00 · America/Sao_Paulo", or the cron itself for a custom one. */
export function scheduleSummary(s: AgentSchedule, freqLabel: string): string {
  if (s.freq === 'custom') return `${freqLabel} · ${s.cron} · ${s.tz}`
  return `${freqLabel} · ${String(s.hour ?? 0).padStart(2, '0')}:${String(s.minute).padStart(2, '0')} · ${s.tz}`
}

/** One-click starting points of the Custom (advanced) option: what the five presets cannot say. */
export const CRON_EXAMPLES: readonly { cron: string; labelKey: string }[] = [
  { cron: '0 9,17 * * 1-5', labelKey: 'agents.schedule.example.twiceWeekdays' },
  { cron: '0 8 * * 1,3,5', labelKey: 'agents.schedule.example.monWedFri' },
  { cron: '0 6 1,15 * *', labelKey: 'agents.schedule.example.twiceMonth' },
]

/** The schedule inputs a frequency uses, in display order (progressive disclosure: the others are not shown). */
export function scheduleFields(freq: PresetFreq): ('weekday' | 'monthday' | 'hour' | 'minute')[] {
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
  if (s.freq === 'custom') return { freq: 'custom', cron: s.cron.trim().split(/\s+/).join(' '), tz: s.tz }
  const out: PresetSchedule = { freq: s.freq, minute: s.minute, tz: s.tz }
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
