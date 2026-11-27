// W3-7: the reasoning-effort control in the model picker, and locale-aware model blurbs.
// Built client + recorded fixtures; /api/models is answered with page.route so one
// model carries the `reasoning` catalog flag and its neighbours do not.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { AXE_TAGS, newVariantContext, SCREENS, loadFixtures } from './lib.mjs'

const base = JSON.parse(loadFixtures().routes['GET /api/models'].body)
// both pinned in the picker (the first model, and the first one of another provider)
const CAPABLE_M = base.models[0]
const PLAIN_M = base.models.find((m) => m.provider !== CAPABLE_M.provider)
const models = base.models.map((m) => (m.id === CAPABLE_M.id ? { ...m, reasoning: { param: 'openai', levels: ['low', 'medium', 'high'] } } : m))

async function open(browser, variant, locale) {
  const ctx = await newVariantContext(browser, variant)
  if (locale) await ctx.addInitScript((l) => Object.defineProperty(navigator, 'language', { get: () => l }), locale)
  const page = await ctx.newPage()
  await page.route('**/api/models', (r) => r.fulfill({ json: { ...base, models } }))
  // record the turn payload the client sends (the shim from lib.mjs answers the stream)
  await page.addInitScript(() => {
    const prev = window.fetch
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (/\/api\/chat$/.test(url) && init?.body instanceof FormData) window.__payload = JSON.parse(init.body.get('payload'))
      return prev(input, init)
    }
  })
  return { ctx, page }
}

// the picker lives in the composer (W1-3): scope to it so a header copy never answers
const modelButton = (page) => page.locator('[data-composer]').getByRole('button', { name: /^Modelo?:/ })

const openPicker = async (page, baseURL) => {
  await SCREENS.welcome(page, baseURL)
  await modelButton(page).click()
  return page.getByRole('dialog', { name: /model/i })
}

test('the effort control is shown for the capable model and hidden for one without the flag', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, { theme: 'dark', mobile: false })
  let panel = await openPicker(page, baseURL)
  // the catalog's first model is the default and carries the flag
  const group = panel.getByRole('group', { name: 'Reasoning effort' })
  await expect(group).toBeVisible()
  await expect(group.getByRole('radio')).toHaveCount(4)
  await expect(group.getByRole('radio', { name: 'Auto' })).toBeChecked()
  await panel.locator('[data-model-item]', { hasText: PLAIN_M.label }).first().click()
  await modelButton(page).click()
  panel = page.getByRole('dialog', { name: /model/i })
  await expect(panel.locator('[data-model-item]').first()).toBeVisible()
  await expect(panel.getByTestId('effort-control')).toHaveCount(0)
  await ctx.close()
})

test('keyboard: arrows move the effort, the choice is sent as reasoning_effort, Auto sends nothing', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, { theme: 'dark', mobile: false })
  await SCREENS.welcome(page, baseURL)
  await modelButton(page).click()
  const group = page.getByRole('group', { name: 'Reasoning effort' })
  // opening moves focus to the selected model (rAF): let it land before moving on
  await expect(page.locator('[data-model-item][aria-pressed="true"]')).toBeFocused()
  await group.getByRole('radio', { name: 'Auto' }).focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(group.getByRole('radio', { name: 'High' })).toBeChecked()
  await page.keyboard.press('Escape')
  await page.locator('textarea').first().fill('hello')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => window.__payload?.reasoning_effort)).toBe('high')
  await ctx.close()

  // untouched: the field is absent from the payload
  const second = await open(browser, { theme: 'dark', mobile: false })
  await SCREENS.welcome(second.page, baseURL)
  await second.page.locator('textarea').first().fill('hello')
  await second.page.keyboard.press('Enter')
  await expect.poll(() => second.page.evaluate(() => !!window.__payload)).toBe(true)
  expect(await second.page.evaluate(() => 'reasoning_effort' in window.__payload)).toBe(false)
  await second.ctx.close()
})

test('a stale effort is not sent once the selected model has no flag', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, { theme: 'dark', mobile: false })
  await SCREENS.welcome(page, baseURL)
  await modelButton(page).click()
  await page.getByRole('group', { name: 'Reasoning effort' }).getByText('Low', { exact: true }).click()
  await page.getByRole('dialog', { name: /model/i }).locator('[data-model-item]', { hasText: PLAIN_M.label }).first().click()
  await page.locator('textarea').first().fill('hello')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => !!window.__payload)).toBe(true)
  expect(await page.evaluate(() => 'reasoning_effort' in window.__payload)).toBe(false)
  await ctx.close()
})

