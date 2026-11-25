// Projects UI (W3-2). Every endpoint is answered with page.route (no backend): the
// mock below keeps the "server" state, applies the same role ladder the real routes
// enforce (view < manage < owner) and can be told to refuse the next call, so the
// permission paths are real UI paths, not asserted strings.
//
// Acceptance criteria map: AC1 create/rename/delete · AC2 members and roles ·
// AC3 instructions + counter · AC4 files + context · AC5 sidebar groups, new chat
// in project, temporary chats · AC6 author on messages + "<name> is answering…" ·
// AC7 keyboard path + axe (1440 and 390, light and dark) + en/pt/es strings.
// W1-8 (ui-revamp): breadcrumb, two-column page (chats | instructions, files, members), colour dot, member avatars,
//   "New chat in this project" bar, Share project → members, ink primary buttons.
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { AXE_TAGS, VARIANTS, newVariantContext, variantName, sendPrompt } from './lib.mjs'

const ME = 'e2e-user@example.com'
const NOW = () => new Date().toISOString()
const LIMITS = {
  nameMaxChars: 200,
  descriptionMaxChars: 2000,
  instructionsMaxChars: 40,
  fileMaxBytes: 2000,
  filesPerUpload: 3,
  filesPerProject: 5,
  extractedCharsPerFile: 50000,
  contextFilesMaxTokens: 32000,
  supportedExtensions: ['pdf', 'txt', 'md'],
}
const RANK = { view: 1, manage: 2, owner: 3 }

// the chat's author: a field on the row, or the `live` record of the shared-chat tests
const ownerOf = (server, s) => s.owner_email || server.live[s.id]?.owner_email || ME

function makeServer() {
  const server = {
    nextId: 10,
    projects: [],
    sessions: [],
    messages: {},
    // session id -> { busy, role, owner_email }; busy follows what a poll should say
    live: {},
    forced: [],
    calls: [],
    payloads: [],
    deletedProjects: [],
  }
  server.addProject = (over = {}) => {
    const p = {
      id: String(server.nextId++),
      name: 'Alpha',
      description: '',
      instructions: '',
      created_by: ME,
      created_at: NOW(),
      updated_at: NOW(),
      role: 'owner',
      members: [{ kind: 'user', principal: ME, role: 'owner', added_by: ME, added_at: NOW() }],
      files: [],
      ...over,
    }
    server.projects.push(p)
    return p
  }
  server.session = (over) => {
    const s = { id: String(server.nextId++), title: 'Chat', model: 'databricks-claude-sonnet-5-5', system_prompt: '', enabled_tools: [], created_at: NOW(), updated_at: NOW(), project_id: null, ephemeral: false, attachment_names: [], ...over }
    server.sessions.unshift(s)
    return s
  }
  // refuse the next call matching `test(method, path)` with `status` / `error`
  server.refuse = (test, status, error) => server.forced.push({ test, status, error })
  return server
}

const pub = (p) => ({ id: p.id, name: p.name, description: p.description, instructions: p.instructions, created_by: p.created_by, created_at: p.created_at, updated_at: p.updated_at, role: p.role })
const ctxOf = (files) => {
  let used = 0
  let excluded = 0
  const out = files.map((f) => {
    const mode = f.name.startsWith('huge') ? 'excluded' : 'full'
    if (mode === 'excluded') excluded++
    else used += f.context_tokens
    return { ...f, context: mode, extracted_chars: 100, truncated_at_upload: f.name.startsWith('cut') }
  })
  return { files: out, context: { budget_tokens: 32000, used_tokens: used, excluded_count: excluded } }
}

