// Minimal hash-based router — no react-router dependency, and hash changes
// never hit the server (unlike a path-based scheme), so no server route
// changes are needed either. Only pure parsing/pushing here; App.jsx owns
// applying the resulting state.
export function parseHash(): { view: 'history' } | { view: 'chat'; sessionId: string | null } {
  const hash = location.hash.replace(/^#\/?/, '')
  if (hash === 'history') return { view: 'history' }
  const m = hash.match(/^chat\/(.+)$/)
  if (m) return { view: 'chat', sessionId: m[1] ?? null }
  return { view: 'chat', sessionId: null }
}

export function pushHash(hash: string): void {
  if (location.hash === hash) return
  history.pushState(null, '', hash)
}

export function replaceHash(hash: string): void {
  if (location.hash === hash) return
  history.replaceState(null, '', hash)
}
