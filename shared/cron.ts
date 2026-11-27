// 5-field cron for agent schedules ("Custom (advanced)" in the agent editor). Pure: parsing, the "not more often than
// hourly" rule and the mapping to and from the five presets of AgentSchedule. No I/O and no time zones: turning a cron
// into instants (with DST) is server/agents/schedule.ts's job, so the preview, the scheduler and a saved definition
// all read one rule.
//
// Syntax: minute hour day-of-month month day-of-week, each a list of `*`, `n`, `a-b`, with an optional `/step`;
// JAN-DEC and SUN-SAT names; 7 is Sunday too; @hourly @daily @midnight @weekly @monthly @yearly @annually. As in
// Vixie cron, when both day fields are restricted (neither starts with `*`) a day matches either one; otherwise it
// must match both (so `*/2` in a day field still only runs every other day).

/** Stable reasons a cron is refused; the server answers `cron_fields` / `cron_invalid`, the UI never sees the detail. */
export type CronErrorCode = 'cron_empty' | 'cron_too_long' | 'cron_fields' | 'cron_invalid'

export class CronError extends Error {
  declare code: CronErrorCode
  constructor(code: CronErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface CronSpec {
  /** the expression with its fields separated by one space (a macro expanded) */
  source: string
  minutes: number[]
  hours: number[]
  doms: Set<number>
  months: Set<number>
  /** 0-6, Sunday is 0 (a 7 is folded in) */
  dows: Set<number>
  /** the field STARTS with `*`: only switches OR to AND between the two day fields */
  domAny: boolean
  dowAny: boolean
}

interface Field {
  label: string
  min: number
  max: number
  names?: readonly string[]
  base?: number
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const
const FIELDS: readonly Field[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTHS, base: 1 },
  { label: 'day of week', min: 0, max: 7, names: DAYS, base: 0 },
]
const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}
export const MAX_CRON_LENGTH = 120
/** a custom cron may not run more often than the hourly preset */
export const MIN_INTERVAL_MINUTES = 60

const bad = (message: string) => new CronError('cron_invalid', message)

function atom(raw: string, f: Field): number {
  const i = f.names ? f.names.indexOf(raw.toUpperCase()) : -1
  if (i >= 0) return i + (f.base ?? 0)
  if (!/^\d{1,2}$/.test(raw)) throw bad(`invalid value in the ${f.label} field: "${raw}"`)
  const n = Number(raw)
  if (n < f.min || n > f.max) throw bad(`${f.label} out of range ${f.min}-${f.max}: ${n}`)
  return n
}

function parseField(text: string, f: Field): Set<number> {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^([^/]+)(?:\/(\d{1,2}))?$/.exec(part)
    if (!m) throw bad(`invalid ${f.label} field: "${text}"`)
    const body = m[1] as string
    const step = m[2] === undefined ? 1 : Number(m[2])
    if (!step) throw bad(`the step of the ${f.label} field must be above zero`)
    let lo: number
    let hi: number
    if (body === '*') {
      lo = f.min
      hi = f.max
    } else if (body.includes('-')) {
      const [a, b, extra] = body.split('-')
      if (extra !== undefined || a === undefined || b === undefined) throw bad(`invalid range in the ${f.label} field: "${body}"`)
      lo = atom(a, f)
      hi = atom(b, f)
      if (lo > hi) throw bad(`reversed range in the ${f.label} field: "${body}"`)
    } else {
      lo = atom(body, f)
      hi = m[2] === undefined ? lo : f.max // Vixie: "5/15" means 5-max/15
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

/** "0 8 * * 1-5" -> a parsed spec. Throws CronError. */
export function parseCron(expr: unknown): CronSpec {
  if (typeof expr !== 'string') throw new CronError('cron_empty', 'the cron expression is missing')
  let text = expr.trim()
  if (!text) throw new CronError('cron_empty', 'the cron expression is empty')
  if (text.length > MAX_CRON_LENGTH) throw new CronError('cron_too_long', `the cron expression is over ${MAX_CRON_LENGTH} characters`)
  if (text.startsWith('@')) {
    const m = MACROS[text.toLowerCase()]
    if (!m) throw bad(`unknown shortcut: ${text}`)
    text = m
  }
  const parts = text.split(/\s+/)
  if (parts.length !== 5) throw new CronError('cron_fields', 'a cron has 5 fields: minute hour day-of-month month day-of-week')
  const sets = parts.map((p, i) => parseField(p, FIELDS[i] as Field)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  const [minutes, hours, doms, months, dowsRaw] = sets
  return {
    source: parts.join(' '),
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    doms,
    months,
    dows: new Set([...dowsRaw].map((d) => (d === 7 ? 0 : d))),
    domAny: (parts[2] as string).startsWith('*'),
    dowAny: (parts[4] as string).startsWith('*'),
  }
}

/** null when the expression parses, else the stable code. */
export function cronProblem(expr: unknown): CronErrorCode | null {
  try {
    parseCron(expr)
    return null
  } catch (e) {
    return e instanceof CronError ? e.code : 'cron_invalid'
  }
}

/** Does the calendar day (month 1-12, day 1-31, weekday 0-6) run? Vixie semantics (see the file header). */
export function cronDayMatches(spec: CronSpec, month: number, day: number, weekday: number): boolean {
  if (!spec.months.has(month)) return false
  if (spec.domAny || spec.dowAny) return spec.doms.has(day) && spec.dows.has(weekday)
  return spec.doms.has(day) || spec.dows.has(weekday)
}

/** The times of day (minutes since midnight, ascending) the cron runs at on a matching day. */
export function timesOfDay(spec: CronSpec): number[] {
  const out: number[] = []
  for (const h of spec.hours) for (const m of spec.minutes) out.push(h * 60 + m)
  return out
}

/**
 * The shortest wall-clock gap, in minutes, between two consecutive runs of the cron, or Infinity when it runs at most
 * once. Exact on the calendar (four years, so 29 February and every day-of-week pairing are seen); DST shifts a gap by
 * at most an hour twice a year and is not modelled (the same rule the presets use).
 */
export function minGapMinutes(spec: CronSpec): number {
  const times = timesOfDay(spec)
  let min = Infinity
  for (let i = 1; i < times.length; i++) min = Math.min(min, (times[i] as number) - (times[i - 1] as number))
  if (times.length === 0) return min
  const wrap = 1440 - (times[times.length - 1] as number) + (times[0] as number) // last run of a day to the first of the next
  if (wrap >= min) return min // the day-to-day gap cannot lower the minimum: skip the calendar walk
  // adjacent matching days are what bring last-to-first closer than a day
  const start = Date.UTC(2024, 0, 1)
  let prevMatches = false
  for (let i = 0; i <= 4 * 366; i++) {
    const d = new Date(start + i * 86_400_000)
    const matches = cronDayMatches(spec, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay())
    if (matches && prevMatches) return Math.min(min, wrap)
    prevMatches = matches
  }
  return min
}

/** True when some day within the next eight years matches (so `0 0 31 2 *` never does). */
export function everRuns(spec: CronSpec): boolean {
  if (!spec.minutes.length || !spec.hours.length) return false
  const start = Date.UTC(2024, 0, 1)
  for (let i = 0; i <= 8 * 366; i++) {
    const d = new Date(start + i * 86_400_000)
    if (cronDayMatches(spec, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay())) return true
  }
  return false
}

/** True when the cron never runs more often than every MIN_INTERVAL_MINUTES. */
export function isHourlyOrSlower(spec: CronSpec): boolean {
  return minGapMinutes(spec) >= MIN_INTERVAL_MINUTES
}

// ---- presets ---------------------------------------------------------------------------------------------------
export type PresetFreq = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
/** The fields of a preset schedule (AgentSchedule without the time zone). */
export interface PresetFields {
  freq: PresetFreq
  minute: number
  hour?: number
  weekday?: number
  monthday?: number
}

/**
 * The preset a cron is exactly equivalent to, or null when no preset covers it (several times a day, several
 * weekdays other than Monday-Friday, a restricted month, a day-of-month above 28, ...). A null stays a custom cron.
 */
export function cronToPreset(spec: CronSpec): PresetFields | null {
  if (spec.months.size !== 12) return null
  const domAll = spec.domAny && spec.doms.size === 31
  const dowAll = spec.dowAny && spec.dows.size === 7
  if (spec.minutes.length !== 1) return null
  const minute = spec.minutes[0] as number
  if (spec.hours.length === 24 && domAll && dowAll) return { freq: 'hourly', minute }
  if (spec.hours.length !== 1) return null
  const hour = spec.hours[0] as number
  if (domAll && dowAll) return { freq: 'daily', minute, hour }
  const days = [...spec.dows].sort((a, b) => a - b)
  if (domAll && !spec.dowAny) {
    if (days.join() === '1,2,3,4,5') return { freq: 'weekdays', minute, hour }
    if (days.length === 1) return { freq: 'weekly', minute, hour, weekday: days[0] as number }
  }
  if (!spec.domAny && dowAll && spec.doms.size === 1) {
    const monthday = [...spec.doms][0] as number
    if (monthday <= 28) return { freq: 'monthly', minute, hour, monthday }
  }
  return null
}

/** The cron a preset is the same as (what the editor offers to start a custom cron from). */
export function presetToCron(p: PresetFields): string {
  const hour = p.hour ?? 0
  switch (p.freq) {
    case 'hourly':
      return `${p.minute} * * * *`
    case 'daily':
      return `${p.minute} ${hour} * * *`
    case 'weekdays':
      return `${p.minute} ${hour} * * 1-5`
    case 'weekly':
      return `${p.minute} ${hour} * * ${p.weekday ?? 0}`
    case 'monthly':
      return `${p.minute} ${hour} ${p.monthday ?? 1} * *`
  }
}
