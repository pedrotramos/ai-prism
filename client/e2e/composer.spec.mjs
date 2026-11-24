// Composer flows: the "/" command menu, the "+" menu, attachments (picker,
// paste, drag and drop), Enter/Shift+Enter/Esc, touch-target sizes, the
// disabled-send token and axe on the open menus. Each flow runs with the
// keyboard only, and the "+" menu also with the mouse. English UI (the
// harness context is en-US), so the selectors use the English copy.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { loadFixtures, newVariantContext, SCREENS, VARIANTS, variantName, AXE_TAGS } from './lib.mjs'

const { ids } = loadFixtures()

async function open(browser, baseURL, variant = { theme: 'dark', mobile: false }) {
  const ctx = await newVariantContext(browser, variant)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await SCREENS.welcome(page, baseURL, ids)
  // ARIA 1.1 combobox: a named wrapper (role=combobox) owns the listbox; the
  // textarea inside it is the plain multiline textbox that takes the typing
  const box = page.getByRole('textbox', { name: 'Message' })
  const combo = page.getByRole('combobox', { name: 'Message' })
  return { ctx, page, errors, box, combo }
}

const slashMenu = (page) => page.getByRole('listbox', { name: 'Commands' })
const plusButton = (page) => page.getByRole('button', { name: 'Add files and more' })
const plusMenu = (page) => page.getByRole('menu', { name: 'Add files and more' })

test('the message box is an ARIA 1.1 combobox whose "/" popup is a listbox of options', async ({ browser, baseURL }) => {
  const { ctx, page, box, combo, errors } = await open(browser, baseURL)
  // the textarea keeps its native role (axe: no role on <textarea>) and stays multiline
  expect(await page.locator('[data-composer] textarea').getAttribute('role')).toBeNull()
  await expect(box).toHaveAttribute('aria-autocomplete', 'list')
  expect(await box.evaluate((el) => el.closest('[role="combobox"]') !== null)).toBe(true)
  // closed: a collapsed combobox that owns nothing; the textbox points at nothing
  await expect(combo).toHaveAttribute('aria-haspopup', 'listbox')
  await expect(combo).toHaveAttribute('aria-expanded', 'false')
  expect(await combo.getAttribute('aria-owns')).toBeNull()
  expect(await combo.getAttribute('aria-controls')).toBeNull()
  expect(await box.getAttribute('aria-controls')).toBeNull()
  expect(await box.getAttribute('aria-activedescendant')).toBeNull()
  await box.focus()
  await page.keyboard.type('/')
  const list = slashMenu(page)
  await expect(list).toBeVisible()
  await expect(combo).toHaveAttribute('aria-expanded', 'true')
  const listId = await list.getAttribute('id')
  expect(listId).toBeTruthy()
  await expect(combo).toHaveAttribute('aria-owns', listId)
  await expect(combo).toHaveAttribute('aria-controls', listId)
  await expect(box).toHaveAttribute('aria-controls', listId)
  const options = list.getByRole('option')
  const n = await options.count()
  expect(n).toBeGreaterThan(0)
  expect(await page.locator('[data-composer] [role="menuitem"]').count()).toBe(0)
  // ids are unique and the active one is the only aria-selected option
  const ids = await options.evaluateAll((els) => els.map((e) => e.id))
  expect(new Set(ids).size).toBe(ids.length)
  const active = await box.getAttribute('aria-activedescendant')
  expect(active).toBe(ids[0])
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  expect(await list.locator('[role="option"][aria-selected="true"]').count()).toBe(1)
  await page.keyboard.press('ArrowDown')
  await expect(box).toHaveAttribute('aria-activedescendant', ids[1])
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(options.first()).toHaveAttribute('aria-selected', 'false')
  await expect(box).toBeFocused()
  // the result count is announced politely and follows the filter
  const status = page.locator('[data-composer] [role="status"][aria-live="polite"]')
  await expect(status).toHaveText(`${n} suggestions`)
  await page.keyboard.type('hel')
  await expect(status).toHaveText('1 suggestion')
  // Esc collapses the combobox and keeps the text
  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()
  await expect(combo).toHaveAttribute('aria-expanded', 'false')
  expect(await combo.getAttribute('aria-owns')).toBeNull()
  expect(await combo.getAttribute('aria-controls')).toBeNull()
  expect(await box.getAttribute('aria-activedescendant')).toBeNull()
  expect(await box.getAttribute('aria-controls')).toBeNull()
  await expect(box).toHaveValue('/hel')
  await expect(status).toHaveText('')
  expect(errors).toEqual([])
  await ctx.close()
})

