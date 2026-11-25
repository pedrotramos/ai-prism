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
import { loadFixtures, newVariantContext, contextOptions, FETCH_SHIM, AXE_TAGS, sendPrompt } from './lib.mjs'

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

async function open(browser, variant = DESKTOP, state = freshState(), { reducedMotion, locale } = {}) {
  let ctx
  if (reducedMotion || locale) {
    ctx = await browser.newContext({ ...contextOptions(variant), ...(reducedMotion ? { reducedMotion: 'reduce' } : {}), ...(locale ? { locale } : {}) })
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
      // docked beside the chat (desktop) the panel is a named region; a modal dialog only where it covers the app
      if (variant.mobile) {
        await expect(root).toHaveAttribute('role', 'dialog')
        await expect(root).toHaveAttribute('aria-modal', 'true')
      } else {
        await expect(root).not.toHaveAttribute('role', 'dialog')
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

test('mobile: closing a studio from the UI leaves no dead history step and keeps the chat', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, MOBILE)
  const before = await page.evaluate(() => history.length)
  const root = await openStudio(page, baseURL, 'sheet')
  await root.locator('[data-studio-close]').click()
  await expect(root).toBeHidden()
  await expect.poll(() => page.evaluate(() => history.state?.prismStudio ?? null)).toBe(null)
  await expect(page).toHaveURL(new RegExp(`#/chat/${ids.s1}$`))
  await expect(page.getByText('Open in Slides Studio').first()).toBeVisible()
  // Back now goes where it went before the studio opened, not into a dead step
  expect(await page.evaluate(() => history.length)).toBeGreaterThanOrEqual(before)
  expect(errors).toEqual([])
  await ctx.close()
})

test('mobile: the system Back with unsaved edits asks, and keeps the work', async ({ browser, baseURL }) => {
  const { ctx, page, errors, state } = await open(browser, MOBILE)
  const root = await openStudio(page, baseURL, 'deck')
  await root.getByRole('button', { name: 'Edit', exact: true }).click()
  await root.getByRole('button', { name: 'Add slide' }).click() // an unsaved edit-mode change
  await expect(root.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  await page.evaluate(() => history.back()) // the system back gesture (goBack would wait for a load)
  const dlg = page.getByRole('alertdialog')
  await expect(dlg).toBeVisible()
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await expect(root).toBeVisible()
  await expect(root.getByRole('button', { name: /^Slide \d$/ })).toHaveCount(4) // the edit is still there
  // the next Back is caught too (the history entry was re-armed)
  await page.evaluate(() => history.back()) // the system back gesture (goBack would wait for a load)
  await expect(dlg).toBeVisible()
  await dlg.getByRole('button', { name: 'Save & close' }).click()
  await expect(root).toBeHidden()
  await expect.poll(() => state.patches.at(-1)).toBe(4)
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
  // polled: the field grows on the frame after the input, and the web fonts may still be swapping in under load
  await expect
    .poll(() => title.evaluate((el) => ({ lines: Math.round((el.clientHeight - parseFloat(getComputedStyle(el).paddingTop) - parseFloat(getComputedStyle(el).paddingBottom)) / parseFloat(getComputedStyle(el).lineHeight)), clipsX: el.scrollWidth > el.clientWidth })))
    .toEqual({ lines: 2, clipsX: false })
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
  const entries = await page.evaluate(() => history.length)
  await root.locator('[data-deck-stage]').click()
  await page.keyboard.press('ArrowRight')
  await expect(thumb(2)).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(thumb(3)).toHaveAttribute('aria-current', 'true')
  // a slide switch is a new frame, not a frame navigation: Back is not eaten by it
  expect(await page.evaluate(() => history.length)).toBe(entries)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(thumb(1)).toHaveAttribute('aria-current', 'true')
  // the scope radios own their arrows
  await root.locator('[data-studio-ai-panel] [role="radio"]').first().focus()
  await page.keyboard.press('ArrowRight')
  await expect(thumb(1)).toHaveAttribute('aria-current', 'true')
  // keys aimed at the chat beside the (desktop side-panel) deck stay with the chat
  await page.locator('textarea').first().focus()
  await page.evaluate(() => document.activeElement.blur())
  await page.keyboard.press('ArrowRight')
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
  await sendPrompt(page, 'Build a 3-slide exec deck')
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
  await sendPrompt(page, 'Build a deck')
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

test('AC-S1: a same-count external deck edit invalidates the undo offer', async ({ browser, baseURL }) => {
  const { ctx, page, state } = await open(browser, DESKTOP)
  let root = await openStudio(page, baseURL, 'deck')
  await root.getByRole('button', { name: 'Slide 2', exact: true }).click()
  await root.getByRole('button', { name: 'Delete slide' }).click()
  await expect.poll(() => state.patches.at(-1)).toBe(2)

  // Another tab edits the deck without changing its slide count.
  state.deck = { ...state.deck, title: 'Edited in another tab' }
  await page.reload()
  root = await openStudio(page, baseURL, 'deck')
  await expect(page.locator('[data-studio-snackbar]')).toHaveCount(0)
  await ctx.close()
})

test('AC-S1: the undo offer expires after 30 minutes while the studio stays open', async ({ browser, baseURL }) => {
  const { ctx, page, state } = await open(browser, DESKTOP)
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
  const root = await openStudio(page, baseURL, 'deck')
  await root.getByRole('button', { name: 'Delete slide' }).click()
  await expect.poll(() => state.patches.at(-1)).toBe(2)
  await expect(page.locator('[data-studio-snackbar]')).toBeVisible()
  await page.clock.fastForward(30 * 60 * 1000 + 1)
  await expect(page.locator('[data-studio-snackbar]')).toHaveCount(0)
  await ctx.close()
})

test('document: Retry saves edits made after a failed Save', async ({ browser, baseURL }) => {
  const { ctx, page, state } = await open(browser, DESKTOP)
  let fail = true
  await ctx.route(`**/api/documents/${ids.doc}`, async (route) => {
    if (route.request().method() === 'PATCH' && fail) {
      fail = false
      return route.fulfill({ status: 500, json: { error: 'database unavailable' } })
    }
    return route.fallback()
  })
  const root = await openStudio(page, baseURL, 'doc')
  await root.getByRole('button', { name: 'Edit', exact: true }).click()
  await root.getByRole('button', { name: 'Edit as Markdown' }).click()
  const editor = root.locator('#doc-studio-md')
  await editor.fill('first draft')
  await root.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(root.locator('[data-save-status="error"]')).toContainText("Couldn't save")

  await editor.fill('latest draft')
  await root.locator('[data-save-status="error"]').getByRole('button', { name: 'Retry' }).click()
  await expect.poll(() => state.doc.markdown).toBe('latest draft')
  await ctx.close()
})

test('deck: an older in-flight autosave cannot overwrite a newer edit', async ({ browser, baseURL }) => {
  const { ctx, page, state } = await open(browser, DESKTOP)
  let intercepted = 0
  let releaseFirst
  const firstRequest = new Promise((resolve) => { releaseFirst = resolve })
  await ctx.route(`**/api/decks/${ids.deck}`, async (route) => {
    const req = route.request()
    if (req.method() !== 'PATCH') return route.fallback()
    const body = req.postDataJSON()
    intercepted++
    if (intercepted === 1) await firstRequest
    state.deck = { ...state.deck, ...body }
    state.patches.push(body.slides.length)
    return route.fulfill({ json: { ok: true } })
  })
  const root = await openStudio(page, baseURL, 'deck')
  const notes = root.getByRole('textbox', { name: 'Speaker notes' })
  await notes.fill('first edit')
  await expect.poll(() => intercepted).toBe(1)
  await notes.fill('newer edit')
  // writes are serialized: the newer PATCH waits for the older one instead of
  // racing it (past the 500 ms debounce it would have been sent by now)
  await page.waitForTimeout(1200)
  expect(intercepted).toBe(1)
  await expect(root.locator('[data-save-status="saving"]')).toBeVisible()
  releaseFirst()
  await expect.poll(() => intercepted).toBe(2)
  // the newer content is what the server ends with, and only then "Saved"
  await expect.poll(() => state.deck.slides[0].notes).toBe('newer edit')
  await expect(root.locator('[data-save-status="saved"]')).toBeVisible()
  expect(state.deck.slides[0].notes).toBe('newer edit')
  await ctx.close()
})

test('document: Retry cannot save an AI preview after the user discarded it', async ({ browser, baseURL }) => {
  const { ctx, page, state } = await open(browser, DESKTOP)
  let fail = true
  await ctx.route(`**/api/documents/${ids.doc}/tweak`, (route) =>
    route.fulfill({ json: { document: { ...state.doc, markdown: 'AI draft' } } }),
  )
  await ctx.route(`**/api/documents/${ids.doc}`, async (route) => {
    if (route.request().method() === 'PATCH' && fail) {
      fail = false
      return route.fulfill({ status: 500, json: { error: 'database unavailable' } })
    }
    return route.fallback()
  })
  const original = state.doc.markdown
  const root = await openStudio(page, baseURL, 'doc')
  const panel = root.locator('[data-studio-ai-panel]')
  await panel.getByRole('textbox').fill('Rewrite this document')
  await panel.getByRole('button', { name: /Apply/ }).click()
  await panel.getByRole('button', { name: 'Accept & save' }).click()
  await expect(root.locator('[data-save-status="error"]')).toContainText("Couldn't save")
  let patchesAfterDiscard = 0
  page.on('request', (r) => r.method() === 'PATCH' && r.url().endsWith(`/api/documents/${ids.doc}`) && patchesAfterDiscard++)
  await panel.getByRole('button', { name: 'Discard' }).click()
  // the failed write was for text the user just threw away: the failure (and
  // its Retry) is gone, and nothing writes the AI draft afterwards
  await expect(root.locator('[data-save-status="error"]')).toHaveCount(0)
  await expect(root.getByRole('button', { name: 'Retry' })).toHaveCount(0)
  await expect(root.getByText('AI draft')).toHaveCount(0)
  await page.waitForTimeout(800)
  expect(patchesAfterDiscard).toBe(0)
  expect(state.doc.markdown).toBe(original)
  await ctx.close()
})

// ---- W2-16: input budgets (9 MiB per speaker note, 4 attachments of 6 MiB) ----

const MiB = 1024 * 1024
const png = (name, bytes) => ({ name, mimeType: 'image/png', buffer: Buffer.alloc(bytes, 7) })

test('deck: a speaker note over 9 MiB is not uploaded; the limit is named, Retry is offered and the note stays editable (AC-6)', async ({ browser, baseURL }) => {
  const { ctx, page, state, errors } = await open(browser, DESKTOP)
  const root = await openStudio(page, baseURL, 'deck')
  const notes = root.getByRole('textbox', { name: 'Speaker notes' })
  await notes.fill('x'.repeat(9 * MiB + 1))
  const alert = root.locator('[data-deck-budget="note"]')
  await expect(alert).toHaveText('The speaker note on slide 1 is over the 9 MiB limit. Shorten it to save.')
  await expect(notes).toHaveAttribute('aria-invalid', 'true')
  const status = root.locator('[data-save-status="error"]')
  await expect(status).toContainText("Couldn't save")
  await expect(status.getByRole('button', { name: 'Retry' })).toBeVisible()
  expect(state.patches).toEqual([]) // refused before the upload
  // nothing was lost: the note is still there and editable; once it fits it saves
  expect((await notes.inputValue()).length).toBe(9 * MiB + 1)
  await notes.fill('Open with the LATAM story')
  await expect(alert).toHaveCount(0)
  await expect(root.locator('[data-save-status="saved"]')).toBeVisible()
  expect(state.deck.slides[0].notes).toBe('Open with the LATAM story')
  expect(errors).toEqual([])
  await ctx.close()
})

test('deck: a budget 413 from the server surfaces like a failed save, names the limit, and Retry saves once it fits', async ({ browser, baseURL }) => {
  const { ctx, page, state } = await open(browser, DESKTOP)
  let reject = true
  await ctx.route(`**/api/decks/${ids.deck}`, async (route) => {
    if (route.request().method() === 'PATCH' && reject) {
      return route.fulfill({ status: 413, json: { error: 'a nota do apresentador do slide 1 passa do limite de 9 MiB', code: 'deck_note_too_large', limit: 9437184, slide: 1 } })
    }
    return route.fallback()
  })
  const root = await openStudio(page, baseURL, 'deck')
  const notes = root.getByRole('textbox', { name: 'Speaker notes' })
  await notes.fill('Open with the LATAM story')
  const status = root.locator('[data-save-status="error"]')
  await expect(status).toContainText("Couldn't save")
  // the localized copy (not the server's pt-BR fallback) names the limit
  await expect(status.locator('[title]')).toHaveAttribute('title', 'The speaker note on slide 1 is over the 9 MiB limit. Shorten it to save.')
  await expect(notes).toHaveValue('Open with the LATAM story')
  reject = false
  await status.getByRole('button', { name: 'Retry' }).click()
  await expect(root.locator('[data-save-status="saved"]')).toBeVisible()
  expect(state.deck.slides[0].notes).toBe('Open with the LATAM story')
  await ctx.close()
})

test('deck: attachments over 6 MiB or past the 4th are refused with the limit named (AC-2, AC-6)', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, DESKTOP)
  const root = await openStudio(page, baseURL, 'deck')
  const input = root.locator('[data-studio-ai-panel] input[type="file"]')
  await input.setInputFiles([png('huge.png', 7 * MiB)])
  await expect(page.getByRole('alert')).toContainText('Not attached, over the 6 MiB limit: huge.png')
  await input.setInputFiles(['a', 'b', 'c', 'd', 'e'].map((n) => png(`${n}.png`, 64)))
  await expect(page.getByRole('alert')).toContainText('Not attached: an AI edit takes at most 4 images.')
  await ctx.close()
})

test('deck: an AI edit the server refuses over a budget keeps the instruction and says why', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, DESKTOP)
  let tweaks = 0
  await ctx.route(`**/api/decks/${ids.deck}/tweak`, (route) => {
    tweaks++
    return route.fulfill({ status: 413, json: { error: 'a imagem 1 passa do limite de 6 MiB', code: 'deck_image_too_large', limit: 6291456, image: 1 } })
  })
  const root = await openStudio(page, baseURL, 'deck')
  const panel = root.locator('[data-studio-ai-panel]')
  await panel.getByRole('textbox').fill('Use this photo as the background')
  await panel.getByRole('button', { name: /Apply/ }).click()
  await expect(page.getByRole('alert')).toContainText('Image 1 is over the 6 MiB limit for an AI edit. Remove it or attach a smaller one.')
  await expect(panel.getByRole('textbox')).toHaveValue('Use this photo as the background')
  expect(tweaks).toBe(1)
  await ctx.close()
})

