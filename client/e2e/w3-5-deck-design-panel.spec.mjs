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
    // Focus inside a sandboxed iframe never matches :focus-visible on the iframe
    // element, so the preview's keyboard stop (and its ring) is the wrapper.
    const preview = studio.locator('[data-slide-preview]').first()
    await expect(preview).toBeVisible()
    let focused = false
    for (let i = 0; i < 40 && !focused; i++) {
      await page.keyboard.press('Tab')
      focused = await preview.evaluate((el) => document.activeElement === el)
    }
    expect(focused).toBe(true)
    const style = await preview.evaluate((el) => ({ focusVisible: el.matches(':focus-visible'), outlineStyle: getComputedStyle(el).outlineStyle, outlineWidth: getComputedStyle(el).outlineWidth }))
    expect(style).toEqual({ focusVisible: true, outlineStyle: 'solid', outlineWidth: '2px' })
    // nothing else inside the preview is a stop of its own: Tab leaves it
    await page.keyboard.press('Tab')
    expect(await preview.evaluate((el) => el.contains(document.activeElement))).toBe(false)
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

// ---- behaviour of the slide-level controls (stateful deck endpoint) ----
const blocks = JSON.parse(fixtures.routes[`GET /api/sessions/${ids.s1}/messages`].body).messages.find((m) => m.id === '60').blocks
const deckBlock = blocks.find((b) => b.type === 'deck-html')

async function openEditor(browser, baseURL) {
  const state = { deck: { id: ids.deck, sessionId: ids.s1, title: deckBlock.title, slides: [...deckBlock.slides], format: 'html' }, patches: [] }
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: false })
  await ctx.route(`**/api/decks/${ids.deck}`, async (route) => {
    const req = route.request()
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON()
      state.deck = { ...state.deck, ...body }
      state.patches.push(body.slides)
      return route.fulfill({ json: { deck: state.deck } })
    }
    return route.fulfill({ json: { deck: state.deck } })
  })
  const page = await ctx.newPage()
  const studio = await openDeck(page, baseURL)
  await studio.getByRole('button', { name: 'Edit', exact: true }).click()
  const design = studio.locator('[data-slide-design]')
  await expect(design).toBeVisible()
  return { ctx, page, studio, design, state }
}
const rootStyle = (studio) => studio.locator('iframe[title]').first().contentFrame().locator('section').first()
const save = async (studio) => studio.getByRole('button', { name: 'Save', exact: true }).click()

