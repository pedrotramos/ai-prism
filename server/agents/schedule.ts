// When does an agent run next? (W4-4a) Pure: the structured presets of AgentSchedule, computed in the schedule's own
// IANA time zone with Intl (no dependency; the same technique server/usage.ts uses for zonedMonthStart).
//
// A schedule is a set of LOCAL wall-clock times (daily at 08:00, hourly at minute 15, ...), or, for the "Custom
// (advanced)" option, a 5-field cron (shared/cron.ts) that selects them. Each one is turned into
// an instant with the pg-boss rules:
//   - a wall time that does not exist (the DST gap) runs at the first valid instant after it, i.e. the moment the
//     clock jumps (02:30 on the spring-forward day runs at 03:00);
//   - a wall time that happens twice (the repeated hour) runs once, at its first occurrence. The second pass is
//     never a candidate: candidates are wall times, and each wall time resolves to ONE instant.
// nextOccurrence walks the candidate wall times in order and returns the first instant strictly after `after`.
import type { AgentSchedule, PresetSchedule } from './definition.ts'
import { isValidTimeZone } from './definition.ts'
import { nextMatchingDay, parseCron, timesOfDay } from '../../shared/cron.ts'
import type { CronSpec } from '../../shared/cron.ts'

const MIN = 60_000

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  if (!isValidTimeZone(tz)) throw new RangeError(`invalid time zone: ${JSON.stringify(tz)}`)
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(tz, f)
  }
  return f
}

interface Wall {
  y: number
  mo: number // 1-12
  d: number
  h: number
  mi: number
}

/** The wall clock of instant `t` in `tz`. */
function wallOf(t: number, tz: string): Wall & { s: number } {
  const p: Record<string, number> = {}
  for (const part of formatter(tz).formatToParts(new Date(t))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  const g = (k: string): number => p[k] ?? 0
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour') === 24 ? 0 : g('hour'), mi: g('minute'), s: g('second') }
}

/** UTC offset of `tz` at instant `t`, in minutes (local = utc + offset). */
function offsetMin(t: number, tz: string): number {
  const w = wallOf(t, tz)
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / MIN)
}

/** The instant a wall time resolves to (the rules in the file header). */
function resolve(w: Wall, tz: string): number {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi)
  const before = offsetMin(guess - 36 * 60 * MIN, tz)
  const after = offsetMin(guess + 36 * 60 * MIN, tz)
  const found = new Set<number>()
  for (const off of new Set([before, after, offsetMin(guess, tz)])) {
    const t = guess - off * MIN
    if (offsetMin(t, tz) === off) found.add(t)
  }
  if (found.size) return Math.min(...found) // two matches = the repeated hour: the first
  // the DST gap: the instant the offset changes (bisect on whole minutes)
  let lo = guess - 36 * 60 * MIN
  let hi = guess + 36 * 60 * MIN
  const offLo = offsetMin(lo, tz)
  while (hi - lo > MIN) {
    const mid = lo + Math.floor((hi - lo) / 2 / MIN) * MIN
    if (offsetMin(mid, tz) === offLo) lo = mid
    else hi = mid
  }
  return hi
}

const dayAdd = (y: number, mo: number, d: number, n: number) => {
  const dt = new Date(Date.UTC(y, mo - 1, d + n))
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay() }
}

function dayMatches(s: PresetSchedule, wd: number, d: number): boolean {
  switch (s.freq) {
    case 'hourly':
    case 'daily':
      return true
    case 'weekdays':
      return wd >= 1 && wd <= 5
    case 'weekly':
      return wd === s.weekday
    case 'monthly':
      return d === s.monthday
  }
}

/**
 * First occurrence strictly after `after`, in s.tz. A local time that doesn't exist (DST gap) runs at the first valid
 * instant after it; in a repeated hour it runs once, at the first occurrence (pg-boss rules). Throws on an invalid tz.
 */
