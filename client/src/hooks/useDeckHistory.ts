import { useCallback, useRef } from 'react'

// Undo/redo for the Deck Studio: a bounded stack of deck snapshots. Handlers
// call `commit(deck)` BEFORE applying a mutation (drags coalesce by
// committing once on pointerdown, not per pointermove); undo/redo return the
// snapshot to restore (or null). Structural sharing via the Studio's
// immutable updates keeps memory reasonable; images are shared references.
const MAX_HISTORY = 100

export default function useDeckHistory<D = unknown>() {
  const past = useRef<D[]>([])
  const future = useRef<D[]>([])

  const commit = useCallback((deck: D | null | undefined) => {
    if (!deck) return
    past.current.push(deck)
    if (past.current.length > MAX_HISTORY) past.current.shift()
    future.current = []
  }, [])

  const undo = useCallback((current: D): D | null => {
    const prev = past.current.pop()
    if (!prev) return null
    future.current.push(current)
    return prev
  }, [])

  const redo = useCallback((current: D): D | null => {
    const next = future.current.pop()
    if (!next) return null
    past.current.push(current)
    return next
  }, [])

  const reset = useCallback(() => {
    past.current = []
    future.current = []
  }, [])

  return { commit, undo, redo, reset }
}
