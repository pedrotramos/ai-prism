// W4-4a AC5: nextOccurrence against the DST table (design §1.9) and an invalid time zone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeSchedule, nextOccurrence } from './schedule.ts'
import { notifyAgentsChanged, onAgentsChanged } from './events.ts'
import type { AgentSchedule } from './definition.ts'
import { everRuns, parseCron } from '../../shared/cron.ts'

const next = (s: AgentSchedule, after: string) => nextOccurrence(s, new Date(after)).toISOString()
const daily = (hour: number, minute: number, tz: string): AgentSchedule => ({ freq: 'daily', hour, minute, tz })

test('America/Sao_Paulo has no DST (UTC-3 all year)', () => {
  assert.equal(next(daily(8, 0, 'America/Sao_Paulo'), '2026-03-07T00:00:00Z'), '2026-03-07T11:00:00.000Z')
  assert.equal(next(daily(8, 0, 'America/Sao_Paulo'), '2026-12-01T12:00:00Z'), '2026-12-02T11:00:00.000Z')
})

test('strictly after: an instant equal to `after` is not returned', () => {
  assert.equal(next(daily(8, 0, 'UTC'), '2026-05-01T08:00:00Z'), '2026-05-02T08:00:00.000Z')
  assert.equal(next(daily(8, 0, 'UTC'), '2026-05-01T07:59:59.999Z'), '2026-05-01T08:00:00.000Z')
})

test('America/New_York spring forward: 02:30 does not exist on 2026-03-08, it runs at the first valid instant (03:00 EDT)', () => {
  const s = daily(2, 30, 'America/New_York')
  assert.equal(next(s, '2026-03-08T00:00:00Z'), '2026-03-08T07:00:00.000Z')
  assert.equal(next(s, '2026-03-08T07:00:00Z'), '2026-03-09T06:30:00.000Z')
})

test('America/New_York fall back: 01:30 happens twice on 2026-11-01, it runs once, at the first', () => {
  const s = daily(1, 30, 'America/New_York')
  assert.equal(next(s, '2026-10-31T12:00:00Z'), '2026-11-01T05:30:00.000Z')
  assert.equal(next(s, '2026-11-01T05:30:00Z'), '2026-11-02T06:30:00.000Z')
  assert.equal(next(s, '2026-11-01T05:45:00Z'), '2026-11-02T06:30:00.000Z')
})

test('Europe/Lisbon spring forward and fall back', () => {
  const s = daily(1, 30, 'Europe/Lisbon')
  assert.equal(next(s, '2026-03-28T12:00:00Z'), '2026-03-29T01:00:00.000Z')
  assert.equal(next(s, '2026-10-24T12:00:00Z'), '2026-10-25T00:30:00.000Z')
  assert.equal(next(s, '2026-10-25T00:30:00Z'), '2026-10-26T01:30:00.000Z')
})

test('Australia/Lord_Howe: a 30-minute DST shift', () => {
  // +10:30 standard, +11:00 summer. DST starts 2026-10-04 02:00 (-> 02:30), ends 2026-04-05 02:00 (-> 01:30).
  assert.equal(next(daily(2, 15, 'Australia/Lord_Howe'), '2026-10-03T00:00:00Z'), '2026-10-03T15:30:00.000Z')
  assert.equal(next(daily(1, 45, 'Australia/Lord_Howe'), '2026-04-04T00:00:00Z'), '2026-04-04T14:45:00.000Z')
  assert.equal(next(daily(1, 45, 'Australia/Lord_Howe'), '2026-04-04T14:45:00Z'), '2026-04-05T15:15:00.000Z')
  assert.equal(next(daily(8, 0, 'Australia/Lord_Howe'), '2026-06-01T00:00:00Z'), '2026-06-01T21:30:00.000Z')
})

