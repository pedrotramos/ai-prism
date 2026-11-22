// The write queue behind every studio's save status (useSaveStatus).
//
// Writes run ONE AT A TIME, in the order they were requested: a newer write
// never races an older one to the server, so a slow first PATCH can no longer
// land after (and overwrite) a newer edit. Each write function reads the live
// state when it RUNS, not when it was queued, so a queued autosave still sends
// the latest content.
//
// The visible status follows the newest request only: an older write that
// settles while a newer one is queued never flips the indicator to Saved or
// Couldn't save. `reset()` (a different artifact loaded, or the pending change
// was discarded) also makes every in-flight result stale.
//
// Retry re-runs `retryFn()` — a function that writes the CURRENT state (the
// studio decides what that is) — never the closure of the write that failed,
// so a draft edited after the failure, or a preview the user discarded, is
// saved as it is now / not resurrected.
export interface SaveState {
  status: 'idle' | 'saving' | 'saved' | 'error'
  error: string | null
}

export type SaveQueue = ReturnType<typeof createSaveQueue>

export function createSaveQueue(onState: (state: SaveState) => void) {
  let tail: Promise<unknown> = Promise.resolve()
  let newest = 0
  let retryFn: (() => unknown) | null = null
  const set = (ticket: number, state: SaveState) => {
    if (ticket === newest) onState(state)
  }
  const run = <T>(fn: () => T | Promise<T>): Promise<NonNullable<T> | boolean> => {
    const ticket = ++newest
    onState({ status: 'saving', error: null })
    const job = tail.then(async () => {
      try {
        const out = await fn()
        set(ticket, { status: 'saved', error: null })
        return out ?? true
      } catch (e) {
        set(ticket, { status: 'error', error: (e as { message?: string } | null)?.message || String(e) })
        return false
      }
    })
    tail = job
    return job
  }
  return {
    run,
    retry: () => (retryFn ? run(retryFn) : Promise.resolve(false)),
    setRetry: (fn: () => unknown) => {
      retryFn = fn
    },
    reset: () => {
      newest++
      onState({ status: 'idle', error: null })
    },
    /** settles once every queued write has (tests and unmount-safe callers) */
    idle: () => tail.then(() => undefined),
  }
}