async function install(page, server) {
  // like the real API: /api/sessions lists only the caller's OWN chats; a teammate's chat in a shared
  // project is reachable only through /api/projects/:id/sessions
  await page.route('**/api/sessions', (route) => route.fulfill({ json: { sessions: server.sessions.filter((s) => ownerOf(server, s) === ME) } }))
  await page.route('**/api/sessions/*/messages', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3]
    return route.fulfill({ json: { messages: server.messages[id] || [] } })
  })
  await page.route(/\/api\/sessions\/\d+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3]
    if (route.request().method() !== 'GET') return route.fallback()
    const s = server.sessions.find((x) => x.id === id)
    if (!s) return route.fulfill({ status: 404, json: { error: 'not found' } })
    const live = server.live[id] || {}
    if (live.fail) return route.fulfill({ status: 500, json: { error: 'boom' } })
    return route.fulfill({ json: { session: { ...s, owner_email: ownerOf(server, s) }, role: live.role ?? null, busy: live.busy ?? null } })
  })

  await page.route(/\/api\/projects(\/[^?]*)?(\?.*)?$/, async (route) => {
    const req = route.request()
    const method = req.method()
    const path = new URL(req.url()).pathname
    const seg = path.split('/').slice(3).filter(Boolean) // after /api/projects
    server.calls.push(`${method} ${path}`)
    const json = (body, status = 200) => route.fulfill({ status, json: body })
    const fail = (status, error) => json({ error }, status)

    const forcedAt = server.forced.findIndex((f) => f.test(method, path))
    if (forcedAt >= 0) {
      const [f] = server.forced.splice(forcedAt, 1)
      return fail(f.status, f.error)
    }

    if (seg.length === 0) {
      if (method === 'GET') return json({ projects: server.projects.map(pub), limits: LIMITS })
      if (method === 'POST') {
        const body = JSON.parse(req.postData() || '{}')
        if (!body.name?.trim()) return fail(400, 'invalid_name')
        const p = server.addProject({ name: body.name.trim() })
        return json({ project: pub(p) }, 201)
      }
    }
    const p = server.projects.find((x) => x.id === seg[0])
    if (!p) return fail(404, 'project_not_found')
    const rank = RANK[p.role]
    const need = (r) => rank >= RANK[r]
    const sub = seg[1]

    if (!sub) {
      if (method === 'GET') return json({ project: pub(p) })
      if (method === 'PATCH') {
        if (!need('manage')) return fail(403, 'forbidden')
        const body = JSON.parse(req.postData() || '{}')
        if (typeof body.instructions === 'string' && body.instructions.length > LIMITS.instructionsMaxChars) return fail(400, 'instructions_too_long')
        Object.assign(p, Object.fromEntries(Object.entries(body).filter(([k]) => ['name', 'description', 'instructions'].includes(k))))
        return json({ project: pub(p) })
      }
      if (method === 'DELETE') {
        if (!need('owner')) return fail(403, 'forbidden')
        server.projects = server.projects.filter((x) => x.id !== p.id)
        server.sessions = server.sessions.filter((s) => s.project_id !== p.id)
        server.deletedProjects.push(p.id)
        return json({ ok: true })
      }
    }
    if (sub === 'members') {
      if (method === 'GET') return json({ members: p.members })
      if (method === 'POST') {
        if (!need('manage')) return fail(403, 'forbidden')
        const b = JSON.parse(req.postData() || '{}')
        if (b.role === 'owner' && p.role !== 'owner') return fail(403, 'cannot_grant_role')
        if (p.members.some((m) => m.kind === b.kind && m.principal === b.principal.toLowerCase())) return fail(409, 'already_a_member')
        const m = { kind: b.kind, principal: b.principal.toLowerCase(), role: b.role, added_by: ME, added_at: NOW() }
        p.members.push(m)
        return json({ member: m }, 201)
      }
      const [, , kind, principal] = [null, null, seg[2], decodeURIComponent(seg[3] || '')]
      const m = p.members.find((x) => x.kind === kind && x.principal === principal)
      if (method === 'PATCH') {
        if (!need('manage')) return fail(403, 'forbidden')
        if (!m) return fail(404, 'member_not_found')
        m.role = JSON.parse(req.postData()).role
        return json({ member: m })
      }
      if (method === 'DELETE') {
        const self = kind === 'user' && principal === ME
        if (!self && !need('manage')) return fail(403, 'forbidden')
        if (m?.role === 'owner' && p.members.filter((x) => x.role === 'owner' && x.kind === 'user').length === 1) return fail(409, 'last_owner')
        p.members = p.members.filter((x) => x !== m)
        return json({ ok: true })
      }
    }
    if (sub === 'files') {
      if (method === 'GET') return json(ctxOf(p.files))
      if (method === 'POST') {
        if (!need('manage')) return fail(403, 'forbidden')
        const body = req.postDataBuffer()?.toString('latin1') || ''
        const names = [...body.matchAll(/filename="([^"]+)"/g)].map((x) => x[1])
        for (const name of names) p.files.push({ id: String(server.nextId++), name, mime: 'text/plain', size_bytes: 120, uploaded_by: ME, created_at: NOW(), context_tokens: 300 })
        return json({ files: ctxOf(p.files).files.slice(-names.length) }, 201)
      }
      if (method === 'DELETE') {
        if (!need('manage')) return fail(403, 'forbidden')
        p.files = p.files.filter((f) => f.id !== seg[2])
        return json({ ok: true })
      }
    }
    if (sub === 'sessions') {
      if (method === 'GET') return json({ sessions: server.sessions.filter((s) => s.project_id === p.id).map((s) => ({ id: s.id, title: s.title, model: s.model, owner_email: ownerOf(server, s), created_at: s.created_at, updated_at: s.updated_at })) })
      if (method === 'POST') {
        const sid = JSON.parse(req.postData()).sessionId
        const s = server.sessions.find((x) => x.id === sid)
        if (!s) return fail(404, 'session_not_found')
        if (s.ephemeral) return fail(400, 'ephemeral_in_project')
        s.project_id = p.id
        return json({ ok: true })
      }
      if (method === 'DELETE') {
        const s = server.sessions.find((x) => x.id === seg[2])
        if (s) s.project_id = null
        return json({ ok: true })
      }
    }
    return fail(404, 'not_found')
  })
}

async function open(browser, baseURL, variant = { theme: 'dark', mobile: false }, setup = () => {}) {
  const ctx = await newVariantContext(browser, variant)
  await ctx.addInitScript(() => {
    window.__payloads = []
    const prev = window.fetch
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (/\/api\/chat$/.test(url) && init?.body instanceof FormData) window.__payloads.push(JSON.parse(init.body.get('payload')))
      return prev(input, init)
    }
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const server = makeServer()
  setup(server)
  await install(page, server)
  return { ctx, page, errors, server }
}

const go = async (page, baseURL, hash) => {
  await page.goto(`${baseURL}/#${hash}`)
  await page.locator('main').first().waitFor()
}
// finite animations only: the busy spinner loops forever by design
const animationsDone = (page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {}))
    )
  )

