import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startDbKeepAlive, KEEPALIVE_INTERVAL_MS } from './keepAlive.js'

// Minimal fake of the window/document surface the module uses.
function fakeEnv() {
  const listeners = []
  const timers = []
  const doc = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn)
      if (i >= 0) listeners.splice(i, 1)
    },
    fire(type) {
      for (const l of listeners.filter((x) => x.type === type)) l.fn()
    },
    listenerCount: () => listeners.length,
  }
  const win = {
    setInterval: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearInterval: (id) => {
      timers[id - 1] = null
    },
    tick: () => timers.filter(Boolean).forEach((t) => t.fn()),
    timers,
  }
  return { doc, win }
}

const flush = () => new Promise((r) => setImmediate(r))

test('a visible tab pings on each interval tick', async () => {
  const { doc, win } = fakeEnv()
  let clock = 0
  let pings = 0
  startDbKeepAlive({ doc, win, now: () => clock, ping: async () => pings++ })
  assert.equal(win.timers[0].ms, KEEPALIVE_INTERVAL_MS)
  win.tick()
  await flush()
  assert.equal(pings, 1)
  clock += KEEPALIVE_INTERVAL_MS
  win.tick()
  await flush()
  assert.equal(pings, 2)
})

test('a hidden tab does not ping', async () => {
  const { doc, win } = fakeEnv()
  let pings = 0
  doc.visibilityState = 'hidden'
  startDbKeepAlive({ doc, win, now: () => 0, ping: async () => pings++ })
  win.tick()
  doc.fire('visibilitychange')
  await flush()
  assert.equal(pings, 0)
})

test('returning to a tab pings only when the last ping is stale', async () => {
  const { doc, win } = fakeEnv()
  let clock = 0
  let pings = 0
  startDbKeepAlive({ doc, win, now: () => clock, ping: async () => pings++ })
  doc.fire('visibilitychange') // first: no ping yet, so it pings
  await flush()
  assert.equal(pings, 1)
  clock += 60_000
  doc.fire('visibilitychange') // fresh: skipped
  await flush()
  assert.equal(pings, 1)
  clock += KEEPALIVE_INTERVAL_MS
  doc.fire('visibilitychange') // stale: pings again
  await flush()
  assert.equal(pings, 2)
})

test('a failed ping is retried on the next opportunity', async () => {
  const { doc, win } = fakeEnv()
  let clock = 0
  let calls = 0
  startDbKeepAlive({
    doc,
    win,
    now: () => clock,
    ping: async () => {
      calls++
      if (calls === 1) throw new Error('offline')
    },
  })
  doc.fire('visibilitychange')
  await flush()
  doc.fire('visibilitychange') // no time has passed: retried because the last one failed
  await flush()
  assert.equal(calls, 2)
})

test('stop clears the timer and the listener', () => {
  const { doc, win } = fakeEnv()
  const stop = startDbKeepAlive({ doc, win, now: () => 0, ping: async () => {} })
  assert.equal(doc.listenerCount(), 1)
  stop()
  assert.equal(doc.listenerCount(), 0)
  assert.equal(win.timers[0], null)
})
