// The three artifact studios (W2-8): one shared AI panel + export menu, dialog
// semantics, named ≥ 32 px toolbar targets, autosave status, delete-slide undo
// that is durable across a reload, keyboard (arrows change slide, Esc leaves
// edit mode before anything else), live "slide N" progress + completion, the
// spreadsheet preview of the W2-9 chart kinds, reduced motion and axe.
//
// The deck, spreadsheet and document endpoints are served from page.route
// (stateful where a PATCH must survive a reload), so nothing here reaches the
// fixture server without a recording.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { loadFixtures, newVariantContext, contextOptions, FETCH_SHIM, AXE_TAGS } from './lib.mjs'

const fx = loadFixtures()
const { ids } = fx
const DESKTOP = { theme: 'dark', mobile: false }
const MOBILE = { theme: 'light', mobile: true }

const sessionBlocks = JSON.parse(fx.routes[`GET /api/sessions/${ids.s1}/messages`].body).messages.find((m) => m.id === '60').blocks
const deckBlock = sessionBlocks.find((b) => b.type === 'deck-html')
const sheetBlock = sessionBlocks.find((b) => b.type === 'spreadsheet')
const docBlock = sessionBlocks.find((b) => b.type === 'document')

const SHEET = {
  id: ids.sheet,
  title: sheetBlock.title,
  sheets: [
    ...sheetBlock.sheets,
    {
      name: 'Analise',
      blocks: [
        { kind: 'title', text: 'Analise' },
        { kind: 'table', columns: [{ header: 'Ticket', format: 'number' }, { header: 'Margem', format: 'number' }, { header: 'Custo', format: 'number' }], rows: [[10, 2, 4], [20, 5, 6], [30, 7, 9], [40, 8, 12]] },
        { kind: 'table', columns: [{ header: 'Faixa', format: 'text' }, { header: 'Pedidos', format: 'integer' }], rows: [['0-10', 4], ['10-20', 9], ['20-30', 6]] },
      ],
      charts: [
        { kind: 'scatter', title: 'Ticket x margem', tableBlock: 1, categoryColumn: 0, valueColumns: [1] },
        { kind: 'histogram', title: 'Pedidos por faixa', tableBlock: 2, categoryColumn: 0, valueColumns: [1] },
        { kind: 'heatmap', title: 'Mapa de custo', tableBlock: 1, categoryColumn: 0, valueColumns: [1, 2] },
      ],
    },
  ],
}

