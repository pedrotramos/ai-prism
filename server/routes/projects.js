// Projects (W2-3, design D4): CRUD, members (users and SCIM groups), files and
// the chats in a project.
//
//   GET    /api/projects                                   the caller's projects (with her role)
//   POST   /api/projects                                   { name, description?, instructions? } → 201
//   GET    /api/projects/:id                               { project } (role included)
//   PATCH  /api/projects/:id                               manage+: name / description / instructions
//   DELETE /api/projects/:id                               owner: the project AND its chats
//   GET    /api/projects/:id/members                       members
//   POST   /api/projects/:id/members                       manage+: { kind: user|group, principal, role } → 201
//   PATCH  /api/projects/:id/members/:kind/:principal      manage+: { role } (owner rows: owner)
//   DELETE /api/projects/:id/members/:kind/:principal      manage+, or the member herself (leave)
//   GET    /api/projects/:id/files                         members: the list (no content)
//   GET    /api/projects/:id/files/:fileId                 members: one file with its extracted text
//   POST   /api/projects/:id/files                         manage+: multipart `files` (PROJECT_FILE_LIMITS) → 201
//   DELETE /api/projects/:id/files/:fileId                 manage+
//   GET    /api/projects/:id/sessions                      members: the project's chats
//   POST   /api/projects/:id/sessions                      view+: { sessionId } moves the caller's own chat in
//   DELETE /api/projects/:id/sessions/:sessionId           the chat's creator with manage+: back to personal
//
// Statuses: 404 for a non-member (app admins included: no implicit access, and
// a project's existence never leaks), 403 for a member whose role is too low,
// 409 for conflicts (duplicate member, last owner, file cap), 400 for invalid
// input. The rules live in server/access.js; server/db/projects.js applies them
// inside the write's own transaction, and row-level security (migration 0005)
// enforces them again in the database.
import path from 'node:path'
import * as projects from '../db/projects.js'
import { normalizePrincipal, PROJECT_ROLES } from '../access.js'
import { auth } from '../middleware/auth.ts'
import { ensureReady } from '../middleware/ensureReady.ts'
import { projectFileUpload, fixFilename } from '../middleware/index.ts'
import { extractText, SUPPORTED_EXTENSIONS } from '../files.ts'
import { logger } from '../log.js'

const ID_RE = /^[0-9]{1,18}$/
const LIMITS = { name: 200, description: 2000, instructions: 20000 }

function send(res, result, okStatus = 200) {
  if (result && result.status) return res.status(result.status).json({ error: result.error })
  return res.status(okStatus).json(result)
}

function fail(res, e, what) {
  logger.warn(`projects: ${what} failed`, { err: e })
  res.status(500).json({ error: 'internal_error' })
}

/** { fields } or { error } for the project body; `partial` = PATCH (all optional). */
export function readProjectFields(body, { partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const fields = {}
  for (const k of ['name', 'description', 'instructions']) {
    if (b[k] === undefined) continue
    if (typeof b[k] !== 'string') return { error: `invalid_${k}` }
    fields[k] = k === 'name' ? b[k].trim() : b[k]
    if (fields[k].length > LIMITS[k]) return { error: `${k}_too_long` }
  }
  if ((!partial || fields.name !== undefined) && !fields.name) return { error: 'invalid_name' }
  if (partial && !Object.keys(fields).length) return { error: 'nothing_to_update' }
  return { fields }
}

/** A stored file name: the last path segment, no control characters, ≤ 255 chars. */
export function safeFileName(raw) {
  const decoded = fixFilename(String(raw || ''))
  // eslint-disable-next-line no-control-regex
  const base = decoded.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!base || base === '.' || base === '..') return null
  return base.slice(0, 255)
}

function member(req) {
  const kind = req.params.kind
  return { kind, principal: normalizePrincipal(kind, req.params.principal) }
}

// multer errors (size / count) are 413 here: nothing is read past the limit
function receiveFiles(req, res) {
  return new Promise((resolve) => {
    projectFileUpload.array('files')(req, res, (err) => {
      if (!err) return resolve(true)
      const tooBig = err?.name === 'MulterError' && ['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT'].includes(err.code)
      res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'payload_too_large' : 'invalid_upload' })
      resolve(false)
    })
  })
}

