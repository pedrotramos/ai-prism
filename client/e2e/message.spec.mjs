// Chat message and inline blocks (W1-8): touch-reachable actions, tool-call
// chip states, reasoning disclosure, code blocks, markdown tables, recovery
// notices, artifact cards in the narrow pane, the chart's text alternative and
// the streaming performance budget. Runs on the built client behind the
// fixture server; extra message shapes are served with page.route so the
// recorded fixtures stay untouched.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { loadFixtures, newVariantContext, AXE_TAGS } from './lib.mjs'

const fx = loadFixtures()
const { ids } = fx
const DESKTOP = { theme: 'dark', mobile: false }
const MOBILE = { theme: 'light', mobile: true }

async function open(browser, variant = DESKTOP) {
  const ctx = await newVariantContext(browser, variant)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  return { ctx, page, errors }
}

const sessionBody = (id) => JSON.parse(fx.routes[`GET /api/sessions/${id}/messages`].body)
const MODEL = sessionBody(ids.s1).messages[1].model

// Serves session s3 with extra rows appended after its user message.
async function serveS3(page, extra, patchUser = (u) => u) {
  const body = sessionBody(ids.s3)
  body.messages = [patchUser(body.messages[0]), ...extra]
  await page.route(`**/api/sessions/${ids.s3}/messages`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  )
  await page.goto(`/#/chat/${ids.s3}`)
}

const assistant = (id, content, more = {}) => ({
  id: String(id),
  role: 'assistant',
  content,
  attachments: null,
  model: MODEL,
  prompt_tokens: 120,
  completion_tokens: 80,
  blocks: null,
  tool_calls: null,
  created_at: '2026-11-17T07:09:00.000Z',
  media_processing: null,
  intent_classify: null,
  reasoning: null,
  ...more,
})

async function startStream(page) {
  await page.goto('/#/chat')
  await page.locator('textarea').first().fill('Revenue by region?')
  await page.locator('button[title="Send"]').click()
  await page.waitForFunction(() => !!window.__sse)
  await page.evaluate((sid) => window.__sse.push({ type: 'meta', sessionId: sid, isNew: true }), ids.s2)
}
const push = (page, ev) => page.evaluate((e) => window.__sse.push(e), ev)
const box = async (loc) => {
  const b = await loc.boundingBox()
  return { w: Math.round(b.width), h: Math.round(b.height) }
}

test('a persisted attachment list with objects renders its names instead of blanking the app', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await serveS3(page, [assistant(900, 'Here is the draft.')], (u) => ({
    ...u,
    attachments: JSON.stringify([{ name: 'q3.xlsx', size: 1234 }, 'notes.txt']),
  }))
  await expect(page.getByText('q3.xlsx')).toBeVisible()
  await expect(page.getByText('notes.txt')).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('tool chips go running → done with a duration, and no Thinking row while one runs', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await startStream(page)
  await push(page, { type: 'token', value: 'Let me check the sales tables.' })
  await push(page, { type: 'tool_call', id: 'c1', name: 'ask_genie_one', label: 'Asking Genie One', args: { question: 'Q3 revenue by region' } })
  await push(page, { type: 'tool_progress', id: 'c1', elapsedMs: 4200 })
  const chip = page.locator('[data-tool-state]').first()
  await expect(chip).toHaveAttribute('data-tool-state', 'running')
  await expect(chip).toContainText('4s')
  await page.waitForTimeout(300)
  await expect(page.getByText('Thinking…')).toHaveCount(0)
  // the streaming region is announced politely, not on every token
  await expect(page.locator('[aria-live="polite"]').first()).toBeAttached()

  await push(page, { type: 'tool_result', id: 'c1', status: 'ok', result: '| region | Q3 |\n|---|---|\n| EMEA | 30.6 |', durationMs: 4210 })
  await expect(chip).toHaveAttribute('data-tool-state', 'done')
  await expect(chip).toContainText('4.2s')
  // between tool rounds the model is deciding: now the Thinking row is the signal
  await expect(page.getByText('Thinking…')).toBeVisible()

  // expanding the chip shows the narration (question + result)
  const toggle = chip.getByRole('button').first()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(chip).toContainText('Q3 revenue by region')
  await expect(chip.getByRole('cell', { name: 'EMEA' })).toBeVisible()
  await page.evaluate(() => {
    window.__sse.push({ type: 'done' })
    window.__sse.end()
  })
  expect(errors).toEqual([])
  await ctx.close()
})