async function expectAxeClean(page, label) {
  await animationsDone(page)
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`), `axe ${label}`).toEqual([])
}

// presses Tab until `locator` has focus (a keyboard-only user has no other way in)
async function tabTo(page, locator, max = 80, key = 'Tab') {
  for (let i = 0; i < max; i++) {
    if (await locator.evaluate((el) => el === document.activeElement).catch(() => false)) return
    await page.keyboard.press(key)
  }
  throw new Error(`Tab never reached ${locator}`)
}

// ---------------------------------------------------------------------------------------------

test('AC1: create, rename and delete a project; delete asks once and says the chats go with it', async ({ browser, baseURL }) => {
  const { ctx, page, errors, server } = await open(browser, baseURL)
  await go(page, baseURL, '/projects')
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()
  await expect(page.getByText('No projects yet.')).toBeVisible()
  await expect(page.getByText('Project chats are kept until the project is deleted.')).toBeVisible()

  // an empty name is refused with the next step, before any request
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('alert')).toContainText('The project needs a name.')
  await expect(page.getByRole('alert')).toContainText('Type a name and try again.')
  expect(server.calls.filter((c) => c.startsWith('POST'))).toEqual([])

  // a server failure ends on what to do, not on a code
  server.refuse((m) => m === 'POST', 500, 'internal_error')
  await page.getByLabel('New project name').fill('Planning')
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('alert')).toContainText('Something went wrong. Try again in a moment.')

  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveURL(/#\/projects\/\d+$/)
  await expect(page.getByRole('heading', { name: 'Planning', level: 1 })).toBeVisible()

  await page.getByRole('button', { name: 'Rename' }).click()
  await page.getByLabel('Project name').fill('Planning Q4')
  await page.getByLabel('Project name').press('Enter')
  await expect(page.getByRole('heading', { name: 'Planning Q4', level: 1 })).toBeVisible()
  expect(server.projects[0].name).toBe('Planning Q4')

  await page.getByRole('button', { name: 'Delete project' }).click()
  const dlg = page.getByRole('alertdialog')
  await expect(dlg).toContainText('Delete “Planning Q4”?')
  await expect(dlg).toContainText('all of its chats are deleted with it')
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await expect(dlg).toHaveCount(0)
  expect(server.deletedProjects).toEqual([])
  await page.getByRole('button', { name: 'Delete project' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete project and chats' }).click()
  await expect.poll(() => server.deletedProjects.length).toBe(1)
  await expect(page).toHaveURL(/#\/projects$/)
  await expect(page.getByText('No projects yet.')).toBeVisible()
  expect(errors).toEqual([])
  await ctx.close()
})

test('AC1: a non-owner is not offered Delete; a refused delete names the role needed', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL, undefined, (s) => s.addProject({ name: 'Managed', role: 'manage' }))
  await go(page, baseURL, `/projects/${server.projects[0].id}`)
  await expect(page.getByRole('heading', { name: 'Managed', level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete project' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Rename' })).toBeVisible()
  await ctx.close()

  // an owner whose role was lowered meanwhile: the delete is refused and says why
  const b = await open(browser, baseURL, undefined, (s) => s.addProject({ name: 'Stale', role: 'owner' }))
  await go(b.page, baseURL, `/projects/${b.server.projects[0].id}`)
  await b.page.getByRole('button', { name: 'Delete project' }).click()
  b.server.projects[0].role = 'manage'
  await b.page.getByRole('alertdialog').getByRole('button', { name: 'Delete project and chats' }).click()
  await expect(b.page.getByRole('alertdialog').getByRole('alert')).toContainText('Only an owner can do this.')
  await expect(b.page.getByRole('alertdialog').getByRole('alert')).toContainText('Ask a project owner to change your role')
  await b.page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()
  // the page re-read the project: the Delete control is gone
  await expect(b.page.getByRole('button', { name: 'Delete project' })).toHaveCount(0)
  await b.ctx.close()
})

test('AC2: add a person and a group, change a role, remove; duplicates and last owner say what to do', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL, undefined, (s) => s.addProject({ name: 'Team' }))
  const pid = server.projects[0].id
  await go(page, baseURL, `/projects/${pid}`)
  const members = page.getByRole('region', { name: 'Members' })

  await members.getByLabel('E-mail address').fill('bo@example.com')
  await members.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(members.getByRole('listitem').filter({ hasText: 'bo@example.com' })).toBeVisible()
  await expect(members.getByRole('status')).toContainText('bo@example.com added.')

  await members.getByLabel('Kind of member').selectOption('group')
  await members.getByLabel('Group name', { exact: true }).fill('data-team')
  await members.getByLabel('Role for the new member').selectOption('manage')
  await members.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(members.getByRole('listitem').filter({ hasText: 'data-team' })).toBeVisible()
  expect(server.projects[0].members.find((m) => m.principal === 'data-team')).toMatchObject({ kind: 'group', role: 'manage' })

  // duplicate: 409 with the next step
  await members.getByLabel('Kind of member').selectOption('user')
  await members.getByLabel('E-mail address').fill('bo@example.com')
  await members.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(members.getByRole('alert')).toContainText('already a member')
  await expect(members.getByRole('alert')).toContainText('Change their role in the list instead.')

  // role change
  await members.getByLabel('Role of bo@example.com').selectOption('manage')
  await expect.poll(() => server.projects[0].members.find((m) => m.principal === 'bo@example.com').role).toBe('manage')
  await expect(members.getByRole('status')).toContainText('bo@example.com is now Manager.')

  // remove
  await members.getByRole('button', { name: 'Remove bo@example.com' }).click()
  await expect(members.getByRole('listitem').filter({ hasText: 'bo@example.com' })).toHaveCount(0)

  // an invalid address is explained
  server.refuse((m, p) => m === 'POST' && p.endsWith('/members'), 400, 'invalid_principal')
  await members.getByLabel('E-mail address').fill('not-an-address')
  await members.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(members.getByRole('alert')).toContainText('Check the spelling')

  // the only owner leaving: refused, with the next step
  await members.getByRole('button', { name: 'Leave project' }).click()
  await expect(members.getByRole('alert')).toContainText('A project needs at least one owner.')
  await expect(members.getByRole('alert')).toContainText('Make someone else an owner first.')
  await ctx.close()
})

test('AC2: a viewer sees read-only members; a manager cannot touch an owner row; a refused add re-reads the role', async ({ browser, baseURL }) => {
  const viewerSetup = (s) =>
    s.addProject({
      name: 'Shared',
      role: 'view',
      members: [
        { kind: 'user', principal: 'boss@example.com', role: 'owner', added_by: 'boss@example.com', added_at: NOW() },
        { kind: 'user', principal: ME, role: 'view', added_by: 'boss@example.com', added_at: NOW() },
      ],
    })
  const v = await open(browser, baseURL, undefined, viewerSetup)
  await go(v.page, baseURL, `/projects/${v.server.projects[0].id}`)
  const members = v.page.getByRole('region', { name: 'Members' })
  await expect(members.getByRole('listitem').filter({ hasText: 'boss@example.com' })).toBeVisible()
  await expect(members.getByRole('combobox')).toHaveCount(0)
  await expect(members.getByLabel('E-mail address')).toHaveCount(0)
  await expect(members.getByRole('button', { name: /^Remove / })).toHaveCount(0)
  await expect(members.getByRole('button', { name: 'Leave project' })).toBeVisible()
  await expect(members.getByText('Only managers can add or change members.')).toBeVisible()
  await expect(v.page.getByText('You are a viewer')).toBeVisible()
  await expect(v.page.getByLabel('Project instructions')).toHaveAttribute('readonly', '')
  await expect(v.page.getByRole('button', { name: 'Upload files' })).toHaveCount(0)
  await v.ctx.close()

  const m = await open(browser, baseURL, undefined, (s) =>
    s.addProject({
      name: 'Mixed',
      role: 'manage',
      members: [
        { kind: 'user', principal: 'boss@example.com', role: 'owner', added_by: 'x', added_at: NOW() },
        { kind: 'user', principal: ME, role: 'manage', added_by: 'x', added_at: NOW() },
        { kind: 'user', principal: 'cy@example.com', role: 'view', added_by: 'x', added_at: NOW() },
      ],
    })
  )
  await go(m.page, baseURL, `/projects/${m.server.projects[0].id}`)
  const mm = m.page.getByRole('region', { name: 'Members' })
  await expect(mm.getByLabel('Role of boss@example.com')).toHaveCount(0)
  await expect(mm.getByRole('button', { name: 'Remove boss@example.com' })).toHaveCount(0)
  await expect(mm.getByLabel('Role of cy@example.com')).toBeVisible()
  // the new member's role list has no Owner for a manager
  await expect(mm.getByLabel('Role for the new member').locator('option')).toHaveText(['Viewer', 'Manager'])

  // her role is lowered behind her back: the add is refused (403), the page says what to do
  // and re-reads the project, so the controls she can no longer use go away
  m.server.projects[0].role = 'view'
  await mm.getByLabel('E-mail address').fill('dee@example.com')
  await mm.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(mm.getByRole('alert')).toContainText('You need the manager or owner role to do this.')
  await expect(mm.getByRole('alert')).toContainText('Ask a project owner to change your role, then try again.')
  await expect(mm.getByLabel('E-mail address')).toHaveCount(0)
  await expect(m.page.getByRole('button', { name: 'Rename' })).toHaveCount(0)
  await m.ctx.close()
})

test('AC2: a project that vanished (404) says gone-or-not-yours and goes back to the list', async ({ browser, baseURL }) => {
  const { ctx, page } = await open(browser, baseURL)
  await go(page, baseURL, '/projects/999')
  await expect(page.getByRole('alert')).toContainText('no longer exists or you no longer have access')
  await page.getByRole('button', { name: 'All projects' }).last().click()
  await expect(page).toHaveURL(/#\/projects$/)
  await ctx.close()
})

test('AC3: instructions save with a counter against the server limit; over the limit blocks Save', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL, undefined, (s) => s.addProject({ name: 'Rules', instructions: 'Be brief.' }))
  await go(page, baseURL, `/projects/${server.projects[0].id}`)
  const box = page.getByLabel('Project instructions')
  await expect(box).toHaveValue('Be brief.')
  await expect(page.getByText('9 of 40 characters')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()

  await box.fill('x'.repeat(45))
  await expect(page.getByText('45 of 40 characters')).toBeVisible()
  await expect(page.getByText('5 over the limit.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()

  await box.fill('Answer in Portuguese.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Instructions saved.')).toBeVisible()
  expect(server.projects[0].instructions).toBe('Answer in Portuguese.')

  // someone with a lower role in the meantime: refused with the next step
  server.projects[0].role = 'view'
  await box.fill('Another rule.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('You need the manager or owner role to do this.')
  await ctx.close()
})

test('AC4: upload, see what is in context, remove; size and type are refused in words', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL, undefined, (s) => s.addProject({ name: 'Docs' }))
  await go(page, baseURL, `/projects/${server.projects[0].id}`)
  const files = page.getByRole('region', { name: 'Files' })
  await expect(files.getByText('No files yet.')).toBeVisible()
  await expect(files.getByText('Up to 2 KB per file. Types: pdf, txt, md.')).toBeVisible()

  const buf = (n) => Buffer.alloc(n, 97)
  await files.getByTestId('project-file-input').setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: buf(100) },
    { name: 'huge-report.pdf', mimeType: 'application/pdf', buffer: buf(100) },
    { name: 'cut-book.md', mimeType: 'text/markdown', buffer: buf(100) },
  ])
  await expect(files.getByRole('listitem').filter({ hasText: 'notes.txt' })).toBeVisible()
  await expect(files.getByText('In context', { exact: true })).toHaveCount(2)
  await expect(files.getByText('Not in context (over budget)')).toHaveCount(1)
  await expect(files.getByText('Text was cut when uploaded.')).toBeVisible()
  await expect(files.getByText('In context: 600 of 32,000 tokens.')).toBeVisible()
  await expect(files.getByText('1 file(s) are over budget and are not read.')).toBeVisible()
  await expect(files.getByRole('status')).toContainText('3 file(s) uploaded.')

  // size, type and count are refused in the browser, each with what to do
  await files.getByTestId('project-file-input').setInputFiles([
    { name: 'big.pdf', mimeType: 'application/pdf', buffer: buf(5000) },
    { name: 'tool.exe', mimeType: 'application/octet-stream', buffer: buf(10) },
  ])
  const refused = files.getByRole('alert')
  await expect(refused).toContainText('big.pdf')
  await expect(refused).toContainText('larger than 2 KB. Split or compress it.')
  await expect(refused).toContainText('tool.exe')
  await expect(refused).toContainText('this type is not supported')
  expect(server.projects[0].files.map((f) => f.name)).toEqual(['notes.txt', 'huge-report.pdf', 'cut-book.md'])

  // the server's own refusals are localized too
  server.refuse((m, p) => m === 'POST' && p.endsWith('/files'), 413, 'payload_too_large')
  await files.getByTestId('project-file-input').setInputFiles([{ name: 'ok.txt', mimeType: 'text/plain', buffer: buf(10) }])
  await expect(files.getByRole('alert')).toContainText('That file is too large.')
  await expect(files.getByRole('alert')).toContainText('Split or compress it and upload again.')

  await files.getByRole('button', { name: 'Remove “notes.txt”' }).click()
  await expect(files.getByRole('listitem').filter({ hasText: 'notes.txt' })).toHaveCount(0)
  await ctx.close()
})

test('AC4: a failed file-list request is an error with Retry, not a false empty state', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL, undefined, (s) => {
    s.addProject({ name: 'Docs', files: [{ id: '1', name: 'notes.txt', mime: 'text/plain', size_bytes: 120, uploaded_by: ME, created_at: NOW(), context_tokens: 300 }] })
    s.refuse((method, path) => method === 'GET' && path.endsWith('/files'), 500, 'internal_error')
  })
  await go(page, baseURL, `/projects/${server.projects[0].id}`)
  const files = page.getByRole('region', { name: 'Files' })
  await expect(files.getByRole('alert')).toContainText('Something went wrong.')
  await expect(files.getByText('No files yet.')).toHaveCount(0)
  await files.getByRole('button', { name: 'Try again' }).click()
  await expect(files.getByRole('listitem').filter({ hasText: 'notes.txt' })).toBeVisible()
  await expect(files.getByRole('alert')).toHaveCount(0)
  await ctx.close()
})

test('AC5: teammate-owned project chats appear in the sidebar group, with their author and no rename or delete', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL, undefined, (s) => {
    const p = s.addProject({ name: 'Alpha' })
    s.session({ title: 'My plan', project_id: p.id })
    const theirs = s.session({ title: 'Teammate plan', project_id: p.id, owner_email: 'bo@example.com' })
    s.messages[theirs.id] = [{ id: '1', role: 'user', content: 'their question', sent_by: 'bo@example.com' }, { id: '2', role: 'assistant', content: 'their answer' }]
    s.session({ title: 'Elsewhere', project_id: '999', owner_email: 'bo@example.com' })
  })
  // the real list of own chats has no teammate chat
  expect(server.sessions.filter((x) => ownerOf(server, x) === ME).map((x) => x.title)).toEqual(['My plan'])
  await go(page, baseURL, '/chat')
  const nav = page.getByRole('navigation', { name: 'Conversations' })
  const group = nav.getByRole('group', { name: 'Alpha' })
  await expect(group.getByRole('button', { name: /Teammate plan/ })).toBeVisible()
  await expect(group.getByRole('button', { name: 'My plan' })).toBeVisible()
  await expect(group.locator('[data-chat-author]')).toHaveText(['by bo@example.com'])
  await expect(nav.getByText('Elsewhere')).toHaveCount(0)
  // someone else's chat can be opened and read, but not renamed, deleted or moved by this user
  const row = group.locator('li', { hasText: 'Teammate plan' })
  await row.hover()
  await expect(row.getByRole('button', { name: /Rename|Delete|Move/ })).toHaveCount(0)
  await row.getByRole('button', { name: /Teammate plan/ }).click()
  await expect(page).toHaveURL(new RegExp(`#/chat/${server.sessions.find((x) => x.title === 'Teammate plan').id}$`))
  await expect(page.getByText('their answer')).toBeVisible()
  await expect(page.getByText('Project: Alpha. Shared with its members.')).toBeVisible()
  await ctx.close()
})

