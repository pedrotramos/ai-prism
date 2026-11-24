import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { loadFixtures, newVariantContext, AXE_TAGS } from './lib.mjs'

const fx = loadFixtures()
const { ids } = fx
const blocks = JSON.parse(fx.routes[`GET /api/sessions/${ids.s1}/messages`].body).messages.find((m) => m.id === '60').blocks
const deckBlock = blocks.find((b) => b.type === 'deck-html')

function freshDeck() {
  return {
    id: ids.deck,
    sessionId: ids.s1,
    title: deckBlock.title,
    slides: JSON.parse(JSON.stringify(deckBlock.slides)),
    format: 'html',
  }
}

async function openDeck(browser, baseURL, { theme = 'dark', width = 1440, height = 900, expanded = true, reducedMotion = false, patchFails = false, fakeClock = false } = {}) {
  const ctx = await newVariantContext(browser, { theme, mobile: false })
  if (!expanded) await ctx.addInitScript(() => localStorage.setItem('prism-deck-focus', '0'))
  const state = { deck: freshDeck(), patches: [], tweaks: [] }
  await ctx.route(`**/api/decks/${ids.deck}`, async (route) => {
    const request = route.request()
    if (request.method() === 'PATCH') {
      if (patchFails) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'save_failed' }) })
      const body = request.postDataJSON()
      state.deck = { ...state.deck, ...body }
      state.patches.push(body)
      return route.fulfill({ json: { deck: state.deck } })
    }
    return route.fulfill({ json: { deck: state.deck } })
  })
  await ctx.route(`**/api/decks/${ids.deck}/tweak`, async (route) => {
    const body = route.request().postDataJSON()
    state.tweaks.push(body)
    return route.fulfill({ json: { deck: state.deck, usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'fixture' } })
  })
  const page = await ctx.newPage()
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' })
  if (fakeClock) await page.clock.install()
  await page.setViewportSize({ width, height })
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  const opener = page.getByText('Open in Slides Studio').first()
  await opener.waitFor()
  await opener.click()
  const root = page.locator('[data-studio="deck"]')
  await root.waitFor()
  await root.locator('iframe').first().waitFor()
  return { ctx, page, root, opener, state }
}

for (const theme of ['light', 'dark']) {
  test(`W1-5 QA: Retry uses the ink action colors in ${theme}`, async ({ browser, baseURL }) => {
    const { ctx, page, root } = await openDeck(browser, baseURL, { theme, patchFails: true })
    try {
      await root.getByRole('textbox', { name: 'Speaker notes' }).fill('force save failure')
      const retry = root.getByRole('button', { name: 'Retry' })
      await expect(retry).toBeVisible()
      const expected = await page.evaluate(() => {
        const probe = document.createElement('i')
        probe.style.backgroundColor = 'var(--action)'
        probe.style.color = 'var(--on-action)'
        document.body.appendChild(probe)
        const s = getComputedStyle(probe)
        const colors = { bg: s.backgroundColor, fg: s.color }
        probe.remove()
        return colors
      })
      const actual = await retry.evaluate((el) => {
        const s = getComputedStyle(el)
        return { bg: s.backgroundColor, fg: s.color }
      })
      expect(actual).toEqual(expected)
    } finally {
      await ctx.close()
    }
  })
}

test('W1-5 QA: Escape closes the 1000 px modal panel and restores focus to its opener', async ({ browser, baseURL }) => {
  const { ctx, page, root, opener } = await openDeck(browser, baseURL, { width: 1000, height: 800 })
  try {
    await expect(root).toHaveAttribute('role', 'dialog')
    await page.keyboard.press('Escape')
    await expect(root).toBeHidden()
    // the opener's text sits in a <span> inside the card's button; focus returns to that button
    await expect(opener.locator('xpath=ancestor-or-self::button[1]')).toBeFocused()
  } finally {
    await ctx.close()
  }
})

test('W1-5 QA: a modal overlay makes the background chat unavailable', async ({ browser, baseURL }) => {
  test.setTimeout(20000)
  const { ctx, page, root } = await openDeck(browser, baseURL, { width: 1000, height: 800, expanded: false })
  try {
    await expect(root).toHaveAttribute('aria-modal', 'true')
    const composer = page.locator('textarea[placeholder^="Ask something"]')
    await expect(composer).toBeVisible()
    // forced: an inert background cannot receive the click, which is the point (no actionability wait)
    await composer.click({ timeout: 3000, force: true })
    await expect(composer).not.toBeFocused()
  } finally {
    await ctx.close()
  }
})

test('W1-5 QA: ArrowRight in an expanded layer tree moves to its first child without changing slides', async ({ browser, baseURL }) => {
  const { ctx, page, root } = await openDeck(browser, baseURL)
  try {
    await root.getByRole('button', { name: 'Edit', exact: true }).click()
    const layersTab = root.getByRole('tab', { name: 'Layers' })
    await expect(layersTab).toBeVisible()
    await layersTab.click()
    const tree = root.getByRole('tree')
    const rows = tree.getByRole('treeitem')
    const activeSlide = root.locator('[data-deck-stage] iframe')
    const before = await activeSlide.getAttribute('title')
    await rows.first().focus()
    await page.keyboard.press('ArrowRight')
    await expect(activeSlide).toHaveAttribute('title', before)
    await expect(tree.getByRole('treeitem').nth(1)).toBeFocused()
  } finally {
    await ctx.close()
  }
})

test('W1-5 QA: the Layers panel is axe-clean in edit mode', async ({ browser, baseURL }) => {
  const { ctx, root, page } = await openDeck(browser, baseURL)
  try {
    await root.getByRole('button', { name: 'Edit', exact: true }).click()
    const layersTab = root.getByRole('tab', { name: 'Layers' })
    await expect(layersTab).toBeVisible()
    await layersTab.click()
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  } finally {
    await ctx.close()
  }
})

test('W1-5: docked above 1100 px the panel is not modal: nothing is inert and Escape leaves it open', async ({ browser, baseURL }) => {
  const { ctx, page, root } = await openDeck(browser, baseURL, { expanded: false })
  try {
    await expect(root).not.toHaveAttribute('aria-modal', 'true')
    await expect(page.locator('[inert]')).toHaveCount(0)
    await root.locator('[data-deck-stage]').click()
    await page.keyboard.press('Escape')
    await expect(root).toBeVisible()
    // and once the overlay closes at 1000 px, the chat is usable again
    await page.setViewportSize({ width: 1000, height: 800 })
    await expect(root).toHaveAttribute('aria-modal', 'true')
    await page.keyboard.press('Escape')
    await expect(root).toBeHidden()
    await expect(page.locator('[inert]')).toHaveCount(0)
  } finally {
    await ctx.close()
  }
})
