import { useEffect, useRef, useState } from 'react'
import { projectsApi } from './projectsApi.ts'
import { busyNotice, nextBusy } from './projectsLogic.ts'

interface BusyState {
  role: string | null
  busy: { since?: unknown; by?: string | null } | null
  ownerEmail: string | null
}

interface UseSessionBusyArgs {
  sessionId: string | number | null | undefined
  enabled: boolean
  streaming: boolean
  email?: string | null
}

const POLL_MS = 3000

/**
 * A project chat is shared: someone else may be mid-turn in it. Reads the
 * session payload (`role`, `busy: { since, by }`) when the chat opens and every
 * few seconds while the tab is visible, and returns who is answering.
 *
 * The indicator never outlives what the server last said: an idle answer, a
 * failed poll, my own turn starting, or another chat opening all clear it.
 * Polling stops while I stream (my own turn is its own state) and for personal
 * chats (nothing to poll).
 */
export function useSessionBusy({ sessionId, enabled, streaming, email }: UseSessionBusyArgs) {
  const [state, setState] = useState<BusyState>({ role: null, busy: null, ownerEmail: null })
  const alive = useRef(0)

  // the chat changed, or my turn started: whatever we knew about "answering" is void
  useEffect(() => {
    setState((s) => ({ ...s, busy: nextBusy(s.busy, { type: streaming ? 'streaming-started' : 'session-changed' }) }))
  }, [sessionId, streaming])

  useEffect(() => {
    if (!sessionId || !enabled) {
      setState({ role: null, busy: null, ownerEmail: null })
      return undefined
    }
    const run = ++alive.current
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (run !== alive.current) return
      if (!streaming && document.visibilityState !== 'hidden') {
        try {
          const r = await projectsApi.session(sessionId)
          if (run !== alive.current) return
          setState((s) => ({ role: r.role ?? null, busy: nextBusy(s.busy, { type: 'poll', busy: r.busy }), ownerEmail: r.session?.owner_email ?? null }))
        } catch {
          if (run !== alive.current) return
          setState((s) => ({ ...s, busy: nextBusy(s.busy, { type: 'poll-failed' }) }))
        }
      }
      if (run === alive.current) timer = setTimeout(tick, POLL_MS)
    }
    tick()
    return () => {
      alive.current++
      clearTimeout(timer)
    }
  }, [sessionId, enabled, streaming])

  return { role: state.role, ownerEmail: state.ownerEmail, answeringBy: busyNotice(state.busy, email) }
}
