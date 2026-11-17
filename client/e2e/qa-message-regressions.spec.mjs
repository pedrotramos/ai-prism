import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext } from './lib.mjs'

const fx = loadFixtures()
const { ids } = fx

// W1-8 acceptance: every touch action target is at least 44×44 CSS px.
test('the code wrap toggle is a 44px touch target', async ({ browser }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: true })
  try {
    const page = await ctx.newPage()
    await page.goto(`/#/chat/${ids.s2}`)
    const wrap = page.getByRole('button', { name: 'Wrap lines' })
    await wrap.waitFor()
    await wrap.scrollIntoViewIfNeeded()
    const box = await wrap.boundingBox()
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
  } finally {
    await ctx.close()
  }
})

// Baseline ux#4: a partial answer marked as an error must not offer ordinary
// Copy/Listen/PDF/Regenerate actions beside the Retry recovery action.
test('a partial error notice hides the message action toolbar', async ({ browser }) => {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  try {
    const page = await ctx.newPage()
    const key = `GET /api/sessions/${ids.s3}/messages`
    const body = JSON.parse(fx.routes[key].body)
    const model = fx.routes[`GET /api/sessions/${ids.s1}/messages`].body
    const modelId = JSON.parse(model).messages.find((m) => m.role === 'assistant').model
    body.messages.push({
      id: 'qa-partial-error', role: 'assistant',
      content: 'Partial response.\n\n⚠️ The answer stopped after an upstream failure.',
      attachments: null, model: modelId, prompt_tokens: 1, completion_tokens: 2,
      blocks: null, tool_calls: null, created_at: '2026-11-17T07:09:00.000Z', reasoning: null,
    })
    await page.route(`**/api/sessions/${ids.s3}/messages`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    )
    await page.goto(`/#/chat/${ids.s3}`)
    const row = page.locator('[data-msg-role="assistant"]').last()
    await expect(row.locator('[data-notice="error"]')).toBeVisible()
    await expect(row.getByRole('button', { name: 'Retry' })).toBeVisible()
    await expect(row.locator('[data-msg-actions]')).toHaveCount(0)
  } finally {
    await ctx.close()
  }
})
