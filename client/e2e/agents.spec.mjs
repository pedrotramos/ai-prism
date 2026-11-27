// Scheduled agents UI (W4-4e). Every /api/agents* and /api/admin/agents* request is answered with page.route
// from client/e2e/fixtures/agents.json (no backend), so the shared fixture file keeps its "no misses" check.
// The mock "server" keeps the agent state and applies the same state machine as the real routes.
//
// AC1 hidden entirely while the status is off (no nav entry, no route content, no admin tab)
// AC2 create → submit → (admin) approve → enable → run now → history shows the run linked to its chat
// AC3 editing an approved agent warns BEFORE saving that approval will be voided
// AC4 presets show the next three occurrences from the server's preview, in the chosen tz; the tz defaults to the browser's
// AC5 errors are shown through the catalogs by code, never the server text
// AC6 axe clean at 1440 and 390, light and dark
// AC7 no copy says "for a customer"
// W1-8 (ui-revamp): the list is a card grid with search and status chips; every action lives in a detail drawer
//   (focus trap, Escape, focus back); ink primary buttons; the model mark beside the editor's select
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFileSync } from 'node:fs'
import { AXE_TAGS, VARIANTS, newVariantContext, variantName } from './lib.mjs'

const FX = JSON.parse(readFileSync(new URL('./fixtures/agents.json', import.meta.url), 'utf8'))
// the real server compares canonical (key-sorted) JSON, so key order never voids an approval
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))
const LIMITS = { nameMax: 80, descriptionMax: 500, instructionsMax: 8000, promptMax: 4000, toolsMax: 12, agentsPerOwner: 10 }

function makeServer({ status = { enabled: true } } = {}) {
  const server = { status, agents: [], runs: {}, nextId: 1, calls: [], forced: [], previews: [], settings: { ...FX.settings }, saved: [], finishRuns: false, toolOptions: FX.toolOptions }
  server.refuse = (match, httpStatus, code) => server.forced.push({ match, httpStatus, code })
  server.add = (over = {}) => {
    const a = {
      id: String(server.nextId++), ownerEmail: FX.me, name: 'Weekly sales', description: 'Summarises last week', revision: 1, status: 'draft', approvalExpiresAt: null, decisionReason: null,
      enabled: false, nextRunAt: null, lastRunAt: null, consecutiveFailures: 0, disabledReason: null, createdAt: FX.now, updatedAt: FX.now,
      definition: { instructions: '', prompt: 'Summarise last week.', model: FX.models[0], reasoningEffort: null, tools: ['web_search'], schedule: { freq: 'weekly', minute: 0, hour: 8, weekday: 1, tz: 'America/Sao_Paulo' }, lang: 'en' },
      ...over,
    }
    server.agents.push(a)
    return a
  }
  return server
}

