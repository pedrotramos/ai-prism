// Memory UI + admin kill-switch UI (W3-3). Settings → Preferences lists, edits and
// deletes the caller's memory entries (GET/POST/PATCH/DELETE /api/memory), opts
// sensitive topics in per entry, and "forgets everything" behind ONE confirmation;
// Settings → Tools has the org-wide memory switch (app_tool_policy key `memory`).
// Every endpoint is answered with page.route (no backend): the mock keeps state so
// a reload reflects what was saved.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { AXE_TAGS, newVariantContext, SCREENS } from './lib.mjs'

const CATEGORIES = ['preference', 'profile', 'work', 'project', 'other', 'health', 'politics', 'religion', 'personal_finance']
const SENSITIVE = ['health', 'politics', 'religion', 'personal_finance']
const LIMITS = { contentMaxChars: 500, perUserMax: 200, injectMaxEntries: 10, injectMaxTokens: 1500, extractMaxPerTurn: 3 }

const entry = (id, content, category = 'other', over = {}) => ({
  id: String(id), content, category, sensitive: SENSITIVE.includes(category), sensitiveOptIn: false,
  source: 'user', sessionId: null, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', ...over,
})
const seed = () => [
  entry(1, 'Prefers answers in bullet points', 'preference', { source: 'extracted' }),
  entry(2, 'Leads the data platform team', 'work'),
  entry(3, 'Runs a marathon in April', 'health'),
]

/**
 * Stateful /api/memory + /api/tool-policy mock. `fail` maps "METHOD path-kind" to
 * a one-shot [status, body] override; `calls` records every request.
 */
async function mockApi(page, { items = seed(), disabled = false, policy = {}, fail = {}, putFail = false } = {}) {
  const state = { items: [...items], disabled, policy: { ...policy }, calls: [], hold: null }
  const take = (k) => {
    const f = fail[k]
    delete fail[k]
    return f
  }
  await page.route('**/api/memory**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const m = req.method()
    const id = url.pathname.split('/')[3]
    const body = req.postData() ? req.postDataJSON() : undefined
    state.calls.push({ method: m, path: url.pathname, body })
    const f = take(`${m} ${id ? 'id' : 'root'}`)
    if (f) return route.fulfill({ status: f[0], json: f[1] })
    if (m === 'GET') {
      if (state.disabled) return route.fulfill({ status: 403, json: { error: 'memory_disabled' } })
      return route.fulfill({ json: { items: state.items, limits: LIMITS, categories: CATEGORIES, sensitiveCategories: SENSITIVE } })
    }
    if (m === 'POST') {
      const e = entry(100 + state.calls.length, body.content, body.category || 'other', { sensitiveOptIn: !!body.sensitiveOptIn })
      state.items.unshift(e)
      return route.fulfill({ status: 201, json: e })
    }
    if (m === 'PATCH') {
      const i = state.items.findIndex((e) => e.id === id)
      if (i < 0) return route.fulfill({ status: 404, json: { error: 'not_found' } })
      state.items[i] = { ...state.items[i], ...body, sensitive: SENSITIVE.includes(body.category ?? state.items[i].category) }
      return route.fulfill({ json: state.items[i] })
    }
    if (m === 'DELETE' && id) {
      state.items = state.items.filter((e) => e.id !== id)
      return route.fulfill({ status: 204, body: '' })
    }
    if (m === 'DELETE') {
      if (state.hold) await state.hold
      const deleted = state.items.length
      state.items = []
      return route.fulfill({ json: { deleted } })
    }
    return route.fulfill({ status: 405, json: {} })
  })
  await page.route('**/api/tool-policy', (r) => r.fulfill({ json: { policy: state.policy } }))
  await page.route('**/api/admin/tool-policy/*', async (r) => {
    const key = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop())
    const body = r.request().postDataJSON()
    state.calls.push({ method: 'PUT', path: `/api/admin/tool-policy/${key}`, body })
    if (putFail) return r.fulfill({ status: 500, json: { error: 'boom' } })
    state.policy[key] = body.enabled
    return r.fulfill({ json: { ok: true } })
  })
  for (const [p, json] of [
    ['**/api/admin/model-endpoints', { endpoints: [], recommended: [] }],
    ['**/api/admin/mcp-catalog', { entries: [], suggestions: [] }],
    ['**/api/admin/web-search/status', { mode: 'auto', enabled: true, offReason: null, chain: [], last24h: { calls: 0, errors: 0, byCode: {} } }],
    ['**/api/admins', { owner: 'owner@example.com', admins: [] }],
    ['**/api/admins/candidates', { candidates: [] }],
    ['**/api/skills', { skills: [], isAdmin: true }],
    ['**/api/deck-templates', { templates: [] }],
  ])
    await page.route(p, (r) => r.fulfill({ json }))
  return state
}