test('deck: simultaneous image batches report attachments that exceed the shared 4-image limit (AC-6)', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, DESKTOP)
  const root = await openStudio(page, baseURL, 'deck')
  const input = root.locator('[data-studio-ai-panel] input[type="file"]')
  const first = [0, 1, 2].map((n) => png(`first-${n}.png`, 3 * MiB))
  const second = [0, 1, 2].map((n) => png(`second-${n}.png`, 3 * MiB))
  // Both handler calls run before FileReader resolves and React commits the
  // first batch, so each pre-check sees zero attached images.
  await Promise.all([input.setInputFiles(first), input.setInputFiles(second)])
  await expect(root.locator('[data-studio-ai-panel] img[alt]')).toHaveCount(4)
  await expect(page.getByRole('alert')).toContainText('Not attached: an AI edit takes at most 4 images.')
  await ctx.close()
})

test('deck: removing an attachment frees its slot; the next one attaches without an overflow notice (AC-6)', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, DESKTOP)
  const root = await openStudio(page, baseURL, 'deck')
  const panel = root.locator('[data-studio-ai-panel]')
  const input = panel.locator('input[type="file"]')
  const thumbs = panel.locator('img[alt]')
  await input.setInputFiles(['a', 'b', 'c', 'd'].map((n) => png(`${n}.png`, 64)))
  await expect(thumbs).toHaveCount(4)
  await panel.locator('button[title="b.png"]').click()
  await expect(thumbs).toHaveCount(3)
  await input.setInputFiles([png('e.png', 64)])
  await expect(thumbs).toHaveCount(4)
  await expect(panel.locator('img[alt="e.png"]')).toHaveCount(1)
  await expect(page.getByText(/^Not attached/)).toHaveCount(0)
  await ctx.close()
})