test('a failed tool chip names the reason without being expanded', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  const tc = { id: 'f1', name: 'uc_query', label: 'Unity Catalog', args: { table: 'main.sales.x' }, status: 'error', durationMs: 1500, result: 'PERMISSION_DENIED: no USE CATALOG on main\nat line 3' }
  await serveS3(page, [assistant(901, 'Trying the table.\n\n{{toolcall:f1}}\n\nI could not read it.', { tool_calls: [tc] })])
  const chip = page.locator('[data-tool-state="failed"]').first()
  await expect(chip).toBeVisible()
  await expect(chip).toContainText('PERMISSION_DENIED: no USE CATALOG on main')
  await expect(chip).toContainText('1.5s')
  expect(errors).toEqual([])
  await ctx.close()
})

test('the reasoning trace is a native disclosure, collapsed once the answer is there', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await serveS3(page, [assistant(902, 'The answer.', { reasoning: 'First I compared both quarters.' })])
  const details = page.locator('details', { has: page.locator('summary', { hasText: 'Reasoning' }) }).first()
  await expect(details).toBeVisible()
  await expect(details).not.toHaveAttribute('open', '')
  await details.locator('summary').click()
  await expect(details.getByText('First I compared both quarters.')).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('code blocks show the language, copy and a wrap toggle', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'])
  const longLine = 'result = ' + 'compute_metric(x) + '.repeat(20) + '0'
  await serveS3(page, [assistant(903, 'Try this:\n\n```python\n' + longLine + '\n```')])
  const block = page.locator('.code-block').first()
  await expect(block.locator('.code-block-lang')).toHaveText('python')
  const pre = block.locator('pre')
  const wrap = block.getByRole('button', { name: 'Wrap lines' })
  await expect(wrap).toHaveAttribute('aria-pressed', 'false')
  expect(await pre.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true)
  await wrap.click()
  await expect(wrap).toHaveAttribute('aria-pressed', 'true')
  expect(await pre.evaluate((e) => getComputedStyle(e.querySelector('code')).whiteSpace)).toBe('pre-wrap')
  await block.getByRole('button', { name: 'Copy code' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(longLine)
  expect(errors).toEqual([])
  await ctx.close()
})

test('markdown tables scroll in their own container with a sticky header', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  const rows = Array.from({ length: 40 }, (_, i) => `| region ${i} | ${i * 3} | ${i * 7} | ${i * 11} | ${i * 13} | ${i * 17} |`).join('\n')
  const md = 'Data:\n\n| Region | Q1 | Q2 | Q3 | Q4 | FY |\n|---|---|---|---|---|---|\n' + rows
  await serveS3(page, [assistant(904, md)])
  const scroller = page.locator('.prose-chat .table-scroll').first()
  await expect(scroller).toBeVisible()
  expect(await scroller.evaluate((e) => getComputedStyle(e).overflowY)).toBe('auto')
  expect(await scroller.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true)
  expect(await scroller.locator('th').first().evaluate((e) => getComputedStyle(e).position)).toBe('sticky')
  // keyboard users can scroll it: focusable and named
  expect(await scroller.getAttribute('tabindex')).toBe('0')
  expect(await scroller.getAttribute('aria-label')).toBeTruthy()
  expect(errors).toEqual([])
  await ctx.close()
})

test('a stopped-early notice offers Retry, which regenerates the turn', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  const text = 'Here is the first half.\n\nℹ️ I reached the time limit for queries in this turn. The reply above uses the data gathered so far; ask me to continue for anything missing.'
  await serveS3(page, [assistant(905, text)])
  const notice = page.locator('[data-notice="stopped"]').first()
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('I reached the time limit')
  await notice.getByRole('button', { name: 'Retry' }).click()
  await page.waitForFunction(() => !!window.__sse)
  expect(errors).toEqual([])
  await ctx.close()
})

test('a truncated answer shows an error notice with Retry', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await serveS3(page, [assistant(906, 'Partial.\n\n⚠️ The reply hit the model\'s output token limit and came back incomplete.')])
  const notice = page.locator('[data-notice="error"]').first()
  await expect(notice).toBeVisible()
  await expect(notice.getByRole('button', { name: 'Retry' })).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('an empty assistant row after an HTTP 500 has no action toolbar', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await page.goto('/#/chat')
  await page.evaluate(() => {
    window.__sseMode = 'http500'
  })
  await page.locator('textarea').first().fill('Hello')
  await page.locator('button[title="Send"]').click()
  await expect(page.getByText(/upstream model temporarily unavailable/).first()).toBeVisible()
  const row = page.locator('[data-msg-role="assistant"]').last()
  await expect(row).toBeAttached()
  await expect(row.locator('[data-msg-actions]')).toHaveCount(0)
  expect(errors).toEqual([])
  await ctx.close()
})

