// Behaviour of the studios' write queue (QA W2-8 r1, findings 3 and 4).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSaveQueue } from './saveQueue.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setImmediate(r))

test('writes run one at a time, in request order, each reading the state when it runs', async () => {
  const states = []
  const q = createSaveQueue((s) => states.push(s.status))
  let content = 'first edit'
  const server = []
  const first = deferred()
  let started = 0
  const write = async () => {
    started++
    const sent = content // read at run time
    if (started === 1) await first.promise
    server.push(sent)
  }
  const a = q.run(write)
  await tick()
  content = 'newer edit'
  const b = q.run(write)
  await tick()
  assert.equal(started, 1, 'the newer write waits for the older one')
  first.resolve()
  await Promise.all([a, b])
  assert.deepEqual(server, ['first edit', 'newer edit'], 'the newer content lands last')
  assert.equal(states.at(-1), 'saved')
})

test('the status follows the newest request: an older failure never shows over a newer save', async () => {
  const states = []
  const q = createSaveQueue((s) => states.push(s))
  const older = q.run(async () => {
    throw new Error('HTTP 500')
  })
  const newer = q.run(async () => true)
  assert.equal(await older, false)
  assert.equal(await newer, true)
  assert.equal(states.at(-1).status, 'saved')
  assert.ok(!states.some((s) => s.status === 'error'), 'the stale failure was not shown')
})

test('Retry runs the current-state writer, not the closure that failed', async () => {
  const states = []
  const q = createSaveQueue((s) => states.push(s))
  const server = []
  let draft = 'first draft'
  const failing = 'first draft'
  assert.equal(
    await q.run(async () => {
      throw new Error(`HTTP 500 for ${failing}`)
    }),
    false,
  )
  assert.equal(states.at(-1).status, 'error')
  draft = 'latest draft'
  q.setRetry(async () => {
    server.push(draft)
    return true
  })
  assert.equal(await q.retry(), true)
  assert.deepEqual(server, ['latest draft'])
  assert.equal(states.at(-1).status, 'saved')
})

test('reset makes in-flight results stale and clears a failure', async () => {
  const states = []
  const q = createSaveQueue((s) => states.push(s.status))
  const hold = deferred()
  const p = q.run(async () => {
    await hold.promise
    throw new Error('HTTP 500')
  })
  q.reset()
  hold.resolve()
  await p
  assert.equal(states.at(-1), 'idle', 'a write for content that is gone does not resurface its error')
  assert.equal(await q.retry(), false, 'nothing to retry without a current-state writer')
})