test('hourly: at the given local minute, also in a zone with a 30-minute offset', () => {
  assert.equal(next({ freq: 'hourly', minute: 15, tz: 'America/Sao_Paulo' }, '2026-06-01T12:20:00Z'), '2026-06-01T13:15:00.000Z')
  assert.equal(next({ freq: 'hourly', minute: 15, tz: 'Australia/Lord_Howe' }, '2026-06-01T00:00:00Z'), '2026-06-01T00:45:00.000Z')
})

test('hourly across the New_York fall back: the repeated hour runs once', () => {
  const s: AgentSchedule = { freq: 'hourly', minute: 30, tz: 'America/New_York' }
  assert.equal(next(s, '2026-11-01T05:00:00Z'), '2026-11-01T05:30:00.000Z') // 01:30 EDT
  assert.equal(next(s, '2026-11-01T05:30:00Z'), '2026-11-01T07:30:00.000Z') // the repeated 01:30 EST is skipped: next is 02:30 EST
})

test('hourly across the spring forward: the missing hour collapses into the first valid instant', () => {
  const s: AgentSchedule = { freq: 'hourly', minute: 30, tz: 'America/New_York' }
  assert.equal(next(s, '2026-03-08T06:30:00Z'), '2026-03-08T07:00:00.000Z') // 02:30 does not exist -> 03:00 EDT
  assert.equal(next(s, '2026-03-08T07:00:00Z'), '2026-03-08T07:30:00.000Z') // 03:30 EDT
})

test('weekdays skips the weekend; weekly uses 0 = Sunday; monthly clamps to day 1-28', () => {
  // 2026-03-06 is a Friday
  assert.equal(next({ freq: 'weekdays', hour: 9, minute: 0, tz: 'UTC' }, '2026-03-06T10:00:00Z'), '2026-03-09T09:00:00.000Z')
  assert.equal(next({ freq: 'weekly', weekday: 0, hour: 9, minute: 0, tz: 'UTC' }, '2026-03-06T10:00:00Z'), '2026-03-08T09:00:00.000Z')
  assert.equal(next({ freq: 'weekly', weekday: 5, hour: 9, minute: 0, tz: 'UTC' }, '2026-03-06T10:00:00Z'), '2026-03-13T09:00:00.000Z')
  assert.equal(next({ freq: 'monthly', monthday: 28, hour: 9, minute: 0, tz: 'UTC' }, '2026-02-28T10:00:00Z'), '2026-03-28T09:00:00.000Z')
  assert.equal(next({ freq: 'monthly', monthday: 1, hour: 0, minute: 0, tz: 'UTC' }, '2026-12-15T00:00:00Z'), '2027-01-01T00:00:00.000Z')
})

test('the local date follows the time zone, not UTC', () => {
  // 2026-05-01T02:00Z is still 2026-04-30 23:00 in Sao_Paulo: 08:00 local that day is 11:00Z on the 1st
  assert.equal(next(daily(8, 0, 'America/Sao_Paulo'), '2026-05-01T02:00:00Z'), '2026-05-01T11:00:00.000Z')
})

test('an invalid time zone throws', () => {
  assert.throws(() => nextOccurrence(daily(8, 0, 'Mars/Olympus'), new Date()), /time ?zone/i)
  assert.throws(() => nextOccurrence(daily(8, 0, ''), new Date()), /time ?zone/i)
  assert.throws(() => nextOccurrence({ ...daily(8, 0, 'UTC'), tz: undefined as unknown as string }, new Date()), /time ?zone/i)
})