test('slide Design panel: swatches come from the active DS and the background is undoable and survives Save + reload', async ({ browser, baseURL }) => {
  const { ctx, page, studio, design, state } = await openEditor(browser, baseURL)
  try {
    await expect(design.getByRole('heading', { name: 'Slide 1' })).toBeVisible()
    // the fixture DS declares these four brand colours and nothing else
    await expect(design.getByRole('button', { name: /^(background|primary|secondary|accent)$/ })).toHaveCount(4)
    const before = await rootStyle(studio).evaluate((el) => getComputedStyle(el).backgroundColor)
    await design.getByRole('button', { name: 'background', exact: true }).click() // #F9F7F4
    await expect.poll(() => rootStyle(studio).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(249, 247, 244)')
    await expect(design.getByRole('button', { name: 'background', exact: true })).toHaveAttribute('aria-pressed', 'true')

    await studio.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => rootStyle(studio).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(before)
    await studio.getByRole('button', { name: 'Redo', exact: true }).click()
    await expect.poll(() => rootStyle(studio).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(249, 247, 244)')

    await save(studio)
    await expect.poll(() => state.patches.length).toBeGreaterThan(0)
    expect(state.patches.at(-1)[0]).toMatch(/background:\s*(#F9F7F4|rgb\(249, 247, 244\))/i)
    await page.reload()
    const again = await (async () => {
      const s = page.locator('[data-studio="deck"]')
      if (!(await s.isVisible().catch(() => false))) {
        await page.locator('[data-artifact-card="deck"] [data-card-primary]').first().click()
      }
      return s
    })()
    await expect(again).toBeVisible()
    await expect.poll(() => again.locator('iframe[title]').first().contentFrame().locator('section').first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(249, 247, 244)')
  } finally {
    await ctx.close()
  }
})

test('slide Design panel: margins write the slide padding', async ({ browser, baseURL }) => {
  const { ctx, studio, design } = await openEditor(browser, baseURL)
  try {
    const top = design.getByLabel('Top', { exact: true })
    await expect(top).toHaveValue('96px') // the fixture slide 1 is padding:96px, shown as authored
    await top.fill('40')
    await expect.poll(() => rootStyle(studio).evaluate((el) => getComputedStyle(el).paddingTop)).toBe('40px')
    expect(await rootStyle(studio).evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('96px') // the other sides are kept
    await design.getByLabel('Left', { exact: true }).fill('52')
    await expect.poll(() => rootStyle(studio).evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('52px')
    expect(await rootStyle(studio).evaluate((el) => el.getAttribute('style'))).toContain('padding: 40px 96px 96px 52px')
  } finally {
    await ctx.close()
  }
})

test('slide Design panel: the grid is an editor-only overlay that never touches the slide HTML', async ({ browser, baseURL }) => {
  const { ctx, studio, design, state } = await openEditor(browser, baseURL)
  try {
    await expect(studio.locator('[data-slide-grid]')).toHaveCount(0) // off by default
    const htmlBefore = await rootStyle(studio).evaluate((el) => el.outerHTML)
    await design.getByRole('switch', { name: 'Grid' }).click()
    const grid = studio.locator('[data-slide-grid]')
    await expect(grid).toBeVisible()
    await expect(grid.locator('rect')).toHaveCount(12)
    await design.getByLabel('Columns').fill('6')
    await expect(grid.locator('rect')).toHaveCount(6)
    expect(await rootStyle(studio).evaluate((el) => el.outerHTML)).toBe(htmlBefore) // the slide DOM is untouched
    await expect(studio.getByRole('button', { name: 'Save', exact: true })).toBeDisabled() // not a change to the deck
    expect(state.patches).toHaveLength(0)
    await design.getByRole('switch', { name: 'Grid' }).click()
    await expect(studio.locator('[data-slide-grid]')).toHaveCount(0)
  } finally {
    await ctx.close()
  }
})

// ---- QA r1 blocking 1: editing one margin must not rewrite the untouched sides ----
async function openWithPadding(browser, baseURL, padding) {
  const state = {
    deck: { id: ids.deck, sessionId: ids.s1, title: deckBlock.title, slides: [deckBlock.slides[0].replace('padding:96px', `padding:${padding}`)], format: 'html' },
    patches: [],
  }
  const ctx = await newVariantContext(browser, { theme: 'light', mobile: false })
  await ctx.route(`**/api/decks/${ids.deck}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON()
      state.deck = { ...state.deck, ...body }
      state.patches.push(body.slides)
    }
    return route.fulfill({ json: { deck: state.deck } })
  })
  const page = await ctx.newPage()
  const studio = await openDeck(page, baseURL)
  await studio.getByRole('button', { name: 'Edit', exact: true }).click()
  const design = studio.locator('[data-slide-design]')
  await expect(design).toBeVisible()
  return { ctx, studio, design, state }
}

test('editing one slide margin keeps the untouched sides in their own CSS units', async ({ browser, baseURL }) => {
  const { ctx, studio, design } = await openWithPadding(browser, baseURL, '2rem 3rem 4rem 5rem')
  try {
    const frameRoot = rootStyle(studio)
    await expect.poll(() => frameRoot.evaluate((el) => getComputedStyle(el).paddingRight)).toBe('48px')
    await design.getByLabel('Top', { exact: true }).fill('40')
    await expect.poll(() => frameRoot.evaluate((el) => getComputedStyle(el).paddingTop)).toBe('40px')
    expect(await frameRoot.evaluate((el) => getComputedStyle(el).paddingRight)).toBe('48px')
    expect(await frameRoot.evaluate((el) => getComputedStyle(el).paddingBottom)).toBe('64px')
    expect(await frameRoot.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('80px')
    // the stored CSS still says rem for the sides nobody touched
    const style = await frameRoot.evaluate((el) => el.getAttribute('style'))
    expect(style).toMatch(/3rem/)
    expect(style).toMatch(/4rem/)
    expect(style).toMatch(/5rem/)
    // the panel shows the original value, unit included
    await expect(design.getByLabel('Right', { exact: true })).toHaveValue('3rem')
  } finally {
    await ctx.close()
  }
})

test('percent and calc() margins survive an edit of another side, and one edit is one undo step', async ({ browser, baseURL }) => {
  const { ctx, studio, design } = await openWithPadding(browser, baseURL, '2rem 10% calc(1rem + 4px) 5em')
  try {
    const frameRoot = rootStyle(studio)
    await design.getByLabel('Left', { exact: true }).fill('52')
    await expect.poll(() => frameRoot.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('52px')
    const style = await frameRoot.evaluate((el) => el.getAttribute('style'))
    expect(style).toMatch(/10%/)
    expect(style).toMatch(/calc\(1rem \+ 4px\)/)
    expect(style).toMatch(/2rem/)
    // a unit typed by the user is written as typed
    await design.getByLabel('Top', { exact: true }).fill('3rem')
    await expect.poll(() => frameRoot.evaluate((el) => getComputedStyle(el).paddingTop)).toBe('48px')
    // one edit = one undo step
    await studio.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => frameRoot.evaluate((el) => getComputedStyle(el).paddingTop)).toBe('32px')
    expect(await frameRoot.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('52px')
    await studio.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => frameRoot.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('80px')
  } finally {
    await ctx.close()
  }
})
