import { useCallback, useEffect, useState } from 'react'
import { fetchAgentsStatus } from './agentsApi.ts'

/**
 * Whether scheduled agents are on for this deployment (GET /api/agents/status). `enabled` is false until the server
 * says true: while loading, when it is off, and when the call fails, so the nav entry, the page and the admin tab
 * never flash in (AC1). `refresh` re-reads it (the admin turned the setting on or off).
 */
export function useAgentsStatus(): { enabled: boolean; refresh: () => void } {
  const [enabled, setEnabled] = useState(false)
  const refresh = useCallback(() => {
    void fetchAgentsStatus().then(setEnabled)
  }, [])
  useEffect(() => {
    let alive = true
    void fetchAgentsStatus().then((v) => alive && setEnabled(v))
    return () => {
      alive = false
    }
  }, [])
  return { enabled, refresh }
}
