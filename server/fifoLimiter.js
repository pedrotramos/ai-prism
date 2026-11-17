export function createFifoLimiter(limit) {
  const max = Math.max(1, Math.floor(Number(limit) || 1))
  const queue = []
  let active = 0

  function drain() {
    while (active < max && queue.length) {
      const item = queue.shift()
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
    run(task) {
      return new Promise((resolve, reject) => {
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