test('keyboard: "/" opens the command menu, arrows move, Esc closes, Enter runs /help', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.focus()
  await page.keyboard.type('/')
  const menu = slashMenu(page)
  await expect(menu).toBeVisible()
  const items = menu.getByRole('option')
  await expect(items.filter({ hasText: '/compact' })).toHaveCount(1)
  await expect(items.filter({ hasText: '/help' })).toHaveCount(1)
  // the highlighted item is announced through aria-activedescendant
  const first = await box.getAttribute('aria-activedescendant')
  expect(first).toBeTruthy()
  await page.keyboard.press('ArrowDown')
  const second = await box.getAttribute('aria-activedescendant')
  expect(second).toBeTruthy()
  expect(second).not.toBe(first)
  await expect(page.locator(`#${second}`)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(box).toHaveValue('/')
  // typing again reopens and filters
  await page.keyboard.type('hel')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Enter')
  const help = page.getByRole('region', { name: 'Commands and shortcuts' })
  await expect(help).toBeVisible()
  await expect(box).toHaveValue('')
  await expect(box).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(help).toBeHidden()
  expect(errors).toEqual([])
  await ctx.close()
})

test('the command filter is accent- and case-insensitive and knows every language', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  // 'aju' would also match the Spanish 'ajustes' (settings)
  await box.fill('/AJÚD')
  await expect(slashMenu(page).getByRole('option')).toHaveCount(1)
  await expect(slashMenu(page).getByRole('option').first()).toContainText('/help')
  await box.fill('/compactar')
  await expect(slashMenu(page).getByRole('option').first()).toContainText('/compact')
  await box.fill('/nothing-matches')
  await expect(slashMenu(page)).toBeHidden()
  expect(errors).toEqual([])
  await ctx.close()
})

test('a typed command with trailing spaces runs on Enter and is not sent to the model', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.focus()
  await page.keyboard.type('/help   ')
  await expect(slashMenu(page)).toBeHidden()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: 'Commands and shortcuts' })).toBeVisible()
  expect(await page.evaluate(() => !!window.__sse)).toBe(false)
  expect(errors).toEqual([])
  await ctx.close()
})

test('/compact in English reaches the compaction path without a confirm dialog', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  let dialogs = 0
  page.on('dialog', (d) => {
    dialogs++
    d.dismiss()
  })
  await box.fill('/compact ')
  await box.press('Enter')
  // a brand-new chat has nothing to compact: the app's toast answers, no turn starts
  await expect(page.getByText('Send a message before compacting')).toBeVisible()
  expect(await page.evaluate(() => !!window.__sse)).toBe(false)
  expect(dialogs).toBe(0)
  expect(errors).toEqual([])
  await ctx.close()
})

