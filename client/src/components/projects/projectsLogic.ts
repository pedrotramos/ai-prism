// Pure rules of the Projects UI. Nothing here decides access: the server does
// (server/access.js, row-level security). These helpers only mirror the ladder
// so a control is not offered to a role that cannot use it, and turn the
// server's refusals into a plain sentence plus the next step to take.

export type Role = 'view' | 'manage' | 'owner'
export type Action = 'read' | 'attach' | 'edit' | 'files' | 'members' | 'detach' | 'delete'

export interface Member {
  kind: string
  principal: string
  role: Role
}

export interface Project {
  id: string | number
  name: string | null
  role: Role | null
  description?: string | null
  instructions?: string | null
}

export interface ProjectLimits {
  fileMaxBytes: number
  supportedExtensions?: string[]
  filesPerUpload: number
  filesPerProject: number
  nameMaxChars?: number
  instructionsMaxChars?: number
}

export interface ProjectFile {
  id: string | number
  name: string
  size_bytes: number
  context?: string
  context_tokens?: number | null
  truncated_at_upload?: boolean
}

export interface FilesContext {
  budget_tokens?: unknown
  used_tokens?: unknown
  excluded_count?: unknown
}

/** A chat row as the sidebar and the project page read it (GET /api/sessions, /projects/:id/sessions). */
export interface ChatRow {
  id: string | number
  title?: string | null
  model?: string | null
  created_at?: string | null
  updated_at?: string | null
  project_id?: string | number | null
  owner_email?: string | null
  ephemeral?: boolean
}

/** What a failed call carries: `ProjectsApiError` or a local `{ status, code }`. */
export interface ApiFailure {
  status?: number
  code?: string | null
}

const RANK = { view: 1, manage: 2, owner: 3 }
const ROLES: Role[] = ['view', 'manage', 'owner']

// minimum role per UI action (same table as NEEDS in server/access.js)
const NEEDS: Record<string, Role> = {
  read: 'view',
  attach: 'view',
  edit: 'manage',
  files: 'manage',
  members: 'manage',
  detach: 'manage',
  delete: 'owner',
}

const rank = (role: string | null | undefined): number => (RANK as Record<string, number>)[role as string] || 0

/** May `role` do `action`? Unknown role or action: no. */
export function can(role: string | null | undefined, action: string): boolean {
  const need = NEEDS[action]
  return !!need && rank(role) >= rank(need)
}

/** The roles `role` may give (manage up to manage, owner anything, view nothing). */
export function assignableRoles(role: string | null | undefined): Role[] {
  if (rank(role) < RANK.manage) return []
  return role === 'owner' ? [...ROLES] : ROLES.filter((r) => r !== 'owner')
}

/** What the caller may do with one member row. Owner rows are an owner's call; anyone may leave. */
export function memberAccess(myRole: string | null | undefined, member: Member, myEmail?: string | null) {
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
export function groupSessionsByProject<S extends ChatRow>(sessions: S[], projects: Project[]) {
  const byId = new Map<string, { project: Project; items: S[] }>(projects.map((p) => [String(p.id), { project: p, items: [] }]))
  const personal: S[] = []
  for (const s of sessions) {
    if (s.project_id == null || s.ephemeral) {
      personal.push(s)
      continue
    }
    const key = String(s.project_id)
    if (!byId.has(key)) byId.set(key, { project: { id: key, name: null, role: null }, items: [] })
    byId.get(key)!.items.push(s) // set just above when absent
  }
  return { groups: [...byId.values()].sort((a, b) => Number(a.project.id) - Number(b.project.id)), personal }
}

/** Character counter against a server limit; `near` = the last 10 %. */
export function charCounter(value: unknown, max: number | null | undefined) {
  const count = String(value ?? '').length
  if (!Number.isFinite(max) || max == null) return { count, max: null, remaining: null, state: 'ok' }
  const state = count > max ? 'over' : count >= max * 0.9 ? 'near' : 'ok'
  return { count, max, remaining: max - count, state }
}

/** What a chat reads of a file, from GET /files: full | partial | excluded | unknown. */
export function fileContextState(file: { context?: string } | null | undefined): string {
  return ['full', 'partial', 'excluded'].includes(file?.context as string) ? (file!.context as string) : 'unknown'
}

/** The totals of GET /files `context`, ready to show. */
export function contextSummary(ctx: FilesContext | null | undefined) {
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
export function describeFailure({ status, code }: ApiFailure, ctx?: string) {
  if (status === 0) return { key: 'projects.err.offline', next: NEXT.retry }
  if (status === 403) {
    const owner = ctx === 'delete' || code === 'cannot_grant_role'
    return { key: owner ? 'projects.err.needOwner' : 'projects.err.needManage', next: NEXT.askOwner }
  }
  if (status === 404) return { key: 'projects.err.gone', next: 'projects.err.next.backToList' }
  if (status === 413) return { key: 'projects.err.fileTooLarge', next: 'projects.err.next.smallerFile' }
  const table: Record<string, [string, string]> = {
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
  const hit = table[code as string]
  if (hit) return { key: hit[0], next: hit[1] }
  if (/_too_long$/.test(code || '')) return { key: 'projects.err.tooLong', next: 'projects.err.next.shorten' }
  return { key: 'projects.err.generic', next: NEXT.retry }
}

const extOf = (name: unknown): string => (String(name).includes('.') ? String(name).split('.').pop()!.toLowerCase() : '')

/**
 * Splits a picked file list into what may be uploaded and what is refused (and
 * why: size, type, count per upload, cap per project) before any byte leaves
 * the browser. `limits` is GET /api/projects `limits`; without it the server decides.
 */
export function precheckUploads<F extends { name: string; size: number }>(files: F[], limits: ProjectLimits | null | undefined, alreadyThere = 0) {
  if (!limits) return { ok: [...files], rejected: [] as { name: string; reason: string }[] }
  const ok: F[] = []
  const rejected: { name: string; reason: string }[] = []
  for (const f of files) {
    let reason: string | null = null
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
export function busyNotice(busy: { since?: unknown; by?: string | null } | null | undefined, myEmail?: string | null) {
  const by = busy?.by
  if (!by) return null
  return String(by).toLowerCase() === String(myEmail || '').toLowerCase() ? null : by
}

/** The busy state after an event; it never outlives what the last poll saw. */
export function nextBusy<B>(_current: unknown, event: { type: string; busy?: B | null }): B | null {
  if (event.type === 'poll') return event.busy || null
  return null
}