for (const [locale, re] of [['en-US', /^Balanced and fast/], ['pt-BR', /^Equilibrado e rápido/], ['es-ES', /^Equilibrado y rápido/]]) {
  test(`blurbs follow the UI language (${locale})`, async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, { theme: 'dark', mobile: false }, locale)
    const panel = await openPicker(page, baseURL)
    await expect(panel.getByText(re).first()).toBeVisible()
    await ctx.close()
  })
}

test('slash-command model blurbs follow the UI language', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, { theme: 'dark', mobile: false }, 'en-US')
  await SCREENS.welcome(page, baseURL)
  await page.locator('textarea').first().fill('/model ')
  await expect(page.getByText(/^Anthropic · Balanced and fast/)).toBeVisible()
  await ctx.close()
})

for (const variant of [{ theme: 'light', mobile: false }, { theme: 'dark', mobile: false }, { theme: 'light', mobile: true }, { theme: 'dark', mobile: true }]) {
  test(`axe: the picker with the effort control is clean (${variant.theme} ${variant.mobile ? '390' : '1440'})`, async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, variant)
    await SCREENS.welcome(page, baseURL)
    await modelButton(page).click()
    await expect(page.getByTestId('effort-control')).toBeVisible()
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running')) // axe must see the final paint, not a frame mid-fade
    const res = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(AXE_TAGS).analyze()
    const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
    await ctx.close()
  })
}

// W0-2 left this check to W1-3: every provider in the catalog gets a real mark
// (a path glyph, never the neutral fallback dot), in both themes.
for (const theme of ['light', 'dark']) {
  test(`every catalog provider's mark renders in the picker (${theme})`, async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, { theme, mobile: false })
    const panel = await openPicker(page, baseURL)
    // expand the whole catalog: the pinned three plus "more", grouped by provider
    await panel.getByRole('button', { name: /^More models/ }).click()
    const providers = [...new Set(models.map((m) => m.provider))]
    const seen = await panel.locator('[data-model-item]').evaluateAll((els) =>
      els.map((el) => ({ label: el.querySelector('.font-semibold')?.textContent, paths: el.querySelectorAll('svg path').length, box: el.querySelector('svg')?.getBoundingClientRect().width }))
    )
    expect(seen.length).toBeGreaterThanOrEqual(models.length)
    for (const row of seen) {
      expect(row.paths, `${row.label} has no mark`).toBeGreaterThan(0)
      expect(row.box).toBeGreaterThan(8)
    }
    // one row per provider is enough to prove the mapping; the trigger shows the current one
    expect(providers.length).toBeGreaterThanOrEqual(5)
    await expect(modelButton(page).locator('svg path').first()).toBeAttached()
    await ctx.close()
  })
}

test('the model rows show the Default tag once, the blurb and the relative-cost bars', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, { theme: 'dark', mobile: false })
  const panel = await openPicker(page, baseURL)
  await expect(panel.getByText('Default', { exact: true })).toHaveCount(1)
  await expect(panel.locator('[data-model-item]').first().getByRole('img', { name: /^Relative cost:/ })).toBeVisible()
  await expect(panel.getByRole('radio', { name: 'Auto' })).toBeChecked()
  await ctx.close()
})

// W2-4 item 9: the search box of the composer's model picker (the header picker test that covered it went in W1-1).
// The search covers the whole catalog, the pinned models included, folds case and accents, and says so when nothing matches.
test('the composer model picker search narrows the whole catalog and reports an empty result', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, { theme: 'dark', mobile: false })
  const panel = await openPicker(page, baseURL)
  await panel.getByRole('button', { name: /^More models/ }).click()
  const search = panel.getByRole('searchbox', { name: 'Search models' })
  const rows = panel.locator('[data-model-item]')
  await expect(rows.first()).toBeVisible()
  // label match, any case: the two "Flash" models, from two providers
  await search.fill('fLaSh')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Gemini 3.8 Flash')
  await expect(rows.nth(1)).toContainText('GLM-5.3 Flash')
  // a provider match reaches the pinned models too: every Anthropic model, exactly the catalog's four
  await search.fill('anthropic')
  await expect(rows).toHaveCount(models.filter((m) => m.provider === 'Anthropic').length)
  // nothing matches
  await search.fill('zzzz-no-such-model')
  await expect(rows).toHaveCount(0)
  await expect(panel.getByText('No model matches “zzzz-no-such-model”.')).toBeVisible()
  // clearing the box brings the catalog back
  await search.fill('')
  await expect(rows.first()).toBeVisible()
  await ctx.close()
})