/** Serves the deck/spreadsheet/document endpoints; the deck keeps PATCHed state. */
async function routeArtifacts(ctx, state) {
  await ctx.route(`**/api/decks/${ids.deck}`, async (route) => {
    const req = route.request()
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON()
      state.deck = { ...state.deck, ...body }
      state.patches.push(body.slides.length)
      return route.fulfill({ json: { deck: state.deck } })
    }
    return route.fulfill({ json: { deck: state.deck } })
  })
  await ctx.route(`**/api/spreadsheets/${ids.sheet}`, (route) => route.fulfill({ json: { spreadsheet: SHEET } }))
  await ctx.route(`**/api/documents/${ids.doc}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON()
      state.doc = { ...state.doc, ...body }
      return route.fulfill({ json: { document: state.doc } })
    }
    return route.fulfill({ json: { document: state.doc } })
  })
}

function freshState() {
  return {
    deck: { id: ids.deck, sessionId: ids.s1, title: deckBlock.title, slides: [...deckBlock.slides], format: 'html' },
    doc: { id: ids.doc, title: docBlock.title, markdown: docBlock.markdown },
    patches: [],
  }
}

async function open(browser, variant = DESKTOP, state = freshState(), { reducedMotion } = {}) {
  let ctx
  if (reducedMotion) {
    ctx = await browser.newContext({ ...contextOptions(variant), reducedMotion: 'reduce' })
    await ctx.addInitScript(FETCH_SHIM)
  } else ctx = await newVariantContext(browser, variant)
  await routeArtifacts(ctx, state)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  return { ctx, page, errors, state }
}

async function gotoChat(page, baseURL) {
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  await page.getByText('Open in Slides Studio').first().waitFor()
}

const STUDIO = { deck: '[data-studio="deck"]', sheet: '[data-studio="sheet"]', doc: '[data-studio="doc"]' }

async function openStudio(page, baseURL, kind) {
  await gotoChat(page, baseURL)
  const btn =
    kind === 'deck'
      ? page.getByText('Open in Slides Studio').first()
      : kind === 'sheet'
        ? page.getByRole('button', { name: 'Open studio' }).first()
        : page.getByRole('button', { name: 'Open', exact: true }).first()
  await btn.scrollIntoViewIfNeeded()
  await btn.click()
  const root = page.locator(STUDIO[kind])
  await root.waitFor()
  if (kind === 'deck') await root.locator('iframe').first().waitFor()
  await page.waitForTimeout(400) // the 250 ms fade-in
  return root
}

for (const variant of [DESKTOP, MOBILE]) {
  const v = variant.mobile ? 'mobile' : 'desktop'

  test(`one shared AI panel and export menu in the three studios (${v})`, async ({ browser, baseURL }) => {
    const { ctx, page, errors } = await open(browser, variant)
    for (const [kind, items] of [['deck', 2], ['sheet', 1], ['doc', 3]]) {
      const root = await openStudio(page, baseURL, kind)
      const panel = root.locator('[data-studio-ai-panel]')
      await expect(panel).toHaveCount(1)
      await expect(panel.getByRole('heading', { name: 'Edit with AI' })).toBeVisible()
      await expect(panel.getByRole('textbox')).toBeVisible()
      await expect(panel.getByRole('button', { name: /Apply/ })).toBeVisible()
      const exp = root.locator('[data-studio-export]')
      await expect(exp).toHaveCount(1)
      await expect(exp).toHaveAttribute('aria-haspopup', 'menu')
      await exp.click()
      const menu = page.getByRole('menu')
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitem')).toHaveCount(items)
      await expect(menu.getByRole('menuitem').first()).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
      await expect(exp).toBeFocused()
      await expect(root).toBeVisible() // Esc closed the menu, not the studio
      await root.locator('[data-studio-close]').click()
      await expect(root).toBeHidden()
    }
    expect(errors).toEqual([])
    await ctx.close()
  })

  test(`studios are named dialogs with named targets of at least 32 px (${v})`, async ({ browser, baseURL }) => {
    const { ctx, page, errors } = await open(browser, variant)
    for (const kind of ['deck', 'sheet', 'doc']) {
      const root = await openStudio(page, baseURL, kind)
      if (kind !== 'deck' || variant.mobile) {
        await expect(root).toHaveAttribute('role', 'dialog')
        await expect(root).toHaveAttribute('aria-modal', 'true')
      }
      const name = kind === 'deck' ? deckBlock.title : kind === 'sheet' ? SHEET.title : docBlock.title
      await expect(root).toHaveAccessibleName(name)
      await expect(root.locator('[data-studio-close]')).toHaveAccessibleName(variant.mobile ? 'Back' : 'Close')
      const small = await root.locator('header').evaluate((h) =>
        [...h.querySelectorAll('button')]
          .filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden')
          .map((b) => ({ name: b.getAttribute('aria-label') || b.textContent.trim(), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height }))
          .filter((b) => b.w < 32 || b.h < 32 || !b.name),
      )
      expect(small, `${kind} header targets`).toEqual([])
      await root.locator('[data-studio-close]').click()
      await expect(root).toBeHidden()
    }
    expect(errors).toEqual([])
    await ctx.close()
  })

  test(`axe is clean on the three studios (${v})`, async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, variant)
    const found = {}
    for (const kind of ['deck', 'sheet', 'doc']) {
      const root = await openStudio(page, baseURL, kind)
      // excluded: the slide iframes (model-authored HTML) and the spreadsheet
      // "paper" — a faithful preview of the workbook's design-system fills and
      // fonts, i.e. data (the same colours the .xlsx exports); see the PR notes
      // on shared/deckTheme contrastOn for the root cause of its contrast gaps
      const res = await new AxeBuilder({ page }).include(STUDIO[kind]).exclude('iframe').exclude('[data-ds-paper]').withTags(AXE_TAGS).analyze()
      found[kind] = res.violations.map((x) => `${x.id} (${x.nodes.length}): ${x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`)
      await root.locator('[data-studio-close]').click()
      await expect(root).toBeHidden()
    }
    expect(found).toEqual({ deck: [], sheet: [], doc: [] })
    await ctx.close()
  })
}

test('mobile: the browser Back leaves a studio instead of the app', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, MOBILE)
  const root = await openStudio(page, baseURL, 'sheet')
  await page.goBack()
  await expect(root).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s1}$`))
  expect(errors).toEqual([])
  await ctx.close()
})

