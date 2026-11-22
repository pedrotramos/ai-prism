// The definition of a scheduled agent (W4-4a): the shape, the limits and the validation. Pure, no I/O.
//
// An agent is a saved turn recipe. `name` and `description` are columns of ai_prism.agents; everything else is the
// `definition` (jsonb), which is the APPROVAL SCOPE: an admin approves the canonical form of exactly this object,
// and the database voids the approval when it changes (migration 0015). validateAgentInput is the one place that
// turns untrusted input (a request body) into an AgentDefinition; the routes never build one by hand.
//
// Every refusal is { ok: false, code, field } with a STABLE code (the routes translate it through the i18n error
// keys; a test pins each one). Codes:
//   field_invalid           wrong type, or a value outside its enum (lang, reasoningEffort); field 'input' = not an object
//   field_required          name, prompt or model empty
//   field_too_long          over AGENT_LIMITS
//   tools_too_many          more than AGENT_LIMITS.toolsMax tool refs
//   tool_duplicate          the same ref twice
//   tool_unknown            not one of the known kinds (or a malformed mcp: ref)
//   mcp_not_in_catalog      an mcp: ref the admin catalog does not list
//   mcp_class_refused       an mcp: service whose credential class is not 'databricks'
//   model_not_in_catalog    a model the owner's catalog does not offer
//   schedule_invalid        unknown frequency, a field out of range, a missing field
//   schedule_too_frequent   more often than hourly
//   timezone_invalid        not an IANA zone
import { createHash } from 'node:crypto'

export type ScheduleFreq = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
export interface AgentSchedule {
  freq: ScheduleFreq
  minute: number
  hour?: number
  weekday?: number
  monthday?: number
  tz: string
}
export type AgentToolRef =
  | 'web_search'
  | 'generate_image'
  | 'artifact:deck'
  | 'artifact:spreadsheet'
  | 'artifact:document'
  | 'genie_one'
  | `mcp:${string}`
export interface AgentDefinition {
  instructions: string
  prompt: string
  model: string
  reasoningEffort: 'low' | 'medium' | 'high' | null
  tools: AgentToolRef[]
  schedule: AgentSchedule | null
  lang: 'en' | 'pt' | 'es'
}

export const AGENT_LIMITS = Object.freeze({
  nameMax: 80,
  descriptionMax: 500,
  instructionsMax: 8000,
  promptMax: 4000,
  toolsMax: 12,
  agentsPerOwner: 10,
} as const)

export interface DefinitionContext {
  /** model ids the owner's catalog offers */
  models: ReadonlySet<string>
  /** admin catalog, keyed by `<catalog>.<schema>.<service>` (no `mcp:` prefix) */
  catalog: ReadonlyMap<string, { credentialClass: string | null }>
}

export type ValidationResult =
  | { ok: true; name: string; description: string; definition: AgentDefinition }
  | { ok: false; code: string; field: string }

const FIXED_TOOLS: ReadonlySet<string> = new Set(['web_search', 'generate_image', 'artifact:deck', 'artifact:spreadsheet', 'artifact:document', 'genie_one'])
const FREQS: ReadonlySet<string> = new Set(['hourly', 'daily', 'weekdays', 'weekly', 'monthly'])
const LANGS: ReadonlySet<string> = new Set(['en', 'pt', 'es'])
const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high'])
// a three-part Unity Catalog name: <catalog>.<schema>.<service>
const MCP_REF = /^mcp:([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/
// words that mean "more often than hourly" in a frequency name
const SUB_HOUR = /min|sec|continu|real.?time|instant|every_?\d/i
// keys that mean the same in a schedule object
const SUB_HOUR_KEYS = ['interval', 'interval_minutes', 'intervalMinutes', 'every', 'cron', 'seconds']

const fail = (code: string, field: string): { ok: false; code: string; field: string } => ({ ok: false, code, field })
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi

/** True for an IANA zone name this runtime knows (Area/Location, or UTC). Offsets such as "+03:00" are not zones. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  if (tz !== 'UTC' && !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2}$/.test(tz)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function text(input: Record<string, unknown>, key: string, max: number, required: boolean): { ok: true; value: string } | { ok: false; code: string; field: string } {
  const v = input[key]
  if (typeof v !== 'string') return fail('field_invalid', key)
  const t = v.trim()
  if (required && !t) return fail('field_required', key)
  if (t.length > max) return fail('field_too_long', key)
  return { ok: true, value: t }
}

function validateSchedule(raw: unknown): { ok: true; value: AgentSchedule | null } | { ok: false; code: string; field: string } {
  if (raw === null) return { ok: true, value: null }
  if (!isObj(raw)) return fail('schedule_invalid', 'schedule')
  if (SUB_HOUR_KEYS.some((k) => k in raw)) return fail('schedule_too_frequent', 'schedule')
  if (Array.isArray(raw.minute) || (typeof raw.minute === 'string' && /[*/,-]/.test(raw.minute))) return fail('schedule_too_frequent', 'schedule')
  const freq = raw.freq
  if (typeof freq !== 'string') return fail('schedule_invalid', 'schedule')
  if (!FREQS.has(freq)) return fail(SUB_HOUR.test(freq) ? 'schedule_too_frequent' : 'schedule_invalid', 'schedule')
  if (!isInt(raw.minute, 0, 59)) return fail('schedule_invalid', 'schedule')
  if (!isValidTimeZone(raw.tz)) return fail('timezone_invalid', 'schedule')
  const out: AgentSchedule = { freq: freq as ScheduleFreq, minute: raw.minute, tz: raw.tz }
  if (freq !== 'hourly') {
    if (!isInt(raw.hour, 0, 23)) return fail('schedule_invalid', 'schedule')
    out.hour = raw.hour
  }
  if (freq === 'weekly') {
    if (!isInt(raw.weekday, 0, 6)) return fail('schedule_invalid', 'schedule')
    out.weekday = raw.weekday
  }
  if (freq === 'monthly') {
    if (!isInt(raw.monthday, 1, 28)) return fail('schedule_invalid', 'schedule')
    out.monthday = raw.monthday
  }
  return { ok: true, value: out }
}

