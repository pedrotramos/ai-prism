import { useEffect, useRef } from 'react'
import { openCrossTab, planSync } from '../../lib/crossTab.ts'
import type { CrossTab } from '../../lib/crossTab.ts'
import type { SessionsState } from './useSessions.ts'

/**
 * Keeps this tab in step with the others of the same browser: when a turn ends here the
 * others are told, and when a turn ends in another tab the list is refreshed and, if that
 * conversation is the open one, its messages are reloaded (lib/crossTab.ts has the rules).
 */
export function useCrossTabSync(s: SessionsState): void {
  // the latest state for the channel callback, which is created once
  const live = useRef(s)
  live.current = s
  const tab = useRef<CrossTab | null>(null)
  const wasStreaming = useRef(false)

  useEffect(() => {
    tab.current = openCrossTab((m) => {
      const cur = live.current
      const plan = planSync(m, { currentId: cur.currentId, streaming: cur.streaming, loadingSession: cur.loadingSession })
      if (plan.list) void cur.loadSessions()
      if (plan.reload) void cur.retryLoad()
    })
    return () => {
      tab.current?.close()
      tab.current = null
    }
  }, [])

  useEffect(() => {
    if (wasStreaming.current && !s.streaming && s.currentId != null) tab.current?.post({ kind: 'turn-ended', id: String(s.currentId) })
    wasStreaming.current = s.streaming
  }, [s.streaming, s.currentId])
}
