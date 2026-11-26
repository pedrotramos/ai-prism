// W3-5: the deck editor's slide-level Design panel and the preview focus ring.
// Cases 1-2 come from the Wave 3 release-gate audit (blockers 1 and 2).
import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext } from './lib.mjs'

const fixtures = loadFixtures()
const { ids } = fixtures

async function openDeck(page, baseURL) {
  await page.goto(`${baseURL}/#/chat/${ids.s1}`, { waitUntil: 'domcontentloaded' })
  const open = page.locator('[data-artifact-card="deck"] [data-card-primary]').first()
  await expect(open).toBeVisible()
  await open.click()
  const studio = page.locator('[data-studio="deck"]')
  await expect(studio).toBeVisible()
  return studio
}

test('keyboard focus on the deck preview iframe has a visible indicator', async ({ browser, baseURL }) => {
  const context = await newVariantContext(browser, { theme: 'light', mobile: false })
  try {
    const page = await context.newPage()
    const messages = JSON.parse(fixtures.routes[`GET /api/sessions/${ids.s1}/messages`].body).messages
    await page.route(`**/api/sessions/${ids.s1}/messages`, (route) =>
      route.fulfill({ json: { messages: messages.filter((message) => ['59', '60'].includes(String(message.id))) } })
    )
    await page.goto(`${baseURL}/#/chat/${ids.s1}`, { waitUntil: 'domcontentloaded' })
    const open = page.locator('[data-artifact-card="deck"] [data-card-primary]').first()
    await expect(open).toBeVisible()
    let reached = false
    for (let i = 0; i < 180 && !reached; i++) {
      await page.keyboard.press('Tab')
      reached = await open.evaluate((el) => document.activeElement === el)
    }
    expect(reached).toBe(true)
    await page.keyboard.press('Enter')
    const studio = page.locator('[data-studio="deck"]')
    await expect(studio).toBeVisible()
    const iframe = studio.locator('iframe[title]:not([tabindex="-1"])').first()
    await expect(iframe).toBeVisible()
    let focused = false
    for (let i = 0; i < 40 && !focused; i++) {
      await page.keyboard.press('Tab')
      focused = await iframe.evaluate((el) => document.activeElement === el)
    }
    expect(focused).toBe(true)
    const style = await iframe.evaluate((el) => ({ focusVisible: el.matches(':focus-visible'), outlineStyle: getComputedStyle(el).outlineStyle }))
    expect(style).toEqual({ focusVisible: true, outlineStyle: 'solid' })
  } finally {
    await context.close()
  }
})

test('opening the deck editor shows slide-level Design controls by default', async ({ browser, baseURL }) => {
  const context = await newVariantContext(browser, { theme: 'light', mobile: false })
  try {
    const page = await context.newPage()
    const studio = await openDeck(page, baseURL)
    await studio.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.locator('#deck-rail-tab-slides')).toBeVisible()
    await expect(page.getByText(/slide margins/i)).toBeVisible()
  } finally {
    await context.close()
  }
})
