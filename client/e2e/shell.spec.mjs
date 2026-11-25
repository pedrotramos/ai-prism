// Shell flows: Welcome, sidebar (expanded, collapsed rail, mobile drawer),
// History and first run. Built client + recorded fixtures, like flows.spec.mjs.
// Each test also fails on an uncaught page error.
//
// The Welcome starters and the sidebar Settings entry need the shell's wiring
// (`<Welcome onPick>` in client/src/app/ChatView.tsx, `<Sidebar onOpenSettings>`
// in client/src/app/Shell.tsx); their tests fail if that wiring is missing.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { AXE_TAGS, loadFixtures, newVariantContext, SCREENS } from './lib.mjs'

const { ids } = loadFixtures()
const DESKTOP = { theme: 'dark', mobile: false }
const MOBILE = { theme: 'light', mobile: true }

async function open(browser, variant = DESKTOP, extra = {}) {
  const ctx = await newVariantContext(browser, variant)
  if (extra.collapsed) await ctx.addInitScript(() => localStorage.setItem('prism-sidebar-collapsed', '1'))
  if (extra.locale) {
    await ctx.addInitScript((loc) => {
      Object.defineProperty(navigator, 'language', { get: () => loc })
    }, extra.locale)
  }
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  return { ctx, page, errors }
}

