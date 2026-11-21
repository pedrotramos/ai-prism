import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  can,
  assignableRoles,
  memberAccess,
  groupSessionsByProject,
  charCounter,
  fileContextState,
  describeFailure,
  precheckUploads,
  busyNotice,
  nextBusy,
  contextSummary,
} from './projectsLogic.ts'
import { ProjectsApiError } from './projectsApi.ts'
import type { ChatRow, Project, Role } from './projectsLogic.ts'

const LIMITS = { nameMaxChars: 200, instructionsMaxChars: 20000, fileMaxBytes: 1000, filesPerUpload: 2, filesPerProject: 3, supportedExtensions: ['pdf', 'txt'] }

test('can(): the same ladder the server enforces (view < manage < owner)', () => {
  assert.equal(can('view', 'read'), true)
  assert.equal(can('view', 'attach'), true)
  assert.equal(can('view', 'edit'), false)
  assert.equal(can('view', 'files'), false)
  assert.equal(can('view', 'members'), false)
  assert.equal(can('manage', 'edit'), true)
  assert.equal(can('manage', 'files'), true)
  assert.equal(can('manage', 'members'), true)
  assert.equal(can('manage', 'delete'), false)
  assert.equal(can('owner', 'delete'), true)
  assert.equal(can(null, 'read'), false)
  assert.equal(can('owner', 'nonsense'), false)
})

test('assignableRoles(): a manager cannot hand out owner, a viewer hands out nothing', () => {
  assert.deepEqual(assignableRoles('owner'), ['view', 'manage', 'owner'])
  assert.deepEqual(assignableRoles('manage'), ['view', 'manage'])
  assert.deepEqual(assignableRoles('view'), [])
  assert.deepEqual(assignableRoles(null), [])
})

test('memberAccess(): who can change or remove which row (owner rows are an owner’s call; anyone may leave)', () => {
  const me = 'ana@x.com'
  const row = (role: Role, principal = 'bo@x.com', kind = 'user') => ({ kind, principal, role })
  assert.deepEqual(memberAccess('view', row('view'), me), { canChangeRole: false, canRemove: false, canLeave: false })
  assert.deepEqual(memberAccess('view', row('view', me), me), { canChangeRole: false, canRemove: false, canLeave: true })
  assert.deepEqual(memberAccess('manage', row('view'), me), { canChangeRole: true, canRemove: true, canLeave: false })
  assert.deepEqual(memberAccess('manage', row('owner'), me), { canChangeRole: false, canRemove: false, canLeave: false })
  assert.deepEqual(memberAccess('owner', row('owner'), me), { canChangeRole: true, canRemove: true, canLeave: false })
  assert.deepEqual(memberAccess('manage', row('manage', me), me), { canChangeRole: true, canRemove: true, canLeave: true })
  // a group row with the caller's e-mail as its name is not the caller
  assert.equal(memberAccess('view', row('view', me, 'group'), me).canLeave, false)
})

test('groupSessionsByProject(): project chats go under their project, personal ones stay; temporary chats never join', () => {
  const projects: Project[] = [
    { id: '1', name: 'Alpha', role: 'owner' },
    { id: '2', name: 'Beta', role: 'view' },
  ]
  const sessions: ChatRow[] = [
    { id: 'a', project_id: '2', title: 'b1' },
    { id: 'b', project_id: null, title: 'p1' },
    { id: 'c', project_id: '1', title: 'a1' },
    { id: 'd', project_id: '1', title: 'a2' },
    { id: 'e', project_id: null, ephemeral: true, title: 'temp' },
    { id: 'f', project_id: '9', title: 'orphan' },
  ]
  const { groups, personal } = groupSessionsByProject(sessions, projects)
  assert.deepEqual(groups.map((g) => [g.project.id, g.items.map((x) => x.id)]), [
    ['1', ['c', 'd']],
    ['2', ['a']],
    ['9', ['f']],
  ])
  assert.equal(groups[2]!.project.name, null, 'an unknown project keeps its id and no name')
  assert.deepEqual(personal.map((x) => x.id), ['b', 'e'])
})

test('groupSessionsByProject(): projects with no chat still appear (so “new chat in project” has a home)', () => {
  const { groups } = groupSessionsByProject([], [{ id: '1', name: 'Alpha', role: 'view' }])
  assert.deepEqual(groups.map((g) => g.project.id), ['1'])
  assert.deepEqual(groups[0]!.items, [])
})

