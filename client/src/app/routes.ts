// Hash routes of the app shell. Hash-based so a route change never reaches the
// server (no server route table to keep in sync) and a deep link survives the
// Databricks Apps proxy. Pure parsing/building only; the shell applies the
// result (App.tsx via useSessions) and lib/hashRouter.js pushes it.
//
//   #/chat              new conversation
//   #/chat/:id          one conversation
//   #/history           all conversations
//   #/costs             admin Costs page (billed cost from the system tables)
//   #/projects[/:id]    reserved: projects (parsed, not routed yet)
//
// Anything else falls back to a new chat, never to a blank page.

// every route the shell understands; `projectId` only exists on the projects view
export type Route =
  | { view: 'chat'; sessionId: string | number | null }
  | { view: 'history' }
  | { view: 'costs' }
  | { view: 'projects'; projectId: string | null }

const NEW_CHAT: Readonly<Route> = Object.freeze({ view: 'chat', sessionId: null })

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

/** @param hash e.g. location.hash */
export function parseRoute(hash: string = ''): Route {
  const path = String(hash).replace(/^#/, '').split('?')[0] ?? ''
  const parts = path.split('/').filter(Boolean)
  const [head, id, ...rest] = parts
  if (rest.length) return { ...NEW_CHAT }
  if (!head) return { ...NEW_CHAT }
  if (head === 'chat') return { view: 'chat', sessionId: id ? decode(id) : null }
  if (id) {
    if (head === 'projects') return { view: 'projects', projectId: decode(id) }
    return { ...NEW_CHAT }
  }
  if (head === 'history') return { view: 'history' }
  if (head === 'costs') return { view: 'costs' }
  if (head === 'projects') return { view: 'projects', projectId: null }
  return { ...NEW_CHAT }
}

/** The hash for a route object (the inverse of parseRoute). */
export function routeHash(route: Readonly<Route> = NEW_CHAT): string {
  switch (route.view) {
    case 'history':
      return '#/history'
    case 'costs':
      return '#/costs'
    case 'projects':
      return route.projectId ? `#/projects/${encodeURIComponent(route.projectId)}` : '#/projects'
    default:
      return route.sessionId ? `#/chat/${encodeURIComponent(route.sessionId)}` : '#/chat'
  }
}
