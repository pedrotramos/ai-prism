// Settings navigation model (W2-7): tabs grouped Personal / Workspace / Admin,
// at most 7 for anyone (Miller / Choice Overload), old deep-link ids still
// land on the section that now holds them, and the mobile two-level list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settingsGroups, resolveSettingsTab, mobileArea, MOBILE_AREAS, MAX_VISIBLE_TABS } from './settingsNav.js'

const ids = (groups) => groups.flatMap((g) => g.tabs.map((t) => t.id))

test('admins see three groups in order and at most 7 tabs', () => {
  const groups = settingsGroups({ isAdmin: true })
  assert.deepEqual(groups.map((g) => g.id), ['personal', 'workspace', 'admin'])
  assert.ok(ids(groups).length <= MAX_VISIBLE_TABS)
  assert.equal(MAX_VISIBLE_TABS, 7)
  assert.deepEqual(ids(groups), ['personal', 'mcp', 'skills', 'templates', 'models', 'tools', 'admins'])
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
  assert.equal(resolveSettingsTab(undefined, true), 'personal')
})

test('mobile: two areas, Personal = personal group, Organization = workspace + admin', () => {
  assert.deepEqual(MOBILE_AREAS.map((a) => a.id), ['personal', 'organization'])
  assert.equal(mobileArea('personal'), 'personal')
  assert.equal(mobileArea('mcp'), 'personal')
  for (const id of ['skills', 'templates', 'models', 'tools', 'admins']) assert.equal(mobileArea(id), 'organization')
})
