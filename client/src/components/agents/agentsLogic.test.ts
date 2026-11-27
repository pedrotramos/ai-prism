// W4-4e: the pure rules behind the Agents UI. No React, no DOM, no network.
//   AC3 an edit of an approved/pending agent warns before saving  · AC4 the tz defaults to the browser's and the
//   preview instants are only FORMATTED here  · AC5 errors go through catalog keys, never raw server text
//   Review focus: the tool picker never offers personal connections; no schedule math in the client.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_ERROR_CODES,
  FIXED_TOOLS,
  selectableTools,
  errorKey,
  defaultTimeZone,
  emptyForm,
  formFromRow,
  formToBody,
  definitionChanged,
  needsVoidWarning,
  diffDefinitions,
  formatInstant,
  scheduleFields,
  rowActions,
  chipKey,
  scheduleForFreq,
  scheduleSummary,
  CRON_EXAMPLES,
} from './agentsLogic.ts'
import type { AgentRow, AgentDefinition, PresetSchedule } from './agentsLogic.ts'

const DEF: AgentDefinition = {
  instructions: 'Be brief.',
  prompt: 'Summarise.',
  model: 'm1',
  reasoningEffort: 'low',
  tools: ['web_search'],
  schedule: { freq: 'weekly', minute: 0, hour: 8, weekday: 1, tz: 'America/Sao_Paulo' },
  lang: 'en',
}
const row = (over: Partial<AgentRow> = {}): AgentRow => ({
  id: '1', ownerEmail: 'a@x.com', name: 'Weekly', description: '', definition: DEF, revision: 3, status: 'draft', approvalExpiresAt: null, decisionReason: null,
  enabled: false, nextRunAt: null, lastRunAt: null, consecutiveFailures: 0, disabledReason: null, createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z', ...over,
})

test('AC5: every code the routes can answer has a catalog key; an unknown code or raw text falls back to internal_error', () => {
  for (const c of ['agents_disabled', 'agents_limit', 'agents_setting_off', 'approval_expired', 'not_approved', 'bad_state', 'busy', 'conflict', 'revision_required', 'no_schedule', 'invalid_setting', 'not_found', 'bad_query', 'admin_required', 'internal_error', 'stale', 'reason_required', 'expected_hash_required', 'invalid_days', 'bad_status', 'schedule_invalid', 'schedule_too_frequent', 'timezone_invalid', 'mcp_not_in_catalog', 'mcp_class_refused', 'model_not_in_catalog']) {
    assert.ok(AGENT_ERROR_CODES.includes(c), c)
    assert.equal(errorKey(c), `agents.errors.${c}`)
  }
  assert.equal(errorKey('SELECT * FROM agents: relation does not exist'), 'agents.errors.internal_error')
  assert.equal(errorKey(null), 'agents.errors.internal_error')
  assert.equal(errorKey('network'), 'agents.errors.network')
  for (const c of AGENT_ERROR_CODES) assert.match(c, /^[a-z][a-z0-9_]*$/)
})

test('tool picker: only what the server admits (GET /api/agents/tool-options); personal, shared and unknown refs are never offered', () => {
  assert.deepEqual(FIXED_TOOLS.map((t) => t.ref), ['web_search', 'generate_image', 'artifact:deck', 'artifact:spreadsheet', 'artifact:document', 'genie_one'])
  const all = FIXED_TOOLS.map((t) => t.ref)
  const out = selectableTools({
    kinds: all,
    mcp: [{ ref: 'mcp:main.tools.sales', name: 'Sales lookups', description: 'Reads sales' }],
  })
  assert.deepEqual(out.filter((t) => t.kind === 'mcp').map((t) => [t.ref, t.label]), [['mcp:main.tools.sales', 'Sales lookups']])
  assert.equal(out.filter((t) => t.kind === 'builtin').length, 6)
  // the server may switch a kind off (org policy): it is not offered
  assert.deepEqual(selectableTools({ kinds: all.filter((k) => k !== 'web_search'), mcp: [] }).map((t) => t.ref), all.filter((k) => k !== 'web_search'))
  // a ref the client does not know, or an mcp ref that is not `mcp:<name>`, is dropped even if the server sent it
  assert.deepEqual(selectableTools({ kinds: ['web_search', 'rm_rf', 'mcp:x'], mcp: [{ ref: 'per_user:drive', name: 'x' }, { ref: 'mcp:', name: 'y' }] }).map((t) => t.ref), ['web_search'])
  // nothing loaded (or a failed load): nothing is offered
  assert.deepEqual(selectableTools(null), [])
})