test('QA probe: an aborted FileReader releases its attachment slot', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, DESKTOP)
  await ctx.addInitScript(() => {
    const original = FileReader.prototype.readAsDataURL
    FileReader.prototype.readAsDataURL = function (file) {
      if (window.__abortNextRead) {
        window.__abortNextRead = false
        const reader = this
        const result = original.call(this, file)
        queueMicrotask(() => {
          reader.abort()
          window.__readAbortComplete = true
        })
        return result
      }
      return original.call(this, file)
    }
  })
  const root = await openStudio(page, baseURL, 'deck')
  const panel = root.locator('[data-studio-ai-panel]')
  const input = panel.locator('input[type="file"]')
  await page.evaluate(() => { window.__abortNextRead = true })
  await input.setInputFiles([png('aborted.png', 6 * MiB)])
  await page.waitForFunction(() => window.__readAbortComplete === true)
  await input.setInputFiles(['a', 'b', 'c', 'd'].map((n) => png(`${n}-after-abort.png`, 64)))
  await expect(panel.locator('img[alt]')).toHaveCount(4)
  await expect(page.getByText(/^Not attached/)).toHaveCount(0)
  await ctx.close()
})

// ---- N6: another tab saved first (409 deck_conflict) ------------------------------------

/**
 * A deck endpoint with a revision: GET answers `server.deck`; a PATCH whose baseRevision is not
 * `server.deck.revision` is the 409 deck_conflict answer (carrying the current deck), else it is
 * stored and the revision advances. `patches` records every PATCH body that reached it.
 */