test('deck: the title wraps on phones and the stage keeps the native 1280x720 frame', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, MOBILE)
  const root = await openStudio(page, baseURL, 'deck')
  const title = root.getByRole('textbox', { name: 'Presentation title' })
  // a title too long for one line wraps to two (not "Q3 FY…"), and no further
  await title.fill('Q3 FY26 Exec Review for the board and the regional leads')
  const box = await title.evaluate((el) => ({ lines: Math.round((el.clientHeight - 4) / parseFloat(getComputedStyle(el).lineHeight)), clipsX: el.scrollWidth > el.clientWidth }))
  expect(box).toEqual({ lines: 2, clipsX: false })
  const frame = root.locator('[data-deck-stage] iframe')
  expect(await frame.evaluate((f) => [f.style.width, f.style.height, /^scale\(/.test(f.style.transform)])).toEqual(['1280px', '720px', true])
  await ctx.close()
})

test('deck: delete slide is set apart, undo restores it and survives a reload (AC-S1)', async ({ browser, baseURL }) => {
  const { ctx, page, errors, state } = await open(browser, DESKTOP)
  let root = await openStudio(page, baseURL, 'deck')
  const del = root.getByRole('button', { name: 'Delete slide' })
  // ux#29: a divider sits right before it
  expect(await del.evaluate((b) => b.previousElementSibling?.getAttribute('role'))).toBe('separator')
  await root.getByRole('button', { name: 'Slide 2', exact: true }).click()
  await del.click()
  await expect(page.locator('[role="alertdialog"]')).toHaveCount(0) // undo instead of a confirm
  const snack = page.locator('[data-studio-snackbar]')
  await expect(snack).toContainText('Slide 2 deleted')
  await expect.poll(() => state.patches.at(-1)).toBe(2)
  await expect(root.locator('[data-save-status="saved"]')).toBeVisible()

  // reload: the deletion persisted AND the undo is still offered
  await page.reload()
  root = await openStudio(page, baseURL, 'deck')
  await expect(root.getByRole('button', { name: /^Slide \d$/ })).toHaveCount(2)
  await expect(page.locator('[data-studio-snackbar]')).toContainText('Slide 2 deleted')
  await page.locator('[data-studio-snackbar]').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => state.patches.at(-1)).toBe(3)
  expect(state.deck.slides[1]).toContain('Where the growth came from')

  // and the restored slide is what a fresh load shows; no stale undo is offered
  await page.reload()
  root = await openStudio(page, baseURL, 'deck')
  await expect(root.getByRole('button', { name: /^Slide \d$/ })).toHaveCount(3)
  await expect(page.locator('[data-studio-snackbar]')).toHaveCount(0)
  expect(errors).toEqual([])
  await ctx.close()
})

test('deck: a failed autosave stays visible with Retry', async ({ browser, baseURL }) => {
  const { ctx, page, state } = await open(browser, DESKTOP)
  let fail = true
  await ctx.route(`**/api/decks/${ids.deck}`, async (route) => {
    if (route.request().method() === 'PATCH' && fail) return route.fulfill({ status: 500, json: { error: 'database unavailable' } })
    return route.fallback()
  })
  const root = await openStudio(page, baseURL, 'deck')
  await root.getByRole('textbox', { name: 'Speaker notes' }).fill('Open with the LATAM story')
  await expect(root.locator('[data-save-status="error"]')).toContainText("Couldn't save")
  fail = false
  await root.locator('[data-save-status="error"]').getByRole('button', { name: 'Retry' }).click()
  await expect(root.locator('[data-save-status="saved"]')).toBeVisible()
  expect(state.patches.length).toBeGreaterThan(0)
  await ctx.close()
})