test('the command menu renders within 100 ms of the keystroke', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.focus()
  await page.evaluate(() => {
    window.__slashTiming = {}
    document.addEventListener('keydown', (e) => {
      if (e.key === '/') window.__slashTiming.down = performance.now()
    }, { capture: true })
    new MutationObserver(() => {
      if (!window.__slashTiming.shown && document.querySelector('[role="listbox"][aria-label="Commands"]')) {
        window.__slashTiming.shown = performance.now()
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  await page.keyboard.type('/')
  await expect(slashMenu(page)).toBeVisible()
  const { down, shown } = await page.evaluate(() => window.__slashTiming)
  expect(shown - down).toBeLessThan(100)
  expect(errors).toEqual([])
  await ctx.close()
})

test('Enter sends, Shift+Enter adds a line, and the user bubble shows before the server answers', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.focus()
  await page.keyboard.type('first line')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('second line')
  await expect(box).toHaveValue('first line\nsecond line')
  expect(await page.evaluate(() => !!window.__sse)).toBe(false)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => !!window.__sse)
  // no SSE event yet (not even meta): the bubble is already in the thread
  await expect(page.getByText('second line').first()).toBeVisible()
  await expect(box).toHaveValue('')
  await page.evaluate((sid) => {
    window.__sse.push({ type: 'meta', sessionId: sid, isNew: true })
    window.__sse.push({ type: 'token', value: 'Noted.' })
  }, ids.s2)
  await expect(page.getByText('Noted.')).toBeVisible()
  await page.evaluate(() => {
    window.__sse.push({ type: 'done' })
    window.__sse.end()
  })
  expect(errors).toEqual([])
  await ctx.close()
})

test('keyboard: the + menu opens, roves with arrows, closes on Esc and attaches a file', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.focus()
  await page.keyboard.press('Tab')
  await expect(plusButton(page)).toBeFocused()
  await expect(plusButton(page)).toHaveAttribute('aria-haspopup', 'menu')
  await page.keyboard.press('Enter')
  const menu = plusMenu(page)
  await expect(menu).toBeVisible()
  await expect(plusButton(page)).toHaveAttribute('aria-expanded', 'true')
  const items = menu.getByRole('menuitem')
  const count = await items.count()
  expect(count).toBeGreaterThanOrEqual(2)
  expect(count).toBeLessThanOrEqual(7)
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(items.nth(1)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(plusButton(page)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(items.first()).toBeFocused()
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press('Enter')
  await (await chooser).setFiles({ name: 'report.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') })
  await expect(page.getByRole('button', { name: 'Remove report.csv' })).toBeVisible()
  await page.getByRole('button', { name: 'Remove report.csv' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Remove report.csv' })).toBeHidden()
  expect(errors).toEqual([])
  await ctx.close()
})

test('mouse: the + menu adds images through an image-only picker', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, baseURL)
  await plusButton(page).click()
  const chooser = page.waitForEvent('filechooser')
  await plusMenu(page).getByRole('menuitem', { name: /Add images/ }).click()
  const fc = await chooser
  expect(await fc.element().getAttribute('accept')).toBe('image/*')
  await fc.setFiles({ name: 'chart.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') })
  await expect(page.getByRole('button', { name: 'Remove chart.png' })).toBeVisible()
  // clicking outside closes a menu that is open
  await plusButton(page).click()
  await expect(plusMenu(page)).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(plusMenu(page)).toBeHidden()
  expect(errors).toEqual([])
  await ctx.close()
})

test('pasting an image and dropping a file both attach them', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.focus()
  await page.evaluate(() => {
    const ta = document.querySelector('textarea')
    const paste = new DataTransfer()
    paste.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }))
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: paste, bubbles: true, cancelable: true }))
    const drop = new DataTransfer()
    drop.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
    ta.dispatchEvent(new DragEvent('dragover', { dataTransfer: drop, bubbles: true, cancelable: true }))
    ta.dispatchEvent(new DragEvent('drop', { dataTransfer: drop, bubbles: true, cancelable: true }))
  })
  await expect(page.getByRole('button', { name: /^Remove pasted-1-/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove notes.txt' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled()
  expect(errors).toEqual([])
  await ctx.close()
})

test('the disabled Send uses the disabled token, not a faded accent', async ({ browser, baseURL }) => {
  for (const theme of ['dark', 'light']) {
    const { ctx, page, errors } = await open(browser, baseURL, { theme, mobile: false })
    const send = page.getByRole('button', { name: 'Send' })
    await expect(send).toBeDisabled()
    const { bg, expected, opacity } = await send.evaluate((el) => {
      const probe = document.createElement('div')
      probe.style.background = 'var(--disabled-bg)'
      document.body.appendChild(probe)
      const expected = getComputedStyle(probe).backgroundColor
      probe.remove()
      const cs = getComputedStyle(el)
      return { bg: cs.backgroundColor, expected, opacity: cs.opacity }
    })
    expect(bg, theme).toBe(expected)
    expect(opacity, theme).toBe('1')
    expect(errors).toEqual([])
    await ctx.close()
  }
})

for (const mobile of [false, true]) {
  test(`touch targets: send, attach, mic and voice are >= ${mobile ? 44 : 32} px at ${mobile ? 390 : 1440} px`, async ({ browser, baseURL }) => {
    const { ctx, page, box, errors } = await open(browser, baseURL, { theme: 'dark', mobile })
    await box.fill('x')
    const min = mobile ? 44 : 32
    const names = ['Send', 'Add files and more', 'Voice mode — talk with the AI']
    if (await page.getByRole('button', { name: 'Dictate (speech to text)' }).count()) names.push('Dictate (speech to text)')
    for (const name of names) {
      const b = await page.getByRole('button', { name, exact: true }).boundingBox()
      expect(b, name).toBeTruthy()
      expect(Math.round(b.width), `${name} width`).toBeGreaterThanOrEqual(min)
      expect(Math.round(b.height), `${name} height`).toBeGreaterThanOrEqual(min)
    }
    expect(errors).toEqual([])
    await ctx.close()
  })
}

for (const variant of VARIANTS) {
  test(`axe: composer closed and with each menu open has no violation of any impact (${variantName(variant)})`, async ({ browser, baseURL }) => {
    const { ctx, page, box, errors } = await open(browser, baseURL, variant)
    const scan = async (label) => {
      // menus fade in; axe must see the final colours, not a frame mid-fade
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
      const res = await new AxeBuilder({ page }).include('[data-composer]').withTags(AXE_TAGS).analyze()
      // any impact: the a11y ratchet counts minor rules too (aria-allowed-role was one)
      // the failure lists each node's selector and axe's reason, not just the rule
      expect(res.violations.flatMap((v) => v.nodes.map((n) => `${v.id}/${v.impact}: ${n.target.join(' ')} — ${n.failureSummary}`)), label).toEqual([])
    }
    await scan('closed')
    await box.fill('/')
    await expect(slashMenu(page)).toBeVisible()
    await scan('slash menu')
    await box.fill('')
    await plusButton(page).click()
    await expect(plusMenu(page)).toBeVisible()
    await scan('plus menu')
    await page.keyboard.press('Escape')
    await box.fill('/help ')
    await box.press('Enter')
    await expect(page.getByRole('region', { name: 'Commands and shortcuts' })).toBeVisible()
    await scan('help panel')
    expect(errors).toEqual([])
    await ctx.close()
  })
}

// ---- commands wired to the app (ChatView's onCommand) ----

async function runCommand(page, box, text) {
  await box.fill(text)
  await box.press('Enter')
}

test('with the app wired, "/" lists all fifteen commands (nine app commands and six artifact shortcuts)', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.fill('/')
  const labels = await slashMenu(page).getByRole('option').evaluateAll((els) => els.map((e) => e.textContent))
  for (const name of ['/compact', '/context', '/new', '/model', '/skills', '/cost', '/history', '/settings', '/help', '/deck', '/memo', '/spreadsheet', '/image', '/genie', '/python']) {
    expect(labels.some((l) => l.startsWith(name)), name).toBe(true)
  }
  expect(errors).toEqual([])
  await ctx.close()
})