async function routeRevisionedDeck(ctx, server) {
  await ctx.route(`**/api/decks/${ids.deck}`, async (route) => {
    const req = route.request()
    if (req.method() !== 'PATCH') return route.fulfill({ json: { deck: server.deck } })
    const body = req.postDataJSON()
    server.patches.push(body)
    if (body.baseRevision !== server.deck.revision) {
      return route.fulfill({ status: 409, json: { error: 'deck_conflict', code: 'deck_conflict', revision: server.deck.revision, deck: server.deck } })
    }
    server.deck = { ...server.deck, ...body, revision: server.deck.revision + 1 }
    delete server.deck.baseRevision
    return route.fulfill({ json: { ok: true, deck: server.deck } })
  })
}
const theirDeck = (state) => ({
  ...state.deck,
  revision: 5,
  slides: state.deck.slides.map((s, i) => (i === 0 ? { html: typeof s === 'string' ? s : s.html, notes: 'Their notes' } : s)),
})

test('deck: a save from a stale revision shows the conflict, stops autosaving, and Reload takes the server deck (N6, AC3)', async ({ browser, baseURL }) => {
  const { ctx, page, state } = await open(browser, DESKTOP)
  const server = { deck: theirDeck(state), patches: [] }
  // this tab loaded revision 4 (every GET says so); another tab has since saved revision 5
  await routeRevisionedDeck(ctx, server)
  await ctx.route(`**/api/decks/${ids.deck}`, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { deck: { ...state.deck, revision: 4 } } })
    return route.fallback()
  })
  const root = await openStudio(page, baseURL, 'deck')
  const notes = root.getByRole('textbox', { name: 'Speaker notes' })
  await notes.fill('My notes')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('This deck was changed elsewhere')
  expect(server.patches.map((p) => p.baseRevision)).toEqual([4])
  // Esc dismisses the dialog; more edits do not hit the server again (no autosave loop)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await notes.fill('My notes, again')
  await expect(root.locator('[data-save-status="error"]')).toContainText("Couldn't save")
  expect(server.patches.length).toBe(1)
  // Retry brings the decision back
  await root.locator('[data-save-status="error"]').getByRole('button', { name: 'Retry' }).click()
  await expect(dialog).toBeVisible()
  expect(server.patches.length).toBe(1)
  await dialog.getByRole('button', { name: 'Reload the saved version' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(notes).toHaveValue('Their notes')
  // saving works again from the new base
  await notes.fill('After reload')
  await expect(root.locator('[data-save-status="saved"]')).toBeVisible()
  expect(server.patches.at(-1).baseRevision).toBe(5)
  expect(server.deck.revision).toBe(6)
  await ctx.close()
})