/**
 * Validates a request body into { name, description, definition }. The definition holds only the approval scope, with
 * only the fields its schedule frequency uses, so its canonical form (and hash) is stable.
 */
export function validateAgentInput(input: unknown, ctx: DefinitionContext): ValidationResult {
  if (!isObj(input)) return fail('field_invalid', 'input')
  const name = text(input, 'name', AGENT_LIMITS.nameMax, true)
  if (!name.ok) return name
  const description = input.description === undefined ? ({ ok: true, value: '' } as const) : text(input, 'description', AGENT_LIMITS.descriptionMax, false)
  if (!description.ok) return description
  const instructions = text(input, 'instructions', AGENT_LIMITS.instructionsMax, false)
  if (!instructions.ok) return instructions
  const prompt = text(input, 'prompt', AGENT_LIMITS.promptMax, true)
  if (!prompt.ok) return prompt

  if (typeof input.model !== 'string') return fail('field_invalid', 'model')
  const model = input.model.trim()
  if (!model) return fail('field_required', 'model')
  if (!ctx.models.has(model)) return fail('model_not_in_catalog', 'model')

  const effort = input.reasoningEffort ?? null
  if (effort !== null && (typeof effort !== 'string' || !EFFORTS.has(effort))) return fail('field_invalid', 'reasoningEffort')
  if (typeof input.lang !== 'string' || !LANGS.has(input.lang)) return fail('field_invalid', 'lang')

  const rawTools = input.tools ?? []
  if (!Array.isArray(rawTools)) return fail('field_invalid', 'tools')
  if (rawTools.length > AGENT_LIMITS.toolsMax) return fail('tools_too_many', 'tools')
  const seen = new Set<string>()
  for (const t of rawTools) {
    if (typeof t !== 'string') return fail('tool_unknown', 'tools')
    if (seen.has(t)) return fail('tool_duplicate', 'tools')
    seen.add(t)
    if (FIXED_TOOLS.has(t)) continue
    const m = MCP_REF.exec(t)
    if (!m) return fail('tool_unknown', 'tools')
    const entry = ctx.catalog.get(m[1] as string)
    if (!entry) return fail('mcp_not_in_catalog', 'tools')
    if (entry.credentialClass !== 'databricks') return fail('mcp_class_refused', 'tools')
  }

  const schedule = validateSchedule(input.schedule === undefined ? null : input.schedule)
  if (!schedule.ok) return schedule

  return {
    ok: true,
    name: name.value,
    description: description.value,
    definition: {
      instructions: instructions.value,
      prompt: prompt.value,
      model,
      reasoningEffort: effort as AgentDefinition['reasoningEffort'],
      tools: rawTools as AgentToolRef[],
      schedule: schedule.value,
      lang: input.lang as AgentDefinition['lang'],
    },
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (isObj(v)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sortKeys(v[k])
    return out
  }
  return v
}

/** Stable JSON of a definition: keys sorted at every level (array order, tools included, is kept). */
export function canonicalDefinition(def: AgentDefinition): string {
  return JSON.stringify(sortKeys(def))
}

/** sha256 (hex) of the canonical definition: what an admin approves and what a run records. */
export function approvalHash(def: AgentDefinition): string {
  return createHash('sha256').update(canonicalDefinition(def)).digest('hex')
}
