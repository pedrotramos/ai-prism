// In-process signal between the agent routes and the scheduler (W4-4a). The routes call notifyAgentsChanged()
// after a write that can move the earliest due time (enable, disable, run now, a decision); the scheduler
// (W4-4c) listens and re-arms its timer. Only this process hears it: another replica finds the change at its own
// next wake-up (the scheduler never sleeps longer than its max sleep), which is why this is a hint and not a queue.
type Listener = () => void

const listeners = new Set<Listener>()

/** Subscribes `fn`; the returned function unsubscribes it. */
export function onAgentsChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Calls every listener once, synchronously. A listener that throws never stops the others or the caller. */
export function notifyAgentsChanged(): void {
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch {
      // a listener's failure is its own: the write that notified has already committed
    }
  }
}