test('describeSchedule speaks en, pt and es and names the zone', () => {
  const s: AgentSchedule = { freq: 'weekly', weekday: 1, hour: 8, minute: 5, tz: 'America/Sao_Paulo' }
  assert.match(describeSchedule(s, 'en'), /Monday.*08:05.*America\/Sao_Paulo/)
  assert.match(describeSchedule(s, 'pt'), /segunda.*08:05.*America\/Sao_Paulo/i)
  assert.match(describeSchedule(s, 'es'), /lunes.*08:05.*America\/Sao_Paulo/i)
  assert.match(describeSchedule({ freq: 'hourly', minute: 7, tz: 'UTC' }, 'en'), /hour.*:07/i)
  assert.match(describeSchedule({ freq: 'monthly', monthday: 3, hour: 0, minute: 0, tz: 'UTC' }, 'en'), /3.*00:00/)
  assert.match(describeSchedule({ freq: 'weekdays', hour: 9, minute: 0, tz: 'UTC' }, 'en'), /weekday/i)
  assert.match(describeSchedule({ freq: 'daily', hour: 9, minute: 0, tz: 'UTC' }, 'pt'), /dia/i)
})

test('events: listeners are called once per notify, unsubscribe works, and a throwing listener stops nobody', () => {
  const seen: string[] = []
  const off1 = onAgentsChanged(() => seen.push('a'))
  const off2 = onAgentsChanged(() => {
    throw new Error('boom')
  })
  const off3 = onAgentsChanged(() => seen.push('c'))
  notifyAgentsChanged()
  assert.deepEqual(seen, ['a', 'c'])
  off1()
  notifyAgentsChanged()
  assert.deepEqual(seen, ['a', 'c', 'c'])
  off2()
  off3()
  notifyAgentsChanged()
  assert.deepEqual(seen, ['a', 'c', 'c'])
})

// ---- "Custom (advanced)": a cron schedule ---------------------------------------------------------------------
const custom = (cron: string, tz = 'UTC'): AgentSchedule => ({ freq: 'custom', cron, tz })
const runs = (s: AgentSchedule, from: string, n: number) => {
  const out: string[] = []
  let at = new Date(from)
  for (let i = 0; i < n; i++) {
    at = nextOccurrence(s, at)
    out.push(at.toISOString())
  }
  return out
}

test('custom: weekdays at two times a day, in the schedule\'s own zone, across a weekend', () => {
  assert.deepEqual(runs(custom('0 9,17 * * 1-5', 'America/Sao_Paulo'), '2026-11-27T12:00:00Z', 4), [
    '2026-11-27T20:00:00.000Z', // Fri 17:00 BRT
    '2026-11-30T12:00:00.000Z', // Mon 09:00
    '2026-11-30T20:00:00.000Z',
    '2026-12-01T12:00:00.000Z',
  ])
})

test('custom: strictly after, and the preview chain is strictly increasing', () => {
  assert.equal(next(custom('0 8 * * *'), '2026-05-01T08:00:00Z'), '2026-05-02T08:00:00.000Z')
  const r = runs(custom('0,30 6-8 * * *'), '2026-05-01T00:00:00Z', 8)
  for (let i = 1; i < r.length; i++) assert.ok(Date.parse(r[i] as string) > Date.parse(r[i - 1] as string))
})

test('custom: day-of-month and day-of-week both restricted match either (Vixie); a * leads to AND', () => {
  // the 13th OR a Friday
  assert.deepEqual(runs(custom('0 0 13 * 5'), '2026-11-01T00:00:00Z', 4), ['2026-11-06T00:00:00.000Z', '2026-11-13T00:00:00.000Z', '2026-11-20T00:00:00.000Z', '2026-11-27T00:00:00.000Z'])
  // */2 in the day-of-month still restricts: odd days only AND Monday
  assert.equal(next(custom('0 0 */2 * 1'), '2026-11-01T00:00:00Z'), '2026-11-09T00:00:00.000Z')
})

test('custom: a month restriction and 29 February', () => {
  assert.equal(next(custom('0 6 1 JAN *'), '2026-02-01T00:00:00Z'), '2027-01-01T06:00:00.000Z')
  assert.equal(next(custom('0 0 29 2 *'), '2026-03-01T00:00:00Z'), '2028-02-29T00:00:00.000Z')
})