// N7-18 (ADR-N7-18): the sidebar reads each project's chats ONCE at startup, whichever of the
// two startup lists (projects, own chats) arrives first, and EVERY later refresh reads again.
// Counted as requests to GET /api/projects/<id>/sessions; never a wall-time assertion.
const projectReads = (server) => server.calls.filter((c) => /^GET \/api\/projects\/\d+\/sessions$/.test(c)).length

// holds the first answer of `pattern` until `until()` resolves, then answers from the mock
async function holdUntil(page, pattern, until, answer) {
  await page.route(pattern, async (route) => {
    await until()
    return route.fulfill({ json: answer() })
  })
}

test('N7-18: startup with the projects list first reads each project once', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL, undefined, (s) => {
    const p = s.addProject({ name: 'Alpha' })
    s.session({ title: 'My plan', project_id: p.id })
    s.session({ title: 'Teammate plan', project_id: p.id, owner_email: 'bo@example.com' })
  })
  let projectsListed
  const projectsDone = new Promise((r) => (projectsListed = r))
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/projects') projectsListed()
  })
  // the caller's own list is held until the projects list has been answered
  await holdUntil(page, '**/api/sessions', () => projectsDone, () => ({ sessions: server.sessions.filter((x) => ownerOf(server, x) === ME) }))
  await go(page, baseURL, '/chat')
  const group = page.getByRole('navigation', { name: 'Conversations' }).getByRole('group', { name: 'Alpha' })
  await expect(group.getByRole('button', { name: /Teammate plan/ })).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(projectReads(server)).toBe(1)
  await ctx.close()
})