test('desktop message actions are named and at least 32 px', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await page.goto(`/#/chat/${ids.s2}`)
  const bar = page.locator('[data-msg-role="assistant"] [data-msg-actions]').first()
  await expect(bar).toBeVisible()
  const buttons = bar.getByRole('button')
  const n = await buttons.count()
  expect(n).toBeGreaterThanOrEqual(4)
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i)
    expect(await b.getAttribute('aria-label'), `button ${i} has a name`).toBeTruthy()
    const s = await box(b)
    expect(s.w, `button ${i} width`).toBeGreaterThanOrEqual(32)
    expect(s.h, `button ${i} height`).toBeGreaterThanOrEqual(32)
  }
  expect(errors).toEqual([])
  await ctx.close()
})

test('on touch, the user-message actions appear on tap and are at least 44 px', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser, MOBILE)
  await page.goto(`/#/chat/${ids.s2}`)
  const row = page.locator('[data-msg-role="user"]').first()
  await expect(row).toBeVisible()
  const copy = row.getByRole('button', { name: 'Copy message' })
  await expect(copy).toHaveCSS('opacity', '0')
  await row.locator('[data-msg-bubble]').tap()
  await expect(copy).toHaveCSS('opacity', '1')
  const s = await box(copy)
  expect(s.w).toBeGreaterThanOrEqual(44)
  expect(s.h).toBeGreaterThanOrEqual(44)
  expect(errors).toEqual([])
  await ctx.close()
})

test('artifact cards keep their title and meta readable in the narrow pane beside a studio', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await page.goto(`/#/chat/${ids.s1}`)
  const openDeck = page.getByText('Open in Slides Studio').first()
  await openDeck.waitFor()
  await openDeck.click()
  await page.locator('iframe').first().waitFor()
  for (const kind of ['deck', 'spreadsheet', 'document']) {
    const card = page.locator(`[data-artifact-card="${kind}"]`).first()
    await card.scrollIntoViewIfNeeded({ timeout: 10_000 })
    const title = await box(card.locator('[data-card-title]'))
    const meta = await box(card.locator('[data-card-meta]'))
    expect(title.w, `${kind} title width`).toBeGreaterThan(120)
    expect(meta.h, `${kind} meta is one line`).toBeLessThanOrEqual(20)
    // one anatomy: every card has exactly one primary action
    await expect(card.locator('[data-card-primary]')).toHaveCount(1)
  }
  // ux#20: the document teaser is prose, not table syntax
  const teaser = await page.locator('[data-artifact-card="document"] [data-card-body]').first().innerText()
  expect(teaser).toContain('Revenue grew 8.4% QoQ')
  expect(teaser).not.toContain('|')
  expect(errors).toEqual([])
  await ctx.close()
})

test('the chart has a text alternative and a View data table', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await page.goto(`/#/chat/${ids.s1}`)
  const chart = page.locator('[data-block="chart"]').first()
  await chart.waitFor({ timeout: 15_000 })
  const img = chart.locator('[role="img"]')
  await expect(img).toHaveAttribute('aria-label', /Revenue by region/)
  await expect(img).toHaveAttribute('aria-label', /Q2/)
  const toggle = chart.getByRole('button', { name: 'View data' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(chart.getByRole('cell', { name: 'North America' })).toBeVisible()
  await expect(chart.getByRole('columnheader', { name: 'Q3' })).toBeVisible()
  // the comparison (first) series is not painted with the brand red
  const fills = await chart.locator('.recharts-bar-rectangle path, .recharts-bar-rectangle rect').evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).fill))])
  expect(fills.length).toBeGreaterThanOrEqual(2)
  expect(fills).not.toContain('rgb(255, 54, 33)')
  expect(errors).toEqual([])
  await ctx.close()
})

