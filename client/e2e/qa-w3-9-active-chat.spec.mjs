import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext } from './lib.mjs'

const { ids, routes } = loadFixtures()
const blocks = JSON.parse(routes[`GET /api/sessions/${ids.s1}/messages`].body).messages.find((m) => m.id === '60').blocks
const deckBlock = blocks.find((b) => b.type === 'deck-html')

test('reselecting the current chat does not ask to close its dirty studio', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  const deck = { id: ids.deck, sessionId: ids.s1, title: deckBlock.title, slides: [...deckBlock.slides], format: 'html' }
  await ctx.route(`**/api/decks/${ids.deck}`, (route) => route.fulfill({ json: { deck } }))

  await page.goto(`${baseURL}/#/chat/${ids.s1}`, { waitUntil: 'domcontentloaded' })
  await page.getByText('Open in Slides Studio').first().click()
  const studio = page.locator('[data-studio="deck"]')
  await expect(studio).toBeVisible()
  await studio.getByRole('button', { name: 'Edit', exact: true }).click()
  await studio.getByRole('button', { name: 'Add slide' }).click()
  await expect(studio).toHaveAttribute('data-studio-dirty', '')

  const expand = page.getByRole('button', { name: 'Expand sidebar' })
  if (await expand.isVisible()) await expand.click()
  await page.getByRole('navigation', { name: 'Conversations' })
    .getByRole('button', { name: 'Q3 revenue by region — analysis', exact: true }).click()

  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s1}$`))
  await expect(studio).toBeVisible()
  await expect(studio).toHaveAttribute('data-studio-dirty', '')
  await ctx.close()
})