test('custom: a date no calendar has throws, so the scheduler stops the agent instead of looping', () => {
  assert.throws(() => nextOccurrence(custom('0 0 31 2 *'), new Date('2026-01-01T00:00:00Z')), RangeError)
})

test('custom: a leap day that must also be a Sunday is 28-40 years apart, and still resolves (no horizon to fall off)', () => {
  assert.deepEqual(runs(custom('0 0 29 2 */7', 'UTC'), '2026-11-27T00:00:00Z', 3), ['2032-02-29T00:00:00.000Z', '2060-02-29T00:00:00.000Z', '2088-02-29T00:00:00.000Z'])
  assert.deepEqual(runs(custom('0 0 29 2 */99,4', 'UTC'), '2026-11-27T00:00:00Z', 3), ['2032-02-29T00:00:00.000Z', '2052-02-29T00:00:00.000Z', '2060-02-29T00:00:00.000Z'])
  // a bare weekday is the OR of Vixie: 29 February or any Monday in February
  assert.deepEqual(runs(custom('0 0 29 2 1', 'UTC'), '2026-11-27T00:00:00Z', 3), ['2027-02-01T00:00:00.000Z', '2027-02-08T00:00:00.000Z', '2027-02-15T00:00:00.000Z'])
})

test('custom: a cron the save-time check accepts always has three occurrences, and one it refuses has none', () => {
  const crons = ['0 0 29 2 *', '0 0 29 2 1', '0 0 29 2 */7', '0 0 29 2 */99,4', '0 0 29 2 */6', '0 0 29 2 */5', '30 4 29 2 1-5', '0 0 1 1 */7', '0 0 31 1,3,5,7,8,10,12 *', '0 0 31 2 *', '0 0 30 2 */7', '0 0 31 4,6,9,11 *']
  for (const c of crons) {
    const spec = parseCron(c)
    const got = (() => {
      try {
        return runs(custom(c, 'UTC'), '2026-11-27T00:00:00Z', 3)
      } catch {
        return null
      }
    })()
    assert.equal(got !== null, everRuns(spec), `${c}: validation and the occurrence search agree`)
    if (got) for (let i = 1; i < 3; i++) assert.ok(Date.parse(got[i] as string) > Date.parse(got[i - 1] as string), c)
  }
})

test('custom: DST in America/New_York, same rules as the presets', () => {
  // 02:30 does not exist on 2026-03-08: the first valid instant after it (03:00 EDT = 07:00Z)
  assert.equal(next(custom('30 2 * * *', 'America/New_York'), '2026-03-08T00:00:00Z'), '2026-03-08T07:00:00.000Z')
  // two times that fall on the same instant in the gap run once
  assert.deepEqual(runs(custom('0,30 2 * * *', 'America/New_York'), '2026-03-08T00:00:00Z', 2), ['2026-03-08T07:00:00.000Z', '2026-03-09T06:00:00.000Z'])
  // 01:30 happens twice on 2026-11-01: once, at the first
  assert.deepEqual(runs(custom('30 1 * * *', 'America/New_York'), '2026-10-31T12:00:00Z', 3), ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z', '2026-11-03T06:30:00.000Z'])
})

test('custom: an invalid zone throws like a preset', () => {
  assert.throws(() => nextOccurrence(custom('0 8 * * *', 'Mars/Olympus'), new Date()), RangeError)
})

test('custom: describeSchedule names the cron and the zone in en, pt and es', () => {
  const s = custom('0 9,17 * * 1-5', 'America/Sao_Paulo')
  assert.equal(describeSchedule(s, 'en'), 'Custom schedule: 0 9,17 * * 1-5 (America/Sao_Paulo)')
  assert.equal(describeSchedule(s, 'pt'), 'Agenda personalizada: 0 9,17 * * 1-5 (America/Sao_Paulo)')
  assert.equal(describeSchedule(s, 'es'), 'Programación personalizada: 0 9,17 * * 1-5 (America/Sao_Paulo)')
})