test('deck: arrows change slide, but not while typing; Esc leaves edit mode before the studio', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP)
  const root = await openStudio(page, baseURL, 'deck')
  const thumb = (n) => root.getByRole('button', { name: `Slide ${n}`, exact: true })
  await expect(thumb(1)).toHaveAttribute('aria-current', 'true')
  await root.locator('[data-deck-stage]').click()
  await page.keyboard.press('ArrowRight')
  await expect(thumb(2)).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(thumb(1)).toHaveAttribute('aria-current', 'true')
  // typing in the notes or the AI box: arrows move the caret, not the slide
  await root.getByRole('textbox', { name: 'Speaker notes' }).click()
  await page.keyboard.press('ArrowRight')
  await expect(thumb(1)).toHaveAttribute('aria-current', 'true')

  await root.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(root.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
  // Esc in the AI box only leaves the box
  await root.locator('[data-studio-ai-panel] textarea').click()
  await page.keyboard.press('Escape')
  await expect(root.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
  // the next Esc leaves edit mode (nothing changed, so no confirmation) and the studio stays
  await page.keyboard.press('Escape')
  await expect(root.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  await expect(root).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('deck: a live stream shows slide progress, then a completion state', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP)
  await page.goto(`${baseURL}/#/chat`)
  await page.locator('textarea').first().fill('Build a 3-slide exec deck')
  await page.locator('button[title="Send"]').click()
  await page.waitForFunction(() => !!window.__sse)
  await page.evaluate((sid) => {
    window.__sse.push({ type: 'meta', sessionId: sid, isNew: true })
    window.__sse.push({ type: 'deck_stream_start', title: 'Q3 FY26 Exec Review', total: 3 })
  }, ids.s1)
  const root = page.locator(STUDIO.deck)
  const progress = root.getByRole('progressbar')
  await expect(progress).toContainText('slide 1 of 3')
  await page.evaluate((html) => window.__sse.push({ type: 'deck_slide', index: 0, html }), deckBlock.slides[0])
  await expect(progress).toContainText('slide 2 of 3')
  await expect(progress).toHaveAttribute('aria-valuenow', '1')
  await page.evaluate((blk) => {
    window.__sse.push({ type: 'deck_slide', index: 1, html: blk.slides[1] })
    window.__sse.push({ type: 'deck_slide', index: 2, html: blk.slides[2] })
    window.__sse.push({ type: 'blocks', content: '{{block:0}}', blocks: [blk] })
    window.__sse.push({ type: 'done' })
    window.__sse.end()
  }, deckBlock)
  await expect(root.getByRole('status').filter({ hasText: 'Deck ready' })).toContainText('3 slides')
  await expect(progress).toHaveCount(0)
  expect(errors).toEqual([])
  await ctx.close()
})

test('deck: a stream without a known total still counts the slide being built', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, DESKTOP)
  await page.goto(`${baseURL}/#/chat`)
  await page.locator('textarea').first().fill('Build a deck')
  await page.locator('button[title="Send"]').click()
  await page.waitForFunction(() => !!window.__sse)
  await page.evaluate((sid) => {
    window.__sse.push({ type: 'meta', sessionId: sid, isNew: true })
    window.__sse.push({ type: 'deck_stream_start', title: 'Deck' })
  }, ids.s1)
  await expect(page.locator(STUDIO.deck).getByRole('progressbar')).toContainText('Building slide 1')
  await ctx.close()
})

test('document: Esc leaves hand-editing first; unsaved changes ask before they are dropped', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP)
  const root = await openStudio(page, baseURL, 'doc')
  await root.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = root.getByRole('textbox', { name: 'Document text editor' })
  await editor.click()
  await page.keyboard.type(' More.')
  await page.keyboard.press('Escape')
  const dlg = page.getByRole('alertdialog')
  await expect(dlg).toBeVisible()
  await page.keyboard.press('Escape') // cancel keeps the edit
  await expect(dlg).toBeHidden()
  await expect(editor).toBeVisible()
  await page.keyboard.press('Escape')
  await dlg.getByRole('button', { name: 'Discard changes' }).click()
  await expect(editor).toBeHidden()
  await expect(root).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('spreadsheet: the chart preview draws scatter, histogram and heatmap', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP)
  const root = await openStudio(page, baseURL, 'sheet')
  await root.getByRole('tab', { name: 'Analise' }).click()
  await root.getByRole('button', { name: /3 charts/ }).click()
  for (const kind of ['scatter', 'histogram', 'heatmap']) await expect(root.locator(`[data-chart-type="${kind}"]`)).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('reduced motion: the studios do not animate in', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, DESKTOP, freshState(), { reducedMotion: true })
  const root = await openStudio(page, baseURL, 'sheet')
  expect(await root.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
  await ctx.close()
})