test('deck: Keep mine re-sends with the new base and overwrites explicitly (N6, AC3)', async ({ browser, baseURL }) => {
  const { ctx, page, state } = await open(browser, DESKTOP)
  const server = { deck: theirDeck(state), patches: [] }
  await routeRevisionedDeck(ctx, server)
  await ctx.route(`**/api/decks/${ids.deck}`, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { deck: { ...state.deck, revision: 4 } } })
    return route.fallback()
  })
  const root = await openStudio(page, baseURL, 'deck')
  const notes = root.getByRole('textbox', { name: 'Speaker notes' })
  await notes.fill('My notes')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep mine and overwrite' }).click()
  await expect(root.locator('[data-save-status="saved"]')).toBeVisible()
  expect(server.patches.map((p) => p.baseRevision)).toEqual([4, 5])
  expect(server.deck.slides[0].notes).toBe('My notes')
  expect(server.deck.revision).toBe(6)
  await expect(notes).toHaveValue('My notes')
  await ctx.close()
})

test('deck: an AI edit based on a stale deck opens the same conflict dialog (N6)', async ({ browser, baseURL }) => {
  const { ctx, page, state } = await open(browser, DESKTOP)
  const current = theirDeck(state)
  await ctx.route(`**/api/decks/${ids.deck}`, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { deck: { ...state.deck, revision: 4 } } })
    return route.fallback()
  })
  let sent
  await ctx.route(`**/api/decks/${ids.deck}/tweak`, (route) => {
    sent = route.request().postDataJSON()
    return route.fulfill({ status: 409, json: { error: 'deck_conflict', code: 'deck_conflict', revision: 5, deck: current } })
  })
  const root = await openStudio(page, baseURL, 'deck')
  const panel = root.locator('[data-studio-ai-panel]')
  await panel.getByRole('textbox').fill('Make it blue')
  await panel.getByRole('button', { name: /Apply/ }).click()
  await expect(page.getByRole('alertdialog')).toContainText('This deck was changed elsewhere')
  expect(sent.baseRevision).toBe(4)
  await ctx.close()
})

test('deck: an AI edit refused as busy (409 deck_busy) says so, spends nothing, and keeps the instruction (N6)', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, DESKTOP)
  let sent = 0
  await ctx.route(`**/api/decks/${ids.deck}/tweak`, (route) => {
    sent++
    return route.fulfill({ status: 409, json: { error: 'deck_busy', code: 'deck_busy', message: 'outra edição com IA está em andamento neste deck' } })
  })
  const root = await openStudio(page, baseURL, 'deck')
  const panel = root.locator('[data-studio-ai-panel]')
  await panel.getByRole('textbox').fill('Make it blue')
  await panel.getByRole('button', { name: /Apply/ }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Another AI edit is running')
  await expect(page.getByRole('alertdialog').getByRole('button', { name: 'Got it' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Got it' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(panel.getByRole('textbox')).toHaveValue('Make it blue')
  expect(sent).toBe(1)
  await ctx.close()
})

for (const [lang, title, reload, openLabel, notesLabel] of [
  ['pt-BR', 'Este deck foi alterado em outro lugar', 'Recarregar a versão salva', 'Abrir no Estúdio de Slides', 'Notas do apresentador'],
  ['es', 'Este deck se cambió en otro lugar', 'Recargar la versión guardada', 'Abrir en el Estudio de Diapositivas', 'Notas del orador'],
]) {
  test(`deck: the conflict dialog is localized (${lang})`, async ({ browser, baseURL }) => {
    const { ctx, page, state } = await open(browser, DESKTOP, freshState(), { locale: lang })
    const server = { deck: theirDeck(state), patches: [] }
    await routeRevisionedDeck(ctx, server)
    await ctx.route(`**/api/decks/${ids.deck}`, async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { deck: { ...state.deck, revision: 4 } } })
      return route.fallback()
    })
    await page.goto(`${baseURL}/#/chat/${ids.s1}`)
    const openBtn = page.getByText(openLabel).first()
    await openBtn.waitFor()
    await openBtn.scrollIntoViewIfNeeded()
    await openBtn.click()
    const root = page.locator(STUDIO.deck)
    await root.waitFor()
    await root.locator('iframe').first().waitFor()
    await root.getByRole('textbox', { name: notesLabel }).fill('x')
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText(title, { timeout: 8000 })
    await expect(dialog.getByRole('button', { name: reload })).toBeVisible()
    await ctx.close()
  })
}

// ---- ui-revamp W1-5: studio chrome and deck editor ---------------------------

/** the computed colour of a CSS value (a var() or a colour) as the browser resolves it */
const resolveColor = (page, css) =>
  page.evaluate((c) => {
    const probe = document.createElement('i')
    probe.style.color = c
    document.body.appendChild(probe)
    const out = getComputedStyle(probe).color
    probe.remove()
    return out
  }, css)

