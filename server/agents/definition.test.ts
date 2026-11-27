// W4-4a AC6: validateAgentInput refuses each bad input with a stable code and the field it came from;
// canonicalDefinition / approvalHash are stable (key order never changes the hash).
import test from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_LIMITS, approvalHash, canonicalDefinition, validateAgentInput } from './definition.ts'
import type { DefinitionContext } from './definition.ts'

const ctx: DefinitionContext = {
  models: new Set(['model-a', 'model-b']),
  catalog: new Map([
    ['main.tools.sales', { credentialClass: 'databricks' }],
    ['main.tools.mine', { credentialClass: 'per_user' }],
    ['main.tools.shared', { credentialClass: 'shared' }],
    ['main.tools.unknown', { credentialClass: 'unverified' }],
    ['main.tools.nullclass', { credentialClass: null }],
  ]),
}

const good = () => ({
  name: 'Weekly sales',
  description: 'Summarises last week',
  instructions: 'Be brief.',
  prompt: 'Summarise last week sales.',
  model: 'model-a',
  reasoningEffort: 'low',
  tools: ['web_search', 'artifact:deck', 'genie_one', 'mcp:main.tools.sales'],
  schedule: { freq: 'weekly', minute: 0, hour: 8, weekday: 1, tz: 'America/Sao_Paulo' },
  lang: 'pt',
})

const refuse = (patch: Record<string, unknown>, code: string, field: string) => {
  const r = validateAgentInput({ ...good(), ...patch }, ctx)
  assert.deepEqual(r.ok ? r : { code: (r as any).code, field: (r as any).field }, { code, field })
}

test('a valid input is accepted and split into name, description and the approval-scope definition', () => {
  const r = validateAgentInput(good(), ctx)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.name, 'Weekly sales')
  assert.equal(r.description, 'Summarises last week')
  assert.equal('name' in r.definition, false)
  assert.equal('description' in r.definition, false)
  assert.equal(r.definition.model, 'model-a')
  assert.deepEqual(r.definition.schedule, { freq: 'weekly', minute: 0, hour: 8, weekday: 1, tz: 'America/Sao_Paulo' })
})

test('limits are exactly the documented ones', () => {
  assert.deepEqual({ ...AGENT_LIMITS }, { nameMax: 80, descriptionMax: 500, instructionsMax: 8000, promptMax: 4000, toolsMax: 12, agentsPerOwner: 10 })
})

test('a null schedule, a null reasoning effort and no tools are valid', () => {
  const r = validateAgentInput({ ...good(), schedule: null, reasoningEffort: null, tools: [] }, ctx)
  assert.equal(r.ok, true)
})

test('every out-of-limit field is refused with field_too_long (at the limit it passes)', () => {
  for (const [field, max] of [['name', 80], ['description', 500], ['instructions', 8000], ['prompt', 4000]] as const) {
    assert.equal(validateAgentInput({ ...good(), [field]: 'x'.repeat(max) }, ctx).ok, true, `${field} at the limit`)
    refuse({ [field]: 'x'.repeat(max + 1) }, 'field_too_long', field)
  }
})

test('required fields: an empty name or prompt, a missing model', () => {
  refuse({ name: '   ' }, 'field_required', 'name')
  refuse({ prompt: '' }, 'field_required', 'prompt')
  refuse({ model: '' }, 'field_required', 'model')
})

test('wrong types are field_invalid', () => {
  refuse({ name: 7 }, 'field_invalid', 'name')
  refuse({ instructions: null }, 'field_invalid', 'instructions')
  refuse({ tools: 'web_search' }, 'field_invalid', 'tools')
  refuse({ lang: 'fr' }, 'field_invalid', 'lang')
  refuse({ reasoningEffort: 'extreme' }, 'field_invalid', 'reasoningEffort')
  assert.deepEqual(
    (() => { const r = validateAgentInput('nope', ctx); return r.ok ? r : { code: r.code, field: r.field } })(),
    { code: 'field_invalid', field: 'input' }
  )
})

test('more than 12 tools is tools_too_many; a repeated tool is tool_duplicate', () => {
  refuse({ tools: Array.from({ length: 13 }, (_, i) => `mcp:main.tools.s${i}`) }, 'tools_too_many', 'tools')
  refuse({ tools: ['web_search', 'web_search'] }, 'tool_duplicate', 'tools')
})

test('an unknown tool kind is tool_unknown', () => {
  refuse({ tools: ['shell'] }, 'tool_unknown', 'tools')
  refuse({ tools: ['artifact:video'] }, 'tool_unknown', 'tools')
  refuse({ tools: ['mcp:'] }, 'tool_unknown', 'tools')
  refuse({ tools: ['mcp:not-a-three-part-name'] }, 'tool_unknown', 'tools')
  refuse({ tools: [42] }, 'tool_unknown', 'tools')
})

