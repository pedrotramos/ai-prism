// QA-only regression probe. This file is not part of the reviewed PR snapshot.
import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext } from './lib.mjs'

const fx = loadFixtures()

test('a malformed block is isolated without dropping its message siblings', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  const { s1 } = fx.ids
  const body = JSON.parse(fx.routes[`GET /api/sessions/${s1}/messages`].body)
  const assistant = body.messages.find((m) => m.role === 'assistant' && m.blocks?.length)
  assistant.blocks[0].series = null
  await page.route(`**/api/sessions/${s1}/messages`, (route) => route.fulfill({ json: body }))
  await page.goto(`${baseURL}/#/chat/${s1}`)

  await expect(page.getByRole('alert').filter({ hasText: 'Could not display this message.' })).toBeVisible()
  await expect(page.getByText('Q3 revenue grew', { exact: false })).toBeVisible()
  await expect(page.getByText('Revenue by region, $M (Q2 vs Q3)', { exact: true })).toBeVisible()
  await ctx.close()
})
