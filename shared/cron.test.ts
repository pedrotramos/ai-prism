// shared/cron.ts: the 5-field cron of the "Custom (advanced)" agent schedule. Parsing, the hourly floor and the
// mapping to and from the presets. The instants (time zones, DST) are server/agents/schedule.test.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CronError, GREGORIAN_CYCLE_DAYS, canonicalCron, cronProblem, cronToPreset, everRuns, isHourlyOrSlower, minGapMinutes, nextMatchingDay, parseCron, presetToCron, timesOfDay } from './cron.ts'

const code = (expr: unknown) => {
  try {
    parseCron(expr)
    return null
  } catch (e) {
    assert.ok(e instanceof CronError)
    return e.code
  }
}

test('parseCron: lists, ranges, steps, names and 7 = Sunday', () => {
  const s = parseCron('0,30 8-10 1,15 JAN,mar */2')
  assert.deepEqual(s.minutes, [0, 30])
  assert.deepEqual(s.hours, [8, 9, 10])
  assert.deepEqual([...s.doms], [1, 15])
  assert.deepEqual([...s.months], [1, 3])
  assert.deepEqual([...s.dows].sort(), [0, 2, 4, 6])
  assert.deepEqual([...parseCron('0 0 * * 7').dows], [0])
  assert.deepEqual([...parseCron('0 0 * * SUN-TUE').dows].sort(), [0, 1, 2])
  assert.deepEqual(parseCron('5/20 * * * *').minutes, [5, 25, 45], 'a start with a step runs to the end of the range')
  assert.equal(parseCron('  0   8  *  *  1-5 ').source, '0 8 * * 1-5', 'whitespace is normalised')
})

test('parseCron: macros expand', () => {
  assert.equal(parseCron('@daily').source, '0 0 * * *')
  assert.equal(parseCron('@HOURLY').source, '0 * * * *')
  assert.equal(parseCron('@weekly').source, '0 0 * * 0')
  assert.equal(parseCron('@monthly').source, '0 0 1 * *')
  assert.equal(code('@sometimes'), 'cron_invalid')
})

test('parseCron: every refusal has a stable code', () => {
  assert.equal(code(undefined), 'cron_empty')
  assert.equal(code(42), 'cron_empty')
  assert.equal(code('   '), 'cron_empty')
  assert.equal(code('x'.repeat(121)), 'cron_too_long')
  assert.equal(code('0 8 * *'), 'cron_fields')
  assert.equal(code('0 0 8 * * 1'), 'cron_fields')
  assert.equal(code('60 * * * *'), 'cron_invalid')
  assert.equal(code('0 24 * * *'), 'cron_invalid')
  assert.equal(code('0 0 0 * *'), 'cron_invalid')
  assert.equal(code('0 0 32 * *'), 'cron_invalid')
  assert.equal(code('0 0 * 13 *'), 'cron_invalid')
  assert.equal(code('0 0 * * 8'), 'cron_invalid')
  assert.equal(code('*/0 * * * *'), 'cron_invalid')
  assert.equal(code('10-5 * * * *'), 'cron_invalid')
  assert.equal(code('1-2-3 * * * *'), 'cron_invalid')
  assert.equal(code('a * * * *'), 'cron_invalid')
  assert.equal(code('0 0 * * FUNDAY'), 'cron_invalid')
  assert.equal(code('0 8 ? * *'), 'cron_invalid', 'Quartz syntax is not cron')
  assert.equal(cronProblem('0 8 * * 1'), null)
  assert.equal(cronProblem('nope'), 'cron_fields')
})

test('timesOfDay: every hour x minute pair, ascending', () => {
  assert.deepEqual(timesOfDay(parseCron('15,45 8,17 * * *')), [8 * 60 + 15, 8 * 60 + 45, 17 * 60 + 15, 17 * 60 + 45])
})

test('minGapMinutes: the shortest wall-clock gap between two runs', () => {
  const gap = (c: string) => minGapMinutes(parseCron(c))
  assert.equal(gap('* * * * *'), 1)
  assert.equal(gap('*/5 * * * *'), 5)
  assert.equal(gap('0,30 8 * * *'), 30)
  assert.equal(gap('0 * * * *'), 60)
  assert.equal(gap('15 8,17 * * *'), 9 * 60)
  assert.equal(gap('0 8 * * *'), 1440)
  assert.equal(gap('30 23 * * 1-2'), 1440, 'Mon 23:30, Tue 23:30')
  assert.equal(gap('0 8 * * 1'), Infinity, 'one weekday: no two runs on adjacent days')
})

