import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext, SCREENS } from './lib.mjs'

const { ids } = loadFixtures()

test('sidebar spend exposes an error state when the usage summary fails', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  await page.route(/\/api\/usage\/summary$/, (r) =>
    r.fulfill({ status: 503, json: { error: 'temporarily unavailable' } }),
  )
  await SCREENS.welcome(page, baseURL, ids)
  const spend = page.locator('#app-sidebar').getByTestId('sidebar-spend')
  await expect(spend).toBeVisible()
  const error = spend.getByRole('status').or(spend.getByRole('alert'))
  await expect(error).toBeVisible()
  await expect(error).toContainText(/unavailable|failed|could not|unable/i)
  await ctx.close()
})

test('sidebar spend does not let an older request overwrite a newer refresh', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  const requests = []
  await page.route('**/api/usage/summary', (route) => requests.push(route))
  await page.goto(`${baseURL}/#/history`)
  await expect(page.getByText('Hiring plan Q1').first()).toBeVisible()
  // StrictMode runs the initial effect twice; both old responses stay pending.
  await expect.poll(() => requests.length).toBe(2)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => requests.length).toBe(3)

  const summary = (usd) => ({
    month: { start: '2026-11-01T00:00:00.000Z', resetsAt: '2026-12-01T00:00:00.000Z', timezone: 'UTC', usd, estimated: false, unpriced: false },
  })
  await requests[2].fulfill({ json: summary(2) })
  const spend = page.locator('#app-sidebar').getByTestId('sidebar-spend')
  await expect(spend).toContainText('$2.00')
  await requests[0].fulfill({ json: summary(1) })
  await requests[1].fulfill({ json: summary(1) })
  await page.waitForLoadState('networkidle')
  await expect(spend).toContainText('$2.00')
  await ctx.close()
})

test('on mobile the cost pill announces the active chat spend', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: true })
  const page = await ctx.newPage()
  await page.route(/\/api\/usage\/summary\?sessionId=25$/, (r) =>
    r.fulfill({
      json: {
        month: { start: '2026-11-01T00:00:00.000Z', resetsAt: '2026-12-01T00:00:00.000Z', timezone: 'UTC', usd: 9.99, estimated: false, unpriced: false },
        session: { id: '25', usd: 0.12, byKind: { chat: { usd: 0.12, calls: 1 } }, estimated: false, unpriced: false },
      },
    }),
  )
  await SCREENS['chat-rich'](page, baseURL, ids)
  const pill = page.locator('main header button[title^="Cost meter"]')
  await expect(pill).toHaveAccessibleName(/0\.12.*this chat/i)
  await ctx.close()
})

test('the single-tool composer glyph uses the accent token instead of a red raster', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: false })
  const page = await ctx.newPage()
  await SCREENS['chat-rich'](page, baseURL, ids)
  const glyph = page.locator('button:has(img[alt="Tools"]) img[alt="Tools"]')
  await expect(glyph).toBeVisible()
  const redPixels = await glyph.evaluate(async (img) => {
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let count = 0
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = data.slice(i, i + 4)
      if (a > 32 && r > 100 && r > g * 1.25 && r > b * 1.25) count++
    }
    return count
  })
  expect(redPixels).toBe(0)
  await ctx.close()
})
