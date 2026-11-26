// W3-3: DocumentStudio Export waits for an in-flight save. DOCX/Markdown export
// fetch the PERSISTED document, so while a write is pending Export would hand out
// the old text next to a preview that shows the new one (same trap as the sheet,
// W3-2). Every write path (Accept, manual Save, Retry) marks the save busy.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { loadFixtures, newVariantContext } from './lib.mjs'

const { ids, routes } = (() => {
  const fx = loadFixtures()
  return { ids: fx.ids, routes: fx.routes }
})()
const docBlock = JSON.parse(routes[`GET /api/sessions/${ids.s1}/messages`].body).messages.find((m) => m.id === '60').blocks.find((b) => b.type === 'document')
const SAVED = { id: ids.doc, title: docBlock.title, markdown: docBlock.markdown }
const PREVIEW_MD = '# Rewritten memo\n\nAI preview text.\n'

// a stateful document backend whose PATCH can be held (and failed) by the test
async function setup(browser, baseURL, { failFirstPatch = false } = {}) {
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const server = { doc: { ...SAVED }, patches: 0, startedResolvers: [] }
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const started = () => new Promise((resolve) => server.startedResolvers.push(resolve))
  server.release = release
  server.started = started
  await ctx.route(`**/api/documents/${ids.doc}/tweak`, (route) =>
    route.fulfill({ json: { document: { ...server.doc, markdown: PREVIEW_MD }, model: 'test', usage: { prompt_tokens: 1 } } }),
  )
  await ctx.route(`**/api/documents/${ids.doc}/export*`, (route) =>
    route.fulfill({ contentType: 'text/markdown', body: server.doc.markdown }),
  )
  await ctx.route(`**/api/documents/${ids.doc}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fulfill({ json: { document: server.doc } })
    server.patches += 1
    if (failFirstPatch && server.patches === 1) return route.fulfill({ status: 500, json: { error: 'save failed' } })
    // the write commits, its response is still on the wire
    server.doc = { ...server.doc, ...route.request().postDataJSON() }
    server.startedResolvers.splice(0).forEach((r) => r())
    await gate
    return route.fulfill({ json: { document: server.doc } })
  })
  const page = await ctx.newPage()
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  await page.getByRole('button', { name: 'Open', exact: true }).first().click()
  const root = page.locator('[data-studio="doc"]')
  await root.waitFor()
  return { ctx, page, root, server }
}

async function applyTweak(root) {
  const panel = root.locator('[data-studio-ai-panel]')
  await panel.getByRole('textbox').fill('Rewrite this document')
  await panel.getByRole('button', { name: /Apply/ }).click()
  return panel.getByRole('button', { name: 'Accept & save' })
}

test('document: Export is disabled while Accept is saving, then exports the new Markdown', async ({ browser, baseURL }) => {
  const { ctx, page, root, server } = await setup(browser, baseURL)
  try {
    const accept = await applyTweak(root)
    const started = server.started()
    await accept.click()
    await started
    const exportBtn = root.locator('[data-studio-export]')
    await expect(exportBtn).toBeDisabled()
    await expect(exportBtn).toHaveAttribute('title', /Saving your changes/)
    server.release()
    await expect(exportBtn).toBeEnabled()
    await expect(exportBtn).not.toHaveAttribute('title', /.+/)
    const download = page.waitForEvent('download')
    await exportBtn.click()
    await page.getByRole('menuitem', { name: /Markdown/ }).click()
    const path = await (await download).path()
    expect(readFileSync(path, 'utf8')).toBe(PREVIEW_MD)
  } finally {
    server.release()
    await ctx.close()
  }
})

test('document: Export is disabled while a manual Save is in flight', async ({ browser, baseURL }) => {
  const { ctx, root, server } = await setup(browser, baseURL)
  try {
    await root.getByRole('button', { name: 'Edit', exact: true }).click()
    const editor = root.getByRole('textbox', { name: 'Document text editor' })
    await editor.click()
    await editor.pressSequentially(' More.')
    const started = server.started()
    await root.getByRole('button', { name: 'Save', exact: true }).click()
    await started
    const exportBtn = root.locator('[data-studio-export]')
    await expect(exportBtn).toBeDisabled()
    await expect(exportBtn).toHaveAttribute('title', /Saving your changes/)
    server.release()
    await expect(exportBtn).toBeEnabled()
  } finally {
    server.release()
    await ctx.close()
  }
})

test('document: Export stays disabled while retrying a failed save', async ({ browser, baseURL }) => {
  const { ctx, root, server } = await setup(browser, baseURL, { failFirstPatch: true })
  try {
    const accept = await applyTweak(root)
    await accept.click()
    await expect(root.locator('[data-save-status="error"]')).toBeVisible()
    const exportBtn = root.locator('[data-studio-export]')
    await expect(exportBtn).toBeEnabled()
    const started = server.started()
    await root.locator('[data-save-status="error"]').getByRole('button', { name: 'Retry' }).click()
    await started
    await expect(exportBtn).toBeDisabled()
    await expect(exportBtn).toHaveAttribute('title', /Saving your changes/)
    server.release()
    await expect(exportBtn).toBeEnabled()
  } finally {
    server.release()
    await ctx.close()
  }
})