test('minGapMinutes: the last run of a day against the first of the next counts only when both days run', () => {
  const gap = (c: string) => minGapMinutes(parseCron(c))
  // 23:50 -> 00:00 the next day is 10 minutes, though inside a day the closest runs are 50 apart
  assert.equal(gap('0,50 0,23 * * *'), 10)
  assert.equal(gap('0,50 0,23 * * 1,2'), 10, 'Mon 23:50 -> Tue 00:00')
  assert.equal(gap('0,50 0,23 * * 1,3'), 50, 'Monday and Wednesday are not adjacent: only the 50 inside a day')
  assert.equal(gap('0,50 0,23 * * 6,0'), 10, 'Saturday -> Sunday')
  assert.equal(gap('0,50 0,23 * * 0,6'), 10)
  assert.equal(gap('0,50 0,23 1 * *'), 50, 'the 1st only: adjacent days never both run')
  assert.equal(gap('0,50 0,23 31 * *'), 50, 'the 31st only: two adjacent days never both run')
  assert.equal(gap('0 0,23 * * 1,2'), 60, 'Mon 23:00 -> Tue 00:00')
})

test('isHourlyOrSlower: the floor is the hourly preset', () => {
  assert.equal(isHourlyOrSlower(parseCron('0 * * * *')), true)
  assert.equal(isHourlyOrSlower(parseCron('59 * * * *')), true)
  assert.equal(isHourlyOrSlower(parseCron('0 8-18 * * 1-5')), true)
  assert.equal(isHourlyOrSlower(parseCron('0 0,12 * * *')), true)
  assert.equal(isHourlyOrSlower(parseCron('*/30 * * * *')), false)
  assert.equal(isHourlyOrSlower(parseCron('0,59 * * * *')), false)
  assert.equal(isHourlyOrSlower(parseCron('0,45 8 * * *')), false)
  assert.equal(isHourlyOrSlower(parseCron('* * * * *')), false)
  assert.equal(isHourlyOrSlower(parseCron('59 23 * * 1,2')), true)
})

test('everRuns: a date no calendar has never runs', () => {
  assert.equal(everRuns(parseCron('0 0 31 2 *')), false)
  assert.equal(everRuns(parseCron('0 0 30 2 *')), false)
  assert.equal(everRuns(parseCron('0 0 29 2 *')), true, '29 February exists')
  assert.equal(everRuns(parseCron('0 0 31 4 *')), false)
  assert.equal(everRuns(parseCron('0 0 31 * *')), true)
})

test('canonicalCron: every spelling of one schedule is one string', () => {
  const canon = (c: string) => canonicalCron(parseCron(c))
  for (const c of ['0 9,17 * * 1-5', '0 9,17 * * MON-FRI', '0 9,17 * * mon-fri', '0 17,9 * * 1-5', '00 09,17 * * 1,2,3,4,5', '0 9-9,17 * * 1-5', '0 9,17,9 * * MON,TUE,WED,THU,FRI']) {
    assert.equal(canon(c), '0 9,17 * * 1-5', c)
  }
  assert.equal(canon('0 8 * * 7'), '0 8 * * 0', '7 is Sunday')
  assert.equal(canon('0 8 * * SUN'), '0 8 * * 0')
  assert.equal(canon('0 0,6,12,18 * * *'), canon('0 */6 * * *'))
  assert.equal(canon('0 */6 * * *'), '0 0,6,12,18 * * *')
  assert.equal(canon('0 8 * JAN-MAR *'), '0 8 * 1-3 *')
  assert.equal(canon('0 8 * 1,2,3,4,5,6,7,8,9,10,11,12 *'), '0 8 * * *', 'every month is the same as *')
  assert.equal(canon('@weekly'), '0 0 * * 0')
})

const canon2 = (c: string) => canonicalCron(parseCron(c))
test('canonicalCron keeps what a set cannot carry: a day field that starts with * (AND) is not a restricted one (OR)', () => {
  assert.equal(canon2('0 0 */2 * 1'), '0 0 */2 * 1')
  assert.equal(canon2('0 0 1-31 * 1'), '0 0 1-31 * 1', '1-31 is restricted: OR, so every day, unlike *')
  assert.notEqual(canon2('0 0 1-31 * 1'), canon2('0 0 * * 1'))
  assert.equal(canon2('0 0 1,15 * *'), '0 0 1,15 * *')
  assert.equal(canon2('0 0 * * */2'), '0 0 * * */2')
  assert.equal(canon2('0 0 * * 0-6'), '0 0 * * 0-6')
  assert.equal(canon2('0 0 * * *'), '0 0 * * *')
  assert.equal(canon2('0 0 */2,5 * 1'), '0 0 */2 * 1', '5 is already an odd day: the same set, so the same step')
  assert.equal(canon2('0 0 */2,6 * 1'), '0 0 */2,6 * 1', 'a *-led list with no plain step keeps its own spelling')
})

test('canonicalCron is idempotent and never changes the schedule (same sets, same OR/AND rule)', () => {
  const sample = ['0 9,17 * * MON-FRI', '30 6-8 * * *', '0 0 13 * 5', '0 0 */2 * 1', '0 0 1,15 * 1', '5/15 0 * * *', '0 0 29 FEB *', '0 0 29 2 */99,4', '0 8 * * 7', '0 8 * * 5-7', '@monthly', '15 4 1-31 * 0-6', '0 0 * * */3', '0 0,12 31 1,3,5,7,8,10,12 *']
  for (const c of sample) {
    const a = parseCron(c)
    const text = canonicalCron(a)
    const b = parseCron(text)
    assert.deepEqual([b.minutes, b.hours, [...b.doms], [...b.months], [...b.dows].sort(), b.domAny, b.dowAny], [a.minutes, a.hours, [...a.doms], [...a.months], [...a.dows].sort(), a.domAny, a.dowAny], c)
    assert.equal(canonicalCron(b), text, `${c}: idempotent`)
  }
})