for (const theme of ['light', 'dark']) {
  test(`deck: the primary CTAs of the studio are ink (--action / --on-action), ${theme}`, async ({ browser, baseURL }) => {
    const { ctx, page, errors } = await open(browser, { theme, mobile: false })
    const root = await openStudio(page, baseURL, 'deck')
    const action = await resolveColor(page, 'var(--action)')
    const onAction = await resolveColor(page, 'var(--on-action)')
    const paint = (loc) => loc.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }))
    // the export button and the Apply button of the ask bar
    await root.locator('[data-studio-ai-panel]').getByRole('textbox').fill('x')
    for (const loc of [root.locator('[data-studio-export]'), root.locator('[data-studio-ai-panel]').getByRole('button', { name: /Apply/ })]) {
      // poll: the colours ease in over --duration-fast when the button enables
      await expect.poll(async () => (await paint(loc)).bg).toBe(action)
      expect((await paint(loc)).fg).toBe(onAction)
    }
    // Save while editing is disabled until something changes, so it is checked by role, not by paint
    await root.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(root.getByRole('button', { name: 'Save', exact: true })).toHaveClass(/bg-action/)
    expect(errors).toEqual([])
    await ctx.close()
  })
}

test('deck: the panel header names the kind, shows undo/redo only while editing and offers no version, share or presence', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP)
  const root = await openStudio(page, baseURL, 'deck')
  const header = root.locator('header')
  await expect(header.locator('[data-studio-subtitle]')).toHaveText(/^Deck · \d+ slides?$/)
  await expect(header.getByRole('textbox', { name: 'Presentation title' })).toBeVisible()
  await expect(header.locator('[data-studio-export]')).toBeVisible()
  await expect(header.locator('[data-studio-close]')).toBeVisible()
  await expect(header.locator('[data-studio-undo]')).toHaveCount(0)
  await root.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(header.locator('[data-studio-undo]')).toBeDisabled()
  await expect(header.locator('[data-studio-redo]')).toBeDisabled()
  for (const name of [/share/i, /version/i, /comment/i]) await expect(header.getByRole('button', { name })).toHaveCount(0)
  expect(errors).toEqual([])
  await ctx.close()
})

test('deck editor: Slides | Layers tabs work from the keyboard, and a selected layer offers the quick actions that run the element-scope AI', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP)
  let body = null
  await ctx.route(`**/api/decks/${ids.deck}/tweak`, (route) => {
    body = route.request().postDataJSON()
    const deck = freshState().deck
    return route.fulfill({ json: { deck, usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'm' } })
  })
  const root = await openStudio(page, baseURL, 'deck')
  await expect(root.getByRole('tablist')).toHaveCount(0) // not in the viewing mode
  await root.getByRole('button', { name: 'Edit', exact: true }).click()
  const tabs = root.getByRole('tablist', { name: 'Editor side panel' })
  const slidesTab = tabs.getByRole('tab', { name: 'Slides' })
  const layersTab = tabs.getByRole('tab', { name: 'Layers' })
  await expect(slidesTab).toHaveAttribute('aria-selected', 'true')
  await slidesTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect(layersTab).toHaveAttribute('aria-selected', 'true')
  await expect(layersTab).toBeFocused()
  await expect(root.getByRole('tabpanel')).toBeVisible()
  // the Design panel replaces the old single inspector column
  await expect(root.getByRole('heading', { name: 'Design' })).toBeVisible()
  // no selection: no quick actions
  await expect(root.locator('[data-quick-actions]')).toHaveCount(0)
  // pick the first child layer: the quick actions show over the canvas
  const rows = root.getByRole('tabpanel').getByRole('treeitem')
  await rows.nth(1).click()
  const quick = root.getByRole('toolbar', { name: 'Quick actions for the selection' })
  await expect(quick).toBeVisible()
  await expect(quick.getByRole('button')).toHaveText(['Adjust with AI', 'More executive', 'Shorten', 'Translate'])
  // Translate asks for the language: it prefills the ask bar, nothing is sent
  await quick.getByRole('button', { name: 'Translate' }).click()
  await expect(root.locator('[data-studio-ai-panel]').getByRole('textbox')).toHaveValue('Translate this element to ')
  expect(body).toBeNull()
  await rows.nth(1).click()
  // Shorten runs the element-scope AI and lands in the Accept / Discard preview
  await quick.getByRole('button', { name: 'Shorten' }).click()
  await expect(root.locator('[data-studio-ai-panel]').getByRole('group', { name: /./ })).toBeVisible()
  expect(body.selection?.path).toBeTruthy()
  expect(body.instruction).toMatch(/Shorten the text/)
  expect(body.preview).toBe(true)
  await expect(root.locator('[data-studio-ai-panel]').getByRole('button', { name: 'Discard' })).toBeVisible()
  await root.locator('[data-studio-ai-panel]').getByRole('button', { name: 'Discard' }).click()
  expect(errors).toEqual([])
  await ctx.close()
})

test('deck: at 1100 px and below the panel floats over the chat as a dialog with a focus loop; above it, it docks', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP)
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('prism-deck-focus', '0')
    } catch {
      // sandboxed slide iframes have no storage
    }
  }) // the deck defaults to expanded
  await page.setViewportSize({ width: 1000, height: 800 })
  let root = await openStudio(page, baseURL, 'deck')
  await expect(root).toHaveAttribute('role', 'dialog')
  await expect(root).toHaveAttribute('aria-modal', 'true')
  expect(await root.evaluate((el) => getComputedStyle(el).position)).toBe('fixed')
  const box = await root.boundingBox()
  expect(box.x + box.width).toBeCloseTo(1000, 0) // flush with the right edge
  expect(box.width).toBeGreaterThanOrEqual(420)
  // the focus loop: Tab never leaves the overlay
  for (let i = 0; i < 40; i++) await page.keyboard.press('Tab')
  expect(await root.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await root.locator('[data-studio-close]').click()
  await expect(root).toBeHidden()
  await page.setViewportSize({ width: 1440, height: 900 })
  root = await openStudio(page, baseURL, 'deck')
  await expect(root).not.toHaveAttribute('role', 'dialog')
  expect(await root.evaluate((el) => getComputedStyle(el).position)).toBe('static')
  const docked = await root.boundingBox()
  expect(docked.width).toBeLessThanOrEqual(760)
  expect(docked.width).toBeGreaterThanOrEqual(420)
  expect(errors).toEqual([])
  await ctx.close()
})

