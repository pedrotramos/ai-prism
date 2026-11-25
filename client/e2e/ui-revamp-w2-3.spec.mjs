// ui-revamp W2-3: admin settings (Models, Tools, Access) and Design system settings.
// Built client + page.route stubs for the admin and template endpoints (no backend).
//   AC1  the models table: a provider mark per row, price source, Active switch (and no lost admin action)
//   AC2  the Design system tabs Brand / Assets / Charts over the existing template data
//   AC3  the access page: administrators and external links only (Q13-A)
//   AC4  admin-only surfaces stay admin-only
//   AC5  ink primary buttons in both themes
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { AXE_TAGS, newVariantContext, SCREENS } from './lib.mjs'

const LIGHT = { theme: 'light', mobile: false }
const DARK = { theme: 'dark', mobile: false }
const MOBILE = { theme: 'light', mobile: true }

const ENDPOINTS = [
  { id: 'databricks-claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', blurb: '', provider: 'Anthropic', enabled: true, discovered: true, curated: true, sortOrder: 0, priceIn: null, priceOut: null, inferredPriceIn: 3, inferredPriceOut: 15, modality: 'chat' },
  { id: 'databricks-gpt-5', displayName: 'GPT 5', blurb: '', provider: 'OpenAI', enabled: true, discovered: true, curated: true, sortOrder: 1, priceIn: 2, priceOut: 8, inferredPriceIn: 1, inferredPriceOut: 4, modality: 'chat' },
  { id: 'databricks-gemini-3', displayName: 'Gemini 3', blurb: '', provider: 'Google', enabled: true, discovered: true, curated: true, sortOrder: 2, priceIn: null, priceOut: null, inferredPriceIn: 1, inferredPriceOut: 2, modality: 'chat' },
  { id: 'databricks-kimi-k2', displayName: 'Kimi K2', blurb: '', provider: 'Moonshot AI', enabled: true, discovered: true, curated: true, sortOrder: 3, priceIn: null, priceOut: null, inferredPriceIn: 1, inferredPriceOut: 2, modality: 'chat' },
  { id: 'custom-runtime', displayName: 'Example Runtime', blurb: '', provider: 'Custom', enabled: true, discovered: true, curated: false, sortOrder: 4, priceIn: 1, priceOut: 2, inferredPriceIn: null, inferredPriceOut: null, modality: 'chat' },
]

const LOGO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#0E6B5C"/></svg>')
const TEMPLATES = [
  {
    id: 11,
    name: 'Org brand',
    scope: 'global',
    canEdit: true,
    isSelected: true,
    primaryColor: '#0E6B5C',
    secondaryColor: '#8FCBB9',
    accentColor: '#E2A23B',
    backgroundColor: '#FFFFFF',
    headingFont: 'Georgia',
    bodyFont: 'Helvetica',
    logoDataUrl: LOGO,
    palette: [
      { varName: '--chart-1', name: 'Chart 1', value: '#112233' },
      { varName: '--hostile', name: 'Hostile', value: 'var(--accent)' },
    ],
    iconAssets: [
      { id: 'i1', kind: 'icon', label: 'Truck', dataUrl: LOGO },
      { id: 'i2', kind: 'icon', label: 'Tag', dataUrl: LOGO },
      { id: 'w1', kind: 'watermark', label: 'Mark', dataUrl: LOGO },
    ],
  },
  { id: 12, name: 'Personal kit', scope: 'user', canEdit: true, isSelected: false, primaryColor: '#222222', iconAssets: [], palette: [] },
]

