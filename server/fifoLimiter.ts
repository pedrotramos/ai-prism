export interface FifoLimiter {
  run<T>(task: () => T | PromiseLike<T>): Promise<T>
  readonly activeCount: number
  readonly pendingCount: number
}

interface QueueItem {
  task: () => unknown
  resolve: (value: any) => void // any: the promise's T is erased in the shared queue
  reject: (reason?: unknown) => void
}

export function createFifoLimiter(limit?: unknown): FifoLimiter {
  const max = Math.max(1, Math.floor(Number(limit) || 1))
  const queue: QueueItem[] = []
  let active = 0

  function drain() {
    while (active < max && queue.length) {
      const item = queue.shift()!
      active++
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          active--
          drain()
        })
    }
  }

  return {
    run<T>(task: () => T | PromiseLike<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({ task, resolve, reject })
        drain()
      })
    },
    get activeCount() {
      return active
    },
    get pendingCount() {
      return queue.length
    },
  }
}