test('N7-18: startup with the own chats first reads each project once', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL, undefined, (s) => {
    const p = s.addProject({ name: 'Alpha' })
    s.session({ title: 'My plan', project_id: p.id })
    s.session({ title: 'Teammate plan', project_id: p.id, owner_email: 'bo@example.com' })
  })
  let sessionsListed
  const sessionsDone = new Promise((r) => (sessionsListed = r))
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/sessions') sessionsListed()
  })
  // the projects list is held until the caller's own list has been answered
  await page.route(/\/api\/projects(\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') await sessionsDone
    return route.fallback()
  })
  await go(page, baseURL, '/chat')
  const group = page.getByRole('navigation', { name: 'Conversations' }).getByRole('group', { name: 'Alpha' })
  await expect(group.getByRole('button', { name: /Teammate plan/ })).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(projectReads(server)).toBe(1)
  await ctx.close()
})

test('N7-18: a refresh one second after startup reads the projects again and shows the new teammate chat', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL, undefined, (s) => {
    const p = s.addProject({ name: 'Alpha' })
    s.session({ title: 'My plan', project_id: p.id })
    s.session({ title: 'Personal note' })
  })
  // a frozen clock keeps the gap between the startup read and the refresh at exactly 1,000 ms
  const t0 = new Date('2026-11-20T12:00:00Z')
  await page.clock.setFixedTime(t0)
  await go(page, baseURL, '/chat')
  const nav = page.getByRole('navigation', { name: 'Conversations' })
  const group = nav.getByRole('group', { name: 'Alpha' })
  await expect(group.getByRole('button', { name: 'My plan' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(projectReads(server)).toBe(1)

  // a teammate adds a chat, one second later the caller moves a chat into the project
  server.session({ title: 'Brand new teammate chat', project_id: server.projects[0].id, owner_email: 'bo@example.com' })
  await page.clock.setFixedTime(new Date(t0.getTime() + 1000))
  await nav.locator('li', { hasText: 'Personal note' }).hover()
  await nav.getByRole('button', { name: 'Move “Personal note” to a project' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Alpha' }).click()
  await expect(group.getByRole('button', { name: 'Brand new teammate chat' })).toBeVisible()
  await expect(group.getByRole('button', { name: 'Personal note' })).toBeVisible()
  expect(projectReads(server)).toBeGreaterThanOrEqual(2)
  await ctx.close()
})

test('AC5: project chats sit under their project; new chat in a project sends its id; temporary chats have no project actions', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL, undefined, (s) => {
    const p = s.addProject({ name: 'Alpha' })
    s.addProject({ name: 'Empty one' })
    s.session({ title: 'Plan the launch', project_id: p.id })
    s.session({ title: 'Personal note' })
    s.session({ title: 'Scratch', ephemeral: true })
  })
  const alpha = server.projects[0]
  await go(page, baseURL, '/chat')
  const nav = page.getByRole('navigation', { name: 'Conversations' })
  const group = nav.getByRole('group', { name: 'Alpha' })
  await expect(group.getByRole('button', { name: 'Plan the launch' })).toBeVisible()
  await expect(nav.getByRole('group', { name: 'Alpha' }).getByText('Personal note')).toHaveCount(0)
  await expect(nav.getByRole('group').filter({ hasText: 'Personal note' }).first()).not.toHaveText(/Plan the launch/)

  // the project chat is not offered "move to project"; the personal one is; the temporary one is not
  await expect(nav.getByRole('button', { name: /Move “Plan the launch”/ })).toHaveCount(0)
  await expect(nav.getByRole('button', { name: /Move “Scratch”/ })).toHaveCount(0)
  await nav.locator('li', { hasText: 'Personal note' }).hover()
  await nav.getByRole('button', { name: 'Move “Personal note” to a project' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Alpha' }).click()
  await expect.poll(() => server.sessions.find((s) => s.title === 'Personal note').project_id).toBe(alpha.id)
  await expect(nav.getByRole('group', { name: 'Alpha' }).getByRole('button', { name: 'Personal note' })).toBeVisible()

  // a new chat inside the project: the first message carries the project id
  await group.getByRole('button', { name: 'New chat in Alpha' }).click()
  await sendPrompt(page, 'hello project')
  await page.waitForFunction(() => !!window.__sse)
  expect(await page.evaluate(() => window.__payloads)).toMatchObject([{ projectId: alpha.id, sessionId: null }])
  await page.evaluate(() => {
    window.__sse.push({ type: 'done' })
    window.__sse.end()
  })

  // a temporary chat never carries a project id
  await page.getByRole('button', { name: 'Add files and more' }).click()
  await page.getByRole('menuitem', { name: /Temporary chat/ }).click()
  await sendPrompt(page, 'secret')
  await expect.poll(() => page.evaluate(() => window.__payloads.length)).toBe(2)
  expect((await page.evaluate(() => window.__payloads))[1]).not.toHaveProperty('projectId')
  await ctx.close()
})

test('AC6: a shared chat shows who sent each message and who is answering; the indicator never sticks', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL, undefined, (s) => {
    const p = s.addProject({ name: 'Alpha' })
    const chat = s.session({ title: 'Shared plan', project_id: p.id })
    s.messages[chat.id] = [
      { id: '1', role: 'user', content: 'first question', sent_by: 'bo@example.com' },
      { id: '2', role: 'assistant', content: 'first answer' },
      { id: '3', role: 'user', content: 'legacy question', sent_by: null },
      { id: '4', role: 'user', content: 'my question', sent_by: ME },
    ]
    s.live[chat.id] = { role: 'view', busy: { since: NOW(), by: 'bo@example.com' }, owner_email: 'bo@example.com' }
  })
  const chat = server.sessions[0]
  await go(page, baseURL, `/chat/${chat.id}`)
  await expect(page.getByText('first question')).toBeVisible()
  await expect(page.locator('[data-msg-author]')).toHaveText(['bo@example.com', ME])
  await expect(page.getByText('Project: Alpha. Shared with its members.')).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'bo@example.com is answering…' })).toBeVisible()
  // a viewer cannot rewrite the shared history: no edit on user messages
  await page.getByText('first question').hover()
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0)

  // the other member's turn ends: the next poll clears the indicator
  server.live[chat.id].busy = null
  await expect(page.getByText('is answering…')).toHaveCount(0, { timeout: 10_000 })

  // busy again, then the server becomes unreachable: "answering" must not stay
  server.live[chat.id].busy = { since: NOW(), by: 'cy@example.com' }
  await expect(page.getByText('cy@example.com is answering…')).toBeVisible({ timeout: 10_000 })
  server.live[chat.id].fail = true
  await expect(page.getByText('is answering…')).toHaveCount(0, { timeout: 10_000 })

  // my own turn is never "someone is answering"
  server.live[chat.id] = { role: 'owner', busy: { since: NOW(), by: ME.toUpperCase() }, owner_email: ME }
  // two completed polls after the change: the first may have been in flight, the second saw the new state
  const polled = () => page.waitForResponse((r) => /\/api\/sessions\/\d+$/.test(r.url()) && r.request().method() === 'GET')
  await polled()
  await polled()
  await expect(page.getByText('is answering…')).toHaveCount(0)
  // an owner/manager may rewrite history
  await page.getByText('first question').hover()
  await expect(page.getByRole('button', { name: 'Edit' }).first()).toBeVisible()
  await ctx.close()
})