async function stub(page, { me = { email: 'e2e-user@example.com', isAdmin: true, isOwner: true }, calls = [], endpoints = ENDPOINTS, templates = TEMPLATES, admins } = {}) {
  await page.route('**/api/me', (r) => r.fulfill({ json: me }))
  await page.route('**/api/admin/model-endpoints', (r) => r.fulfill({ json: { endpoints, recommended: [] } }))
  await page.route('**/api/admin/model-endpoints/*', (r) => {
    const body = r.request().postDataJSON()
    calls.push({ method: r.request().method(), url: new URL(r.request().url()).pathname, body })
    return r.fulfill({ json: { ok: true } })
  })
  await page.route('**/api/admin/model-endpoints-order', (r) => {
    calls.push({ method: r.request().method(), url: '/api/admin/model-endpoints-order', body: r.request().postDataJSON() })
    return r.fulfill({ json: { ok: true } })
  })
  await page.route('**/api/admin/tool-policy/*', (r) => r.fulfill({ json: { ok: true } }))
  await page.route('**/api/admin/mcp-catalog', (r) => r.fulfill({ json: { entries: [], suggestions: [] } }))
  await page.route('**/api/admins', (r) => {
    if (r.request().method() === 'POST') {
      calls.push({ method: 'POST', url: '/api/admins', body: r.request().postDataJSON() })
      return r.fulfill({ json: { ok: true } })
    }
    return r.fulfill({ json: admins || { owner: 'owner@example.com', admins: [{ principal: 'ana@example.com', kind: 'user' }, { principal: 'data-team', kind: 'group' }] } })
  })
  await page.route('**/api/admins/*', (r) => {
    if (r.request().method() === 'DELETE') calls.push({ method: 'DELETE', url: new URL(r.request().url()).pathname })
    return r.fulfill({ json: { ok: true } })
  })
  await page.route('**/api/admins/candidates', (r) => r.fulfill({ json: { candidates: [] } }))
  await page.route('**/api/deck-templates', (r) => r.fulfill({ json: { templates } }))
  await page.route('**/api/deck-templates/*/select', (r) => {
    calls.push({ method: 'POST', url: new URL(r.request().url()).pathname })
    return r.fulfill({ json: { ok: true } })
  })
  await page.route('**/api/deck-templates/*/scope', (r) => {
    calls.push({ method: 'POST', url: new URL(r.request().url()).pathname, body: r.request().postDataJSON() })
    return r.fulfill({ json: { ok: true } })
  })
  await page.route('**/api/skills', (r) => r.fulfill({ json: { skills: [], isAdmin: true } }))
  await page.route('**/api/mcp/connections*', (r) => r.fulfill({ json: { connections: [] } }))
}

async function open(browser, variant = LIGHT, opts) {
  const ctx = await newVariantContext(browser, variant)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const calls = []
  await stub(page, { calls, ...opts })
  return { ctx, page, calls, errors }
}

async function openTab(page, baseURL, tab) {
  await SCREENS.welcome(page, baseURL)
  await page.locator('button[title="Settings"]').first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: tab, exact: true }).click()
  return dialog
}

// the computed colours of --action / --on-action, resolved by a probe element
const inkOf = (el) => {
  const probe = (prop, token) => {
    const d = document.createElement('i')
    d.style.cssText = `position:absolute;${prop}:var(${token})`
    document.body.appendChild(d)
    const v = getComputedStyle(d)[prop === 'color' ? 'color' : 'backgroundColor']
    d.remove()
    return v
  }
  const cs = getComputedStyle(el)
  return [[cs.backgroundColor, cs.color], [probe('background-color', '--action'), probe('color', '--on-action')]]
}

const axeBad = async (page, scope) => {
  const res = await new AxeBuilder({ page }).include(scope).withTags(AXE_TAGS).analyze()
  return res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)
}

// ---------------------------------------------------------------- AC1 models

test('AC1 models: every row carries its provider mark (an svg with paths, or the neutral dot), never a coloured dot', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  const dialog = await openTab(page, baseURL, 'Models (LLM)')
  const list = dialog.getByRole('list', { name: 'Enabled models' })
  await expect(list.getByRole('listitem')).toHaveCount(5)
  for (const [name, hasPaths] of [['Claude Sonnet 5.5', true], ['GPT 5', true], ['Gemini 3', true], ['Kimi K2', true], ['Example Runtime', false]]) {
    const row = list.getByRole('listitem').filter({ has: page.getByRole('button', { name: `Edit ${name}`, exact: true }) })
    const svg = row.locator('span[aria-hidden="true"] svg').first()
    await expect(svg).toBeVisible()
    expect(await svg.locator('path').count() > 0).toBe(hasPaths)
    // the mark takes the text colour, not a brand hex
    expect((await svg.getAttribute('fill')) ?? '').not.toMatch(/^#/)
  }
  expect(errors).toEqual([])
  await ctx.close()
})

test('AC1 models: the price column says where a price comes from, and the first chat model is the default', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  const dialog = await openTab(page, baseURL, 'Models (LLM)')
  const list = dialog.getByRole('list', { name: 'Enabled models' })
  const rowOf = (name) => list.getByRole('listitem').filter({ has: page.getByRole('button', { name: `Edit ${name}`, exact: true }) })
  await expect(rowOf('Claude Sonnet 5.5').getByText('List price').locator('visible=true')).toHaveCount(1)
  await expect(rowOf('GPT 5').getByText('Negotiated').locator('visible=true')).toHaveCount(1)
  await expect(rowOf('Claude Sonnet 5.5').getByText('default', { exact: true })).toBeVisible()
  await expect(rowOf('GPT 5').getByText('default', { exact: true })).toHaveCount(0)
  await ctx.close()
})

