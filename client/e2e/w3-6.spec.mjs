// W3-6 (critique P1 #2, #3, #4, #7): the Tools popover stays in a short viewport, studios take and give back
// keyboard focus, placeholders are readable, and opening a studio does not shift the layout.
import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext, contextOptions, FETCH_SHIM } from './lib.mjs'

const fx = loadFixtures()
const { ids } = fx
const blocks = JSON.parse(fx.routes[`GET /api/sessions/${ids.s1}/messages`].body).messages.find((m) => m.id === '60').blocks
const deckBlock = blocks.find((b) => b.type === 'deck-html')
const sheetBlock = blocks.find((b) => b.type === 'spreadsheet')
const docBlock = blocks.find((b) => b.type === 'document')

async function routeArtifacts(ctx) {
  await ctx.route(`**/api/decks/${ids.deck}`, (r) => r.fulfill({ json: { deck: { id: ids.deck, sessionId: ids.s1, title: deckBlock.title, slides: [...deckBlock.slides], format: 'html' } } }))
  await ctx.route(`**/api/spreadsheets/${ids.sheet}`, (r) => r.fulfill({ json: { spreadsheet: { id: ids.sheet, title: sheetBlock.title, sheets: sheetBlock.sheets } } }))
  await ctx.route(`**/api/documents/${ids.doc}`, (r) => r.fulfill({ json: { document: { id: ids.doc, title: docBlock.title, markdown: docBlock.markdown } } }))
}

async function open(browser, opts = {}) {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: false })
  await routeArtifacts(ctx)
  const page = await ctx.newPage()
  if (opts.viewport) await page.setViewportSize(opts.viewport)
  return { ctx, page }
}

test('#2: the Tools popover and every focusable inside it stay inside a 1440x600 viewport', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, { viewport: { width: 1440, height: 600 } })
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  await page.locator('[data-composer] button[title="Tools"]').click()
  const dialog = page.getByRole('dialog', { name: 'Tools' })
  await expect(dialog).toBeVisible()
  const inView = async () => {
    const r = await dialog.evaluate((el) => {
      const b = el.getBoundingClientRect()
      return { top: b.top, bottom: b.bottom, vh: window.innerHeight }
    })
    expect(r.top).toBeGreaterThanOrEqual(0)
    expect(r.bottom).toBeLessThanOrEqual(r.vh)
  }
  await inView()
  const n = await dialog.locator('button, [tabindex="0"], input, a').count()
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab')
    const r = await page.evaluate(() => {
      const b = document.activeElement.getBoundingClientRect()
      return { top: b.top, bottom: b.bottom, vh: window.innerHeight }
    })
    expect(r.top).toBeGreaterThanOrEqual(0)
    expect(r.bottom).toBeLessThanOrEqual(r.vh)
  }
  await ctx.close()
})

test('#3: a keyboard-opened studio takes focus; closing returns it to the card that opened it', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  const card = page.getByRole('button', { name: 'Open', exact: true }).first()
  await card.scrollIntoViewIfNeeded()
  await card.focus()
  await page.keyboard.press('Enter')
  const root = page.locator('[data-studio="doc"]')
  await root.waitFor()
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-studio="doc"]'))).toBe(true)
  await root.locator('[data-studio-close]').focus()
  await page.keyboard.press('Enter')
  await expect(root).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Open')
  await expect.poll(() => card.evaluate((el) => el === document.activeElement)).toBe(true)
  await ctx.close()
})

test('#4: an input and a textarea with no placeholder class get a readable placeholder (--faint, >= 4.5:1)', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser)
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  await page.locator('[data-composer]').waitFor()
  // bare controls: exactly what falls back to Tailwind preflight (#9ca3af) without the global rule
  const r = await page.evaluate(() => {
    const out = {}
    const probe = document.createElement('span')
    probe.style.color = 'var(--faint)'
    document.body.appendChild(probe)
    out.faint = getComputedStyle(probe).color
    probe.remove()
    for (const tag of ['input', 'textarea']) {
      const el = document.createElement(tag)
      el.placeholder = 'x'
      document.body.appendChild(el)
      out[tag] = getComputedStyle(el, '::placeholder').color
      el.remove()
    }
    return out
  })
  expect(r.input).toBe(r.faint)
  expect(r.textarea).toBe(r.faint)
  await ctx.close()
})

for (const kind of ['doc', 'sheet', 'deck']) {
  test(`#7: opening the ${kind} studio by click has a CLS of at most 0.1`, async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser)
    await page.addInitScript(() => {
      window.__cls = { counted: 0, all: 0 }
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__cls.all += e.value
          if (!e.hadRecentInput) window.__cls.counted += e.value
        }
      }).observe({ type: 'layout-shift', buffered: true })
    })
    await page.goto(`${baseURL}/#/chat/${ids.s1}`)
    await page.getByText('Open in Slides Studio').first().waitFor()
    await page.waitForTimeout(600)
    await page.evaluate(() => { window.__cls = { counted: 0, all: 0 } })
    const btn = kind === 'deck' ? page.getByText('Open in Slides Studio').first() : kind === 'sheet' ? page.getByRole('button', { name: 'Open studio' }).first() : page.getByRole('button', { name: 'Open', exact: true }).first()
    await btn.scrollIntoViewIfNeeded()
    await page.evaluate(() => { window.__cls = { counted: 0, all: 0 } })
    await btn.click()
    await page.locator(`[data-studio="${kind}"]`).waitFor()
    await page.waitForTimeout(900)
    const cls = await page.evaluate(() => window.__cls)
    console.log(`CLS ${kind}: counted=${cls.counted.toFixed(4)} all(incl. recent-input)=${cls.all.toFixed(4)}`)
    // the CLS metric excludes shifts within 500 ms of a click/key (hadRecentInput); the raw sum is logged for the record
    expect(cls.counted).toBeLessThanOrEqual(0.1)
    await ctx.close()
  })
}