test('the rich chat thread has no serious or critical axe violations', async ({ browser }) => {
  for (const variant of [DESKTOP, MOBILE]) {
    const { ctx, page, errors } = await open(browser, variant)
    await page.goto(`/#/chat/${ids.s1}`)
    await page.getByText('Open in Slides Studio').first().waitFor()
    await page.waitForTimeout(1200)
    const res = await new AxeBuilder({ page }).include('[data-msg-role]').withTags(AXE_TAGS).analyze()
    const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`)
    expect(bad, `${variant.theme} ${variant.mobile ? 'mobile' : 'desktop'}`).toEqual([])
    expect(errors).toEqual([])
    await ctx.close()
  }
})

test('a 2,000-token stream keeps every main-thread task under 50 ms', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await startStream(page)
  await page.evaluate(() => {
    window.__longTasks = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration))
    }).observe({ type: 'longtask', buffered: false })
  })
  // ~2,000 tokens of realistic markdown (paragraphs, a list, a code fence,
  // a table), fed 20 tokens per 16 ms tick like a fast model would stream them
  const total = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const words = []
        for (let s = 0; s < 24; s++) {
          words.push(`\n\n### Section ${s + 1}\n\n`)
          for (let i = 0; i < 90; i++) words.push(i % 17 === 16 ? 'revenue.\n\n' : `word${i} `)
          words.push('\n\n- first point about **growth**\n- second point with `code`\n')
          if (s % 4 === 1) words.push('\n```python\nfor r in rows:\n    print(r)\n```\n')
          if (s % 4 === 3) words.push('\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n')
        }
        const tokens = words.slice(0, 2000)
        let i = 0
        const t = setInterval(() => {
          for (let k = 0; k < 20 && i < tokens.length; k++, i++) window.__sse.push({ type: 'token', value: tokens[i] })
          if (i >= tokens.length) {
            clearInterval(t)
            resolve(tokens.length)
          }
        }, 16)
      })
  )
  expect(total).toBe(2000)
  await page.waitForTimeout(500)
  const long = await page.evaluate(() => window.__longTasks)
  expect(long, 'main-thread tasks over 50 ms during the stream').toEqual([])
  await page.evaluate(() => {
    window.__sse.push({ type: 'done' })
    window.__sse.end()
  })
  expect(errors).toEqual([])
  await ctx.close()
})

test('hostile markdown in an answer and in a tool result comes out inert, and code keeps its characters', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  const hostile =
    'Look <script>window.__xss = 1</script> here <img src="x" onerror="window.__xss = 2">\n\n' +
    '[click me](javascript:window.__xss=3) and <a href="javascript:window.__xss=4">raw link</a>\n\n' +
    '```html\n<div class="card">List<String></div>\n```'
  const tc = { id: 'h1', name: 'uc_query', label: 'Unity Catalog', args: { q: 'x' }, status: 'ok', durationMs: 10, result: '<img src="y" onerror="window.__xss = 5"> [tool link](javascript:window.__xss=6)' }
  await serveS3(page, [assistant(907, hostile + '\n\n{{toolcall:h1}}', { tool_calls: [tc] })])
  const row = page.locator('[data-msg-role="assistant"]').last()
  await expect(row.locator('.code-block')).toBeVisible()
  await row.locator('[data-tool-state]').getByRole('button').first().click()
  await expect(row.getByText('tool link')).toBeVisible()
  await page.waitForTimeout(300)
  // (the tool chip's own icon is an <img>; only injected elements count)
  expect(await row.locator('script, iframe, img[src="x"], img[src="y"], img[onerror]').count()).toBe(0)
  const hrefs = await row.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href') || ''))
  expect(hrefs.filter((h) => /^\s*javascript:/i.test(h))).toEqual([])
  // a link whose destination was unsafe is neutralised to "#" before rendering
  expect(await row.getByRole('link', { name: 'click me' }).getAttribute('href')).toBe('#')
  expect(await page.evaluate(() => window.__xss)).toBeUndefined()
  // raw tags read as text; code is shown exactly as written
  await expect(row).toContainText('<script>window.__xss = 1</script>')
  await expect(row.locator('.code-block pre')).toHaveText('<div class="card">List<String></div>')
  expect(errors).toEqual([])
  await ctx.close()
})

test('on touch, every control in the thread is at least 44 × 44 px', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser, MOBILE)
  const tc = { id: 't1', name: 'uc_query', label: 'Unity Catalog', args: { q: 'x' }, status: 'ok', durationMs: 10, result: 'ok' }
  await serveS3(page, [
    assistant(908, 'Code:\n\n```python\nprint(1)\n```\n\n{{toolcall:t1}}', { tool_calls: [tc], reasoning: 'Checked.' }),
    assistant(909, 'Partial.\n\nℹ️ Stopped on the round limit.'),
  ])
  await expect(page.locator('.code-block').first()).toBeVisible()
  // measure the settled layout: web fonts loaded and the row entrance finished
  await page.evaluate(() => document.fonts.ready)
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity))
  const small = await page.locator('[data-msg-role]').evaluateAll((rows) => {
    const out = []
    for (const row of rows) {
      for (const el of row.querySelectorAll('button, summary, input, select, textarea, a[href]')) {
        // inline links inside a sentence are exempt (WCAG 2.5.8 "inline")
        if (el.tagName === 'A' && el.closest('p, li, td')) continue
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (r.width < 44 || r.height < 44) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}" ${r.width.toFixed(2)}×${r.height.toFixed(2)}`)
      }
    }
    return out
  })
  expect(small).toEqual([])
  expect(errors).toEqual([])
  await ctx.close()
})
