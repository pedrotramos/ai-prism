// Calls to /api/projects. The shared helpers in api.js throw a bare Error with
// the server's code and drop the HTTP status, but the Projects UI has to tell
// 403 (your role is too low: say which and what to do) from 404 (gone or not
// yours) from 409 (conflict), so this thin wrapper keeps `status` and `code`.

export class ProjectsApiError extends Error {
  constructor(status, code) {
    super(code || `HTTP ${status}`)
    this.name = 'ProjectsApiError'
    this.status = status
    this.code = code || null
  }
}

async function call(method, url, { json, form } = {}) {
  let r
  try {
    r = await fetch(url, {
      method,
      headers: json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: json !== undefined ? JSON.stringify(json) : form,
    })
  } catch {
    throw new ProjectsApiError(0, 'network')
  }
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ProjectsApiError(r.status, body?.error)
  return body
}

const enc = encodeURIComponent
const base = (id) => `/api/projects/${enc(id)}`
const memberUrl = (id, m) => `${base(id)}/members/${enc(m.kind)}/${enc(m.principal)}`

export const projectsApi = {
  list: () => call('GET', '/api/projects'),
  create: (fields) => call('POST', '/api/projects', { json: fields }),
  get: (id) => call('GET', base(id)),
  update: (id, fields) => call('PATCH', base(id), { json: fields }),
  remove: (id) => call('DELETE', base(id)),
  members: (id) => call('GET', `${base(id)}/members`),
  addMember: (id, m) => call('POST', `${base(id)}/members`, { json: m }),
  setRole: (id, m, role) => call('PATCH', memberUrl(id, m), { json: { role } }),
  removeMember: (id, m) => call('DELETE', memberUrl(id, m)),
  files: (id) => call('GET', `${base(id)}/files`),
  upload: (id, files) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    return call('POST', `${base(id)}/files`, { form: fd })
  },
  removeFile: (id, fileId) => call('DELETE', `${base(id)}/files/${enc(fileId)}`),
  sessions: (id) => call('GET', `${base(id)}/sessions`),
  attach: (id, sessionId) => call('POST', `${base(id)}/sessions`, { json: { sessionId } }),
  detach: (id, sessionId) => call('DELETE', `${base(id)}/sessions/${enc(sessionId)}`),
  session: (sessionId) => call('GET', `/api/sessions/${enc(sessionId)}`),
}