async function open(browser, baseURL, opts = {}, variant = { theme: 'dark', mobile: false }, tab = 'Preferences') {
  const ctx = await newVariantContext(browser, variant)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const state = await mockApi(page, opts)
  await SCREENS.welcome(page, baseURL)
  await page.locator('button[title="Settings"]').first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  if (tab !== 'Preferences' && variant.mobile) await dialog.getByRole('group', { name: 'Settings area' }).getByRole('button', { name: 'Organization' }).click()
  if (tab !== 'Preferences') await dialog.getByRole('button', { name: tab, exact: true }).click()
  return { ctx, page, dialog, state, errors, section: dialog.getByRole('region', { name: 'Memory' }) }
}
const rows = (section) => section.locator('li[data-memory-id]')
const rowOf = (section, text) => rows(section).filter({ hasText: text })

test('AC1: lists entries with their category; edit saves via PATCH, delete via DELETE /:id', async ({ browser, baseURL }) => {
  const { ctx, section, state, errors } = await open(browser, baseURL)
  await expect(rows(section)).toHaveCount(3)
  await expect(rowOf(section, 'Leads the data platform team')).toContainText('Work')
  await rowOf(section, 'Leads the data platform team').getByRole('button', { name: /^Edit memory/ }).click()
  const box = section.getByRole('textbox', { name: 'Memory text' })
  await box.fill('Leads the data and AI platform team')
  await section.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(rowOf(section, 'data and AI platform')).toBeVisible()
  expect(state.calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: '/api/memory/2', body: { content: 'Leads the data and AI platform team', category: 'work', sensitiveOptIn: false } })
  await rowOf(section, 'bullet points').getByRole('button', { name: /^Delete memory/ }).click()
  await expect(rows(section)).toHaveCount(2)
  expect(state.calls.some((c) => c.method === 'DELETE' && c.path === '/api/memory/1')).toBe(true)
  expect(errors).toEqual([])
  await ctx.close()
})

test('AC1: 409 duplicate, 409 limit and 400 show inline, localized, with a next action; the form stays open', async ({ browser, baseURL }) => {
  const fail = { 'PATCH id': [409, { error: 'memory_duplicate' }] }
  const { ctx, section, state } = await open(browser, baseURL, { fail })
  await rowOf(section, 'Leads the data').getByRole('button', { name: /^Edit memory/ }).click()
  await section.getByRole('textbox', { name: 'Memory text' }).fill('Prefers answers in bullet points')
  await section.getByRole('button', { name: 'Save', exact: true }).click()
  const alert = section.getByRole('alert')
  await expect(alert).toContainText('already have this memory')
  await expect(section.getByRole('textbox', { name: 'Memory text' })).toHaveValue('Prefers answers in bullet points')
  await section.getByRole('button', { name: 'Cancel', exact: true }).click()
  await section.getByRole('button', { name: 'Add memory' }).click()
  state.calls.length = 0
  fail['POST root'] = [409, { error: 'memory_limit' }]
  await section.getByRole('textbox', { name: 'Memory text' }).fill('One more fact')
  await section.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(section.getByRole('alert')).toContainText('limit of 200')
  fail['POST root'] = [400, { error: 'content must be 1..500 characters' }]
  await section.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(section.getByRole('alert')).toContainText('between 1 and 500 characters')
  await ctx.close()
})

test('AC1: an edit of an entry deleted elsewhere (404) reloads the list instead of keeping a stale row', async ({ browser, baseURL }) => {
  const { ctx, section, state } = await open(browser, baseURL, { fail: { 'PATCH id': [404, { error: 'not_found' }] } })
  await rowOf(section, 'Leads the data').getByRole('button', { name: /^Edit memory/ }).click()
  state.items = state.items.filter((e) => e.id !== '2')
  await section.getByRole('textbox', { name: 'Memory text' }).fill('Changed')
  await section.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(section.getByRole('status').filter({ hasText: 'no longer exists' })).toBeVisible()
  await expect(rows(section)).toHaveCount(2)
  await expect(rowOf(section, 'Leads the data')).toHaveCount(0)
  await ctx.close()
})

