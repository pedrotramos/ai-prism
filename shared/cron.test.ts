// shared/cron.ts: the 5-field cron of the "Custom (advanced)" agent schedule. Parsing, the hourly floor and the
// mapping to and from the presets. The instants (time zones, DST) are server/agents/schedule.test.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CronError, cronProblem, cronToPreset, everRuns, isHourlyOrSlower, minGapMinutes, parseCron, presetToCron, timesOfDay } from './cron.ts'

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
  assert.equal(everRuns(parseCron('0 0 29 2 *')), true, '29 February exists within eight years')
  assert.equal(everRuns(parseCron('0 0 31 4 *')), false)
  assert.equal(everRuns(parseCron('0 0 31 * *')), true)
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