test('AC7: keyboard only: create a project, add a member, open a chat, send', async ({ browser, baseURL }) => {
  const { ctx, page, errors, server } = await open(browser, baseURL)
  await go(page, baseURL, '/chat')
  const projectsNav = page.getByRole('button', { name: 'Projects', exact: true })
  await tabTo(page, projectsNav)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()

  await tabTo(page, page.getByLabel('New project name'))
  await page.keyboard.type('Keyboard project')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Keyboard project', level: 1 })).toBeVisible()

  await tabTo(page, page.getByLabel('E-mail address'))
  await page.keyboard.type('kim@example.com')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: 'Members' }).getByRole('listitem').filter({ hasText: 'kim@example.com' })).toBeVisible()
  expect(server.projects[0].members.map((m) => m.principal)).toContain('kim@example.com')

  // the chat bar sits above the side column in reading order: walk back to it
  const newChat = page.getByRole('button', { name: 'New chat in this project' })
  await tabTo(page, newChat, 80, 'Shift+Tab')
  await page.keyboard.press('Enter')
  const box = page.locator('textarea').first()
  await tabTo(page, box)
  await page.keyboard.type('hello from the keyboard')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => !!window.__sse)
  expect(await page.evaluate(() => window.__payloads)).toMatchObject([{ projectId: server.projects[0].id, prompt: 'hello from the keyboard' }])
  await page.evaluate(() => {
    window.__sse.push({ type: 'done' })
    window.__sse.end()
  })
  expect(errors).toEqual([])
  await ctx.close()
})

