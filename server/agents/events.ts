// In-process signal between the agent routes and the scheduler (W4-4a). The routes call notifyAgentsChanged()
// after a write that can move the earliest due time (enable, disable, run now, a decision); the scheduler
// (W4-4c) listens and re-arms its timer. Only this process hears it: another replica finds the change at its own
// next wake-up or when request activity (below) makes it look again, which is why this is a hint and not a queue.
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

const activityListeners = new Set<Listener>()

/** Subscribes `fn` to "this process served a request"; the returned function unsubscribes it. */
export function onAgentsActivity(fn: () => void): () => void {
  activityListeners.add(fn)
  return () => {
    activityListeners.delete(fn)
  }
}

/**
 * An authenticated request reached this process (so the database is awake anyway). The scheduler uses it to re-read the
 * schedules at most every few minutes, which is how a change saved on another replica is seen without a poll while
 * the app is idle. Cheap: one set lookup and a timestamp compare per listener; a listener that throws is ignored.
 */
export function noteAgentsActivity(): void {
  for (const fn of activityListeners) {
    try {
      fn()
    } catch {
      // activity is a hint
    }
  }
}