test('/new leaves an open chat for an empty one', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, baseURL)
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  await page.getByText('Open in Slides Studio').first().waitFor()
  const box = page.getByRole('textbox', { name: 'Message' })
  await runCommand(page, box, '/nova')
  await expect(page.getByText('Open in Slides Studio')).toHaveCount(0)
  await expect(page).toHaveURL(/#\/chat\/?$/)
  expect(errors).toEqual([])
  await ctx.close()
})

test('/history opens the History page and /settings opens Settings', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await runCommand(page, box, '/historial')
  await expect(page).toHaveURL(/#\/history$/)
  await expect(page.getByText('Hiring plan Q1').first()).toBeVisible()
  await page.goto(`${baseURL}/#/chat`)
  const box2 = page.getByRole('textbox', { name: 'Message' })
  await runCommand(page, box2, '/settings')
  // Settings opens on its first tab (the same check as flows.spec.mjs)
  await expect(page.getByRole('button', { name: 'Preferences', exact: true }).first()).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('/skills opens Settings on the Skills tab', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  // the Skills tab lists /api/skills, which the recorded fixtures do not cover
  await page.route('**/api/skills', (r) => r.fulfill({ json: { skills: [], isAdmin: false } }))
  await runCommand(page, box, '/skills')
  await expect(page.getByText(/Capabilities AI Prism triggers on its own/)).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('/model lists the models and picking one switches the chat model', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await box.fill('/model ')
  const list = slashMenu(page)
  await expect(list.getByRole('option').first()).toBeVisible()
  await box.press('End')
  await page.keyboard.type('kimi')
  await expect(list.getByRole('option')).toHaveCount(1)
  await box.press('Enter')
  await expect(box).toHaveValue('')
  await expect(page.locator('[data-composer]').getByText('Kimi K3').first()).toBeVisible()
  // a typed query that matches nothing says so instead of failing silently
  await runCommand(page, box, '/model no-such-model')
  await expect(page.getByText('No model matches "no-such-model"')).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('/cost opens the cost meter and /context reports the last request size', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, baseURL)
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  await page.getByText('Open in Slides Studio').first().waitFor()
  const box = page.getByRole('textbox', { name: 'Message' })
  await runCommand(page, box, '/costo')
  await expect(page.getByRole('dialog', { name: 'Spent this month' })).toBeVisible()
  await page.keyboard.press('Escape')
  await box.focus()
  await runCommand(page, box, '/context')
  await expect(page.getByText('The latest request in this chat sent 18,234 tokens to the model')).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

// ---- W1-3: artifact shortcuts, the ink Send button, tools, style and model pickers ----

const picker = (page, name) => page.locator('[data-composer]').getByRole('button', { name })

test('/deck, /memo and /spreadsheet only prefill the message box: nothing is sent', async ({ browser, baseURL }) => {
  const { ctx, page, box, errors } = await open(browser, baseURL)
  await page.route('**/api/chat', (r) => r.abort()) // a send would hit this; none must
  await box.fill('/deck')
  await box.press('Enter')
  await expect(box).toHaveValue('Create a presentation about ')
  await box.fill('/memo quarterly risks')
  await box.press('Enter')
  await expect(box).toHaveValue('Write a memo about quarterly risks')
  await box.fill('/')
  await slashMenu(page).getByRole('option', { name: /^\/spreadsheet/ }).click()
  await expect(box).toHaveValue('Build a spreadsheet with ')
  await expect(box).toBeFocused()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(errors).toEqual([])
  await ctx.close()
})

for (const theme of ['light', 'dark']) {
  test(`the Send button is an ink primary: computed colours equal --action / --on-action (${theme})`, async ({ browser, baseURL }) => {
    const { ctx, page, box } = await open(browser, baseURL, { theme, mobile: false })
    await box.fill('hello')
    const send = page.locator('[data-composer]').getByRole('button', { name: 'Send' })
    await expect(send).toBeEnabled()
    await page.waitForTimeout(400) // the colour transition (150 ms) must have finished
    const c = await send.evaluate((btn) => {
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
    expect(c.bg, JSON.stringify(c)).toBe(c.wantBg)
    expect(c.fg, JSON.stringify(c)).toBe(c.wantFg)
    await ctx.close()
  })
}

test('the tools button shows the icon stack and a count, and the popover is a keyboard dialog', async ({ browser, baseURL }) => {
  const { ctx, page, errors } = await open(browser, baseURL)
  await page.route('**/api/mcp/connections', (r) => r.fulfill({ json: { connections: [] } }))
  const tools = page.locator('[data-composer] button[title="Tools"]')
  await expect(tools).toBeVisible()
  await expect(tools.locator('svg').first()).toBeVisible()
  await tools.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Tools' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('switch', { name: 'Genie One' })).toBeVisible()
  await expect(dialog.getByText('Everything runs with your own login. Your admin decides what shows up here.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(tools).toBeFocused()
  expect(errors).toEqual([])
  await ctx.close()
})

test('selected sources show as chips above the box and the x removes one and saves the chat', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  const sessions = JSON.parse(loadFixtures().routes['GET /api/sessions'].body)
  const withSources = {
    ...sessions,
    sessions: sessions.sessions.map((x) =>
      String(x.id) === String(ids.s1)
        ? { ...x, enabled_tools: [{ kind: 'genie', spaceId: 'sp1', title: 'Sales space' }, { kind: 'vector-search', indexName: 'docs_idx' }] }
        : x
    ),
  }
  await page.route('**/api/sessions', (r) => r.fulfill({ json: withSources }))
  const patches = []
  await page.route(`**/api/sessions/${ids.s1}`, (r) => {
    if (r.request().method() === 'PATCH') {
      patches.push(JSON.parse(r.request().postData() || '{}'))
      return r.fulfill({ json: { ok: true } })
    }
    return r.fallback()
  })
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  const chips = page.getByRole('list', { name: 'Selected sources' })
  await expect(chips.getByText('Sales space')).toBeVisible()
  await expect(chips.getByText('docs_idx')).toBeVisible()
  await chips.getByRole('button', { name: 'Remove source Sales space' }).click()
  await expect(chips.getByText('Sales space')).toHaveCount(0)
  await expect.poll(() => patches.at(-1)?.enabled_tools?.map((t) => t.kind)).toEqual(['vector-search'])
  await ctx.close()
})

test('the style picker writes the chat system_prompt and Escape closes it', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  const patches = []
  await page.route(`**/api/sessions/${ids.s1}`, (r) => {
    if (r.request().method() === 'PATCH') {
      patches.push(JSON.parse(r.request().postData() || '{}'))
      return r.fulfill({ json: { ok: true } })
    }
    return r.fallback()
  })
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  const trigger = picker(page, /^Response style:/)
  await expect(trigger).toBeVisible()
  await trigger.click()
  const menu = page.getByRole('menu', { name: 'Response style' })
  await expect(menu.getByRole('menuitemradio', { name: /Default/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await menu.getByRole('menuitemradio', { name: /Executive/ }).click()
  await expect.poll(() => patches.at(-1)?.system_prompt).toMatch(/senior consultant/)
  await expect(picker(page, 'Response style: Executive')).toBeVisible()
  await ctx.close()
})

// ---- W1-3 QA r1: keyboard handoff between picker copies, and a failed style save ----

const firstModel = JSON.parse(loadFixtures().routes['GET /api/models'].body).models[0]

test('opening the composer model picker by keyboard closes the other picker copy', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  await SCREENS['chat-rich'](page, baseURL, ids)
  const triggers = page.getByRole('button', { name: `Model: ${firstModel.label}` })
  const dialogs = page.getByRole('dialog', { name: 'Models via AI Gateway' })
  const n = await triggers.count()
  await triggers.first().focus()
  await page.keyboard.press('Enter')
  await expect(dialogs).toHaveCount(1)
  await triggers.nth(n - 1).focus()
  await page.keyboard.press('Enter')
  await expect(dialogs).toHaveCount(1)
  await ctx.close()
})

test('opening the composer Tools picker by keyboard closes the other picker copy', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  await page.route('**/api/mcp/connections', (r) => r.fulfill({ json: { connections: [] } }))
  await SCREENS['chat-rich'](page, baseURL, ids)
  const triggers = page.locator('button[title="Tools"]')
  const dialogs = page.getByRole('dialog', { name: 'Tools' })
  const n = await triggers.count()
  await triggers.first().focus()
  await page.keyboard.press('Enter')
  await expect(dialogs).toHaveCount(1)
  await triggers.nth(n - 1).focus()
  await page.keyboard.press('Enter')
  await expect(dialogs).toHaveCount(1)
  await ctx.close()
})

test('a failed style save reverts the picker and says so', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  await page.route(`**/api/sessions/${ids.s1}`, (route) => {
    if (route.request().method() === 'PATCH') return route.fulfill({ status: 500, json: { error: 'save failed' } })
    return route.fallback()
  })
  await SCREENS['chat-rich'](page, baseURL, ids)
  const trigger = page.locator('[data-composer]').getByRole('button', { name: /^Response style:/ })
  await trigger.click()
  await page.getByRole('menu', { name: 'Response style' }).getByRole('menuitemradio', { name: /Executive/ }).click()
  await expect(page.getByRole('alert').filter({ hasText: /style/i })).toBeVisible()
  await expect(trigger).toHaveAccessibleName('Response style: Default')
  await ctx.close()
})

test('a late older style-save failure does not revert a newer saved style', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  let patchCount = 0
  let completedPatchCount = 0
  let releaseFirstPatch
  await page.route(`**/api/sessions/${ids.s1}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    patchCount += 1
    if (patchCount === 1) {
      await new Promise((resolve) => {
        let released = false
        releaseFirstPatch = async () => {
          if (released) return
          released = true
          await route.fulfill({ status: 500, json: { error: 'first save failed late' } })
          resolve()
        }
      })
      return
    }
    await route.fulfill({ status: 200, json: { ok: true } })
    completedPatchCount += 1
  })
  try {
    await SCREENS['chat-rich'](page, baseURL, ids)
    const trigger = page.locator('[data-composer]').getByRole('button', { name: /^Response style:/ })
    await trigger.click()
    await page.getByRole('menu', { name: 'Response style' }).getByRole('menuitemradio', { name: /Executive/ }).click()
    await expect.poll(() => patchCount).toBe(1)
    await expect(trigger).toHaveAccessibleName('Response style: Executive')
    await trigger.click()
    await page.getByRole('menu', { name: 'Response style' }).getByRole('menuitemradio', { name: /Concise/ }).click()
    await expect.poll(() => completedPatchCount).toBe(1)
    await expect(trigger).toHaveAccessibleName('Response style: Concise')
    await releaseFirstPatch()
    await expect(trigger).toHaveAccessibleName('Response style: Concise')
    // the stale failure is not reported either: only the latest request for the chat toasts
    await expect(page.getByRole('alert').filter({ hasText: /style/i })).toHaveCount(0)
  } finally {
    if (releaseFirstPatch) await releaseFirstPatch().catch(() => {})
    await ctx.close()
  }
})

// QA-only r3 probes for a confirmed older save and for chat-switch toasts.
test('a latest failure rolls back to a successful older save that completed while it was pending', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  const patches = []
  let patchCount = 0
  let firstCompleted = 0
  let secondCompleted = 0
  let firstReleased = false
  let secondReleased = false
  let releaseFirst
  let releaseSecond
  await page.route(`**/api/sessions/${ids.s1}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    patches.push(JSON.parse(route.request().postData() || '{}'))
    patchCount += 1
    const complete = async (response, mark) => {
      await route.fulfill(response)
      mark()
    }
    if (patchCount === 1) {
      await new Promise((resolve) => {
        releaseFirst = async () => {
          if (firstReleased) return
          firstReleased = true
          await complete({ status: 200, json: { ok: true } }, () => { firstCompleted += 1 })
          resolve()
        }
      })
      return
    }
    if (patchCount === 2) {
      await new Promise((resolve) => {
        releaseSecond = async () => {
          if (secondReleased) return
          secondReleased = true
          await complete({ status: 500, json: { error: 'newer save failed' } }, () => { secondCompleted += 1 })
          resolve()
        }
      })
      return
    }
    return route.fulfill({ status: 200, json: { ok: true } })
  })
  try {
    await SCREENS['chat-rich'](page, baseURL, ids)
    const trigger = page.locator('[data-composer]').getByRole('button', { name: /^Response style:/ })
    await trigger.click()
    await page.getByRole('menu', { name: 'Response style' }).getByRole('menuitemradio', { name: /Executive/ }).click()
    await expect.poll(() => patchCount).toBe(1)
    await trigger.click()
    await page.getByRole('menu', { name: 'Response style' }).getByRole('menuitemradio', { name: /Concise/ }).click()
    await expect.poll(() => patchCount).toBe(2)
    await releaseFirst()
    await expect.poll(() => firstCompleted).toBe(1)
    await releaseSecond()
    await expect.poll(() => secondCompleted).toBe(1)
    expect(patches.map(Object.keys)).toEqual([['system_prompt'], ['system_prompt']])
    await expect(page.getByRole('alert').filter({ hasText: /style/i })).toBeVisible()
    await expect(trigger).toHaveAccessibleName('Response style: Executive')
  } finally {
    if (releaseFirst) await releaseFirst().catch(() => {})
    if (releaseSecond) await releaseSecond().catch(() => {})
    await ctx.close()
  }
})

test('a failed style save after switching chats shows no stale toast or rollback', async ({ browser, baseURL }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  let patchCount = 0
  let failureReleased = false
  let releaseFailure
  await page.route(`**/api/sessions/${ids.s1}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    patchCount += 1
    await new Promise((resolve) => {
      releaseFailure = async () => {
        if (failureReleased) return
        failureReleased = true
        await route.fulfill({ status: 500, json: { error: 'old chat save failed' } })
        resolve()
      }
    })
  })
  try {
    await SCREENS['chat-rich'](page, baseURL, ids)
    const oldTrigger = page.locator('[data-composer]').getByRole('button', { name: /^Response style:/ })
    await oldTrigger.click()
    await page.getByRole('menu', { name: 'Response style' }).getByRole('menuitemradio', { name: /Executive/ }).click()
    await expect.poll(() => patchCount).toBe(1)
    const otherChat = page.getByRole('button', { name: 'Fix flaky pytest in ingestion job', exact: true })
    await otherChat.click()
    await expect(otherChat).toHaveAttribute('aria-current', 'page')
    const currentTrigger = page.locator('[data-composer]').getByRole('button', { name: /^Response style:/ })
    const currentStyle = await currentTrigger.getAttribute('aria-label')
    await releaseFailure()
    await expect(currentTrigger).toHaveAttribute('aria-label', currentStyle)
    await expect(page.getByRole('alert').filter({ hasText: /style/i })).toHaveCount(0)
  } finally {
    if (releaseFailure) await releaseFailure().catch(() => {})
    await ctx.close()
  }
})