for (const v of VARIANTS) {
  test(`AC7: axe has no serious or critical violation on the Projects screens (${variantName(v)})`, async ({ browser, baseURL }) => {
    const seed = (s) => {
      const p = s.addProject({ name: 'Alpha', instructions: 'Be brief.', files: [{ id: '1', name: 'notes.txt', mime: 'text/plain', size_bytes: 120, uploaded_by: ME, created_at: NOW(), context_tokens: 300 }, { id: '2', name: 'huge-report.pdf', mime: 'application/pdf', size_bytes: 900, uploaded_by: ME, created_at: NOW(), context_tokens: 90000 }] })
      p.members.push({ kind: 'user', principal: 'bo@example.com', role: 'view', added_by: ME, added_at: NOW() }, { kind: 'group', principal: 'data-team', role: 'manage', added_by: ME, added_at: NOW() })
      s.addProject({ name: 'Read only one', role: 'view' })
      const chat = s.session({ title: 'Shared plan', project_id: p.id })
      s.session({ title: 'Personal note' })
      s.messages[chat.id] = [{ id: '1', role: 'user', content: 'first question', sent_by: 'bo@example.com' }, { id: '2', role: 'assistant', content: 'first answer' }]
      s.live[chat.id] = { role: 'owner', busy: { since: NOW(), by: 'bo@example.com' }, owner_email: ME }
    }
    const { ctx, page, server } = await open(browser, baseURL, v, seed)
    await go(page, baseURL, '/projects')
    await expect(page.getByRole('button', { name: 'Alpha' }).first()).toBeVisible()
    await expectAxeClean(page, `list ${variantName(v)}`)
    await go(page, baseURL, `/projects/${server.projects[0].id}`)
    await expect(page.getByRole('heading', { name: 'Alpha', level: 1 })).toBeVisible()
    await expect(page.getByText('Not in context (over budget)')).toBeVisible()
    await expectAxeClean(page, `owner detail ${variantName(v)}`)
    await go(page, baseURL, `/projects/${server.projects[1].id}`)
    await expect(page.getByRole('heading', { name: 'Read only one', level: 1 })).toBeVisible()
    await expectAxeClean(page, `viewer detail ${variantName(v)}`)
    await go(page, baseURL, `/chat/${server.sessions[1].id === undefined ? '' : server.sessions.find((s) => s.title === 'Shared plan').id}`)
    await expect(page.getByText('bo@example.com is answering…')).toBeVisible()
    await expectAxeClean(page, `shared chat ${variantName(v)}`)
    await ctx.close()
  })
}