const seriousOrCritical = (res) =>
  res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`)

const sidebar = (page) => page.locator('#app-sidebar')

test('welcome greets by time of day and offers 3 start cards that prefill the composer', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  await SCREENS.welcome(page, baseURL, ids)
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ })).toBeVisible()
  const starters = page.locator('[data-suggestion]')
  await expect(starters).toHaveCount(3)
  expect(await starters.evaluateAll((els) => els.map((e) => e.getAttribute('data-suggestion')))).toEqual(['data', 'artifact', 'docs'])
  await page.locator('[data-suggestion="artifact"]').click()
  await expect(page.locator('textarea').first()).toHaveValue('Create a 5-slide presentation about ')
  // the caret is in the composer, at the end: typing finishes the sentence
  await expect(page.locator('textarea').first()).toBeFocused()
  await page.keyboard.type('our Q3 results')
  await expect(page.locator('textarea').first()).toHaveValue('Create a 5-slide presentation about our Q3 results')
  expect(errors).toEqual([])
  await ctx.close()
})

test('sidebar order: New chat first, then search; the account is last, bottom-left', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  await SCREENS.welcome(page, baseURL, ids)
  const bar = sidebar(page)
  const names = await bar.locator('button, a[href]').evaluateAll((els) =>
    els.filter((e) => e.getClientRects().length).map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim())
  )
  const iNew = names.indexOf('New chat')
  const iSearch = names.indexOf('Search chats')
  const iFirstChat = names.indexOf('Ambiente local de demonstração')
  expect(iNew).toBeGreaterThan(-1)
  expect(iNew).toBeLessThan(iSearch)
  expect(iSearch).toBeLessThan(iFirstChat)
  // Jakob: left column, account at the bottom-left
  const box = await bar.boundingBox()
  const account = bar.getByText('e2e-user@example.com', { exact: true })
  const acc = await account.boundingBox()
  expect(box.x).toBe(0)
  expect(acc.y + acc.height).toBeGreaterThan(box.y + box.height - 80)
  expect(errors).toEqual([])
  await ctx.close()
})

test('Settings is reachable from the sidebar footer on a phone', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, MOBILE)
  await SCREENS.welcome(page, baseURL, ids)
  await page.locator('header button').first().click()
  const settings = sidebar(page).getByRole('button', { name: 'Open settings' })
  expect(await settings.count()).toBeGreaterThan(0)
  const r = await settings.boundingBox()
  expect(r.width).toBeGreaterThanOrEqual(44)
  expect(r.height).toBeGreaterThanOrEqual(44)
  await settings.click()
  await expect(page.getByRole('button', { name: 'Preferences', exact: true }).first()).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('collapsed rail: every control is at least 44 px, named and has a tooltip', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP, { collapsed: true })
  await SCREENS.welcome(page, baseURL, ids)
  const rail = page.locator('aside').filter({ has: page.getByRole('button', { name: 'Expand sidebar' }) })
  await expect(rail).toBeVisible()
  const buttons = await rail.locator('button').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { name: e.getAttribute('aria-label'), title: e.getAttribute('title'), w: r.width, h: r.height }
    })
  )
  expect(buttons.length).toBeGreaterThanOrEqual(3)
  for (const b of buttons) {
    expect(b.name, JSON.stringify(b)).toBeTruthy()
    expect(b.title, JSON.stringify(b)).toBeTruthy()
    expect(b.w, JSON.stringify(b)).toBeGreaterThanOrEqual(44)
    expect(b.h, JSON.stringify(b)).toBeGreaterThanOrEqual(44)
  }
  expect(buttons.map((b) => b.name).slice(0, 3)).toEqual(['Expand sidebar', 'New chat', 'Search chats'])
  expect(errors).toEqual([])
  await ctx.close()
})

test('mobile hamburger is named (axe button-name)', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, MOBILE)
  await SCREENS.welcome(page, baseURL, ids)
  const res = await new AxeBuilder({ page }).withRules(['button-name']).analyze()
  expect(res.violations.map((v) => v.id)).not.toContain('button-name')
  await ctx.close()
})

test('mobile drawer is a modal: focus moves in and is trapped, Esc closes and focus returns', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, MOBILE)
  await SCREENS.welcome(page, baseURL, ids)
  const opener = page.locator('header button').first()

  // closed: off-screen controls are out of the tab order
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('#app-sidebar'))).toBe(false)
  }

  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'Navigation' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(page.getByRole('button', { name: 'New chat' }).first()).toBeFocused()
  // the close button is on top of everything (the header used to cover it)
  const close = dialog.getByRole('button', { name: 'Close sidebar' })
  await expect.poll(async () => (await dialog.boundingBox()).x).toBe(0) // slide-in finished
  const r = await close.boundingBox()
  expect(r.width).toBeGreaterThanOrEqual(44)
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#app-sidebar'), [r.x + r.width / 2, r.y + r.height / 2])).toBe(true)

  // Tab and Shift+Tab never leave the drawer
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('#app-sidebar'))).toBe(true)
  }
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Shift+Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('#app-sidebar'))).toBe(true)
  }

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()

  // the scrim closes it too
  await opener.click()
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible()
  await page.mouse.click(380, 400)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(errors).toEqual([])
  await ctx.close()
})

test('history: main landmark, every control named, no serious/critical axe finding', async ({ browser, baseURL }) => {
  for (const variant of [DESKTOP, MOBILE]) {
    const { ctx, page, errors } = await open(browser, variant)
    await page.goto(`${baseURL}/#/history`)
    await expect(page.getByText('Hiring plan Q1').first()).toBeVisible()
    await expect(page.getByRole('main', { name: 'History' })).toBeVisible()
    await expect(page.getByRole('searchbox', { name: 'Search conversations' })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Sort conversations' })).toBeVisible()
    await expect(page.getByRole('checkbox', { name: 'Select all' })).toBeVisible()
    await expect(page.getByRole('checkbox', { name: 'Select “Hiring plan Q1”' })).toBeAttached()
    await expect(page.getByRole('button', { name: 'Delete “Hiring plan Q1”' })).toBeAttached()
    // row checkbox hit area is the whole cell, not the 16 px glyph
    const cb = await page.getByRole('checkbox', { name: 'Select “Hiring plan Q1”' }).boundingBox()
    expect(cb.width).toBeGreaterThanOrEqual(variant.mobile ? 44 : 32)
    const res = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
    expect(seriousOrCritical(res)).toEqual([])
    expect(res.violations.map((v) => v.id)).not.toContain('landmark-one-main')
    // selecting shows the bulk action in the danger colour, not the brand accent
    await page.getByRole('checkbox', { name: 'Select “Hiring plan Q1”' }).check()
    await expect(page.getByRole('button', { name: 'Delete 1 selected' })).toBeVisible()
    expect(errors).toEqual([])
    await ctx.close()
  }
})