test('everRuns is exact, not a horizon: a leap day that also has to be a given weekday', () => {
  // 29 February on a Sunday: 2032, 2060, 2088 (28 years apart, 40 across 2100). A window of eight years misses it
  assert.equal(everRuns(parseCron('0 0 29 2 */7')), true)
  assert.equal(everRuns(parseCron('0 0 29 2 */99,4')), true)
  assert.equal(everRuns(parseCron('0 0 29 2 0')), true, 'a bare weekday is OR: every Sunday of February')
  assert.equal(everRuns(parseCron('0 0 30 2 */7')), false)
  assert.equal(everRuns(parseCron('0 0 31 4,6,9,11 *')), false)
  assert.equal(everRuns(parseCron('0 0 31 2,4 *')), false)
})

test('nextMatchingDay: from any start the answer is the same exact search; null only when no day ever matches', () => {
  const sun = parseCron('0 0 29 2 */7')
  assert.deepEqual(nextMatchingDay(sun, { y: 2026, mo: 11, d: 27 }), { y: 2032, mo: 2, d: 29, wd: 0 })
  assert.deepEqual(nextMatchingDay(sun, { y: 2032, mo: 2, d: 29 }), { y: 2032, mo: 2, d: 29, wd: 0 }, 'on or after: the start day counts')
  assert.deepEqual(nextMatchingDay(sun, { y: 2032, mo: 3, d: 1 }), { y: 2060, mo: 2, d: 29, wd: 0 })
  assert.deepEqual(nextMatchingDay(sun, { y: 2088, mo: 3, d: 1 }), { y: 2128, mo: 2, d: 29, wd: 0 }, '40 years across 2100, which is not a leap year')
  assert.equal(nextMatchingDay(parseCron('0 0 31 2 *'), { y: 2026, mo: 1, d: 1 }), null)
  assert.equal(GREGORIAN_CYCLE_DAYS, 400 * 365 + 97, '400 years, 97 leap days')
  assert.equal(GREGORIAN_CYCLE_DAYS % 7, 0, 'a whole number of weeks, so the weekday pattern repeats exactly')
})

test('cronToPreset: only an exact equivalent becomes a preset', () => {
  const p = (c: string) => cronToPreset(parseCron(c))
  assert.deepEqual(p('15 * * * *'), { freq: 'hourly', minute: 15 })
  assert.deepEqual(p('@hourly'), { freq: 'hourly', minute: 0 })
  assert.deepEqual(p('30 9 * * *'), { freq: 'daily', minute: 30, hour: 9 })
  assert.deepEqual(p('@daily'), { freq: 'daily', minute: 0, hour: 0 })
  assert.deepEqual(p('0 8 * * 1-5'), { freq: 'weekdays', minute: 0, hour: 8 })
  assert.deepEqual(p('0 8 * * MON,TUE,WED,THU,FRI'), { freq: 'weekdays', minute: 0, hour: 8 })
  assert.deepEqual(p('0 8 * * 1'), { freq: 'weekly', minute: 0, hour: 8, weekday: 1 })
  assert.deepEqual(p('0 8 * * 7'), { freq: 'weekly', minute: 0, hour: 8, weekday: 0 })
  assert.deepEqual(p('0 8 15 * *'), { freq: 'monthly', minute: 0, hour: 8, monthday: 15 })
  // not covered by a preset: stays custom
  assert.equal(p('0 8,17 * * *'), null, 'two times a day')
  assert.equal(p('0,30 8 * * *'), null, 'two minutes')
  assert.equal(p('0 8 * * 1,3'), null, 'two weekdays other than Monday-Friday')
  assert.equal(p('0 8 * * 0,6'), null, 'weekend')
  assert.equal(p('0 8 29 * *'), null, 'the monthly preset stops at day 28')
  assert.equal(p('0 8 1 1 *'), null, 'a month restriction')
  assert.equal(p('0 8 */2 * *'), null, 'every other day of the month')
  assert.equal(p('0 8 1 * 1'), null, 'day of month OR weekday')
  assert.equal(p('0 */2 * * *'), null, 'every other hour')
})

test('presetToCron round-trips with cronToPreset for the five presets', () => {
  const presets = [
    { freq: 'hourly', minute: 5 },
    { freq: 'daily', minute: 0, hour: 23 },
    { freq: 'weekdays', minute: 45, hour: 7 },
    { freq: 'weekly', minute: 0, hour: 8, weekday: 3 },
    { freq: 'monthly', minute: 10, hour: 6, monthday: 28 },
  ] as const
  for (const preset of presets) {
    const cron = presetToCron(preset)
    assert.deepEqual(cronToPreset(parseCron(cron)), preset, cron)
  }
  assert.equal(presetToCron({ freq: 'weekly', minute: 0, hour: 8, weekday: 1 }), '0 8 * * 1')
})