test('AC1 models: the Active switch disables and re-enables a model, the row stays so it is one click to undo', async ({ browser, baseURL }) => {
  const { ctx, page, calls } = await open(browser)
  const dialog = await openTab(page, baseURL, 'Models (LLM)')
  const sw = dialog.getByRole('switch', { name: 'Active: GPT 5' })
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  expect(calls.at(-1)).toMatchObject({ method: 'PUT', url: '/api/admin/model-endpoints/databricks-gpt-5', body: { enabled: false } })
  await expect(dialog.getByRole('list', { name: 'Enabled models' }).getByRole('listitem')).toHaveCount(5)
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  expect(calls.at(-1)).toMatchObject({ body: { enabled: true } })
  await ctx.close()
})

test('AC1 models: a failed switch keeps the model on and shows the error (no silent revert)', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await page.route('**/api/admin/model-endpoints/*', (r) => r.fulfill({ status: 500, json: { error: 'boom' } }))
  const dialog = await openTab(page, baseURL, 'Models (LLM)')
  const sw = dialog.getByRole('switch', { name: 'Active: GPT 5' })
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByRole('alert').first()).toBeVisible()
  await ctx.close()
})

test('AC1 models: nothing is lost from the old tab: reorder, edit, price fields and Add model all still work', async ({ browser, baseURL }) => {
  const { ctx, page, calls } = await open(browser)
  const dialog = await openTab(page, baseURL, 'Models (LLM)')
  await dialog.getByRole('button', { name: 'Move GPT 5 down' }).click()
  await expect.poll(() => calls.some((c) => c.url === '/api/admin/model-endpoints-order')).toBe(true)
  await dialog.getByRole('button', { name: 'Edit GPT 5', exact: true }).click()
  await expect(dialog.getByLabel('Display name')).toHaveValue('GPT 5')
  await expect(dialog.getByLabel(/^Input/)).toHaveValue('2')
  await expect(dialog.getByRole('button', { name: 'Add model', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await ctx.close()
})

// ---------------------------------------------------------------- AC5 ink

for (const variant of [LIGHT, DARK]) {
  test(`AC5 ink: the primary CTAs of Models, Access and Design system compute to --action / --on-action (${variant.theme})`, async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, variant)
    let dialog = await openTab(page, baseURL, 'Models (LLM)')
    const checks = []
    checks.push(await dialog.getByRole('button', { name: 'Add model', exact: true }).evaluate(inkOf))
    await dialog.getByRole('button', { name: 'Administrators', exact: true }).click()
    await expect(dialog.getByRole('heading', { name: 'Policies', exact: true })).toBeVisible()
    await dialog.getByLabel('Add an administrator').fill('someone@example.com')
    checks.push(await dialog.getByRole('button', { name: 'Add', exact: true }).evaluate(inkOf))
    await dialog.getByRole('button', { name: 'Design system', exact: true }).click()
    await expect(dialog.getByRole('combobox', { name: 'Design system' })).toBeVisible() // loaded, not the loading state
    checks.push(await dialog.getByRole('button', { name: 'Import folder' }).evaluate(inkOf))
    for (const [got, want] of checks) expect(got).toEqual(want)
    await ctx.close()
  })
}

// ---------------------------------------------------------------- Tools

test('Tools: two lists (on by default / catalogs), every control still there: web search, memory and MCP Apps cards included', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await page.route('**/api/tool-policy', (r) => r.fulfill({ json: { policy: {} } }))
  const dialog = await openTab(page, baseURL, 'Tools')
  await expect(dialog.getByRole('heading', { name: 'On by default' })).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Catalogs to choose from in each conversation' })).toBeVisible()
  await expect(dialog.getByTestId('web-search-card')).toBeVisible()
  await expect(dialog.getByTestId('memory-admin-card')).toBeVisible()
  await expect(dialog.getByTestId('mcp-apps-admin-card')).toBeVisible()
  for (const name of ['Python', 'Genie One']) await expect(dialog.getByRole('switch', { name })).toBeVisible()
  const defaults = dialog.getByRole('region', { name: 'On by default' })
  await expect(defaults.getByRole('switch')).toHaveCount(6)
  await dialog.getByRole('switch', { name: 'Python' }).click()
  await expect(dialog.getByRole('switch', { name: 'Python' })).toHaveAttribute('aria-checked', 'false')
  await expect(dialog.getByRole('heading', { name: 'MCP catalog' })).toBeVisible()
  await ctx.close()
})