test('history row actions are reachable by keyboard (not hover-only)', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  await page.goto(`${baseURL}/#/history`)
  const rename = page.getByRole('button', { name: 'Rename “Hiring plan Q1”' })
  const actions = rename.locator('..')
  await expect(actions).toHaveCSS('opacity', '0')
  await page.getByRole('checkbox', { name: 'Select “Hiring plan Q1”' }).focus()
  await page.keyboard.press('Tab') // title
  await page.keyboard.press('Tab') // rename
  await expect(rename).toBeFocused()
  await expect(actions).toHaveCSS('opacity', '1')
  expect(errors).toEqual([])
  await ctx.close()
})

test('empty states end in an action: no chats yet, and no search results', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  await page.route('**/api/sessions', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) }))
  await page.route('**/api/search?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [] }) }))
  await page.goto(`${baseURL}/#/history`)
  const main = page.getByRole('main', { name: 'History' })
  await expect(main.getByText('No conversations yet')).toBeVisible()
  await expect(main.getByRole('button', { name: 'New chat' }).last()).toBeVisible()
  await expect(sidebar(page).getByRole('button', { name: 'Start your first chat' })).toBeVisible()

  await page.getByRole('searchbox', { name: 'Search conversations' }).fill('quarterly churn')
  await expect(main.getByText('No related chats found.')).toBeVisible()
  await main.getByRole('button', { name: 'Clear search' }).last().click()
  await expect(page.getByRole('searchbox', { name: 'Search conversations' })).toHaveValue('')
  await expect(main.getByText('No conversations yet')).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('skeletons have the shape of the rows they stand for and are announced once', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  let release
  const gate = new Promise((r) => (release = r))
  await page.route('**/api/sessions', async (route) => {
    await gate
    await route.continue()
  })
  await page.goto(`${baseURL}/#/chat`)
  const loading = sidebar(page).getByRole('status', { name: 'Loading conversations' })
  await expect(loading).toBeVisible()
  const skelRow = await loading.locator('.h-9').first().boundingBox()
  release()
  const row = sidebar(page).getByRole('button', { name: 'Ambiente local de demonstração' })
  await expect(row).toBeVisible()
  const realRow = await row.boundingBox()
  expect(Math.abs(skelRow.height - realRow.height)).toBeLessThanOrEqual(1)
  await expect(loading).toHaveCount(0)
  expect(errors).toEqual([])
  await ctx.close()
})

test('page load applies the saved theme without a fade', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, MOBILE)
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    // record whether the class ever appears while the app boots; init scripts
    // run before <html> is parsed, so observe the document subtree
    new MutationObserver(() => {
      if (document.documentElement?.classList.contains('theme-switching')) window.__fadedOnLoad = true
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['class'] })
  })
  await SCREENS.welcome(page, baseURL, ids)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await page.evaluate(() => !!window.__fadedOnLoad)).toBe(false)
  await ctx.close()
})

test('theme switch cross-fades in 200 ms, and switches instantly under reduced motion', async ({ browser, baseURL }) => {
  for (const reduce of [false, true]) {
    const ctx = await newVariantContext(browser, DESKTOP)
    const page = await ctx.newPage()
    if (reduce) await page.emulateMedia({ reducedMotion: 'reduce' })
    await SCREENS.welcome(page, baseURL, ids)
    const during = await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light')
      return new Promise((r) =>
        requestAnimationFrame(() =>
          r({
            cls: document.documentElement.classList.contains('theme-switching'),
            dur: getComputedStyle(document.querySelector('#app-sidebar')).transitionDuration,
          })
        )
      )
    })
    if (reduce) {
      expect(during.cls).toBe(false)
      expect(during.dur.split(',').every((d) => parseFloat(d) === 0)).toBe(true)
    } else {
      expect(during.cls).toBe(true)
      expect(during.dur.split(',').map((d) => d.trim())).toContain('0.2s')
      await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('theme-switching'))).toBe(false)
    }
    await ctx.close()
  }
})