async function install(page, server) {
  const json = (route, body, status = 200) => route.fulfill({ status, json: body })
  await page.route('**/api/agents/status', (r) => json(r, server.status))
  await page.route('**/api/agents/schedule-preview', (r) => {
    server.previews.push(r.request().postDataJSON())
    return json(r, FX.preview)
  })
  await page.route(/\/api\/agents(\/[^?]*)?(\?.*)?$/, async (r) => {
    const req = r.request()
    const method = req.method()
    const path = new URL(req.url()).pathname
    if (path === '/api/agents/status' || path === '/api/agents/schedule-preview' || path === '/api/agents/tool-options') return r.fallback()
    server.calls.push(`${method} ${path}`)
    const at = server.forced.findIndex((f) => f.match(method, path))
    if (at >= 0) {
      const [f] = server.forced.splice(at, 1)
      return json(r, { error: f.code, code: f.code }, f.httpStatus)
    }
    const seg = path.split('/').slice(3)
    if (seg.length === 0) {
      if (method === 'GET') return json(r, { agents: server.agents, limits: LIMITS })
      if (method === 'POST') {
        const { name, description, ...definition } = req.postDataJSON()
        return json(r, server.add({ name, description, definition }), 201)
      }
    }
    const a = server.agents.find((x) => x.id === seg[0])
    if (!a) return json(r, { error: 'not_found', code: 'not_found' }, 404)
    const sub = seg[1]
    if (!sub && method === 'PATCH') {
      const { revision, name, description, ...definition } = req.postDataJSON()
      server.saved.push(req.postDataJSON())
      if (revision !== a.revision) return json(r, { error: 'conflict', code: 'conflict' }, 409)
      const voided = canon(definition) !== canon(a.definition) && ['approved', 'pending'].includes(a.status)
      Object.assign(a, { name, description, definition, revision: a.revision + 1 })
      if (voided) Object.assign(a, { status: 'draft', enabled: false, nextRunAt: null, approvalExpiresAt: null })
      return json(r, a)
    }
    if (!sub && method === 'DELETE') {
      server.agents.splice(server.agents.indexOf(a), 1)
      return r.fulfill({ status: 204 })
    }
    if (sub === 'submit') return (a.status = 'pending'), json(r, a)
    if (sub === 'enable') return Object.assign(a, { enabled: true, nextRunAt: FX.preview.next[0] }), json(r, a)
    if (sub === 'disable') return Object.assign(a, { enabled: false, nextRunAt: null }), json(r, a)
    if (sub === 'run') {
      server.runs[a.id] = [{ id: FX.run.id, agentId: a.id, trigger: 'manual', slotAt: FX.now, status: 'queued', errorCode: null, startedAt: null, finishedAt: null, sessionId: null, costUsd: null, unpriced: false, toolNames: [] }]
      return json(r, { run: server.runs[a.id][0] }, 202)
    }
    if (sub === 'runs') {
      const list = (server.runs[a.id] || []).map((x) => (server.finishRuns ? { ...x, ...FX.run, agentId: a.id, startedAt: FX.now, finishedAt: FX.now, slotAt: FX.now } : x))
      return json(r, { runs: list })
    }
    return json(r, { error: 'not_found', code: 'not_found' }, 404)
  })
  // what an owner may put on an agent (the server filters: admitted kinds, databricks-class catalog services only)
  await page.route('**/api/agents/tool-options', (r) => json(r, server.toolOptions))
  await page.route('**/api/admin/agents/settings', (r) => {
    if (r.request().method() === 'PUT') {
      Object.assign(server.settings, r.request().postDataJSON())
      server.calls.push('PUT settings')
    }
    return json(r, server.settings)
  })
  await page.route(/\/api\/admin\/agents(\?.*)?$/, (r) => {
    const rows = server.agents.map((a) => ({
      ...a,
      approvalHash: a.status === 'approved' ? 'h1' : null,
      currentHash: `h-${a.revision}`,
      toolIdentities: a.definition.tools.map((tool) => ({ tool, runsAs: 'app_service_principal', readsWorkspaceData: tool === 'genie_one' || tool.startsWith('mcp:') })),
    }))
    return json(r, { agents: rows })
  })
  await page.route(/\/api\/admin\/agents\/\d+\/(approve|reject|revoke)$/, (r) => {
    const parts = new URL(r.request().url()).pathname.split('/')
    const action = parts[5]
    const a = server.agents.find((x) => x.id === parts[4])
    server.calls.push(`POST ${action}`)
    if (action === 'approve') Object.assign(a, { status: 'approved', approvalExpiresAt: '2027-02-01T00:00:00.000Z' })
    if (action === 'reject') Object.assign(a, { status: 'rejected', decisionReason: r.request().postDataJSON().reason })
    if (action === 'revoke') Object.assign(a, { status: 'revoked', enabled: false })
    return json(r, a)
  })
  // opening Settings loads the skills list; answered here so the shared fixture server records no miss
  await page.route('**/api/skills', (r) => json(r, { skills: [] }))
  await page.route('**/api/mcp/connections**', (r) => json(r, { connections: [] }))
  await page.route(/\/api\/sessions\/42(\/messages)?$/, (r) =>
    r.request().url().endsWith('/messages')
      ? json(r, { messages: [{ id: '900', role: 'assistant', content: 'Weekly summary' }] })
      : json(r, { session: { id: '42', title: 'Weekly sales · 2026-11-23', model: FX.models[0], system_prompt: '', enabled_tools: [], created_at: FX.now, updated_at: FX.now, ephemeral: false, attachment_names: [] }, role: null, busy: null })
  )
}

async function open(browser, server, variant = { theme: 'dark', mobile: false }, hash = '#/agents') {
  const ctx = await newVariantContext(browser, variant)
  const page = await ctx.newPage()
  await install(page, server)
  await page.goto('/' + hash)
  return { ctx, page }
}