export default function registerProjectRoutes(app) {
  app.get('/api/projects', auth, async (req, res) => {
    try {
      await ensureReady(req)
      res.json({ projects: await projects.listProjects(req.email, req.token) })
    } catch (e) {
      fail(res, e, 'list')
    }
  })

  app.post('/api/projects', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const { fields, error } = readProjectFields(req.body)
      if (error) return res.status(400).json({ error })
      res.status(201).json({ project: await projects.createProject(req.email, req.token, fields) })
    } catch (e) {
      fail(res, e, 'create')
    }
  })

  app.get('/api/projects/:id', auth, async (req, res) => {
    try {
      await ensureReady(req)
      send(res, await projects.getProject(req.email, req.token, req.params.id))
    } catch (e) {
      fail(res, e, 'get')
    }
  })

  app.patch('/api/projects/:id', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const { fields, error } = readProjectFields(req.body, { partial: true })
      if (error) {
        // a non-member learns nothing, not even that her body was invalid
        const role = await projects.getProjectRole(req.email, req.token, req.params.id)
        return role ? res.status(400).json({ error }) : res.status(404).json({ error: 'project_not_found' })
      }
      send(res, await projects.updateProject(req.email, req.token, req.params.id, fields))
    } catch (e) {
      fail(res, e, 'update')
    }
  })

  app.delete('/api/projects/:id', auth, async (req, res) => {
    try {
      await ensureReady(req)
      send(res, await projects.deleteProject(req.email, req.token, req.params.id))
    } catch (e) {
      fail(res, e, 'delete')
    }
  })

  // ---- members ----
  app.get('/api/projects/:id/members', auth, async (req, res) => {
    try {
      await ensureReady(req)
      send(res, await projects.listMembers(req.email, req.token, req.params.id))
    } catch (e) {
      fail(res, e, 'members list')
    }
  })

  app.post('/api/projects/:id/members', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const b = req.body || {}
      const principal = normalizePrincipal(b.kind, b.principal)
      const bad = !principal ? 'invalid_principal' : !PROJECT_ROLES.includes(b.role) ? 'invalid_role' : null
      if (bad) {
        const role = await projects.getProjectRole(req.email, req.token, req.params.id)
        return role ? res.status(400).json({ error: bad }) : res.status(404).json({ error: 'project_not_found' })
      }
      send(res, await projects.addMember(req.email, req.token, req.params.id, { kind: b.kind, principal, role: b.role }), 201)
    } catch (e) {
      fail(res, e, 'member add')
    }
  })

  app.patch('/api/projects/:id/members/:kind/:principal', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const m = member(req)
      const role = req.body?.role
      if (!m.principal || !PROJECT_ROLES.includes(role)) {
        const mine = await projects.getProjectRole(req.email, req.token, req.params.id)
        return mine ? res.status(400).json({ error: !m.principal ? 'invalid_principal' : 'invalid_role' }) : res.status(404).json({ error: 'project_not_found' })
      }
      send(res, await projects.updateMemberRole(req.email, req.token, req.params.id, { ...m, role }))
    } catch (e) {
      fail(res, e, 'member update')
    }
  })

  app.delete('/api/projects/:id/members/:kind/:principal', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const m = member(req)
      if (!m.principal) {
        const mine = await projects.getProjectRole(req.email, req.token, req.params.id)
        return mine ? res.status(400).json({ error: 'invalid_principal' }) : res.status(404).json({ error: 'project_not_found' })
      }
      send(res, await projects.removeMember(req.email, req.token, req.params.id, m))
    } catch (e) {
      fail(res, e, 'member remove')
    }
  })

  // ---- files ----
  app.get('/api/projects/:id/files', auth, async (req, res) => {
    try {
      await ensureReady(req)
      send(res, await projects.listFiles(req.email, req.token, req.params.id))
    } catch (e) {
      fail(res, e, 'files list')
    }
  })

  app.get('/api/projects/:id/files/:fileId', auth, async (req, res) => {
    try {
      if (!ID_RE.test(req.params.fileId)) return res.status(404).json({ error: 'file_not_found' })
      await ensureReady(req)
      send(res, await projects.getFile(req.email, req.token, req.params.id, req.params.fileId))
    } catch (e) {
      fail(res, e, 'file get')
    }
  })

  app.post('/api/projects/:id/files', auth, async (req, res) => {
    try {
      await ensureReady(req)
      // the role first: a non-member's or viewer's bytes are never read
      const role = await projects.getProjectRole(req.email, req.token, req.params.id)
      if (!role) return res.status(404).json({ error: 'project_not_found' })
      if (role === 'view') return res.status(403).json({ error: 'forbidden' })
      if (!(await receiveFiles(req, res))) return
      const uploads = req.files || []
      if (!uploads.length) return res.status(400).json({ error: 'no_files' })
      const files = []
      for (const f of uploads) {
        const name = safeFileName(f.originalname)
        const ext = name && name.includes('.') ? path.extname(name).slice(1).toLowerCase() : ''
        if (!name || !SUPPORTED_EXTENSIONS.includes(ext)) return res.status(400).json({ error: 'unsupported_file', name: name || null })
        files.push({ name, mime: f.mimetype || null, sizeBytes: f.size, contentText: await extractText(name, f.buffer) })
      }
      send(res, await projects.addFiles(req.email, req.token, req.params.id, files), 201)
    } catch (e) {
      fail(res, e, 'files add')
    }
  })

  app.delete('/api/projects/:id/files/:fileId', auth, async (req, res) => {
    try {
      if (!ID_RE.test(req.params.fileId)) return res.status(404).json({ error: 'file_not_found' })
      await ensureReady(req)
      send(res, await projects.deleteFile(req.email, req.token, req.params.id, req.params.fileId))
    } catch (e) {
      fail(res, e, 'file delete')
    }
  })

  // ---- chats in the project ----
  app.get('/api/projects/:id/sessions', auth, async (req, res) => {
    try {
      await ensureReady(req)
      send(res, await projects.listProjectSessions(req.email, req.token, req.params.id))
    } catch (e) {
      fail(res, e, 'sessions list')
    }
  })

  app.post('/api/projects/:id/sessions', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const sid = String(req.body?.sessionId ?? '')
      if (!ID_RE.test(sid)) {
        const role = await projects.getProjectRole(req.email, req.token, req.params.id)
        return role ? res.status(400).json({ error: 'invalid_session_id' }) : res.status(404).json({ error: 'project_not_found' })
      }
      send(res, await projects.attachSession(req.email, req.token, req.params.id, sid))
    } catch (e) {
      fail(res, e, 'session attach')
    }
  })

  app.delete('/api/projects/:id/sessions/:sessionId', auth, async (req, res) => {
    try {
      if (!ID_RE.test(req.params.sessionId)) return res.status(404).json({ error: 'session_not_found' })
      await ensureReady(req)
      send(res, await projects.detachSession(req.email, req.token, req.params.id, req.params.sessionId))
    } catch (e) {
      fail(res, e, 'session detach')
    }
  })
}