test('a browser language the UI does not ship falls back to English', async ({ browser, baseURL }) => {
  for (const [locale, newChat] of [['fr-FR', 'New chat'], ['de-DE', 'New chat'], ['es-ES', 'Nueva conversación'], ['pt-BR', 'Nova conversa']]) {
    const { ctx, page, errors } = await open(browser, DESKTOP, { locale })
    await page.goto(`${baseURL}/#/chat`)
    await page.locator('textarea').first().waitFor()
    await expect(sidebar(page).getByRole('button', { name: newChat, exact: true })).toBeVisible()
    expect(errors).toEqual([])
    await ctx.close()
  }
})

// ---- W1-1: the revamped shell ------------------------------------------------

// what a probe painted with the given tokens resolves to
async function tokenColours(page, bg, fg) {
  return page.evaluate(([b, f]) => {
    const probe = document.createElement('span')
    probe.style.backgroundColor = `var(${b})`
    probe.style.color = `var(${f})`
    document.body.append(probe)
    const c = getComputedStyle(probe)
    const out = { bg: c.backgroundColor, fg: c.color }
    probe.remove()
    return out
  }, [bg, fg])
}

for (const theme of ['light', 'dark']) {
  test(`primary action in the shell (History: New chat) computes to --action / --on-action (${theme})`, async ({ browser, baseURL }) => {
    const { ctx, page, errors } = await open(browser, { theme, mobile: false })
    await SCREENS.welcome(page, baseURL, ids)
    await page.goto(`${baseURL}/#/history`)
    const cta = page.locator('main header').getByRole('button', { name: 'New chat' })
    await expect(cta).toBeVisible()
    const want = await tokenColours(page, '--action', '--on-action')
    const got = await cta.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }))
    expect(got).toEqual(want)
    expect(errors).toEqual([])
    await ctx.close()
  })
}

test('sidebar footer: month spend for everyone, theme toggle, name and Settings', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  await SCREENS.welcome(page, baseURL, ids)
  const bar = sidebar(page)
  // the month figure comes from /api/usage/summary (fixture: $0.0893)
  const spend = bar.getByTestId('sidebar-spend')
  await expect(spend).toContainText('Spent in')
  await expect(spend).toContainText('$0.09')
  await expect(spend).toContainText('List-price estimate')
  // the toggle sets an explicit theme, the opposite of the painted one
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  expect(before).toBe('dark')
  await bar.getByRole('button', { name: 'Switch to light theme' }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light')
  expect(await page.evaluate(() => localStorage.getItem('prism-theme'))).toBe('light')
  await bar.getByRole('button', { name: 'Switch to dark theme' }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark')
  await expect(bar.getByRole('button', { name: 'Open settings' })).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('projects get a colour dot derived from their id, from the --project-N tokens', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  const rows = [3, 4].map((id) => ({ id, name: `Plan ${id}`, role: 'manage', description: '', members: 1 }))
  await page.route(/\/api\/projects(\?.*)?$/, (r) => r.fulfill({ json: { projects: rows, limits: {} } }))
  await SCREENS.welcome(page, baseURL, ids)
  const dots = sidebar(page).locator('[data-sidebar-project-dot]')
  await expect(dots).toHaveCount(2)
  const colours = await dots.evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor))
  // each dot paints its own token: project 3 -> --project-3, project 4 -> --project-4
  const want = await page.evaluate(() => [3, 4].map((n) => {
    const probe = document.createElement('span')
    probe.style.backgroundColor = `var(--project-${n})`
    document.body.append(probe)
    const c = getComputedStyle(probe).backgroundColor
    probe.remove()
    return c
  }))
  expect(colours).toEqual(want)
  expect(want[0]).toMatch(/^rgb/)
  expect(want[0]).not.toBe(want[1])
  expect(errors).toEqual([])
  await ctx.close()
})