export function nextOccurrence(s: AgentSchedule, after: Date): Date {
  formatter(s.tz) // throws RangeError for an invalid zone before anything else
  const t0 = after.getTime()
  if (!Number.isFinite(t0)) throw new RangeError('invalid date')
  const here = wallOf(t0, s.tz)
  if (s.freq === 'custom') return nextCronOccurrence(parseCron(s.cron), s.tz, t0, here)
  const hours = s.freq === 'hourly' ? Array.from({ length: 24 }, (_, h) => h) : [s.hour ?? 0]
  // a monthly schedule needs up to ~2 months; start a day early so a repeated hour at midnight is not missed
  for (let i = -1; i <= 70; i++) {
    const day = dayAdd(here.y, here.mo, here.d, i)
    if (!dayMatches(s, day.wd, day.d)) continue
    for (const h of hours) {
      const t = resolve({ y: day.y, mo: day.mo, d: day.d, h, mi: s.minute }, s.tz)
      if (t > t0) return new Date(t)
    }
  }
  throw new RangeError('no occurrence within the search window (invalid schedule)')
}

// A cron, in the same terms: its matching calendar days, each time of day resolved to one instant. The days come from
// shared/cron.ts's nextMatchingDay, which is exact over a whole Gregorian cycle, so a cron that validates (everRuns)
// always has a next occurrence, however sparse (29 February on a Sunday is 28-40 years apart): the scheduler and the
// preview never throw for a saved cron. Only an expression with no matching day at all fails here (never saved: cron_never).
function nextCronOccurrence(spec: CronSpec, tz: string, t0: number, here: Wall): Date {
  const times = timesOfDay(spec)
  // start a day early: the zone's wall date can trail the instant's by a day (a repeated hour at midnight)
  let from = dayAdd(here.y, here.mo, here.d, -1)
  for (let guard = 0; guard < 8; guard++) {
    const day = nextMatchingDay(spec, from)
    if (!day) break
    for (const tod of times) {
      const t = resolve({ y: day.y, mo: day.mo, d: day.d, h: Math.floor(tod / 60), mi: tod % 60 }, tz)
      if (t > t0) return new Date(t)
    }
    from = dayAdd(day.y, day.mo, day.d, 1) // every time of that day is already past: the next matching day
  }
  throw new RangeError('no occurrence (invalid schedule)')
}

const DAYS = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  pt: ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'],
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
} as const

const pad = (n: number) => String(n).padStart(2, '0')

/** A short human description of the schedule, in the owner's language ("Every Monday at 08:05 (America/Sao_Paulo)"). */
export function describeSchedule(s: AgentSchedule, lang: 'en' | 'pt' | 'es'): string {
  const l = lang === 'pt' || lang === 'es' ? lang : 'en'
  if (s.freq === 'custom') {
    const lead = { en: 'Custom schedule', pt: 'Agenda personalizada', es: 'Programación personalizada' }[l]
    return `${lead}: ${s.cron} (${s.tz})`
  }
  const time = `${pad(s.hour ?? 0)}:${pad(s.minute)}`
  const zone = `(${s.tz})`
  const day = DAYS[l][s.weekday ?? 0]
  const T = {
    en: {
      hourly: `Every hour at :${pad(s.minute)} ${zone}`,
      daily: `Every day at ${time} ${zone}`,
      weekdays: `Every weekday at ${time} ${zone}`,
      weekly: `Every ${day} at ${time} ${zone}`,
      monthly: `On day ${s.monthday} of every month at ${time} ${zone}`,
    },
    pt: {
      hourly: `A cada hora no minuto ${pad(s.minute)} ${zone}`,
      daily: `Todo dia às ${time} ${zone}`,
      weekdays: `Todo dia útil às ${time} ${zone}`,
      weekly: `Toda ${day} às ${time} ${zone}`,
      monthly: `No dia ${s.monthday} de cada mês às ${time} ${zone}`,
    },
    es: {
      hourly: `Cada hora en el minuto ${pad(s.minute)} ${zone}`,
      daily: `Todos los días a las ${time} ${zone}`,
      weekdays: `Todos los días hábiles a las ${time} ${zone}`,
      weekly: `Cada ${day} a las ${time} ${zone}`,
      monthly: `El día ${s.monthday} de cada mes a las ${time} ${zone}`,
    },
  }
  return T[l][s.freq]
}
