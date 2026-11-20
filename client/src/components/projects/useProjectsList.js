import { useCallback, useEffect, useState } from 'react'
import { projectsApi } from './projectsApi.js'

/**
 * The caller's projects and the server's limits (GET /api/projects). The sidebar
 * and the Projects page share one copy. A failure never breaks the shell: the
 * list stays empty and `error` says why (the page shows it with Retry).
 */
export function useProjectsList() {
  const [projects, setProjects] = useState([])
  const [limits, setLimits] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const reload = useCallback(async () => {
    try {
      const r = await projectsApi.list()
      setProjects(r.projects || [])
      setLimits(r.limits || null)
      setError(null)
      return r.projects || []
    } catch (e) {
      setError(e)
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  return { projects, limits, loading, error, reload }
}