// ---------------------------------------------------------------- AC3 access

test('AC3 access: administrators as chips, add and remove still work, and only external links stand in for policies', async ({ browser, baseURL }) => {
  const { ctx, page, calls } = await open(browser)
  const dialog = await openTab(page, baseURL, 'Administrators')
  await expect(dialog.getByRole('heading', { name: 'Access and policies' })).toBeVisible()
  await expect(dialog.getByText('owner@example.com', { exact: true })).toBeVisible()
  await expect(dialog.getByText('ana@example.com', { exact: true })).toBeVisible()
  await expect(dialog.getByText('data-team', { exact: true })).toBeVisible()

  await dialog.getByLabel('Add an administrator').fill('new@example.com')
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect.poll(() => calls.find((c) => c.url === '/api/admins')?.body).toEqual({ principal: 'new@example.com', kind: 'user' })

  await dialog.getByRole('button', { name: /^Remove admin: ana@example.com/i }).click()
  await expect.poll(() => calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/admins/ana%40example.com')

  // external links open in a new tab and never leak the opener
  for (const name of ['AI Gateway docs', 'Budgets docs']) {
    const link = dialog.getByRole('link', { name })
    await expect(link).toHaveAttribute('href', /^https:\/\//)
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noreferrer/)
  }
  // Q13-A: nothing that needs server work is offered
  for (const forbidden of [/retention/i, /attachment/i, /sharing link/i, /groups with access/i, /per-tool/i]) await expect(dialog.getByText(forbidden)).toHaveCount(0)
  await ctx.close()
})

// ---------------------------------------------------------------- AC4 admin only

test('AC4 admin-only: a non-admin sees no Models, Tools or Administrators tab, and the admin endpoints are never called', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, LIGHT, { me: { email: 'user@example.com', isAdmin: false, isOwner: false } })
  const adminCalls = []
  page.on('request', (r) => {
    if (/\/api\/(admin\/|admins)/.test(r.url())) adminCalls.push(r.url())
  })
  await SCREENS.welcome(page, baseURL)
  await page.locator('button[title="Settings"]').first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('button', { name: 'Preferences', exact: true })).toBeVisible()
  for (const name of ['Models (LLM)', 'Tools', 'Administrators']) await expect(dialog.getByRole('button', { name, exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Design system', exact: true }).click()
  // no publish-to-everyone control for a non-admin
  await expect(dialog.getByRole('button', { name: /Make available to everyone|Make personal/ })).toHaveCount(0)
  expect(adminCalls).toEqual([])
  await ctx.close()
})

// ---------------------------------------------------------------- AC2 design system

test('AC2 design system: the picker, three tabs over the existing template data, keyboard arrows between tabs', async ({ browser, baseURL }) => {
  const { ctx, page, calls } = await open(browser)
  const dialog = await openTab(page, baseURL, 'Design system')
  const picker = dialog.getByRole('combobox', { name: 'Design system' })
  await expect(picker).toHaveValue('11')
  await expect(picker.locator('option')).toHaveText(['Org brand — Organization default', 'Personal kit'])

  const tabs = dialog.getByRole('tablist', { name: 'Design system sections' })
  await expect(tabs.getByRole('tab')).toHaveText(['Brand', 'Assets', 'Charts'])
  await expect(tabs.getByRole('tab', { name: 'Brand' })).toHaveAttribute('aria-selected', 'true')

  // Brand: colours (the four roles + palette tokens), import, starter kit
  await expect(dialog.getByRole('heading', { name: 'Colors' })).toBeVisible()
  await expect(dialog.getByText('#0E6B5C').first()).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Import folder' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /starter kit/i })).toBeVisible()

  await tabs.getByRole('tab', { name: 'Brand' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(tabs.getByRole('tab', { name: 'Assets' })).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.getByRole('tab', { name: 'Assets' })).toBeFocused()
  await expect(dialog.getByRole('heading', { name: 'Logo' })).toBeVisible()
  await expect(dialog.getByRole('heading', { name: /^Icons/ })).toBeVisible()
  await expect(dialog.getByRole('listitem').filter({ has: page.locator('img[alt="Truck"]') })).toHaveCount(1)
  await expect(dialog.getByText('1 watermark detected and ignored')).toBeVisible()

  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('list', { name: 'Series colors' }).getByRole('listitem')).toHaveCount(4) // chart token, primary, secondary, accent
  await page.keyboard.press('ArrowRight')
  await expect(tabs.getByRole('tab', { name: 'Brand' })).toHaveAttribute('aria-selected', 'true') // wraps

  await picker.selectOption('12')
  await expect.poll(() => calls.some((c) => c.url === '/api/deck-templates/12/select')).toBe(true)
  await ctx.close()
})

test('AC2 design system: every action of the old card grid is still on the selected design system', async ({ browser, baseURL }) => {
  const { ctx, page, calls } = await open(browser)
  const dialog = await openTab(page, baseURL, 'Design system')
  for (const name of ['Inspect design system', 'Edit', 'Duplicate', 'Delete']) await expect(dialog.getByRole('button', { name })).toBeVisible()
  const scope = dialog.getByRole('button', { name: /Make personal/ })
  await expect(scope).toHaveAttribute('aria-pressed', 'true')
  await scope.click()
  await expect.poll(() => calls.find((c) => c.url === '/api/deck-templates/11/scope')?.body).toEqual({ scope: 'user' })
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Save template' })).toBeVisible()
  const [got, want] = await dialog.getByRole('button', { name: 'Save template' }).evaluate(inkOf)
  expect(got).toEqual(want)
  await ctx.close()
})

test('AC2 design system: a palette value that is not a literal colour never paints (no app token leaks into a DS preview)', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  const dialog = await openTab(page, baseURL, 'Design system')
  const hostile = dialog.getByText('--hostile', { exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-card")][1]')
  await expect(hostile).toBeVisible()
  await expect(hostile.locator('svg rect')).toHaveCount(0)
  await ctx.close()
})

test('AC2 design system: a design system without chart colours or assets says so, honestly', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, LIGHT, { templates: [{ id: 5, name: 'Empty', scope: 'user', canEdit: true, isSelected: true, iconAssets: [], palette: [] }] })
  const dialog = await openTab(page, baseURL, 'Design system')
  await dialog.getByRole('tab', { name: 'Assets' }).click()
  await expect(dialog.getByText(/No logo in this design system yet/)).toBeVisible()
  await expect(dialog.getByText(/No assets yet/)).toBeVisible()
  await dialog.getByRole('tab', { name: 'Charts' }).click()
  await expect(dialog.getByText(/carries no chart colors yet/)).toBeVisible()
  await ctx.close()
})