// ---- W2-2: document and spreadsheet studios in the docked panel ----

test('doc and sheet dock beside the chat above 1100 px and float over it as a modal below', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP)
  for (const kind of ['doc', 'sheet']) {
    let root = await openStudio(page, baseURL, kind)
    await expect(root).not.toHaveAttribute('role', 'dialog')
    expect(await root.evaluate((el) => getComputedStyle(el).position)).toBe('static')
    const docked = await root.boundingBox()
    expect(docked.width).toBeLessThanOrEqual(760)
    expect(docked.width).toBeGreaterThanOrEqual(420)
    // viewing: Esc does not close a docked panel
    await page.keyboard.press('Escape')
    await expect(root).toBeVisible()
    await root.locator('[data-studio-close]').click()
    await expect(root).toBeHidden()
    await page.setViewportSize({ width: 1000, height: 900 })
    root = await openStudio(page, baseURL, kind)
    await expect(root).toHaveAttribute('role', 'dialog')
    await expect(root).toHaveAttribute('aria-modal', 'true')
    expect(await root.evaluate((el) => getComputedStyle(el).position)).toBe('fixed')
    for (let i = 0; i < 40; i++) await page.keyboard.press('Tab')
    expect(await root.evaluate((el) => el.contains(document.activeElement))).toBe(true) // the focus loop stays inside
    await root.locator('[data-studio-close]').focus() // (Esc inside the ask box only leaves the box)
    await page.keyboard.press('Escape') // a modal overlay: Esc closes it
    await expect(root).toBeHidden()
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  expect(errors).toEqual([])
  await ctx.close()
})

for (const theme of ['light', 'dark']) {
  test(`doc and sheet: the Export primary is an ink button, --action / --on-action (${theme})`, async ({ browser, baseURL }) => {
    const { ctx, page } = await open(browser, { theme, mobile: false })
    for (const kind of ['doc', 'sheet']) {
      const root = await openStudio(page, baseURL, kind)
      await page.waitForTimeout(300) // the colour transition must have finished
      const c = await root.locator('[data-studio-export]').evaluate((btn) => {
        const probe = document.createElement('button')
        probe.style.backgroundColor = 'var(--action)'
        probe.style.color = 'var(--on-action)'
        document.body.append(probe)
        const want = getComputedStyle(probe)
        const got = getComputedStyle(btn)
        const out = { bg: got.backgroundColor, wantBg: want.backgroundColor, fg: got.color, wantFg: want.color }
        probe.remove()
        return out
      })
      expect(c.bg, `${kind} ${JSON.stringify(c)}`).toBe(c.wantBg)
      expect(c.fg, `${kind} ${JSON.stringify(c)}`).toBe(c.wantFg)
      await root.locator('[data-studio-close]').click()
      await expect(root).toBeHidden()
    }
    await ctx.close()
  })
}

test('document: header names the kind and the length, the page stays white in dark, no suggest mode, no Share without a handler', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP)
  const root = await openStudio(page, baseURL, 'doc')
  await expect(root.locator('[data-studio-subtitle]')).toHaveText(/^Document · \d+ words$/)
  const paper = await root.locator('[data-doc-page]').evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el.querySelector('p')).color }))
  expect(paper.bg).toBe('rgb(255, 255, 255)') // the page previews the exported .docx, in both themes
  expect(paper.fg).not.toBe('rgb(255, 255, 255)')
  await expect(root.locator('.doc-print-area')).toHaveCount(1)
  await expect(root.getByRole('button', { name: /suggest/i })).toHaveCount(0) // Q12-A
  await expect(root.getByRole('button', { name: 'Share' })).toHaveCount(0)
  expect(errors).toEqual([])
  await ctx.close()
})

test('document: the Text menu restyles the block under the caret and the markdown follows', async ({ browser, baseURL }) => {
  const { ctx, page, state, errors } = await open(browser, DESKTOP)
  const root = await openStudio(page, baseURL, 'doc')
  await root.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = root.getByRole('textbox', { name: 'Document text editor' })
  await editor.getByText('Revenue grew').click()
  const menu = root.getByRole('combobox', { name: 'Text style' })
  await expect(menu).toHaveValue('p')
  await menu.selectOption('h3')
  await expect(editor.locator('h3', { hasText: 'Revenue grew' })).toHaveCount(1)
  await root.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => state.doc.markdown).toContain('### Revenue grew')
  expect(errors).toEqual([])
  await ctx.close()
})

