// User flows on the built client with /api/* from fixtures and the three turn
// routes fed by the fetch shim (real SSE event shapes). Each test also fails
// on an uncaught page error, so a white screen cannot pass silently.
import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext, SCREENS } from './lib.mjs'

const { ids } = loadFixtures()

async function open(browser, variant = { theme: 'dark', mobile: false }) {
  const ctx = await newVariantContext(browser, variant)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  return { ctx, page, errors }
}

test('a new chat streams reasoning and the answer into the thread', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  await SCREENS.welcome(page, baseURL, ids)
  await page.locator('textarea').first().fill('How many rows landed yesterday?')
  await page.locator('button[title="Send"]').click()
  await page.waitForFunction(() => !!window.__sse)
  await page.evaluate((sid) => {
    const s = window.__sse
    s.push({ type: 'meta', sessionId: sid, isNew: true })
    s.push({ type: 'reasoning', value: 'Checking the ingestion audit table first.' })
    s.push({ type: 'token', value: 'Yesterday the pipeline loaded **1.20M rows**' })
    s.push({ type: 'token', value: ' into `bronze_events`.' })
  }, ids.s2)
  await expect(page.getByText('1.20M rows')).toBeVisible()
  await expect(page.getByText('How many rows landed yesterday?').first()).toBeVisible()
  await page.evaluate(() => {
    window.__sse.push({ type: 'done' })
    window.__sse.end()
  })
  expect(errors).toEqual([])
  await ctx.close()
})

test('an HTTP 500 on send surfaces the gateway error to the user', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  await SCREENS.welcome(page, baseURL, ids)
  await page.evaluate(() => {
    window.__sseMode = 'http500'
  })
  await page.locator('textarea').first().fill('Hello')
  await page.locator('button[title="Send"]').click()
  // friendly copy inline, the raw gateway text one click away under Details
  const card = page.getByRole('alert').filter({ hasText: 'This answer could not be generated.' })
  await expect(card).toBeVisible()
  await expect(card.getByText('The service is temporarily unavailable.', { exact: false })).toBeVisible()
  await card.getByText('Details').click()
  await expect(card.getByText(/upstream model temporarily unavailable/)).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('settings opens on Preferences', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  await SCREENS['settings-preferences'](page, baseURL, ids)
  await expect(page.getByRole('button', { name: 'Preferences', exact: true }).first()).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('the deck card opens the Slides Studio with the slide preview', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  await SCREENS['deck-studio'](page, baseURL, ids)
  await expect(page.locator('iframe').first()).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('history lists the seeded conversations on mobile', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, { theme: 'light', mobile: true })
  await page.goto(`${baseURL}/#/history`)
  await expect(page.getByText('Fix flaky pytest in ingestion job').first()).toBeVisible()
  await expect(page.getByText('Hiring plan Q1').first()).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('every request of the flows had a recorded fixture', async ({ baseURL }) => {
  const misses = await (await fetch(`${baseURL}/__fixtures/misses`)).json()
  expect(misses.map((m) => m.key)).toEqual([])
})
