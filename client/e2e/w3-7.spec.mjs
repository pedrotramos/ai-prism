// W3-7: deck editor polish from the Wave 3 release critique (P1 #8 and #9).
import { test, expect } from '@playwright/test'
import { loadFixtures, contextOptions } from './lib.mjs'

const fixtures = loadFixtures()
const { ids } = fixtures

async function openDeckEditor(browser, baseURL, { mobile, locale }) {
  const ctx = await browser.newContext({ ...contextOptions({ theme: 'light', mobile }), locale })
  const page = await ctx.newPage()
  await page.goto(`${baseURL}/#/chat/${ids.s1}`, { waitUntil: 'domcontentloaded' })
  const open = page.locator('[data-artifact-card="deck"] [data-card-primary]').first()
  await expect(open).toBeVisible()
  await open.click()
  const studio = page.locator('[data-studio="deck"]')
  await expect(studio).toBeVisible()
  return { ctx, page, studio }
}

test('notes label spans the textarea width, above it, at 390 px in every UI locale', async ({ browser, baseURL }) => {
  for (const locale of ['pt-BR', 'en-US', 'es-ES']) {
    const { ctx, studio } = await openDeckEditor(browser, baseURL, { mobile: true, locale })
    try {
      const label = studio.locator('label[for="deck-studio-notes"]')
      const textarea = studio.locator('#deck-studio-notes')
      await expect(label).toBeVisible()
      const [l, t] = await Promise.all([label.boundingBox(), textarea.boundingBox()])
      expect(l).not.toBeNull()
      expect(t).not.toBeNull()
      expect(Math.abs(l.width - t.width)).toBeLessThanOrEqual(1)
      expect(l.y + l.height).toBeLessThanOrEqual(t.y + 0.5)
      const fit = await label.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
      expect(fit.scroll).toBeLessThanOrEqual(fit.client)
    } finally {
      await ctx.close()
    }
  }
})

test('notes label stays beside the textarea on desktop', async ({ browser, baseURL }) => {
  const { ctx, studio } = await openDeckEditor(browser, baseURL, { mobile: false, locale: 'en-US' })
  try {
    const [l, t] = await Promise.all([studio.locator('label[for="deck-studio-notes"]').boundingBox(), studio.locator('#deck-studio-notes').boundingBox()])
    expect(l.x + l.width).toBeLessThanOrEqual(t.x + 0.5)
  } finally {
    await ctx.close()
  }
})

test('layer rows show the localized label, never the raw tag', async ({ browser, baseURL }) => {
  const { ctx, studio } = await openDeckEditor(browser, baseURL, { mobile: false, locale: 'en-US' })
  try {
    await studio.getByRole('button', { name: 'Edit', exact: true }).click()
    await studio.getByRole('tab', { name: 'Layers' }).click()
    const rows = studio.getByRole('tree').getByRole('treeitem')
    await expect(rows.first()).toBeVisible()
    const texts = await rows.evaluateAll((els) => els.map((el) => el.textContent.trim().toLowerCase()))
    expect(texts.length).toBeGreaterThan(0)
    const rawTags = ['section', 'div', 'span', 'p', 'img', 'svg', 'ul', 'li', 'a', 'button', 'table', 'figure', 'header', 'footer', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']
    for (const text of texts) expect(rawTags).not.toContain(text)
    // no mono tag badge, and the computed accessible name of every item excludes its raw tag
    expect(await studio.getByRole('tree').locator('span.font-mono').count()).toBe(0)
    for (const row of await rows.all()) {
      const title = await row.getAttribute('title')
      expect(title).toMatch(/^<[^>]+>$/)
      const rawTag = title.slice(1, -1)
      const accessibleName = (await row.ariaSnapshot()).match(/treeitem "([^"]+)"/)?.[1]
      expect(accessibleName).toBeTruthy()
      expect(accessibleName).not.toMatch(new RegExp(`\\b${rawTag}\\b`, 'i'))
    }
  } finally {
    await ctx.close()
  }
})
