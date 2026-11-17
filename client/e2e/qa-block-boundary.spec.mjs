// Block-level error containment (from QA review r1 of W1-6). One malformed
// stored block (a chart whose `series` is null) must never blank the app, and
// once each block is wrapped it must not take the rest of its message down.
import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext } from './lib.mjs'

const fx = loadFixtures()

async function openWithBrokenChart(browser, baseURL) {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  const { s1 } = fx.ids
  const body = JSON.parse(fx.routes[`GET /api/sessions/${s1}/messages`].body)
  const assistant = body.messages.find((m) => m.role === 'assistant' && m.blocks?.length)
  assistant.blocks[0].series = null
  await page.route(`**/api/sessions/${s1}/messages`, (route) => route.fulfill({ json: body }))
  await page.goto(`${baseURL}/#/chat/${s1}`)
  return { ctx, page }
}

test('a malformed block becomes an inline card and the app keeps working', async ({ browser, baseURL }) => {
  const { ctx, page } = await openWithBrokenChart(browser, baseURL)
  // message-level card today; block-level card once W1-8 wraps each block
  await expect(page.getByRole('alert').filter({ hasText: /Could not display this (message|part of the message)\./ }).first()).toBeVisible()
  await expect(page.locator('textarea').first()).toBeVisible()
  await expect(page.locator('main header button[aria-label="Settings"]')).toBeVisible()
  await ctx.close()
})

// Message.jsx wraps each block renderer in <BlockErrorBoundary> from
// client/src/app/ErrorBoundary.jsx, so the failing chart becomes a block card
// while the prose and the other blocks of the same message keep rendering.
test('a malformed block is isolated without dropping its message siblings', async ({ browser, baseURL }) => {
  const { ctx, page } = await openWithBrokenChart(browser, baseURL)
  const card = page.getByRole('alert').filter({ hasText: 'Could not display this part of the message.' })
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-block-type', 'chart')
  await expect(page.getByRole('alert').filter({ hasText: 'Could not display this message.' })).toHaveCount(0)
  await expect(page.getByText('Q3 revenue grew', { exact: false })).toBeVisible()
  // the sibling table block still renders (the chart's own title goes with the chart)
  await expect(page.getByText('QoQ change by region', { exact: true })).toBeVisible()
  await ctx.close()
})