test('AC7: the strings exist in pt-BR and es', async ({ browser, baseURL }) => {
  for (const [locale, heading, create] of [['pt-BR', 'Projetos', 'Criar projeto'], ['es-ES', 'Proyectos', 'Crear proyecto']]) {
    const ctx = await browser.newContext({ locale, timezoneId: 'UTC' })
    const page = await ctx.newPage()
    const server = makeServer()
    await install(page, server)
    await page.goto(`${baseURL}/#/projects`)
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: create })).toBeVisible()
    await ctx.close()
  }
})

// ---- ui-revamp W1-8 ----------------------------------------------------------------------------------------------
test('W1-8: the project page has a breadcrumb, a colour dot, member avatars and the chat bar', async ({ browser, baseURL }) => {
  const seed = (s) => {
    const p = s.addProject({ name: 'Alpha', description: 'The Q4 committee.' })
    p.members.push({ kind: 'user', principal: 'bo@example.com', role: 'view', added_by: ME, added_at: NOW() })
    s.session({ title: 'Shared plan', project_id: p.id })
  }
  const { ctx, page, server } = await open(browser, baseURL, undefined, seed)
  await go(page, baseURL, `/projects/${server.projects[0].id}`)
  await expect(page.getByRole('heading', { name: 'Alpha', level: 1 })).toBeVisible()
  const crumb = page.getByRole('navigation', { name: 'Projects' })
  await expect(crumb.getByRole('button', { name: 'Projects' })).toBeVisible()
  await expect(crumb.locator('[aria-current="page"]')).toHaveText('Alpha')
  await expect(page.getByText('The Q4 committee.')).toBeVisible()
  // the dot takes its colour from the project token of its id (lib/projectColor.ts: id % 8), never a literal
  const dot = page.locator('[data-project-dot]').first()
  const token = await page.evaluate((id) => {
    const probe = document.createElement('i')
    document.body.append(probe)
    probe.style.color = `var(--project-${Number(id) % 8})`
    const out = getComputedStyle(probe).color
    probe.remove()
    return out
  }, server.projects[0].id)
  expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(token)
  // real members only: the owner row of the mock plus bo@
  await expect(page.getByRole('list', { name: /^Members: .*bo@example\.com/ })).toBeVisible()
  // the side column holds the settings, the main column the chats
  const side = page.getByRole('group', { name: 'Project settings' })
  for (const name of ['Instructions', 'Files', 'Members']) await expect(side.getByRole('region', { name })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Chats' }).getByRole('button', { name: /^Shared plan/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New chat in this project' })).toBeVisible()
  await ctx.close()
})

test('W1-8: "Share project" takes the cursor to the members form, and only a manager sees it', async ({ browser, baseURL }) => {
  const { ctx, page, server } = await open(browser, baseURL, undefined, (s) => {
    s.addProject({ name: 'Mine' })
    s.addProject({ name: 'Theirs', role: 'view' })
  })
  await go(page, baseURL, `/projects/${server.projects[0].id}`)
  await page.getByRole('button', { name: 'Share project' }).click()
  await expect(page.getByRole('region', { name: 'Members' }).getByLabel('Kind of member')).toBeFocused()
  await go(page, baseURL, `/projects/${server.projects[1].id}`)
  await expect(page.getByRole('heading', { name: 'Theirs', level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Share project' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New chat in this project' })).toBeVisible()
  await ctx.close()
})

for (const theme of ['light', 'dark']) {
  test(`W1-8: primary buttons on the Projects screens are ink (--action / --on-action), ${theme}`, async ({ browser, baseURL }) => {
    const { ctx, page, server } = await open(browser, baseURL, { theme, mobile: false }, (s) => s.addProject({ name: 'Alpha', instructions: 'x' }))
    await go(page, baseURL, '/projects')
    const resolved = () =>
      page.evaluate(() => {
        const probe = document.createElement('i')
        document.body.append(probe)
        const read = (v) => ((probe.style.color = `var(${v})`), getComputedStyle(probe).color)
        const out = { action: read('--action'), onAction: read('--on-action') }
        probe.remove()
        return out
      })
    const cta = (loc) => loc.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }))
    const want = await resolved()
    expect(await cta(page.getByRole('button', { name: 'Create project' }))).toEqual({ bg: want.action, fg: want.onAction })
    await go(page, baseURL, `/projects/${server.projects[0].id}`)
    await page.getByLabel('Project instructions').fill('changed')
    expect(await cta(page.getByRole('button', { name: 'Save', exact: true }))).toEqual({ bg: want.action, fg: want.onAction })
    await ctx.close()
  })
}
