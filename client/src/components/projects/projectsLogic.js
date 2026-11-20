// Pure rules of the Projects UI. Nothing here decides access: the server does
// (server/access.js, row-level security). These helpers only mirror the ladder
// so a control is not offered to a role that cannot use it, and turn the
// server's refusals into a plain sentence plus the next step to take.

const RANK = { view: 1, manage: 2, owner: 3 }
const ROLES = ['view', 'manage', 'owner']

// minimum role per UI action (same table as NEEDS in server/access.js)
const NEEDS = {
  read: 'view',
  attach: 'view',
  edit: 'manage',
  files: 'manage',
  members: 'manage',
  detach: 'manage',
  delete: 'owner',
}

const rank = (role) => RANK[role] || 0

/** May `role` do `action`? Unknown role or action: no. */
export function can(role, action) {
  const need = NEEDS[action]
  return !!need && rank(role) >= rank(need)
}

/** The roles `role` may give (manage up to manage, owner anything, view nothing). */
export function assignableRoles(role) {
  if (rank(role) < RANK.manage) return []
  return role === 'owner' ? [...ROLES] : ROLES.filter((r) => r !== 'owner')
}

/** What the caller may do with one member row. Owner rows are an owner's call; anyone may leave. */
export function memberAccess(myRole, member, myEmail) {
  const me = String(myEmail || '').trim().toLowerCase()
  const self = member.kind === 'user' && String(member.principal || '').toLowerCase() === me
  const touchable = rank(myRole) >= RANK.manage && (member.role !== 'owner' || myRole === 'owner')
  return { canChangeRole: touchable, canRemove: touchable, canLeave: self }
}

/**
 * Project chats under their project (Common Region), personal chats apart.
 * A project with no chat still gets a group (it is where "new chat" lives); a
 * project the list does not know (not loaded yet) keeps its id and no name.
 * A temporary chat is never in a project.
 */
export function groupSessionsByProject(sessions, projects) {
  const byId = new Map(projects.map((p) => [String(p.id), { project: p, items: [] }]))
  const personal = []
  for (const s of sessions) {
    if (s.project_id == null || s.ephemeral) {
      personal.push(s)
      continue
    }
    const key = String(s.project_id)
    if (!byId.has(key)) byId.set(key, { project: { id: key, name: null, role: null }, items: [] })
    byId.get(key).items.push(s)
  }
  return { groups: [...byId.values()].sort((a, b) => Number(a.project.id) - Number(b.project.id)), personal }
}

/** Character counter against a server limit; `near` = the last 10 %. */
export function charCounter(value, max) {
  const count = String(value ?? '').length
  if (!Number.isFinite(max) || max == null) return { count, max: null, remaining: null, state: 'ok' }
  const state = count > max ? 'over' : count >= max * 0.9 ? 'near' : 'ok'
  return { count, max, remaining: max - count, state }
}

/** What a chat reads of a file, from GET /files: full | partial | excluded | unknown. */
export function fileContextState(file) {
  return ['full', 'partial', 'excluded'].includes(file?.context) ? file.context : 'unknown'
}

/** The totals of GET /files `context`, ready to show. */
export function contextSummary(ctx) {
  if (!ctx) return null
  const budget = Number(ctx.budget_tokens) || 0
  const used = Number(ctx.used_tokens) || 0
  return { used, budget, excluded: Number(ctx.excluded_count) || 0, percent: budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0 }
}

const NEXT = {
  askOwner: 'projects.err.next.askOwner',
  retry: 'projects.err.next.retry',
}

/**
 * A failed call → { key, next }: two catalog keys, what happened and what to do
 * about it. `ctx` is what the user was doing (create, edit, delete, members,
 * files, attach). 403 names the role that was needed; 404 never says whether the
 * project exists for someone else (it is "gone or not yours").
 */
export function describeFailure({ status, code }, ctx) {
  if (status === 0) return { key: 'projects.err.offline', next: NEXT.retry }
  if (status === 403) {
    const owner = ctx === 'delete' || code === 'cannot_grant_role'
    return { key: owner ? 'projects.err.needOwner' : 'projects.err.needManage', next: NEXT.askOwner }
  }
  if (status === 404) return { key: 'projects.err.gone', next: 'projects.err.next.backToList' }
  if (status === 413) return { key: 'projects.err.fileTooLarge', next: 'projects.err.next.smallerFile' }
  const table = {
    last_owner: ['projects.err.lastOwner', 'projects.err.next.addOwnerFirst'],
    already_a_member: ['projects.err.alreadyMember', 'projects.err.next.changeRoleInstead'],
    ephemeral_in_project: ['projects.err.ephemeral', 'projects.err.next.startNormalChat'],
    invalid_principal: ['projects.err.invalidPrincipal', 'projects.err.next.checkAddress'],
    invalid_role: ['projects.err.generic', NEXT.retry],
    invalid_name: ['projects.err.invalidName', 'projects.err.next.typeName'],
    unsupported_file: ['projects.err.fileType', 'projects.err.next.convertFile'],
    file_limit: ['projects.err.fileCap', 'projects.err.next.removeFile'],
    too_many_files: ['projects.err.fileCap', 'projects.err.next.removeFile'],
    no_files: ['projects.err.noFiles', 'projects.err.next.pickFile'],
  }
  const hit = table[code]
  if (hit) return { key: hit[0], next: hit[1] }
  if (/_too_long$/.test(code || '')) return { key: 'projects.err.tooLong', next: 'projects.err.next.shorten' }
  return { key: 'projects.err.generic', next: NEXT.retry }
}

const extOf = (name) => (String(name).includes('.') ? String(name).split('.').pop().toLowerCase() : '')

/**
 * Splits a picked file list into what may be uploaded and what is refused (and
 * why: size, type, count per upload, cap per project) before any byte leaves
 * the browser. `limits` is GET /api/projects `limits`; without it the server decides.
 */
export function precheckUploads(files, limits, alreadyThere = 0) {
  if (!limits) return { ok: [...files], rejected: [] }
  const ok = []
  const rejected = []
  for (const f of files) {
    let reason = null
    if (f.size > limits.fileMaxBytes) reason = 'size'
    else if (!(limits.supportedExtensions || []).includes(extOf(f.name))) reason = 'type'
    else if (ok.length >= limits.filesPerUpload) reason = 'count'
    else if (alreadyThere + ok.length >= limits.filesPerProject) reason = 'cap'
    if (reason) rejected.push({ name: f.name, reason })
    else ok.push(f)
  }
  return { ok, rejected }
}

/** Who to name in "<name> is answering…": someone else's turn only. */
export function busyNotice(busy, myEmail) {
  const by = busy?.by
  if (!by) return null
  return String(by).toLowerCase() === String(myEmail || '').toLowerCase() ? null : by
}

/** The busy state after an event; it never outlives what the last poll saw. */
export function nextBusy(current, event) {
  if (event.type === 'poll') return event.busy || null
  return null
}
