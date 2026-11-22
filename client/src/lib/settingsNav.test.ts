// Settings navigation model (W2-7): tabs grouped Personal / Workspace / Admin,
// at most 7 for anyone (Miller / Choice Overload), old deep-link ids still
// land on the section that now holds them, and the mobile two-level list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settingsGroups, resolveSettingsTab, mobileArea, MOBILE_AREAS, MAX_VISIBLE_TABS } from './settingsNav.ts'

const ids = (groups: ReturnType<typeof settingsGroups>) => groups.flatMap((g) => g.tabs.map((t) => t.id))

test('admins see three groups in order and at most 8 tabs', () => {
  const groups = settingsGroups({ isAdmin: true })
  assert.deepEqual(groups.map((g) => g.id), ['personal', 'workspace', 'admin'])
  assert.ok(ids(groups).length <= MAX_VISIBLE_TABS)
  assert.equal(MAX_VISIBLE_TABS, 8)
  assert.deepEqual(ids(groups), ['personal', 'mcp', 'skills', 'templates', 'models', 'tools', 'admins'])
})

test('the Agents tab is registered for admins only while agents are on (AC1)', () => {
  assert.ok(!ids(settingsGroups({ isAdmin: true })).includes('agents'), 'off by default')
  assert.ok(!ids(settingsGroups({ isAdmin: true, agents: false })).includes('agents'))
  const on = settingsGroups({ isAdmin: true, agents: true })
  assert.deepEqual(ids(on), ['personal', 'mcp', 'skills', 'templates', 'models', 'tools', 'admins', 'agents'])
  assert.ok(ids(on).length <= MAX_VISIBLE_TABS)
  assert.ok(!ids(settingsGroups({ isAdmin: false, agents: true })).includes('agents'), 'never for a non-admin')
  assert.equal(resolveSettingsTab('agents', true, false), 'personal', 'deep link while off lands on the first tab')
  assert.equal(resolveSettingsTab('agents', true, true), 'agents')
  assert.equal(resolveSettingsTab('agents', false, true), 'personal')
  assert.equal(mobileArea('agents'), 'organization')
})

test('non-admins never see the Admin group', () => {
  const groups = settingsGroups({ isAdmin: false })
  assert.deepEqual(groups.map((g) => g.id), ['personal', 'workspace'])
  assert.deepEqual(ids(groups), ['personal', 'mcp', 'skills', 'templates'])
})

test('every group and tab carries an i18n key, never a literal', () => {
  for (const g of settingsGroups({ isAdmin: true })) {
    assert.match(g.labelKey, /^settings\./)
    for (const t of g.tabs) assert.match(t.labelKey, /^settings\./)
  }
})

test('legacy deep links resolve to the tab that now holds them', () => {
  assert.equal(resolveSettingsTab('tone', true), 'personal')
  assert.equal(resolveSettingsTab('mcp-catalog', true), 'tools')
  assert.equal(resolveSettingsTab('skills', false), 'skills')
  assert.equal(resolveSettingsTab('mcp', false), 'mcp')
})

test('admin-only or unknown ids fall back to the first tab', () => {
  assert.equal(resolveSettingsTab('models', false), 'personal')
  assert.equal(resolveSettingsTab('mcp-catalog', false), 'personal')
  assert.equal(resolveSettingsTab('nope', true), 'personal')
  assert.equal(resolveSettingsTab(undefined as unknown as string, true), 'personal') // a caller may pass nothing
})

test('mobile: two areas, Personal = personal group, Organization = workspace + admin', () => {
  assert.deepEqual(MOBILE_AREAS.map((a) => a.id), ['personal', 'organization'])
  assert.equal(mobileArea('personal'), 'personal')
  assert.equal(mobileArea('mcp'), 'personal')
  for (const id of ['skills', 'templates', 'models', 'tools', 'admins']) assert.equal(mobileArea(id), 'organization')
})