// a card opens its drawer (a modal dialog named after the agent); every per-agent action lives in it
const agentCard = (page, name) => page.getByRole('list', { name: 'Your agents' }).getByRole('listitem').filter({ hasText: name })
async function openDrawer(page, name) {
  await agentCard(page, name).getByRole('button').click()
  const dlg = page.getByRole('dialog', { name })
  await expect(dlg).toBeVisible()
  return dlg
}
const nav = (page) => page.getByRole('button', { name: 'Agents', exact: true })
// Settings tabs are buttons (aria-current) in a rail; on a phone the Organization area holds the admin group
const openAdminTab = async (page) => {
  const phone = (page.viewportSize()?.width ?? 1440) < 768
  if (phone) await page.getByRole('button', { name: 'Open menu' }).first().click() // the sidebar is a drawer on a phone
  await page.getByRole('button', { name: 'Open settings' }).first().click()
  const dialog = page.getByRole('dialog')
  if (phone) await dialog.getByRole('button', { name: 'Organization', exact: true }).click()
  await dialog.getByRole('button', { name: 'Agents', exact: true }).click()
}

test('AC1: with the status off there is no nav entry, no route content and no admin tab', async ({ browser }) => {
  for (const status of [{ enabled: false, reason: 'env_off' }, { enabled: false, reason: 'admin_off' }]) {
    const server = makeServer({ status })
    const { ctx, page } = await open(browser, server)
    await expect(page.getByRole('button', { name: 'Open settings' }).first()).toBeVisible()
    await expect(nav(page)).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toHaveCount(0)
    expect(server.calls.filter((c) => /\/api\/agents/.test(c))).toEqual([])
    await page.getByRole('button', { name: 'Open settings' }).first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Agents', exact: true })).toHaveCount(0)
    await ctx.close()
  }
})