test('a model outside the catalog is model_not_in_catalog', () => {
  refuse({ model: 'model-z' }, 'model_not_in_catalog', 'model')
})

test('an mcp: tool must be in the admin catalog and of credential class databricks', () => {
  refuse({ tools: ['mcp:main.tools.absent'] }, 'mcp_not_in_catalog', 'tools')
  for (const s of ['mine', 'shared', 'unknown', 'nullclass']) refuse({ tools: [`mcp:main.tools.${s}`] }, 'mcp_class_refused', 'tools')
  assert.equal(validateAgentInput({ ...good(), tools: ['mcp:main.tools.sales'] }, ctx).ok, true)
})

test('a schedule more frequent than hourly is schedule_too_frequent', () => {
  const s = (p: Record<string, unknown>) => ({ freq: 'hourly', minute: 0, tz: 'UTC', ...p })
  refuse({ schedule: s({ freq: 'minutely' }) }, 'schedule_too_frequent', 'schedule')
  refuse({ schedule: s({ freq: 'every_5_minutes' }) }, 'schedule_too_frequent', 'schedule')
  refuse({ schedule: s({ minute: [0, 15, 30, 45] }) }, 'schedule_too_frequent', 'schedule')
  refuse({ schedule: s({ minute: '*/5' }) }, 'schedule_too_frequent', 'schedule')
  refuse({ schedule: s({ interval_minutes: 5 }) }, 'schedule_too_frequent', 'schedule')
})

test('other schedule problems: unknown freq, bad ranges, bad time zone', () => {
  const s = (p: Record<string, unknown>) => ({ freq: 'daily', minute: 0, hour: 8, tz: 'UTC', ...p })
  refuse({ schedule: s({ freq: 'yearly' }) }, 'schedule_invalid', 'schedule')
  refuse({ schedule: s({ minute: 60 }) }, 'schedule_invalid', 'schedule')
  refuse({ schedule: s({ hour: 24 }) }, 'schedule_invalid', 'schedule')
  refuse({ schedule: s({ hour: undefined }) }, 'schedule_invalid', 'schedule')
  refuse({ schedule: s({ freq: 'weekly', weekday: 7 }) }, 'schedule_invalid', 'schedule')
  refuse({ schedule: s({ freq: 'monthly', monthday: 29 }) }, 'schedule_invalid', 'schedule')
  refuse({ schedule: s({ freq: 'monthly', monthday: 0 }) }, 'schedule_invalid', 'schedule')
  refuse({ schedule: s({ tz: 'Mars/Olympus' }) }, 'timezone_invalid', 'schedule')
  refuse({ schedule: s({ tz: '' }) }, 'timezone_invalid', 'schedule')
  refuse({ schedule: s({ tz: '+03:00' }) }, 'timezone_invalid', 'schedule')
  refuse({ schedule: 'daily' }, 'schedule_invalid', 'schedule')
})

test('the normalised schedule keeps only the fields its frequency uses', () => {
  const r = validateAgentInput({ ...good(), schedule: { freq: 'hourly', minute: 5, hour: 9, weekday: 3, monthday: 4, tz: 'UTC' } }, ctx)
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.definition.schedule, { freq: 'hourly', minute: 5, tz: 'UTC' })
})

test('canonicalDefinition sorts keys at every level; approvalHash is sha256 hex and ignores key order', () => {
  const r = validateAgentInput(good(), ctx)
  assert.ok(r.ok)
  if (!r.ok) return
  const d = r.definition
  const shuffled = JSON.parse(JSON.stringify({ lang: d.lang, tools: d.tools, schedule: { tz: d.schedule!.tz, hour: (d.schedule as { hour: number }).hour, minute: 0, weekday: 1, freq: 'weekly' }, reasoningEffort: d.reasoningEffort, prompt: d.prompt, model: d.model, instructions: d.instructions }))
  assert.equal(canonicalDefinition(d), canonicalDefinition(shuffled))
  assert.match(approvalHash(d), /^[0-9a-f]{64}$/)
  assert.equal(approvalHash(d), approvalHash(shuffled))
  assert.ok(canonicalDefinition(d).indexOf('"instructions"') < canonicalDefinition(d).indexOf('"lang"'))
  assert.notEqual(approvalHash(d), approvalHash({ ...d, prompt: d.prompt + '!' }))
  // tool order is part of the definition
  assert.notEqual(approvalHash(d), approvalHash({ ...d, tools: [...d.tools].reverse() }))
})

// ---- "Custom (advanced)": a cron schedule ---------------------------------------------------------------------
const withCron = (cron: unknown, tz = 'America/Sao_Paulo') => ({ schedule: { freq: 'custom', cron, tz } })
const scheduleOf = (patch: Record<string, unknown>) => {
  const r = validateAgentInput({ ...good(), ...patch }, ctx)
  assert.equal(r.ok, true, JSON.stringify(r))
  return r.ok ? r.definition.schedule : null
}

