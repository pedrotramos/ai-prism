import { useEffect, useRef, useState } from 'react'
import { projectsApi } from './projectsApi.js'

// GET /api/sessions lists only the caller's OWN chats, but a project's chats are
// shared: a teammate's chat is visible to every member through
// GET /api/projects/:id/sessions. The sidebar needs both to group chats under
// their project (Common Region), so this loads the project lists.
//
// Kept cheap: one request per project, at most MAX_PROJECTS of them. Nothing is read
// until `ready` (both startup lists, the projects and the caller's own chats, have
// finished loading), so startup is ONE read per project whichever list arrives first.
// After that every change of the project list or of the caller's own chat list (they
// reload after every turn and every move) reads again: there is NO cache and no time
// window, so a refresh is never swallowed. Never on a timer. A failed read keeps what
// was known for that project (the sidebar must not lose chats to a blip).
const MAX_PROJECTS = 20

/** GET /api/projects/:id/sessions. A plain read: no cache, no join, no window. */
export function readProjectSessions(id, api = projectsApi) {
  return Promise.resolve(api.sessions(String(id)))
}

/**
 * @param {Array<{id: string}>} projects the caller's projects
 * @param {unknown} refreshKey changes whenever the caller's own chat list reloads
 * @param {boolean} ready true once the projects list and the caller's own chats finished loading
 * @returns {Array} chats of the projects (all authors), shaped like session rows
 */
export function useProjectChats(projects, refreshKey, ready) {
  const [byProject, setByProject] = useState({})
  const run = useRef(0)
  const ids = projects.slice(0, MAX_PROJECTS).map((p) => String(p.id))
  const idsKey = ids.join(',')

  useEffect(() => {
    const mine = ++run.current
    const list = idsKey ? idsKey.split(',') : []
    // a project the caller is no longer in drops out at once
    setByProject((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => list.includes(id))))
    if (!ready) return undefined // startup: the other list is still loading, read once when both are in
    Promise.allSettled(list.map((id) => readProjectSessions(id))).then((results) => {
      if (mine !== run.current) return
      setByProject((prev) => {
        const next = {}
        list.forEach((id, i) => {
          const r = results[i]
          if (r.status === 'fulfilled') {
            next[id] = (r.value.sessions || []).map((x) => ({
              id: String(x.id),
              title: x.title,
              model: x.model,
              created_at: x.created_at,
              updated_at: x.updated_at,
              project_id: id,
              owner_email: x.owner_email || null,
              ephemeral: false,
            }))
          } else if (prev[id]) next[id] = prev[id]
        })
        return next
      })
    })
    return () => {
      run.current++
    }
  }, [ready, idsKey, refreshKey])

  return Object.values(byProject).flat()
}

/**
 * The caller's own chats plus the chats other members made in the caller's
 * projects, newest first. A chat the caller owns keeps its own row (it carries
 * the model, tools and so on).
 */
export function mergeProjectChats(own, shared) {
  const have = new Set(own.map((s) => String(s.id)))
  const extra = shared.filter((s) => !have.has(String(s.id)))
  if (!extra.length) return own
  return [...own, ...extra].sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))
}