test('AC4: the tz defaults to the browser tz; an invalid or missing one falls back to UTC', () => {
  assert.equal(defaultTimeZone('America/Sao_Paulo'), 'America/Sao_Paulo')
  assert.equal(defaultTimeZone('Mars/Olympus'), 'UTC')
  assert.equal(defaultTimeZone(''), 'UTC')
  assert.equal(defaultTimeZone(undefined), 'UTC')
  const f = emptyForm({ model: 'm1', lang: 'pt', tz: 'Europe/Lisbon' })
  assert.equal(f.schedule?.tz, 'Europe/Lisbon')
  assert.equal(f.lang, 'pt')
  assert.equal(f.model, 'm1')
  assert.deepEqual(f.tools, [])
})

test('AC4: instants from the server are only formatted in the chosen tz (no schedule math)', () => {
  const iso = '2026-11-23T11:00:00.000Z'
  assert.match(formatInstant(iso, 'America/Sao_Paulo', 'en'), /8:00/)
  assert.match(formatInstant(iso, 'UTC', 'en'), /11:00/)
  assert.match(formatInstant(iso, 'Asia/Kolkata', 'en'), /4:30/)
  assert.equal(formatInstant('not a date', 'UTC', 'en'), '')
  assert.equal(formatInstant(iso, 'Mars/Olympus', 'en'), formatInstant(iso, 'UTC', 'en'), 'a bad zone degrades to UTC, never throws')
})

test('progressive disclosure: a frequency shows only the schedule fields it uses', () => {
  assert.deepEqual(scheduleFields('hourly'), ['minute'])
  assert.deepEqual(scheduleFields('daily'), ['hour', 'minute'])
  assert.deepEqual(scheduleFields('weekdays'), ['hour', 'minute'])
  assert.deepEqual(scheduleFields('weekly'), ['weekday', 'hour', 'minute'])
  assert.deepEqual(scheduleFields('monthly'), ['monthday', 'hour', 'minute'])
})

test('formToBody trims, keeps only the freq-used schedule fields and never names an owner, status or approval', () => {
  const f = { ...formFromRow(row()), name: '  Weekly  ', schedule: { freq: 'daily' as const, minute: 5, hour: 9, weekday: 3, monthday: 4, tz: 'UTC' } }
  const b = formToBody(f) as Record<string, unknown>
  assert.equal(b.name, 'Weekly')
  assert.deepEqual(b.schedule, { freq: 'daily', minute: 5, hour: 9, tz: 'UTC' })
  for (const k of ['ownerEmail', 'owner_email', 'status', 'enabled', 'approvalHash', 'revision']) assert.ok(!(k in b), k)
  assert.deepEqual(formToBody({ ...f, schedule: null }).schedule, null)
  assert.deepEqual(Object.keys(b).sort(), ['description', 'instructions', 'lang', 'model', 'name', 'prompt', 'reasoningEffort', 'schedule', 'tools'])
})

test('AC3: editing the definition of an approved or pending agent warns; name/description only, or a draft, does not', () => {
  const approved = row({ status: 'approved', enabled: true })
  const same = formFromRow(approved)
  assert.equal(definitionChanged(approved, same), false)
  assert.equal(needsVoidWarning(approved, same), false)
  assert.equal(needsVoidWarning(approved, { ...same, name: 'Renamed', description: 'd' }), false)
  for (const change of [{ prompt: 'other' }, { instructions: 'x' }, { model: 'm2' }, { tools: ['web_search', 'genie_one'] }, { lang: 'pt' as const }, { reasoningEffort: 'high' as const }, { schedule: null }]) {
    assert.equal(needsVoidWarning(approved, { ...same, ...change }), true, JSON.stringify(change))
  }
  assert.equal(needsVoidWarning(approved, { ...same, schedule: { ...(DEF.schedule as PresetSchedule), hour: 9 } }), true)
  assert.equal(needsVoidWarning(row({ status: 'pending' }), { ...same, prompt: 'x' }), true)
  for (const st of ['draft', 'rejected', 'revoked'] as const) assert.equal(needsVoidWarning(row({ status: st }), { ...same, prompt: 'x' }), false, st)
  assert.equal(needsVoidWarning(null, same), false, 'a new agent has nothing to void')
  // tool order is not a change in the approval scope (the server canonicalises)
  assert.equal(definitionChanged(row({ definition: { ...DEF, tools: ['web_search', 'genie_one'] } }), { ...same, tools: ['genie_one', 'web_search'] }), false)
})

