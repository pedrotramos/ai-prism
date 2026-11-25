import { test, expect } from '@playwright/test'
import { loadFixtures, newVariantContext } from './lib.mjs'

const fx = loadFixtures()
const { ids } = fx
const blocks = JSON.parse(fx.routes[`GET /api/sessions/${ids.s1}/messages`].body).messages.find((m) => m.id === '60').blocks
const docBlock = blocks.find((b) => b.type === 'document')
const sheetBlock = blocks.find((b) => b.type === 'spreadsheet')
const sheet = {
  id: ids.sheet,
  title: sheetBlock.title,
  sheets: [
    ...sheetBlock.sheets,
    { name: 'Analise', blocks: [{ kind: 'title', text: 'Analise' }, { kind: 'table', columns: [{ header: 'Ticket' }, { header: 'Margem' }, { header: 'Custo' }], rows: [[10, 2, 4], [20, 5, 6], [30, 7, 9]] }] },
  ],
}

async function openStudio(browser, baseURL, kind, mobile = true, locale) {
  const ctx = await newVariantContext(browser, { theme: 'light', mobile })
  if (locale) await ctx.addInitScript((l) => Object.defineProperty(navigator, 'language', { get: () => l }), locale)
  await ctx.route(`**/api/documents/${ids.doc}`, (route) => route.fulfill({ json: { document: { id: ids.doc, title: docBlock.title, markdown: docBlock.markdown } } }))
  await ctx.route(`**/api/spreadsheets/${ids.sheet}`, (route) => route.fulfill({ json: { spreadsheet: sheet } }))
  await ctx.route('**/api/deck-templates/selected', (route) => route.fulfill({ json: { template: null } }))

  const page = await ctx.newPage()
  await page.goto(`${baseURL}/#/chat/${ids.s1}`)
  const cardKind = kind === 'doc' ? 'document' : 'spreadsheet'
  await page.locator(`[data-artifact-card="${cardKind}"]`).waitFor()
  const opener = page.locator(`[data-artifact-card="${cardKind}"] [data-card-primary]`)
  await opener.scrollIntoViewIfNeeded()
  await opener.click()
  const root = page.locator(`[data-studio="${kind}"]`)
  await root.waitFor()
  return { ctx, page, root }
}

test('W2-2 studios keep 44 px targets at 390 px, including selection actions', async ({ browser, baseURL }) => {
  for (const kind of ['doc', 'sheet']) {
    const { ctx, page, root } = await openStudio(browser, baseURL, kind)
    try {
      if (kind === 'sheet') {
        const first = root.locator('[data-rc="5-1"]')
        const last = root.locator('[data-rc="6-2"]')
        await first.click()
        await last.click({ modifiers: ['Shift'] })
        const quick = root.locator('[data-quick-actions]')
        await expect(quick).toBeVisible()
        const [a, z, bar] = await Promise.all([first.boundingBox(), last.boundingBox(), quick.boundingBox()])
        const rangeTop = Math.min(a.y, z.y)
        const rangeBottom = Math.max(a.y + a.height, z.y + z.height)
        expect(bar.y + bar.height <= rangeTop || bar.y >= rangeBottom, 'selection toolbar does not cover any selected cell').toBe(true)
        for (const name of ['Ask AI', 'Add % variance', 'Chart from selection', 'Explain formula']) {
          await expect(quick.getByRole('button', { name })).toBeVisible()
        }
      }

      const smallTargets = await page.evaluate(() =>
        [...document.querySelectorAll('button, select, input:not([type=hidden]), [role=button], [role=switch]')]
          .filter((e) => {
            const r = e.getBoundingClientRect()
            const cs = getComputedStyle(e)
            return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.closest('iframe, [inert]')
          })
          .map((e) => ({ label: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 40), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) }))
          .filter((x) => x.w < 44 || x.h < 44)
      )
      expect(smallTargets, `${kind}: visible controls under 44 by 44 px`).toEqual([])
    } finally {
      await ctx.close()
    }
  }
})

for (const kind of ['doc', 'sheet']) {
  test(`W2-2 docked ${kind} studio keeps one app-level h1 per screen`, async ({ browser, baseURL }) => {
    const { ctx, page } = await openStudio(browser, baseURL, kind, false)
    try {
      const headings = await page.evaluate(() =>
        [...document.querySelectorAll('h1')]
          .filter((h) => !h.closest('[role="region"][aria-label="Document page"]'))
          .map((h) => h.textContent.trim()),
      )
      expect(headings, `${kind}: app-level h1`).toHaveLength(1)
      expect(headings[0], `${kind}: h1 has text`).not.toBe('')
    } finally {
      await ctx.close()
    }
  })
}

for (const [locale, label, instruction] of [
  ['en-US', 'Explain formula', 'Explain in plain language what the formula in B5 calculates, in a note under its table. Do not change any value, formula or format.'],
  ['pt-BR', 'Explicar fórmula', 'Explique em linguagem simples o que a fórmula em B5 calcula, numa nota abaixo da tabela. Não altere nenhum valor, fórmula ou formato.'],
  ['es-ES', 'Explicar fórmula', 'Explica en lenguaje sencillo qué calcula la fórmula en B5, en una nota bajo su tabla. No cambies ningún valor, fórmula ni formato.'],
]) {
  test(`W2-2 Explain formula uses localized prompt and the existing tweak request (${locale})`, async ({ browser, baseURL }) => {
    const { ctx, root } = await openStudio(browser, baseURL, 'sheet', false, locale)
    const bodies = []
    try {
      await ctx.route(`**/api/spreadsheets/${ids.sheet}/tweak`, async (route) => {
        bodies.push(route.request().postDataJSON())
        return route.fulfill({ json: { spreadsheet: sheet, model: 'test-model' } })
      })
      const quick = root.locator('[data-quick-actions]')
      await root.locator('[data-rc="5-1"]').click()
      await expect(quick.getByRole('button', { name: label, exact: true })).toBeVisible()
      await quick.getByRole('button', { name: label, exact: true }).click()
      await expect.poll(() => bodies.length).toBe(1)
      expect(bodies[0].instruction).toBe(instruction)
      expect(Object.keys(bodies[0]).sort()).toEqual(['instruction', 'model', 'preview', 'sheetIndex'])
      expect(bodies[0]).toMatchObject({ preview: true, sheetIndex: 0 })
    } finally {
      await ctx.close()
    }
  })
}