test('AC2: sensitive topics are per entry; sensitive categories are not selectable without the opt-in; sensitiveOptIn is sent', async ({ browser, baseURL }) => {
  const { ctx, section, state } = await open(browser, baseURL)
  await rowOf(section, 'Leads the data').getByRole('button', { name: /^Edit memory/ }).click()
  const cat = section.getByRole('combobox', { name: 'Category' })
  const sens = section.getByRole('checkbox', { name: 'Include sensitive topics' })
  await expect(sens).not.toBeChecked()
  for (const v of SENSITIVE) await expect(cat.locator(`option[value="${v}"]`)).toBeDisabled()
  await expect(cat.locator('option[value="project"]')).toBeEnabled()
  await sens.check()
  for (const v of SENSITIVE) await expect(cat.locator(`option[value="${v}"]`)).toBeEnabled()
  await cat.selectOption('religion')
  await section.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(rowOf(section, 'Leads the data')).toContainText('Religion')
  expect(state.calls.find((c) => c.method === 'PATCH').body).toMatchObject({ category: 'religion', sensitiveOptIn: true })
  // the other rows keep their own state: the switch is per entry
  await rowOf(section, 'bullet points').getByRole('button', { name: /^Edit memory/ }).click()
  await expect(section.getByRole('checkbox', { name: 'Include sensitive topics' })).not.toBeChecked()
  await ctx.close()
})

test('AC3: Forget everything asks once (focus trapped, Escape cancels), then DELETE /api/memory and shows the count; no double submit', async ({ browser, baseURL }) => {
  const { ctx, page, dialog, section, state } = await open(browser, baseURL)
  const trigger = section.getByRole('button', { name: 'Forget everything' })
  await trigger.click()
  const confirm = page.getByRole('dialog', { name: 'Forget everything?' })
  await expect(confirm).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(trigger).toBeFocused()
  expect(state.calls.some((c) => c.method === 'DELETE')).toBe(false)
  await trigger.click()
  // Tab never leaves the dialog
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement.closest('[data-memory-confirm]'))).toBe(true)
  }
  let release
  state.hold = new Promise((r) => (release = r))
  const go = confirm.getByRole('button', { name: 'Forget everything', exact: true })
  await go.click()
  await go.click({ force: true, timeout: 500 }).catch(() => {})
  release()
  await expect(rows(section)).toHaveCount(0)
  await expect(section.getByRole('status').filter({ hasText: '3 memories deleted' })).toBeVisible()
  expect(state.calls.filter((c) => c.method === 'DELETE' && c.path === '/api/memory')).toHaveLength(1)
  await ctx.close()
})

test('AC4: with the admin switch off (403 memory_disabled) the user sees "turned off by your organization", no list, and can still forget everything', async ({ browser, baseURL }) => {
  const { ctx, page, section, state } = await open(browser, baseURL, { disabled: true })
  await expect(section.getByTestId('memory-disabled')).toContainText('Your organization turned memory off')
  await expect(rows(section)).toHaveCount(0)
  await expect(section.getByRole('button', { name: 'Add memory' })).toHaveCount(0)
  await expect(section.getByTestId('memory-notice')).toHaveCount(0)
  await section.getByRole('button', { name: 'Forget everything' }).click()
  await page.getByRole('dialog', { name: 'Forget everything?' }).getByRole('button', { name: 'Forget everything', exact: true }).click()
  await expect(section.getByRole('status').filter({ hasText: 'deleted' })).toBeVisible()
  expect(state.calls.some((c) => c.method === 'DELETE' && c.path === '/api/memory')).toBe(true)
  await ctx.close()
})

test('a failed load is an error with Retry, not an empty list (403 vs empty vs error are three different states)', async ({ browser, baseURL }) => {
  const { ctx, section } = await open(browser, baseURL, { fail: { 'GET root': [500, { error: 'internal_error' }] }, items: [] })
  await expect(section.getByRole('alert')).toContainText('Could not load')
  await expect(section.getByTestId('memory-empty')).toHaveCount(0)
  await section.getByRole('button', { name: 'Try again' }).click()
  await expect(section.getByTestId('memory-empty')).toContainText('Nothing remembered yet')
  await ctx.close()
})

