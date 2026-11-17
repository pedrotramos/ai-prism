import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFifoLimiter } from './fifoLimiter.js'

const deferred = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}
const tick = () => new Promise((r) => setImmediate(r))

test('never runs more tasks than the limit at once, in FIFO order', async () => {
  const limiter = createFifoLimiter(2)
  const started = []
  const gates = [deferred(), deferred(), deferred(), deferred()]
  const runs = gates.map((gate, i) =>
    limiter.run(async () => {
      started.push(i)
      await gate.promise
      return i
    })
  )
  await tick()
  assert.deepEqual(started, [0, 1])
  assert.equal(limiter.activeCount, 2)
  assert.equal(limiter.pendingCount, 2)
  gates[0].resolve()
  await tick()
  assert.deepEqual(started, [0, 1, 2])
  gates[1].resolve()
  gates[2].resolve()
  gates[3].resolve()
  assert.deepEqual(await Promise.all(runs), [0, 1, 2, 3])
  assert.equal(limiter.activeCount, 0)
  assert.equal(limiter.pendingCount, 0)
})

test('a rejected task rejects only its own promise and frees the slot', async () => {
  const limiter = createFifoLimiter(1)
  const bad = limiter.run(async () => {
    throw new Error('boom')
  })
  const good = limiter.run(async () => 'ok')
  await assert.rejects(bad, /boom/)
  assert.equal(await good, 'ok')
})

test('a limit below 1 is clamped to 1', async () => {
  const limiter = createFifoLimiter(0)
  let active = 0
  let peak = 0
  const task = async () => {
    active++
    peak = Math.max(peak, active)
    await tick()
    active--
  }
  await Promise.all([limiter.run(task), limiter.run(task), limiter.run(task)])
  assert.equal(peak, 1)
})