test('collapsed rail peeks on hover: the full sidebar floats over the content and parks again', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP, { collapsed: true })
  await SCREENS.welcome(page, baseURL, ids)
  const panel = sidebar(page)
  const rail = page.locator('aside').filter({ has: page.getByRole('button', { name: 'Expand sidebar' }) })
  await expect(rail).toBeVisible()
  // parked: invisible, so out of the tab order and the accessibility tree (and no page-wide [inert])
  await expect(panel).toBeHidden()
  await expect(page.locator('[inert]')).toHaveCount(0)
  const main = await page.locator('main').first().boundingBox()
  await rail.hover({ position: { x: 32, y: 400 } })
  await expect(panel).toBeVisible()
  await expect.poll(async () => (await panel.boundingBox()).x).toBe(0)
  expect((await panel.boundingBox()).width).toBe(256)
  // floating: the page did not move under it
  expect((await page.locator('main').first().boundingBox()).x).toBe(main.x)
  await page.mouse.move(900, 400)
  await expect(panel).toBeHidden()
  expect(errors).toEqual([])
  await ctx.close()
})

test('collapsed rail peeks on keyboard focus and Escape closes it, returning focus to the rail', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, DESKTOP, { collapsed: true })
  await SCREENS.welcome(page, baseURL, ids)
  const panel = sidebar(page)
  const expand = page.getByRole('button', { name: 'Expand sidebar' })
  await expand.focus()
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('button', { name: 'New chat' })).toBeVisible()
  // Tab walks on into the floating panel
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab')
  expect(await page.evaluate(() => !!document.activeElement?.closest('#app-sidebar'))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(expand).toBeFocused()
  expect(errors).toEqual([])
  await ctx.close()
})

test('at 1100 px or less the sidebar is a rail; above it, docked; at 760 px or less, a drawer', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  const rail = () => page.locator('aside').filter({ has: page.getByRole('button', { name: 'Expand sidebar' }) })
  await page.setViewportSize({ width: 1101, height: 800 })
  await SCREENS.welcome(page, baseURL, ids)
  await expect(rail()).toHaveCount(0)
  expect((await sidebar(page).boundingBox()).width).toBe(256)
  await page.setViewportSize({ width: 1100, height: 800 })
  await expect(rail()).toBeVisible()
  await expect(sidebar(page)).toBeHidden()
  // the rail made by the window cannot be docked: expanding it peeks
  await rail().getByRole('button', { name: 'Expand sidebar' }).click()
  await expect(sidebar(page)).toBeVisible()
  await page.setViewportSize({ width: 761, height: 800 })
  await expect(rail()).toBeVisible()
  await page.setViewportSize({ width: 760, height: 800 })
  await expect(rail()).toHaveCount(0)
  await expect(page.locator('main header').getByRole('button', { name: 'Open menu' })).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('sidebar spend: a failed load keeps the card with a message and Try again; retrying recovers', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser)
  let fail = true
  await page.route(/\/api\/usage\/summary$/, (r) =>
    fail
      ? r.fulfill({ status: 503, json: { error: 'temporarily unavailable' } })
      : r.fulfill({ json: { month: { start: '2026-11-01T00:00:00.000Z', resetsAt: '2026-12-01T00:00:00.000Z', timezone: 'UTC', usd: 3.5, estimated: false, unpriced: false } } })
  )
  await SCREENS.welcome(page, baseURL, ids)
  const spend = sidebar(page).getByTestId('sidebar-spend')
  await expect(spend.getByRole('status')).toContainText('Could not load spend.')
  fail = false
  await spend.getByRole('button', { name: 'Try again' }).click()
  await expect(spend).toContainText('$3.50')
  await expect(spend.getByRole('status')).toHaveCount(0)
  // a later failure keeps the last figure, marked out of date
  fail = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(spend.getByRole('status')).toContainText('Out of date.')
  await expect(spend).toContainText('$3.50')
  expect(errors).toEqual([])
  await ctx.close()
})