test('row actions follow the state machine of the routes', () => {
  assert.deepEqual(rowActions(row({ status: 'draft' }), 0), { edit: true, submit: true, enable: false, disable: false, run: false, delete: true })
  assert.equal(rowActions(row({ status: 'rejected' }), 0).submit, true)
  assert.equal(rowActions(row({ status: 'revoked' }), 0).submit, true)
  assert.equal(rowActions(row({ status: 'pending' }), 0).submit, false)
  const ok = row({ status: 'approved', approvalExpiresAt: '2027-01-01T00:00:00Z' })
  const now = Date.parse('2026-11-20T00:00:00Z')
  assert.deepEqual(rowActions(ok, now), { edit: true, submit: false, enable: true, disable: false, run: true, delete: true })
  assert.equal(rowActions({ ...ok, enabled: true }, now).disable, true)
  assert.equal(rowActions({ ...ok, enabled: true }, now).enable, false)
  const expired = rowActions(row({ status: 'approved', approvalExpiresAt: '2026-11-01T00:00:00Z' }), now)
  assert.equal(expired.enable, false)
  assert.equal(expired.run, false)
  assert.equal(rowActions(row({ status: 'approved', approvalExpiresAt: '2027-01-01T00:00:00Z', definition: { ...DEF, schedule: null } }), now).enable, false, 'no schedule: nothing to enable')
})

test('status chips are text keys, never colour alone', () => {
  assert.equal(chipKey(row({ status: 'approved', enabled: true })), 'agents.chip.scheduled')
  assert.equal(chipKey(row({ status: 'approved' })), 'agents.chip.approved')
  assert.equal(chipKey(row({ status: 'pending' })), 'agents.chip.pending')
  assert.equal(chipKey(row({ status: 'draft' })), 'agents.chip.draft')
  assert.equal(chipKey(row({ status: 'rejected' })), 'agents.chip.rejected')
  assert.equal(chipKey(row({ status: 'revoked' })), 'agents.chip.revoked')
})

test('admin diff: lists each changed field against the earlier approved definition, tools as added/removed', () => {
  assert.deepEqual(diffDefinitions(DEF, DEF), [])
  const next: AgentDefinition = { ...DEF, prompt: 'New', tools: ['genie_one', 'web_search'], schedule: { ...(DEF.schedule as PresetSchedule), hour: 9 } }
  const d = diffDefinitions(DEF, next)
  assert.deepEqual(d.map((c) => c.field), ['prompt', 'tools', 'schedule'])
  const tools = d.find((c) => c.field === 'tools')!
  assert.deepEqual({ added: tools.added, removed: tools.removed }, { added: ['genie_one'], removed: [] })
  assert.equal(diffDefinitions(null, DEF).length, 0, 'no earlier approved version: nothing to compare against')
  assert.deepEqual(diffDefinitions(DEF, { ...DEF, tools: [] }).find((c) => c.field === 'tools')!.removed, ['web_search'])
})

// ---- "Custom (advanced)" ------------------------------------------------------------------------------------------
test('picking Custom starts from the cron the current preset is the same as, and keeps the zone', () => {
  const weekly: PresetSchedule = { freq: 'weekly', minute: 30, hour: 8, weekday: 3, tz: 'Europe/Lisbon' }
  assert.deepEqual(scheduleForFreq(weekly, 'custom', 'UTC'), { freq: 'custom', cron: '30 8 * * 3', tz: 'Europe/Lisbon' })
  assert.deepEqual(scheduleForFreq({ freq: 'hourly', minute: 15, tz: 'UTC' }, 'custom', 'UTC'), { freq: 'custom', cron: '15 * * * *', tz: 'UTC' })
  assert.deepEqual(scheduleForFreq({ freq: 'weekdays', minute: 0, hour: 9, tz: 'UTC' }, 'custom', 'UTC'), { freq: 'custom', cron: '0 9 * * 1-5', tz: 'UTC' })
  assert.deepEqual(scheduleForFreq(null, 'custom', 'America/Sao_Paulo'), { freq: 'custom', cron: '0 8 * * 1', tz: 'America/Sao_Paulo' }, 'no schedule yet: a working starting point')
  const typed = { freq: 'custom' as const, cron: '0 9,17 * * 1-5', tz: 'UTC' }
  assert.equal(scheduleForFreq(typed, 'custom', 'UTC'), typed, 'picking Custom again never drops what was typed')
})

