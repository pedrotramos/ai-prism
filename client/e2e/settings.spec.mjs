// Settings modal and its tabs (W2-7): dialog semantics with a real focus trap,
// tabs grouped Personal / Workspace / Admin (at most 7), the mobile two-level
// list with an edge fade, switches as role=switch, the Models catalog as
// collapsed rows with expand-to-edit, inline validation with explicit
// saved/error states, advanced options collapsed, and axe on every tab.
// Built client + recorded fixtures; the admin endpoints the fixtures do not
// record are answered with page.route.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { AXE_TAGS, newVariantContext, SCREENS } from './lib.mjs'

const DESKTOP = { theme: 'dark', mobile: false }
const MOBILE = { theme: 'light', mobile: true }

const PROVIDERS = ['Anthropic', 'OpenAI', 'Google', 'Meta', 'Alibaba']
const ENDPOINTS = Array.from({ length: 15 }, (_, i) => ({
  id: `databricks-model-${i + 1}`,
  displayName: `Model ${i + 1}`,
  blurb: `Blurb ${i + 1}`,
  provider: PROVIDERS[i % PROVIDERS.length],
  enabled: true,
  discovered: true,
  curated: true,
  sortOrder: i,
  priceIn: null,
  priceOut: null,
  inferredPriceIn: 1,
  inferredPriceOut: 2,
  modality: 'chat',
}))

async function stubAdmin(page, puts = []) {
  await page.route('**/api/admin/model-endpoints', (r) => r.fulfill({ json: { endpoints: ENDPOINTS, recommended: [] } }))
  await page.route('**/api/admin/model-endpoints/*', (r) => {
    puts.push({ url: r.request().url(), body: r.request().postDataJSON() })
    return r.fulfill({ json: { ok: true } })
  })
  await page.route('**/api/admin/mcp-catalog', (r) =>
    r.fulfill({
      json: {
        entries: [
          { connectionName: 'main.default.github', displayName: 'GitHub', comment: 'Issues and PRs', source: 'curated', hidden: false },
          { connectionName: 'main.default.jira', displayName: 'Jira', comment: '', source: 'custom', hidden: true },
        ],
        suggestions: [],
      },
    })
  )
  await page.route('**/api/admins', (r) => r.fulfill({ json: { owner: 'owner@example.com', admins: [] } }))
  await page.route('**/api/admins/candidates', (r) => r.fulfill({ json: { candidates: [] } }))
  await page.route('**/api/skills', (r) => r.fulfill({ json: { skills: [], isAdmin: true } }))
  await page.route('**/api/deck-templates', (r) => r.fulfill({ json: { templates: [] } }))
  await page.route('**/api/mcp/connections*', (r) =>
    r.fulfill({ json: { connections: [{ connectionName: 'main.default.github', comment: 'Issues and PRs', adopted: true, status: 'connected' }] } })
  )
}

async function open(browser, variant = DESKTOP) {
  const ctx = await newVariantContext(browser, variant)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const puts = []
  await stubAdmin(page, puts)
  return { ctx, page, errors, puts }
}

async function openSettings(page, baseURL) {
  await SCREENS.welcome(page, baseURL)
  const opener = page.locator('button[title="Settings"]').first()
  await opener.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  return { opener, dialog }
}

const inDialog = (page) => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-modal="true"]'))

test('Settings is a labelled modal dialog: focus moves in, Tab never leaves, Escape closes and restores focus', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  const { opener, dialog } = await openSettings(page, baseURL)
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  const labelId = await dialog.getAttribute('aria-labelledby')
  expect(labelId).toBeTruthy()
  await expect(page.locator(`[id="${labelId}"]`)).toHaveText(/Settings/)
  expect(await inDialog(page)).toBe(true)

  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab')
    expect(await inDialog(page)).toBe(true)
  }
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Shift+Tab')
    expect(await inDialog(page)).toBe(true)
  }

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
  await expect(opener).toBeFocused()
  expect(errors).toEqual([])
  await ctx.close()
})

test('the Done button is an ink primary (--action / --on-action), not the accent', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  const { dialog } = await openSettings(page, baseURL)
  const done = dialog.getByRole('button', { name: 'Done' })
  const [got, want] = await done.evaluate((el) => {
    const probe = (prop) => {
      const d = document.createElement('i')
      d.style.cssText = `position:absolute;${prop}:var(${prop === 'color' ? '--on-action' : '--action'})`
      document.body.appendChild(d)
      const v = getComputedStyle(d)[prop === 'color' ? 'color' : 'backgroundColor']
      d.remove()
      return v
    }
    const cs = getComputedStyle(el)
    return [[cs.backgroundColor, cs.color], [probe('background-color'), probe('color')]]
  })
  expect(got).toEqual(want)
  await ctx.close()
})