test('spreadsheet: header, formula bar and tabs; the grid stays read-only', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP)
  const root = await openStudio(page, baseURL, 'sheet')
  await expect(root.locator('[data-studio-subtitle]')).toHaveText('Spreadsheet · 3 sheets')
  await expect(root.getByRole('group', { name: 'Formula bar' })).toBeVisible()
  await expect(root.getByRole('button', { name: 'Share' })).toHaveCount(0) // no handler wired yet
  await root.locator('[data-rc="5-1"]').click()
  await expect(root.getByRole('group', { name: 'Formula bar' })).toContainText('B5')
  await page.keyboard.type('123') // typing never edits a cell
  await expect(root.locator('[data-ds-paper] input, [data-ds-paper] textarea, [data-ds-paper] [contenteditable]')).toHaveCount(0)
  await expect(root.locator('[data-rc="5-1"]')).not.toContainText('123')
  // tabs: roving tabindex, arrows move and activate
  const tabs = root.getByRole('tab')
  await expect(tabs).toHaveCount(3)
  await tabs.first().focus()
  await page.keyboard.press('ArrowRight')
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.nth(1)).toBeFocused()
  await expect(tabs.nth(0)).toHaveAttribute('tabindex', '-1')
  await page.keyboard.press('End')
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true')
  await expect(root.getByRole('list', { name: 'Cell colours' }).getByRole('listitem')).toHaveCount(3)
  expect(errors).toEqual([])
  await ctx.close()
})

test('spreadsheet: AI quick actions appear over the selection and send the same tweak request', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP)
  const bodies = []
  await ctx.route(`**/api/spreadsheets/${ids.sheet}/tweak`, async (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { spreadsheet: SHEET, usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'claude-sonnet-5-5' } })
  })
  const root = await openStudio(page, baseURL, 'sheet')
  const quick = root.locator('[data-quick-actions]')
  await expect(quick).toHaveCount(0) // not a fixed toolbar: nothing is selected yet
  await root.locator('[data-rc="5-1"]').click()
  await expect(quick).toBeVisible()
  await expect(quick.getByRole('button', { name: 'Chart from selection' })).toHaveCount(0) // one cell: no chart
  await root.locator('[data-rc="6-2"]').click({ modifiers: ['Shift'] })
  await expect(quick.getByRole('button', { name: 'Chart from selection' })).toBeVisible()
  // Ask AI names the range and moves focus to the ask bar
  await quick.getByRole('button', { name: 'Ask AI' }).click()
  const box = root.locator('[data-studio-ai-panel]').getByRole('textbox')
  await expect(box).toHaveValue('About B5:C6: ')
  await expect(box).toBeFocused()
  // Add % variance is the same POST as a typed instruction: sheet scope, preview mode
  await quick.getByRole('button', { name: 'Add % variance' }).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0].instruction).toContain('B5:C6')
  expect(bodies[0]).toMatchObject({ preview: true, sheetIndex: 0 })
  expect(Object.keys(bodies[0]).sort()).toEqual(['instruction', 'model', 'preview', 'sheetIndex'].filter((k) => k in bodies[0]).sort())
  // the result lands in the usual Accept / Discard preview
  await expect(root.locator('[data-studio-ai-panel]').getByRole('button', { name: 'Accept & save' })).toBeVisible()
  await expect(quick).toHaveCount(0)
  expect(errors).toEqual([])
  await ctx.close()
})

test('spreadsheet: Explain formula shows only for a formula selection and sends the same tweak request', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP)
  const bodies = []
  await ctx.route(`**/api/spreadsheets/${ids.sheet}/tweak`, async (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { spreadsheet: SHEET, usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'claude-sonnet-5-5' } })
  })
  const root = await openStudio(page, baseURL, 'sheet')
  const quick = root.locator('[data-quick-actions]')
  await root.locator('[data-rc="5-0"]').click() // a label cell
  await expect(quick).toBeVisible()
  await expect(quick.getByRole('button', { name: 'Explain formula' })).toHaveCount(0)
  await root.locator('[data-rc="5-1"]').click() // a formula cell
  await quick.getByRole('button', { name: 'Explain formula' }).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0].instruction).toContain('B5')
  expect(bodies[0]).toMatchObject({ preview: true, sheetIndex: 0 })
  await expect(root.locator('[data-studio-ai-panel]').getByRole('button', { name: 'Accept & save' })).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

for (const [label, variant, size] of [['390 px phone', MOBILE, null], ['1000 px overlay', DESKTOP, { width: 1000, height: 900 }]]) {
  test(`spreadsheet: the selection actions stay on screen and above the range (${label})`, async ({ browser, baseURL }) => {
    const { ctx, page, errors } = await open(browser, variant)
    if (size) await page.setViewportSize(size)
    const root = await openStudio(page, baseURL, 'sheet')
    const quick = root.locator('[data-quick-actions]')
    for (const rc of ['5-0', '7-1']) {
      const cell = root.locator(`[data-rc="${rc}"]`)
      await cell.click()
      await expect(quick).toBeVisible()
      const [bar, c, vp] = [await quick.boundingBox(), await cell.boundingBox(), page.viewportSize()]
      expect(bar.x).toBeGreaterThanOrEqual(0)
      expect(bar.x + bar.width).toBeLessThanOrEqual(vp.width)
      expect(bar.y + bar.height).toBeLessThanOrEqual(c.y) // above the selected cell, not over it
      expect(c.y - (bar.y + bar.height)).toBeLessThanOrEqual(24)
    }
    expect(errors).toEqual([])
    await ctx.close()
  })
}