// ---------------------------------------------------------------- a11y + mobile

for (const variant of [LIGHT, DARK, MOBILE]) {
  test(`axe: Models, Tools, Administrators and the three Design system tabs are clean (${variant.theme}${variant.mobile ? ', 390' : ''})`, async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, variant)
    await page.route('**/api/tool-policy', (r) => r.fulfill({ json: { policy: {} } }))
    await SCREENS.welcome(page, baseURL)
    await page.locator('button[title="Settings"]').first().click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    if (variant.mobile) await dialog.getByRole('group', { name: 'Settings area' }).getByRole('button', { name: 'Organization' }).click()
    const found = {}
    for (const name of ['Models (LLM)', 'Tools', 'Administrators']) {
      await dialog.getByRole('button', { name, exact: true }).click()
      await page.waitForTimeout(300)
      const bad = await axeBad(page, '[role="dialog"][aria-modal="true"]')
      if (bad.length) found[name] = bad
    }
    await dialog.getByRole('button', { name: 'Design system', exact: true }).click()
    for (const tab of ['Brand', 'Assets', 'Charts']) {
      await dialog.getByRole('tab', { name: tab }).click()
      await page.waitForTimeout(300)
      const bad = await axeBad(page, '[role="dialog"][aria-modal="true"]')
      if (bad.length) found[`DS ${tab}`] = bad
    }
    expect(found).toEqual({})
    await ctx.close()
  })
}

test('mobile 390: the models table and the access page do not scroll sideways', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, MOBILE)
  await SCREENS.welcome(page, baseURL)
  await page.locator('button[title="Settings"]').first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('group', { name: 'Settings area' }).getByRole('button', { name: 'Organization' }).click()
  for (const name of ['Models (LLM)', 'Administrators', 'Design system']) {
    await dialog.getByRole('button', { name, exact: true }).click()
    await page.waitForTimeout(200)
    const overflow = await dialog.locator('[role="region"][tabindex="0"]').evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow, name).toBeLessThanOrEqual(1)
  }
  await ctx.close()
})