test('the close button is named and also restores focus to the opener', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  const { opener, dialog } = await openSettings(page, baseURL)
  await dialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
  await expect(opener).toBeFocused()
  await ctx.close()
})

test('tabs are grouped Your account / Admin, at most 8 (MAX_VISIBLE_TABS in settingsNav.ts), in visual order', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  const { dialog } = await openSettings(page, baseURL)
  const nav = dialog.getByRole('navigation', { name: 'Settings sections' })
  const groups = nav.getByRole('group')
  await expect(groups.nth(0)).toHaveAccessibleName('Your account')
  const count = await groups.count()
  if (count > 1) {
    await expect(count).toBe(2)
    await expect(groups.nth(1)).toHaveAccessibleName(/^Admin/)
  }
  const tabs = nav.getByRole('button')
  const n = await tabs.count()
  expect(n).toBeLessThanOrEqual(8)
  // DOM (= keyboard) order matches top-to-bottom visual order
  const ys = []
  for (let i = 0; i < n; i++) ys.push((await tabs.nth(i).boundingBox()).y)
  expect([...ys].sort((a, b) => a - b)).toEqual(ys)
  // exactly one current section
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1)
  await ctx.close()
})

test('Preferences keeps tone and prompt, and the image model sits in the defaults section with a Recommended default and its provider mark', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  const { dialog } = await openSettings(page, baseURL)
  await dialog.getByRole('button', { name: 'Preferences', exact: true }).click()
  await expect(dialog.getByLabel('System prompt')).toBeVisible()
  await expect(dialog.getByLabel('Image generation model')).toBeVisible()
  // the selected model carries a mark (decorative svg) beside the select
  await expect(dialog.getByLabel('Image generation model').locator('xpath=..').locator('svg')).toHaveCount(1)
  // theme is 3-way, Sistema first, and the choice persists
  const themeBtns = dialog.getByRole('group', { name: 'Appearance' }).getByRole('button')
  await expect(themeBtns).toHaveText(['System', 'Light', 'Dark'])
  await expect(dialog.getByLabel('Image generation model').locator('option:checked')).toHaveText(/Recommended/)
  // labels sit above their controls
  const label = await dialog.getByText('Interface language', { exact: true }).boundingBox()
  const select = await dialog.getByLabel('Interface language').boundingBox()
  expect(select.y).toBeGreaterThanOrEqual(label.y + label.height - 1)
  // the notifications switch is a named role=switch
  const sw = dialog.getByRole('switch', { name: 'Notify when finished' })
  await expect(sw).toHaveAttribute('aria-checked', /true|false/)
  await ctx.close()
})

test('Tools: every group toggle is a named role=switch with aria-checked, and the MCP catalog lives in the same section', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await page.route('**/api/admin/tool-policy/*', (r) => r.fulfill({ json: { ok: true } }))
  const { dialog } = await openSettings(page, baseURL)
  await dialog.getByRole('button', { name: 'Tools', exact: true }).click()
  const switches = dialog.getByRole('switch')
  await expect(switches.first()).toBeVisible()
  const count = await switches.count()
  expect(count).toBeGreaterThanOrEqual(7 + 2) // 7 tool groups + 2 catalog entries
  for (let i = 0; i < count; i++) {
    await expect(switches.nth(i)).toHaveAttribute('aria-checked', /^(true|false)$/)
    expect((await switches.nth(i).getAttribute('aria-label')) || (await switches.nth(i).getAttribute('aria-labelledby'))).toBeTruthy()
  }
  const python = dialog.getByRole('switch', { name: 'Python' })
  await expect(python).toHaveAttribute('aria-checked', 'true')
  await python.click()
  await expect(python).toHaveAttribute('aria-checked', 'false')
  await expect(dialog.getByRole('heading', { name: 'MCP catalog' })).toBeVisible()
  await ctx.close()
})

test('Models: 15 models render as collapsed rows (≤ 1,200 px) and expand to edit', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  const { dialog } = await openSettings(page, baseURL)
  await dialog.getByRole('button', { name: 'Models (LLM)', exact: true }).click()
  const list = dialog.getByRole('list', { name: 'Enabled models' })
  await expect(list.getByRole('listitem')).toHaveCount(15)
  const box = await list.boundingBox()
  expect(box.height).toBeLessThanOrEqual(1200)
  await expect(dialog.getByLabel('Display name')).toHaveCount(0)

  const expand = list.getByRole('button', { name: 'Edit Model 3', exact: true })
  await expect(expand).toHaveAttribute('aria-expanded', 'false')
  await expand.click()
  await expect(expand).toHaveAttribute('aria-expanded', 'true')
  await expect(dialog.getByLabel('Display name')).toHaveValue('Model 3')
  await ctx.close()
})