test('leaving Custom for a preset keeps the zone and gives the preset sane defaults', () => {
  const typed = { freq: 'custom' as const, cron: '0 9,17 * * 1-5', tz: 'Europe/Lisbon' }
  assert.deepEqual(scheduleForFreq(typed, 'daily', 'UTC'), { freq: 'daily', minute: 0, tz: 'Europe/Lisbon', hour: 8, weekday: 1, monthday: 1 })
  // preset to preset keeps the shared fields (the behaviour before Custom existed)
  assert.deepEqual(scheduleForFreq({ freq: 'weekly', minute: 20, hour: 6, weekday: 4, tz: 'UTC' }, 'monthly', 'UTC'), { freq: 'monthly', minute: 20, hour: 6, weekday: 4, monthday: 1, tz: 'UTC' })
  assert.deepEqual(scheduleForFreq(null, 'hourly', 'UTC'), { freq: 'hourly', minute: 0, tz: 'UTC', hour: 8, weekday: 1, monthday: 1 })
})

test('formToBody sends a custom schedule as freq + cron + tz only, the cron trimmed and single-spaced', () => {
  const f = { ...formFromRow(row()), schedule: { freq: 'custom' as const, cron: '  0 9,17   * * 1-5 ', tz: 'UTC', hour: 3 } as never }
  assert.deepEqual((formToBody(f) as { schedule: unknown }).schedule, { freq: 'custom', cron: '0 9,17 * * 1-5', tz: 'UTC' })
})

test('AC3: changing the cron, or moving to Custom, voids the approval; retyping spaces does not', () => {
  const custom: AgentDefinition = { ...DEF, schedule: { freq: 'custom', cron: '0 9,17 * * 1-5', tz: 'UTC' } }
  const approved = row({ status: 'approved', enabled: true, definition: custom })
  const same = formFromRow(approved)
  assert.equal(needsVoidWarning(approved, same), false)
  assert.equal(needsVoidWarning(approved, { ...same, schedule: { freq: 'custom', cron: ' 0  9,17 * * 1-5', tz: 'UTC' } }), false, 'spacing is not a change')
  assert.equal(needsVoidWarning(approved, { ...same, schedule: { freq: 'custom', cron: '0 9,18 * * 1-5', tz: 'UTC' } }), true)
  assert.equal(needsVoidWarning(approved, { ...same, schedule: { freq: 'custom', cron: '0 9,17 * * 1-5', tz: 'Europe/Lisbon' } }), true)
  assert.equal(needsVoidWarning(row({ status: 'approved', enabled: true }), { ...formFromRow(row()), schedule: { freq: 'custom', cron: '0 8 * * 1,3', tz: 'America/Sao_Paulo' } }), true)
})

test('admin diff shows a schedule that moved to a cron', () => {
  const next: AgentDefinition = { ...DEF, schedule: { freq: 'custom', cron: '0 9,17 * * 1-5', tz: 'UTC' } }
  assert.deepEqual(diffDefinitions(DEF, next).map((c) => c.field), ['schedule'])
})

test('scheduleSummary: a preset reads as time + zone, a custom one as its cron', () => {
  assert.equal(scheduleSummary({ freq: 'weekly', minute: 5, hour: 8, weekday: 1, tz: 'UTC' }, 'Every week'), 'Every week · 08:05 · UTC')
  assert.equal(scheduleSummary({ freq: 'custom', cron: '0 9,17 * * 1-5', tz: 'UTC' }, 'Custom (advanced)'), 'Custom (advanced) · 0 9,17 * * 1-5 · UTC')
})

test('the cron error codes are known to the UI, and every example is a cron the server accepts', async () => {
  for (const c of ['cron_invalid', 'cron_fields', 'cron_never']) assert.equal(errorKey(c), `agents.errors.${c}`)
  const { parseCron, isHourlyOrSlower } = await import('../../../../shared/cron.ts')
  for (const ex of CRON_EXAMPLES) assert.equal(isHourlyOrSlower(parseCron(ex.cron)), true, ex.cron)
})