test('a custom cron the presets do not cover is kept as freq custom, normalised', () => {
  assert.deepEqual(scheduleOf(withCron('  0  9,17   * * 1-5 ')), { freq: 'custom', cron: '0 9,17 * * 1-5', tz: 'America/Sao_Paulo' })
  assert.deepEqual(scheduleOf(withCron('0 8 * * 1,3')), { freq: 'custom', cron: '0 8 * * 1,3', tz: 'America/Sao_Paulo' })
})

test('extra fields of a custom schedule are dropped, so its hash is stable', () => {
  const s = scheduleOf({ schedule: { freq: 'custom', cron: '0 9,17 * * *', tz: 'UTC', minute: 7, hour: 3, weekday: 1 } })
  assert.deepEqual(s, { freq: 'custom', cron: '0 9,17 * * *', tz: 'UTC' })
})

test('a custom cron that IS a preset becomes that preset (one definition, one approval hash)', () => {
  assert.deepEqual(scheduleOf(withCron('0 8 * * 1')), { freq: 'weekly', minute: 0, hour: 8, weekday: 1, tz: 'America/Sao_Paulo' })
  assert.deepEqual(scheduleOf(withCron('@daily', 'UTC')), { freq: 'daily', minute: 0, hour: 0, tz: 'UTC' })
  assert.deepEqual(scheduleOf(withCron('30 * * * *')), { freq: 'hourly', minute: 30, tz: 'America/Sao_Paulo' })
  const a = validateAgentInput({ ...good(), ...withCron('0 8 * * 1') }, ctx)
  const b = validateAgentInput(good(), ctx)
  assert.ok(a.ok && b.ok)
  if (a.ok && b.ok) assert.equal(approvalHash(a.definition), approvalHash(b.definition))
})

test('changing the cron changes the approval hash (an edit goes back to admin approval)', () => {
  const a = validateAgentInput({ ...good(), ...withCron('0 9,17 * * 1-5') }, ctx)
  const b = validateAgentInput({ ...good(), ...withCron('0 9,18 * * 1-5') }, ctx)
  const c = validateAgentInput({ ...good(), ...withCron('0 9,17 * * 1-5', 'UTC') }, ctx)
  assert.ok(a.ok && b.ok && c.ok)
  if (a.ok && b.ok && c.ok) {
    assert.notEqual(approvalHash(a.definition), approvalHash(b.definition))
    assert.notEqual(approvalHash(a.definition), approvalHash(c.definition), 'the zone is part of the scope too')
  }
})

test('a custom cron is refused with a stable code', () => {
  refuse(withCron('0 9,17 * *'), 'cron_fields', 'schedule')
  refuse(withCron('0 9,17 * * * *'), 'cron_fields', 'schedule')
  refuse(withCron('61 * * * *'), 'cron_invalid', 'schedule')
  refuse(withCron('0 8 * * FUNDAY'), 'cron_invalid', 'schedule')
  refuse(withCron(''), 'cron_invalid', 'schedule')
  refuse(withCron(null), 'cron_invalid', 'schedule')
  refuse({ schedule: { freq: 'custom', tz: 'UTC' } }, 'cron_invalid', 'schedule')
  refuse(withCron('x'.repeat(200)), 'cron_invalid', 'schedule')
  refuse(withCron('0 0 31 2 *'), 'cron_never', 'schedule')
  refuse(withCron('0 8 * * *', 'Mars/Olympus'), 'timezone_invalid', 'schedule')
  refuse(withCron('0 8 * * *', '+03:00'), 'timezone_invalid', 'schedule')
})

test('a sparse but real cron is accepted (a leap-day Sunday), an impossible one is cron_never', () => {
  for (const c of ['0 0 29 2 */7', '0 0 29 2 */99,4', '0 0 29 2 *']) assert.deepEqual(scheduleOf(withCron(c)), { freq: 'custom', cron: c, tz: 'America/Sao_Paulo' }, c)
  for (const c of ['0 0 30 2 */7', '0 0 31 4,6,9,11 *']) refuse(withCron(c), 'cron_never', 'schedule')
})

test('a custom cron more often than hourly is schedule_too_frequent, whatever the spelling', () => {
  for (const c of ['* * * * *', '*/5 * * * *', '*/30 * * * *', '0,45 8 * * *', '0,59 * * * *', '0,50 0,23 * * *']) {
    refuse(withCron(c), 'schedule_too_frequent', 'schedule')
  }
  assert.ok(scheduleOf(withCron('0 */2 * * *')), 'every other hour is fine')
  assert.ok(scheduleOf(withCron('0 8-18 * * 1-5')), 'on the hour, business hours')
})

test('a `cron` key beside a preset frequency is still the old "more often than hourly" refusal', () => {
  refuse({ schedule: { freq: 'hourly', minute: 0, tz: 'UTC', cron: '*/5 * * * *' } }, 'schedule_too_frequent', 'schedule')
})