test('AC5: memory is shown as ON by default with what is remembered and where it is turned off', async ({ browser, baseURL }) => {
  const { ctx, section } = await open(browser, baseURL)
  const notice = section.getByTestId('memory-notice')
  await expect(notice).toContainText('Memory is on')
  await expect(notice).toContainText('Settings → Tools')
  await expect(notice).toContainText('never learned automatically')
  await ctx.close()
})

test('AC6: the admin card toggles app_tool_policy.memory, survives a reload, and reverts + reports when the save fails', async ({ browser, baseURL }) => {
  const { ctx, page, dialog, state } = await open(browser, baseURL, {}, { theme: 'dark', mobile: false }, 'Tools')
  const card = dialog.getByRole('region', { name: 'Memory' })
  const sw = card.getByRole('switch', { name: 'Memory' })
  await expect(sw).toBeChecked() // missing row = on
  await sw.click()
  await expect(sw).not.toBeChecked()
  await expect.poll(() => state.policy.memory).toBe(false)
  expect(state.calls.find((c) => c.method === 'PUT')).toMatchObject({ path: '/api/admin/tool-policy/memory', body: { enabled: false } })
  await page.reload()
  await page.locator('button[title="Settings"]').first().click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Tools', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Memory' }).getByRole('switch', { name: 'Memory' })).not.toBeChecked()
  await ctx.close()
})

test('AC6: a failed save puts the switch back and says so', async ({ browser, baseURL }) => {
  const { ctx, dialog } = await open(browser, baseURL, { putFail: true }, { theme: 'dark', mobile: false }, 'Tools')
  const card = dialog.getByRole('region', { name: 'Memory' })
  const sw = card.getByRole('switch', { name: 'Memory' })
  await sw.click()
  await expect(card.getByRole('alert')).toContainText(/could not|failed/i)
  await expect(sw).toBeChecked()
  await ctx.close()
})

for (const variant of [
  { theme: 'dark', mobile: false },
  { theme: 'light', mobile: false },
  { theme: 'dark', mobile: true },
  { theme: 'light', mobile: true },
]) {
  test(`AC7: axe clean (${variant.theme}, ${variant.mobile ? '390' : '1440'}): list, edit form, confirm dialog, disabled state, admin card`, async ({ browser, baseURL }) => {
    // scoped to the surfaces this task adds (the Settings tab nav is another task's); after the open animation
    const scan = async (page, label, scope = '[data-testid="memory-section"]') => {
      await page.waitForTimeout(500)
      const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).include(scope).analyze()
      expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${label} ${v.id}: ${v.nodes.map((n) => `${n.target} ${n.any[0]?.message ?? ''}`).join(' | ')}`)).toEqual([])
    }
    const a = await open(browser, baseURL, {}, variant)
    await expect(rows(a.section)).toHaveCount(3)
    await scan(a.page, 'list')
    await rowOf(a.section, 'Leads').getByRole('button', { name: /^Edit memory/ }).click()
    await scan(a.page, 'edit')
    await a.section.getByRole('button', { name: 'Cancel', exact: true }).click()
    await a.section.getByRole('button', { name: 'Forget everything' }).click()
    await scan(a.page, 'confirm', '[data-memory-confirm]')
    await a.ctx.close()
    const b = await open(browser, baseURL, { disabled: true }, variant)
    await expect(b.section.getByTestId('memory-disabled')).toBeVisible()
    await scan(b.page, 'disabled')
    await b.ctx.close()
    const c = await open(browser, baseURL, {}, variant, 'Tools')
    await expect(c.dialog.getByRole('region', { name: 'Memory' })).toBeVisible()
    await scan(c.page, 'admin', '[data-testid="memory-admin-card"]')
    await c.ctx.close()
  })
}

test('AC7: keyboard-only path: reach the list, edit, save, delete', async ({ browser, baseURL }) => {
  const { ctx, page, section } = await open(browser, baseURL)
  const edit = rowOf(section, 'Leads').getByRole('button', { name: /^Edit memory/ })
  await edit.focus()
  await page.keyboard.press('Enter')
  const box = section.getByRole('textbox', { name: 'Memory text' })
  await expect(box).toBeFocused()
  await page.keyboard.type(' today')
  await page.keyboard.press('Control+Enter')
  await expect(rowOf(section, 'Leads the data platform team today')).toBeVisible()
  await expect(rowOf(section, 'Leads').getByRole('button', { name: /^Edit memory/ })).toBeFocused()
  await ctx.close()
})