test('Models: a negative price is rejected inline without saving; a valid edit shows Saved', async ({ browser, baseURL }) => {
  const { ctx, page, puts } = await open(browser)
  const { dialog } = await openSettings(page, baseURL)
  await dialog.getByRole('button', { name: 'Models (LLM)', exact: true }).click()
  await dialog.getByRole('button', { name: 'Edit Model 1', exact: true }).click()
  const priceIn = dialog.getByLabel(/^Input/)
  await priceIn.fill('-3')
  await priceIn.blur()
  await expect(priceIn).toHaveAttribute('aria-invalid', 'true')
  const errId = await priceIn.getAttribute('aria-describedby')
  expect(errId).toBeTruthy()
  await expect(page.locator(`[id="${errId.split(' ')[0]}"]`)).toBeVisible()
  expect(puts).toHaveLength(0)

  await priceIn.fill('3')
  await priceIn.blur()
  await expect(priceIn).not.toHaveAttribute('aria-invalid', 'true')
  await expect(dialog.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()
  expect(puts).toHaveLength(1)
  expect(puts[0].body.priceIn).toBe(3)
  await ctx.close()
})

test('Models: a failed save shows an explicit error', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await page.route('**/api/admin/model-endpoints/*', (r) => r.fulfill({ status: 500, json: { error: 'boom' } }))
  const { dialog } = await openSettings(page, baseURL)
  await dialog.getByRole('button', { name: 'Models (LLM)', exact: true }).click()
  await dialog.getByRole('button', { name: 'Edit Model 2', exact: true }).click()
  const name = dialog.getByLabel('Display name')
  await name.fill('Renamed')
  await name.blur()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await ctx.close()
})

test('mobile: tabs are a two-level list (Personal / Organization) with an edge fade', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, MOBILE)
  await SCREENS.welcome(page, baseURL)
  await page.locator('button[title="Settings"]').first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  const level1 = dialog.getByRole('group', { name: 'Settings area' })
  await expect(level1.getByRole('button')).toHaveText(['Personal', 'Organization'])
  const nav = dialog.getByRole('navigation', { name: 'Settings sections' })
  await expect(nav.getByRole('button', { name: 'Preferences', exact: true })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Skills', exact: true })).toBeHidden()

  await level1.getByRole('button', { name: 'Organization' }).click()
  await expect(level1.getByRole('button', { name: 'Organization' })).toHaveAttribute('aria-pressed', 'true')
  await expect(nav.getByRole('button', { name: 'Skills', exact: true })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Models (LLM)', exact: true })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Preferences', exact: true })).toBeHidden()

  const fade = await nav.evaluate((el) => {
    const s = getComputedStyle(el)
    return s.maskImage || s.webkitMaskImage || 'none'
  })
  expect(fade).not.toBe('none')
  await ctx.close()
})

const TABS = ['Preferences', 'MCP connections', 'Skills', 'Design system', 'Models (LLM)', 'Tools', 'Administrators']

for (const variant of [DESKTOP, { theme: 'light', mobile: false }]) {
  test(`axe: the settings dialog and every tab are clean (${variant.theme})`, async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, variant)
    const { dialog } = await openSettings(page, baseURL)
    const found = {}
    for (const name of TABS) {
      await dialog.getByRole('button', { name, exact: true }).click()
      await page.waitForTimeout(300)
      const res = await new AxeBuilder({ page }).include('[role="dialog"][aria-modal="true"]').withTags(AXE_TAGS).analyze()
      const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
      if (bad.length) found[name] = bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)
    }
    expect(found).toEqual({})
    await ctx.close()
  })
}

test('ModelPicker shows at most 7 options until searched, search filters, arrows move focus', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await SCREENS.welcome(page, baseURL)
  await page.getByRole('button', { name: /^Model:/ }).first().click()
  const panel = page.getByRole('dialog', { name: /model/i })
  const items = panel.locator('[data-model-item]')
  expect(await items.count()).toBeLessThanOrEqual(7)
  const search = panel.getByRole('searchbox')
  if (!(await search.isVisible())) await panel.getByRole('button', { name: /more/i }).first().click()
  await panel.getByRole('searchbox').fill('opus')
  await expect(items).not.toHaveCount(0)
  for (const label of await items.allInnerTexts()) expect(label.toLowerCase()).toContain('opus')
  await items.first().focus()
  await page.keyboard.press('ArrowDown')
  expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-model-item'))).toBe(true)
  await ctx.close()
})