test('charCounter(): counts against the server limit and flags the last 10 %', () => {
  assert.deepEqual(charCounter('abc', 10), { count: 3, max: 10, remaining: 7, state: 'ok' })
  assert.equal(charCounter('a'.repeat(9), 10).state, 'near')
  assert.equal(charCounter('a'.repeat(10), 10).state, 'near')
  assert.equal(charCounter('a'.repeat(11), 10).state, 'over')
  assert.equal(charCounter('', 10).state, 'ok')
  // no limit loaded yet: never "over"
  assert.equal(charCounter('a'.repeat(99999), null).state, 'ok')
})

test('fileContextState(): full / partial / excluded and the unknown legacy case', () => {
  assert.equal(fileContextState({ context: 'full' }), 'full')
  assert.equal(fileContextState({ context: 'partial' }), 'partial')
  assert.equal(fileContextState({ context: 'excluded' }), 'excluded')
  assert.equal(fileContextState({}), 'unknown')
  assert.equal(fileContextState({ context: 'weird' }), 'unknown')
})

test('contextSummary(): used of budget tokens and how many files are left out', () => {
  assert.deepEqual(contextSummary({ budget_tokens: 32000, used_tokens: 8000, excluded_count: 2 }), { used: 8000, budget: 32000, excluded: 2, percent: 25 })
  assert.equal(contextSummary(undefined), null)
  assert.equal(contextSummary({ budget_tokens: 0, used_tokens: 0, excluded_count: 3 })!.percent, 0)
})

test('describeFailure(): a permission problem names the role needed and the next step (Peak-End)', () => {
  assert.deepEqual(describeFailure({ status: 403, code: 'forbidden' }, 'members'), { key: 'projects.err.needManage', next: 'projects.err.next.askOwner' })
  assert.deepEqual(describeFailure({ status: 403, code: 'cannot_grant_role' }, 'members'), { key: 'projects.err.needOwner', next: 'projects.err.next.askOwner' })
  assert.deepEqual(describeFailure({ status: 403, code: 'forbidden' }, 'delete'), { key: 'projects.err.needOwner', next: 'projects.err.next.askOwner' })
  assert.deepEqual(describeFailure({ status: 403, code: 'forbidden' }, 'edit'), { key: 'projects.err.needManage', next: 'projects.err.next.askOwner' })
  assert.deepEqual(describeFailure({ status: 404, code: 'project_not_found' }, 'edit'), { key: 'projects.err.gone', next: 'projects.err.next.backToList' })
  assert.deepEqual(describeFailure({ status: 409, code: 'last_owner' }, 'members'), { key: 'projects.err.lastOwner', next: 'projects.err.next.addOwnerFirst' })
  assert.deepEqual(describeFailure({ status: 409, code: 'already_a_member' }, 'members'), { key: 'projects.err.alreadyMember', next: 'projects.err.next.changeRoleInstead' })
  assert.deepEqual(describeFailure({ status: 400, code: 'ephemeral_in_project' }, 'attach'), { key: 'projects.err.ephemeral', next: 'projects.err.next.startNormalChat' })
  assert.deepEqual(describeFailure({ status: 400, code: 'invalid_principal' }, 'members'), { key: 'projects.err.invalidPrincipal', next: 'projects.err.next.checkAddress' })
  assert.deepEqual(describeFailure({ status: 400, code: 'invalid_name' }, 'create'), { key: 'projects.err.invalidName', next: 'projects.err.next.typeName' })
  assert.deepEqual(describeFailure({ status: 400, code: 'instructions_too_long' }, 'edit'), { key: 'projects.err.tooLong', next: 'projects.err.next.shorten' })
  assert.deepEqual(describeFailure({ status: 413, code: 'payload_too_large' }, 'files'), { key: 'projects.err.fileTooLarge', next: 'projects.err.next.smallerFile' })
  assert.deepEqual(describeFailure({ status: 400, code: 'unsupported_file' }, 'files'), { key: 'projects.err.fileType', next: 'projects.err.next.convertFile' })
  assert.deepEqual(describeFailure({ status: 409, code: 'file_limit' }, 'files'), { key: 'projects.err.fileCap', next: 'projects.err.next.removeFile' })
  assert.deepEqual(describeFailure({ status: 500, code: 'internal_error' }, 'edit'), { key: 'projects.err.generic', next: 'projects.err.next.retry' })
  assert.deepEqual(describeFailure({ status: 0, code: 'network' }, 'edit'), { key: 'projects.err.offline', next: 'projects.err.next.retry' })
})

