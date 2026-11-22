// Calls to /api/projects. The shared helpers in api.js throw a bare Error with
// the server's code and drop the HTTP status, but the Projects UI has to tell
// 403 (your role is too low: say which and what to do) from 404 (gone or not
// yours) from 409 (conflict), so this thin wrapper keeps `status` and `code`.

import type { ChatRow, FilesContext, Member, Project, ProjectFile, ProjectLimits } from './projectsLogic.ts'

interface ProjectsListResponse {
  projects?: Project[]
  limits?: ProjectLimits
}

/** GET /api/sessions/:id, the fields the busy poll reads. */
interface SessionPayload {
  role?: string | null
  busy?: { by?: string | null } | null
  session?: { owner_email?: string | null }
}

export class ProjectsApiError extends Error {
  // type-only: `declare` emits no class field, so the constructor's assignment order (name, status, code) stays the runtime order
  declare status: number
  declare code: string | null
  constructor(status: number, code?: string | null) {
    super(code || `HTTP ${status}`)
    this.name = 'ProjectsApiError'
    this.status = status
    this.code = code || null
  }
}

// Response bodies are parsed JSON whose shape each caller owns (`T` defaults to unknown).
async function call<T = unknown>(method: string, url: string, { json, form }: { json?: unknown; form?: FormData } = {}): Promise<T> {
  let r: Response
  try {
    r = await fetch(url, {
      method,
      headers: json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: json !== undefined ? JSON.stringify(json) : form,
    })
  } catch {
    throw new ProjectsApiError(0, 'network')
  }
  // r.json() is `any`: the body is read loosely for `error`, then handed to the typed caller
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ProjectsApiError(r.status, body?.error)
  return body
}

const enc = encodeURIComponent
const base = (id: string | number) => `/api/projects/${enc(id)}`
const memberUrl = (id: string | number, m: { kind: string; principal: string }) => `${base(id)}/members/${enc(m.kind)}/${enc(m.principal)}`

type Id = string | number
type MemberRef = { kind: string; principal: string }

export const projectsApi = {
  list: () => call<ProjectsListResponse>('GET', '/api/projects'),
  create: (fields: { name: string }) => call<{ project: Project }>('POST', '/api/projects', { json: fields }),
  get: (id: Id) => call<{ project?: Project } & Partial<Project>>('GET', base(id)),
  update: (id: Id, fields: { name?: string; instructions?: string }) => call<{ project?: Project }>('PATCH', base(id), { json: fields }),
  remove: (id: Id) => call('DELETE', base(id)),
  members: (id: Id) => call<{ members: Member[] }>('GET', `${base(id)}/members`),
  addMember: (id: Id, m: Member) => call('POST', `${base(id)}/members`, { json: m }),
  setRole: (id: Id, m: MemberRef, role: string) => call('PATCH', memberUrl(id, m), { json: { role } }),
  removeMember: (id: Id, m: MemberRef) => call('DELETE', memberUrl(id, m)),
  files: (id: Id) => call<{ files: ProjectFile[]; context?: FilesContext | null }>('GET', `${base(id)}/files`),
  upload: (id: Id, files: File[]) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    return call('POST', `${base(id)}/files`, { form: fd })
  },
  removeFile: (id: Id, fileId: Id) => call('DELETE', `${base(id)}/files/${enc(fileId)}`),
  sessions: (id: Id) => call<{ sessions?: ChatRow[] }>('GET', `${base(id)}/sessions`),
  attach: (id: Id, sessionId: Id) => call('POST', `${base(id)}/sessions`, { json: { sessionId } }),
  detach: (id: Id, sessionId: Id) => call('DELETE', `${base(id)}/sessions/${enc(sessionId)}`),
  session: (sessionId: Id) => call<SessionPayload>('GET', `/api/sessions/${enc(sessionId)}`),
}