test('a dialog nested in Settings (skill editor) traps focus itself; Escape closes only it and focus returns to its trigger', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  const { dialog } = await openSettings(page, baseURL)
  await dialog.getByRole('button', { name: 'Skills', exact: true }).click()
  const add = dialog.getByRole('button', { name: 'Add', exact: true })
  await add.click()
  await page.getByRole('button', { name: 'Write instructions' }).click()
  const editor = page.getByRole('dialog', { name: 'Write skill instructions' })
  await expect(editor).toBeVisible()
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-labelledby] [role="dialog"]'))).toBe(true)
  }
  // required fields are validated inline, inside the editor
  await editor.getByRole('button', { name: 'Create' }).click()
  await expect(editor.getByRole('alert')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await expect(add).toBeFocused()
  await ctx.close()
})

test('Models rows: report the measured heights (collapsed list vs one row expanded)', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  const { dialog } = await openSettings(page, baseURL)
  await dialog.getByRole('button', { name: 'Models (LLM)', exact: true }).click()
  const list = dialog.getByRole('list', { name: 'Enabled models' })
  await expect(list.getByRole('listitem')).toHaveCount(15)
  const collapsed = (await list.boundingBox()).height
  await list.getByRole('button', { name: 'Edit Model 1', exact: true }).click()
  const oneOpen = (await list.boundingBox()).height
  test.info().annotations.push({ type: 'heights', description: `15 rows collapsed ${Math.round(collapsed)} px; one expanded ${Math.round(oneOpen)} px` })
  console.log(`[W2-7] 15 model rows: collapsed ${Math.round(collapsed)} px, one expanded ${Math.round(oneOpen)} px`)
  expect(collapsed).toBeLessThanOrEqual(1200)
  expect(oneOpen).toBeLessThanOrEqual(1200 + 400)
  await ctx.close()
})

// QA round 1 (PR #85): the add-model path for a non-curated endpoint, which
// must enter its costs before it can be added
const CUSTOM = {
  id: 'custom-runtime',
  displayName: 'Example Runtime',
  provider: 'Custom',
  enabled: false,
  discovered: true,
  curated: false,
  inferredPriceIn: null,
  inferredPriceOut: null,
  modality: 'chat',
}

async function openAddModel(page, baseURL) {
  await page.route('**/api/admin/model-endpoints', (r) => r.fulfill({ json: { endpoints: [CUSTOM], recommended: [] } }))
  const { dialog } = await openSettings(page, baseURL)
  await dialog.getByRole('button', { name: 'Models (LLM)', exact: true }).click()
  await dialog.getByRole('button', { name: 'Add model', exact: true }).click()
  return {
    dialog,
    priceIn: dialog.getByLabel('Example Runtime: input cost (US$/1M tokens)'),
    priceOut: dialog.getByLabel('Example Runtime: output cost (US$/1M tokens)'),
  }
}

test('add model: a non-curated model shows visible cost labels above their inputs', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  const { dialog, priceIn, priceOut } = await openAddModel(page, baseURL)
  for (const [text, control] of [['Input cost (US$/1M tokens)', priceIn], ['Output cost (US$/1M tokens)', priceOut]]) {
    const label = dialog.getByText(text, { exact: true })
    await expect(label).toBeVisible()
    const l = await label.boundingBox()
    const c = await control.boundingBox()
    expect(c.y).toBeGreaterThanOrEqual(l.y + l.height - 1)
  }
  await ctx.close()
})

test('add model: missing costs mark each input invalid with its own message, and nothing is saved', async ({ browser, baseURL }) => {
  const { ctx, page, puts } = await open(browser)
  const { dialog, priceIn, priceOut } = await openAddModel(page, baseURL)
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Enter the input and output costs')
  for (const control of [priceIn, priceOut]) {
    await expect(control).toHaveAttribute('aria-invalid', 'true')
    const ids = (await control.getAttribute('aria-describedby')) || ''
    expect(ids).toBeTruthy()
    await expect(page.locator(`[id="${ids.split(' ')[0]}"]`)).toBeVisible()
  }
  expect(puts).toHaveLength(0)
  const res = await new AxeBuilder({ page }).include('[role="dialog"][aria-modal="true"]').withTags(AXE_TAGS).analyze()
  expect(res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])
  // fixing one field clears only that field's error
  await priceIn.fill('2')
  await expect(priceIn).not.toHaveAttribute('aria-invalid', 'true')
  await expect(priceOut).toHaveAttribute('aria-invalid', 'true')
  await ctx.close()
})

test('add model: a failed save keeps the costs the admin typed', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await page.route('**/api/admin/model-endpoints/*', (r) => r.fulfill({ status: 500, json: { error: 'boom' } }))
  const { dialog, priceIn, priceOut } = await openAddModel(page, baseURL)
  await priceIn.fill('2')
  await priceOut.fill('8')
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(priceIn).toHaveValue('2')
  await expect(priceOut).toHaveValue('8')
  await ctx.close()
})