test('precheckUploads(): size, type and count are refused before any bytes leave the browser', () => {
  const f = (name: string, size: number) => ({ name, size })
  assert.deepEqual(precheckUploads([f('a.pdf', 10), f('b.txt', 20)], LIMITS, 0), { ok: [f('a.pdf', 10), f('b.txt', 20)], rejected: [] })
  const r = precheckUploads([f('big.pdf', 5000), f('x.exe', 1), f('ok.TXT', 5)], LIMITS, 0)
  assert.deepEqual(r.ok.map((x) => x.name), ['ok.TXT'])
  assert.deepEqual(r.rejected, [
    { name: 'big.pdf', reason: 'size' },
    { name: 'x.exe', reason: 'type' },
  ])
  // more than filesPerUpload in one go: the extra ones are refused
  const many = precheckUploads([f('1.pdf', 1), f('2.pdf', 1), f('3.pdf', 1)], LIMITS, 0)
  assert.equal(many.ok.length, 2)
  assert.deepEqual(many.rejected, [{ name: '3.pdf', reason: 'count' }])
  // the per-project cap counts what is already there
  const cap = precheckUploads([f('1.pdf', 1), f('2.pdf', 1)], LIMITS, 2)
  assert.equal(cap.ok.length, 1)
  assert.deepEqual(cap.rejected, [{ name: '2.pdf', reason: 'cap' }])
  // limits not loaded yet: let the server decide
  assert.deepEqual(precheckUploads([f('a.xyz', 1e9)], null, 0).rejected, [])
})

test('busyNotice(): names who is answering, never the caller herself, never a stale value', () => {
  assert.equal(busyNotice(null, 'ana@x.com'), null)
  assert.equal(busyNotice({ since: 't' }, 'ana@x.com'), null, 'no author: nothing to name')
  assert.equal(busyNotice({ since: 't', by: 'ana@x.com' }, 'ana@x.com'), null, 'my own turn is the streaming state, not this')
  assert.equal(busyNotice({ since: 't', by: 'Bo@x.com' }, 'ana@x.com'), 'Bo@x.com')
})

test('nextBusy(): the indicator clears when the poll says idle, when the poll fails, and when I start streaming', () => {
  const busy = { since: 't', by: 'bo@x.com' }
  assert.deepEqual(nextBusy(null, { type: 'poll', busy }), busy)
  assert.equal(nextBusy(busy, { type: 'poll', busy: null }), null)
  assert.equal(nextBusy(busy, { type: 'poll-failed' }), null, 'an unreachable server must not leave a stale "answering"')
  assert.equal(nextBusy(busy, { type: 'streaming-started' }), null)
  assert.equal(nextBusy(busy, { type: 'session-changed' }), null)
})

test('mergeProjectChats(): teammates’ project chats join the caller’s own, once, newest first', async () => {
  const { mergeProjectChats } = await import('./useProjectChats.ts')
  const own: ChatRow[] = [{ id: '1', title: 'mine', project_id: '5', updated_at: '2026-01-02' }, { id: '2', title: 'solo', project_id: null, updated_at: '2026-01-01' }]
  const shared: ChatRow[] = [
    { id: '1', title: 'mine', project_id: '5', owner_email: 'me@x.com', updated_at: '2026-01-02' },
    { id: '3', title: 'theirs', project_id: '5', owner_email: 'bo@x.com', updated_at: '2026-01-03' },
  ]
  const merged = mergeProjectChats(own, shared)
  assert.deepEqual(merged.map((s) => s.id), ['3', '1', '2'])
  assert.equal(merged.find((s) => s.id === '1')!.owner_email, undefined, 'the caller’s own row wins')
  assert.equal(mergeProjectChats(own, []), own)
})

test('ProjectsApiError keeps the existing enumerable property order when serialized', () => {
  const error = new ProjectsApiError(403, 'forbidden')
  assert.deepEqual(Object.keys(error), ['name', 'status', 'code'])
  assert.equal(JSON.stringify(error), '{"name":"ProjectsApiError","status":403,"code":"forbidden"}')
})