test('AC1: a failing status call reads as off (fail closed)', async ({ browser }) => {
  const server = makeServer()
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  await install(page, server)
  await page.route('**/api/agents/status', (r) => r.fulfill({ status: 500, json: { error: 'boom' } }))
  await page.goto('/#/agents')
  await expect(page.getByRole('button', { name: 'Open settings' }).first()).toBeVisible()
  await expect(nav(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toHaveCount(0)
  await ctx.close()
})

test("AC2 + AC4: create → submit → approve → enable → run now → history opens the run's chat", async ({ browser }) => {
  const server = makeServer()
  const { ctx, page } = await open(browser, server)
  await expect(nav(page)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  await expect(page.getByText('No agents yet')).toBeVisible()

  await page.getByRole('button', { name: 'New agent' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Weekly sales')
  await page.getByLabel('Prompt', { exact: true }).fill('Summarise last week.')
  await page.getByRole('group', { name: 'Tools' }).getByRole('checkbox', { name: 'Web search' }).check()
  // AC4: the tz defaults to the browser's (the context runs in UTC); the occurrences come from the server
  await page.getByLabel('Repeat').selectOption('weekly')
  await expect(page.getByLabel('Time zone')).toHaveValue('UTC')
  const next = page.getByRole('region', { name: 'Next runs' })
  await expect(next.getByRole('listitem')).toHaveCount(3)
  await expect(next).toContainText(FX.preview.description)
  await expect(next.getByRole('listitem').first()).toContainText('11:00')
  await page.getByLabel('Time zone').selectOption('America/Sao_Paulo')
  await expect(next.getByRole('listitem').first()).toContainText('8:00')
  // the (debounced) preview is asked again for the new zone; the instants shown are only formatted in it
  await expect.poll(() => server.previews.at(-1)?.schedule.tz).toBe('America/Sao_Paulo')
  await page.getByRole('button', { name: 'Save agent' }).click()
  const row = agentCard(page, 'Weekly sales')
  await expect(row).toContainText('Draft')

  const dlg1 = await openDrawer(page, 'Weekly sales')
  await dlg1.getByRole('button', { name: 'Submit for approval' }).click()
  await expect(dlg1).toContainText('Waiting for approval')
  await page.keyboard.press('Escape')
  await expect(row).toContainText('Waiting for approval')
  await openAdminTab(page)
  const card = page.getByRole('article').filter({ hasText: 'Weekly sales' })
  // approval never depends on the diff: the card always shows the full current definition and each tool's identity
  await expect(card).toContainText('Summarise last week.')
  await expect(card).toContainText('web_search: runs as the app')
  await expect(card).toContainText('runs as the app')
  await card.getByRole('button', { name: 'Approve' }).click()
  await expect(card).toContainText('Approved')
  await page.keyboard.press('Escape')

  await page.reload()
  const row2 = agentCard(page, 'Weekly sales')
  await expect(row2).toContainText('Approved')
  const dlg2 = await openDrawer(page, 'Weekly sales')
  await dlg2.getByRole('button', { name: 'Enable schedule' }).click()
  await expect(dlg2).toContainText('Scheduled')
  await dlg2.getByRole('button', { name: 'Run now' }).click()
  await expect(dlg2.getByRole('status')).toContainText('queued')
  server.finishRuns = true
  await dlg2.getByRole('button', { name: 'Run history' }).click()
  const hist = page.getByRole('region', { name: 'Run history' })
  await expect(hist).toContainText('Succeeded')
  await hist.getByRole('link', { name: /Open chat/ }).click()
  await expect(page).toHaveURL(/#\/chat\/42$/)
  await expect(page.getByText('Weekly summary')).toBeVisible()
  expect(server.calls).toEqual(expect.arrayContaining(['POST /api/agents', 'POST /api/agents/1/submit', 'POST approve', 'POST /api/agents/1/enable', 'POST /api/agents/1/run']))
  await ctx.close()
})

test('AC3: editing an approved agent warns before anything is saved; a name-only edit does not', async ({ browser }) => {
  const server = makeServer()
  server.add({ status: 'approved', approvalExpiresAt: '2027-02-01T00:00:00.000Z' })
  const { ctx, page } = await open(browser, server)
  await (await openDrawer(page, 'Weekly sales')).getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Renamed')
  await page.getByRole('button', { name: 'Save agent' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(agentCard(page, 'Renamed')).toContainText('Approved')
  await (await openDrawer(page, 'Renamed')).getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Prompt', { exact: true }).fill('A different prompt.')
  const before = server.saved.length
  await page.getByRole('button', { name: 'Save agent' }).click()
  const warn = page.getByRole('alert')
  await expect(warn).toContainText('void the approval')
  expect(server.saved.length).toBe(before)
  await warn.getByRole('button', { name: 'Keep editing' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'Save agent' }).click()
  await page.getByRole('alert').getByRole('button', { name: 'Save and void approval' }).click()
  await expect(agentCard(page, 'Renamed')).toContainText('Draft')
  expect(server.saved.length).toBe(before + 1)
  await ctx.close()
})

test('the tool picker offers what the server admits to a NON-admin owner too, and nothing personal', async ({ browser }) => {
  const server = makeServer()
  const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
  const page = await ctx.newPage()
  await install(page, server)
  await page.route('**/api/me', (r) => r.fulfill({ json: { email: FX.me, isAdmin: false, isOwner: false } }))
  let adminCatalogReads = 0
  await page.route('**/api/admin/mcp-catalog', (r) => (adminCatalogReads++, r.fulfill({ status: 403, json: { error: 'admin_required' } })))
  await page.goto('/#/agents')
  await page.getByRole('button', { name: 'New agent' }).click()
  const tools = page.getByRole('group', { name: 'Tools' })
  for (const n of ['Web search', 'Image generation', 'Deck', 'Spreadsheet', 'Document', 'Genie One', 'Sales lookups']) await expect(tools.getByRole('checkbox', { name: n })).toBeVisible()
  await expect(tools.getByRole('checkbox', { name: 'My personal drive' })).toHaveCount(0)
  await expect(tools.getByRole('checkbox', { name: 'Team board' })).toHaveCount(0)
  expect(adminCatalogReads).toBe(0)
  await expect(page.getByLabel('Instructions')).toBeHidden()
  await page.getByText('Advanced', { exact: true }).click()
  await expect(page.getByLabel('Instructions')).toBeVisible()
  await ctx.close()
})

test('a kind the org policy switched off is not offered; a failed options call offers no tools and says why', async ({ browser }) => {
  const server = makeServer()
  server.toolOptions = { kinds: FX.toolOptions.kinds.filter((k) => k !== 'web_search'), mcp: [] }
  const { ctx, page } = await open(browser, server)
  await page.getByRole('button', { name: 'New agent' }).click()
  await expect(page.getByRole('group', { name: 'Tools' }).getByRole('checkbox', { name: 'Image generation' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Tools' }).getByRole('checkbox', { name: 'Web search' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.route('**/api/agents/tool-options', (r) => r.fulfill({ status: 500, json: { error: 'boom', code: 'internal_error' } }))
  await page.reload()
  await page.getByRole('button', { name: 'New agent' }).click()
  await expect(page.getByRole('group', { name: 'Tools' }).getByRole('checkbox')).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Tools' })).toContainText('could not be loaded')
  await ctx.close()
})

test('a saved tool the server no longer offers is shown as unavailable with only Remove; it can never be checked (admin and non-admin, options failed or not)', async ({ browser }) => {
  for (const { isAdmin, optionsFail } of [{ isAdmin: true, optionsFail: false }, { isAdmin: false, optionsFail: false }, { isAdmin: true, optionsFail: true }, { isAdmin: false, optionsFail: true }]) {
    const server = makeServer()
    server.add().definition.tools = ['mcp:main.tools.mine', 'web_search']
    const ctx = await newVariantContext(browser, { theme: 'dark', mobile: false })
    const page = await ctx.newPage()
    await install(page, server)
    if (!isAdmin) await page.route('**/api/me', (r) => r.fulfill({ json: { email: FX.me, isAdmin: false, isOwner: false } }))
    if (optionsFail) await page.route('**/api/agents/tool-options', (r) => r.fulfill({ status: 500, json: { error: 'internal_error', code: 'internal_error' } }))
    await page.goto('/#/agents')
    await (await openDrawer(page, 'Weekly sales')).getByRole('button', { name: 'Edit' }).click()
    const tools = page.getByRole('group', { name: 'Tools' })
    // never a checkbox for it
    await expect(tools.getByRole('checkbox', { name: /mcp:main\.tools\.mine/ })).toHaveCount(0)
    const item = tools.getByRole('listitem').filter({ hasText: 'mcp:main.tools.mine' })
    await expect(item).toContainText('no longer available')
    await expect(item.getByRole('button', { name: /^Remove/ })).toBeVisible()
    if (optionsFail) await expect(tools.getByRole('checkbox', { name: 'Web search' })).toHaveCount(0)
    // Remove drops it from the agent for good
    await item.getByRole('button', { name: /^Remove/ }).click()
    await expect(tools.getByText('mcp:main.tools.mine')).toHaveCount(0)
    await page.getByRole('button', { name: 'Save agent' }).click()
    await expect.poll(() => server.saved.at(-1)?.tools).not.toContain('mcp:main.tools.mine')
    await ctx.close()
  }
})

test('the admin card shows every field of the current definition', async ({ browser }) => {
  const server = makeServer()
  const agent = server.add({ status: 'pending' })
  agent.definition.reasoningEffort = 'high'
  agent.definition.lang = 'es'
  agent.definition.instructions = 'Be brief.'
  const { ctx, page } = await open(browser, server)
  await openAdminTab(page)
  const card = page.getByRole('article').filter({ hasText: 'Weekly sales' })
  await expect(card).toBeVisible() // count() does not wait: the queue loads after the tab opens
  const counts = await Promise.all([
    card.getByText('Reasoning effort', { exact: true }).count(),
    card.getByText('Language of the result', { exact: true }).count(),
    card.getByText('High', { exact: true }).count(),
    card.getByText('Spanish', { exact: true }).count(),
  ])
  expect(counts).toEqual([1, 1, 1, 1])
  await expect(card).toContainText('Be brief.')
  await expect(card).toContainText('web_search: runs as the app')
  await ctx.close()
})

test('AC5: errors are shown by code through the catalog, never the server text', async ({ browser }) => {
  const server = makeServer()
  server.add({ status: 'approved', approvalExpiresAt: '2027-02-01T00:00:00.000Z' })
  const { ctx, page } = await open(browser, server)
  const row = await openDrawer(page, 'Weekly sales')
  server.refuse((m, p) => m === 'POST' && p.endsWith('/run'), 409, 'busy')
  await row.getByRole('button', { name: 'Run now' }).click()
  await expect(page.getByRole('alert')).toContainText('already queued or running')
  await expect(page.getByRole('alert')).not.toContainText('busy')
  server.refuse((m, p) => m === 'POST' && p.endsWith('/enable'), 409, 'approval_expired')
  await row.getByRole('button', { name: 'Enable schedule' }).click()
  await expect(page.getByRole('alert')).toContainText('approval has expired')
  server.refuse((m, p) => m === 'GET' && p === '/api/agents', 500, 'SELECT * FROM agents failed: relation does not exist')
  await page.reload()
  await expect(page.getByRole('alert')).not.toContainText('SELECT')
  await expect(page.getByRole('alert')).toContainText('Something went wrong')
  await ctx.close()
})

test('admin: reject needs a reason; revoke; the settings are saved', async ({ browser }) => {
  const server = makeServer()
  server.add({ status: 'pending' })
  server.add({ name: 'Live agent', status: 'approved', enabled: true, approvalExpiresAt: '2027-02-01T00:00:00.000Z' })
  const { ctx, page } = await open(browser, server, { theme: 'dark', mobile: false }, '#/chat')
  await openAdminTab(page)
  const pending = page.getByRole('article').filter({ hasText: 'Weekly sales' })
  await pending.getByRole('button', { name: 'Reject' }).click()
  await expect(pending.getByRole('alert')).toContainText('reason')
  await pending.getByLabel('Reason').fill('Too broad')
  await pending.getByRole('button', { name: 'Reject' }).click()
  await expect(pending).toContainText('Rejected')
  const live = page.getByRole('article').filter({ hasText: 'Live agent' })
  await live.getByRole('button', { name: 'Revoke' }).click()
  await expect(live).toContainText('Revoked')
  await page.getByLabel('Approval validity (days)').fill('30')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()
  expect(server.settings.approvalDays).toBe(30)
  await ctx.close()
})

test('AC7: nothing on the Agents screens says "for a customer"', async ({ browser }) => {
  const server = makeServer()
  server.add({ status: 'pending' })
  const { ctx, page } = await open(browser, server)
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  expect(await page.locator('body').innerText()).not.toMatch(/for (a|the) customer|para (um|o) cliente|para (un|el) cliente/i)
  await ctx.close()
})

for (const variant of VARIANTS) {
  test(`AC6: axe is clean on the list, the drawer, the editor and the admin tab (${variantName(variant)})`, async ({ browser }) => {
    const server = makeServer()
    server.add({ status: 'pending' })
    server.add({ name: 'Live agent', status: 'approved', enabled: true, approvalExpiresAt: '2027-02-01T00:00:00.000Z' })
    const { ctx, page } = await open(browser, server, variant)
    const scan = async (label) => {
      // the 250 ms fade-in must be over for axe to see the final paint: wait for the screen's own settled state
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity))
      const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
      expect(r.violations.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
    }
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
    await scan('list')
    await openDrawer(page, 'Live agent')
    await scan('drawer')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'New agent' }).click()
    await page.getByLabel('Repeat').selectOption('weekly')
    await expect(page.getByRole('region', { name: 'Next runs' }).getByRole('listitem')).toHaveCount(3)
    await page.getByText('Advanced', { exact: true }).click()
    await scan('editor')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await openAdminTab(page)
    await expect(page.getByRole('article').first()).toBeVisible()
    await scan('admin')
    await ctx.close()
  })
}

// ---- ui-revamp W1-8 ----------------------------------------------------------------------------------------------
test('W1-8: search and status chips filter our own agents; the counts are real', async ({ browser }) => {
  const server = makeServer()
  server.add({ name: 'Weekly sales', description: 'Pipeline', status: 'draft' })
  server.add({ name: 'Previsão de caixa', description: 'Fluxo', status: 'approved', enabled: true, approvalExpiresAt: '2027-02-01T00:00:00.000Z' })
  server.add({ name: 'Ops digest', description: 'Daily', status: 'pending' })
  const { ctx, page } = await open(browser, server, { theme: 'light', mobile: false })
  const chips = page.getByRole('group', { name: 'Filter by status' })
  await expect(chips.getByRole('button', { name: /^All\s*3$/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(chips.getByRole('button', { name: /^Scheduled\s*1$/ })).toBeVisible()
  await expect(chips.getByRole('button', { name: /^Drafts\s*1$/ })).toBeVisible()
  await expect(chips.getByRole('button', { name: /^Rejected or revoked/ })).toHaveCount(0) // no agent in it: no chip
  const list = page.getByRole('list', { name: 'Your agents' })
  await expect(list.getByRole('listitem')).toHaveCount(3)
  await chips.getByRole('button', { name: /^Drafts/ }).click()
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list).toContainText('Weekly sales')
  await chips.getByRole('button', { name: /^All/ }).click()
  await page.getByRole('searchbox', { name: 'Search agents' }).fill('PREVISAO')
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list).toContainText('Previsão de caixa')
  await page.getByRole('searchbox', { name: 'Search agents' }).fill('nothing like this')
  await expect(page.getByText('No agents match.')).toBeVisible()
  await ctx.close()
})

test('W1-8: the drawer traps focus, closes on Escape and gives focus back to its card', async ({ browser }) => {
  const server = makeServer()
  server.add({ status: 'approved', approvalExpiresAt: '2027-02-01T00:00:00.000Z' })
  const { ctx, page } = await open(browser, server, { theme: 'light', mobile: false })
  const opener = agentCard(page, 'Weekly sales').getByRole('button')
  await opener.focus()
  await page.keyboard.press('Enter')
  const dlg = page.getByRole('dialog', { name: 'Weekly sales' })
  await expect(dlg).toBeVisible()
  await expect(dlg).toHaveAttribute('aria-modal', 'true')
  await expect(dlg.getByRole('button', { name: 'Close' })).toBeFocused()
  // the model, the prompt and the tools of this agent, nothing else
  await expect(dlg).toContainText('Summarise last week.')
  await expect(dlg).toContainText('Web search')
  // Tab never leaves the drawer, either way round
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab')
    expect(await dlg.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Shift+Tab')
    expect(await dlg.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dlg).toHaveCount(0)
  await expect(opener).toBeFocused()
  // the close button and the scrim close it too
  await opener.click()
  await dlg.getByRole('button', { name: 'Close' }).click()
  await expect(dlg).toHaveCount(0)
  await ctx.close()
})

test('W1-8: deleting from the drawer asks first, then removes the card', async ({ browser }) => {
  const server = makeServer()
  server.add({ status: 'draft' })
  const { ctx, page } = await open(browser, server, { theme: 'light', mobile: false })
  const dlg = await openDrawer(page, 'Weekly sales')
  await dlg.getByRole('button', { name: 'Delete', exact: false }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Delete agent' }).click()
  await expect(page.getByText('No agents yet')).toBeVisible()
  await ctx.close()
})

for (const theme of ['light', 'dark']) {
  test(`W1-8: primary buttons are ink (--action / --on-action), ${theme}`, async ({ browser }) => {
    const server = makeServer()
    server.add({ status: 'draft' })
    const { ctx, page } = await open(browser, server, { theme, mobile: false })
    const resolved = await page.evaluate(() => {
      const probe = document.createElement('i')
      document.body.append(probe)
      const read = (v) => {
        probe.style.color = `var(${v})`
        return getComputedStyle(probe).color
      }
      const out = { action: read('--action'), onAction: read('--on-action') }
      probe.remove()
      return out
    })
    const cta = async (loc) => loc.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }))
    expect(await cta(page.getByRole('button', { name: 'New agent' }))).toEqual({ bg: resolved.action, fg: resolved.onAction })
    const dlg = await openDrawer(page, 'Weekly sales')
    expect(await cta(dlg.getByRole('button', { name: 'Submit for approval' }))).toEqual({ bg: resolved.action, fg: resolved.onAction })
    await ctx.close()
  })
}

test('W1-8: the editor shows the provider mark beside the model select', async ({ browser }) => {
  const server = makeServer()
  const { ctx, page } = await open(browser, server, { theme: 'light', mobile: false })
  await page.getByRole('button', { name: 'New agent' }).click()
  const select = page.getByLabel('Model', { exact: true })
  await expect(select).toBeVisible()
  // svg is not in XPath's HTML namespace: climb to the wrapper and use CSS
  await expect(select.locator('xpath=..').locator('svg')).toHaveCount(1)
  await ctx.close()
})
