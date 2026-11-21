// Abort threading below the turn routes (W2-2), against the fake AI Gateway, no
// database: a turn's AbortSignal reaches the gateway request (server/llm.js),
// the tool call (server/tools.js) and the deck slide queue
// (server/deckHtmlGenerate.js), and the turn's cancellation state
// (createTurnCancel in server/turn.js) frees the session lock at once unless
// the turn is already writing its answer.
//
//   node --test server/turnAbort.test.js
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { startFakeGateway } from '../scripts/fake-gateway.mjs'

process.env.LOCAL_DEV_MODE = '1'
process.env.APPKIT_BOOT = '1'

let gw
let llm
let tools
let deck
let turn

before(async () => {
  gw = await startFakeGateway({ port: 0 })
  process.env.DATABRICKS_HOST = gw.url
  llm = await import('./llm.js')
  tools = await import('./tools.js')
  deck = await import('./deckHtmlGenerate.ts')
  turn = await import('./turn.js')
})

after(async () => {
  await gw?.close()
})

const MODEL = 'databricks-claude-sonnet-5-5'
const ABORT_BUDGET_MS = 1000

const lastUser = (body) => {
  const m = [...(body?.messages || [])].reverse().find((x) => x.role === 'user')
  const c = m?.content
  // a prompt-cached message arrives as text blocks
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text || '').join('') : ''
}

/** Resolves with `p`, or rejects when it takes longer than `ms`. */
function within(p, ms, what) {
  let t
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, reject) => (t = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms))),
  ])
}

// ---------------------------------------------------------------- llm.js

test('streamChat: aborting the signal mid-stream cancels the gateway request within 1 s', async () => {
  const marker = `stream-abort-${Date.now()}`
  const hold = gw.hold((r) => r.body?.stream && lastUser(r.body).includes(marker))
  try {
    const ac = new AbortController()
    const run = (async () => {
      for await (const _ of llm.streamChat('t', MODEL, [{ role: 'user', content: marker }], { signal: ac.signal })) {
        // drain
      }
    })()
    await hold.entered
    const t0 = Date.now()
    ac.abort()
    await assert.rejects(within(run, ABORT_BUDGET_MS, 'streamChat'), (e) => e.name === 'AbortError')
    const seen = await within(hold.aborted, ABORT_BUDGET_MS, 'gateway observes the abort')
    assert.ok(seen.at - t0 <= ABORT_BUDGET_MS, `gateway saw the abort after ${seen.at - t0} ms`)
  } finally {
    hold.release()
  }
})

test('streamChat: an already-aborted signal makes no gateway request', async () => {
  const marker = `pre-abort-${Date.now()}`
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(
    (async () => {
      for await (const _ of llm.streamChat('t', MODEL, [{ role: 'user', content: marker }], { signal: ac.signal })) {
        // drain
      }
    })(),
    (e) => e.name === 'AbortError'
  )
  assert.equal(gw.requests.filter((r) => lastUser(r.body).includes(marker)).length, 0)
})

test('completeWithUsage: the signal cancels a non-streaming gateway request', async () => {
  const marker = `complete-abort-${Date.now()}`
  const hold = gw.hold((r) => r.body && !r.body.stream && lastUser(r.body).includes(marker))
  try {
    const ac = new AbortController()
    const run = llm.completeWithUsage('t', MODEL, [{ role: 'user', content: marker }], { signal: ac.signal })
    await hold.entered
    ac.abort()
    await assert.rejects(within(run, ABORT_BUDGET_MS, 'completeWithUsage'), (e) => e.name === 'AbortError')
    await within(hold.aborted, ABORT_BUDGET_MS, 'gateway observes the abort')
  } finally {
    hold.release()
  }
})

// ---------------------------------------------------------------- tools.js

test('invokeTool: an abort while the tool awaits its backend rejects at once with AbortError', async () => {
  const hold = gw.hold((r) => r.path.startsWith('/api/2.0/genie/'))
  try {
    const ac = new AbortController()
    const resolver = { kind: 'genie', toolName: 'ask_genie_fake', ref: { spaceId: 'fake-space', title: 'Fake' } }
    const run = tools.invokeTool('t', resolver, { question: 'fake' }, { signal: ac.signal })
    await hold.entered
    ac.abort()
    await assert.rejects(within(run, ABORT_BUDGET_MS, 'invokeTool'), (e) => e.name === 'AbortError')
  } finally {
    hold.release()
  }
})

test('invokeTool: an already-aborted signal never starts the tool', async () => {
  const before = gw.requests.length
  const ac = new AbortController()
  ac.abort()
  const resolver = { kind: 'genie', toolName: 'ask_genie_fake', ref: { spaceId: 'fake-space', title: 'Fake' } }
  await assert.rejects(tools.invokeTool('t', resolver, { question: 'fake' }, { signal: ac.signal }), (e) => e.name === 'AbortError')
  assert.equal(gw.requests.length, before, 'no backend request')
})

// ---------------------------------------------------------------- deckHtmlGenerate.js

const OUTLINE = {
  title: 'Abort deck',
  slides: Array.from({ length: 8 }, (_, i) => ({ kind: 'content', headline: `Slide ${i + 1}` })),
}
const isSlideCall = (r) => r.body && !r.body.stream && /<section> do slide \d+:\s*$/.test(lastUser(r.body))

test('generateDeckFromOutline: without a signal every slide is materialized', async () => {
  const slides = []
  const titles = []
  const built = await deck.generateDeckFromOutline('t', MODEL, OUTLINE, { onTitle: (...a) => titles.push(a), onSlide: (_, i) => slides.push(i) })
  // the title event carries the planned slide count ("Building slide N of M")
  assert.deepEqual(titles, [[OUTLINE.title, 8]])
  assert.equal(built.slides.length, 8)
  assert.equal(built.cancelled, false)
  assert.equal(slides.length, 8)
})

test('generateDeckFromOutline: an abort cancels the in-flight slide calls and starts no new one', async () => {
  const hold = gw.hold(isSlideCall)
  try {
    const ac = new AbortController()
    const startedBefore = gw.requests.filter(isSlideCall).length
    const slides = []
    const run = deck.generateDeckFromOutline('t', MODEL, OUTLINE, { signal: ac.signal, onSlide: (_, i) => slides.push(i) })
    await hold.entered // slide 0 (the style anchor) is in flight
    const t0 = Date.now()
    ac.abort()
    const built = await within(run, ABORT_BUDGET_MS, 'generateDeckFromOutline')
    assert.equal(built.cancelled, true)
    assert.deepEqual(slides, [], 'no slide is emitted after the abort')
    const seen = await within(hold.aborted, ABORT_BUDGET_MS, 'gateway observes the slide abort')
    assert.ok(seen.at - t0 <= ABORT_BUDGET_MS)
    // generateDeckFromOutline has returned, so every slide worker has exited:
    // no later slide call can start (no fixed wait needed)
    assert.equal(gw.requests.filter(isSlideCall).length - startedBefore, 1, 'only the anchor slide call was ever issued')
    hold.release()
  } finally {
    hold.release()
  }
})

// ---------------------------------------------------------------- turn.js: cancellation state

function fakeRes() {
  const res = new EventEmitter()
  res.writableFinished = false
  res.writableEnded = false
  res.end = () => {
    res.writableEnded = true
  }
  return res
}

test('createTurnCancel: a client disconnect aborts the signal and frees the lock at once', () => {
  const res = fakeRes()
  let released = 0
  const cancel = turn.createTurnCancel(res, () => () => released++)
  assert.equal(cancel.signal.aborted, false)
  res.emit('close')
  assert.equal(cancel.gone, true)
  assert.equal(cancel.signal.aborted, true)
  assert.equal(released, 1, 'lock released on cancel, not when the handler unwinds')
  assert.equal(res.writableEnded, true)
})

test('createTurnCancel: a finished response closing is not a cancel', () => {
  const res = fakeRes()
  let released = 0
  const cancel = turn.createTurnCancel(res, () => () => released++)
  res.writableFinished = true
  res.emit('close')
  assert.equal(cancel.gone, false)
  assert.equal(cancel.signal.aborted, false)
  assert.equal(released, 0)
})

test('createTurnCancel: commit() refuses to start writing after a cancel', async () => {
  const res = fakeRes()
  const cancel = turn.createTurnCancel(res, () => () => {})
  res.emit('close')
  let wrote = false
  const out = await cancel.commit(async () => {
    wrote = true
  })
  assert.equal(out.committed, false)
  assert.equal(wrote, false)
})

test('createTurnCancel: a cancel during commit() lets the writes finish; the lock is released once, at the cancel', async () => {
  const res = fakeRes()
  let released = 0
  const cancel = turn.createTurnCancel(res, () => () => released++)
  let finishWrite
  const writing = cancel.commit(() => new Promise((r) => (finishWrite = r)).then(() => 'row'))
  res.emit('close')
  assert.equal(cancel.signal.aborted, true)
  assert.equal(released, 1, 'released at the cancel, not after the writes')
  finishWrite()
  const out = await writing
  assert.deepEqual(out, { committed: true, value: 'row' })
  assert.equal(released, 1, 'and only once')
})

test('createTurnCancel: the next turn on the session waits for a cancelled turn\'s pending commit before writing', async () => {
  const res = fakeRes()
  const key = `drain-${Date.now()}`
  const cancel = turn.createTurnCancel(res, () => () => {}, () => key)
  let finishWrite
  const order = []
  const writing = cancel.commit(() => new Promise((r) => (finishWrite = r)).then(() => order.push('old answer')))
  res.emit('close')
  const next = turn.awaitSessionDrain(key).then(() => order.push('next turn'))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(order, [], 'the next turn is still waiting')
  finishWrite()
  await Promise.all([writing, next])
  assert.deepEqual(order, ['old answer', 'next turn'])
  // nothing pending afterwards: an immediate drain
  let settled = false
  await turn.awaitSessionDrain(key).then(() => (settled = true))
  assert.equal(settled, true)
})

test('awaitSessionDrain: a session with no cancelled commit resolves at once', async () => {
  assert.equal(await turn.awaitSessionDrain(`none-${Date.now()}`), undefined)
})

test('createTurnCancel: a cancel releases the lock immediately while commit() is still pending', async () => {
  const res = fakeRes()
  let released = 0
  const cancel = turn.createTurnCancel(res, () => () => released++)
  let finishWrite
  const writing = cancel.commit(() => new Promise((r) => (finishWrite = r)))
  try {
    res.emit('close')
    assert.equal(released, 1, 'Stop-then-send must not wait for the current commit')
  } finally {
    finishWrite()
    await writing
  }
})

test('createTurnCancel: each turn gets its own signal (no leak into the next turn)', () => {
  const a = turn.createTurnCancel(fakeRes(), () => null)
  const resB = fakeRes()
  const b = turn.createTurnCancel(resB, () => null)
  resB.emit('close')
  assert.equal(b.signal.aborted, true)
  assert.equal(a.signal.aborted, false)
  assert.notEqual(a.signal, b.signal)
})

// ---------------------------------------------------------------- review follow-ups

test('classifyIntent: the turn signal cancels the classifier request (null, no wait for the 4 s timeout)', async () => {
  const marker = `intent-abort-${Date.now()}`
  const hold = gw.hold((r) => r.body && !r.body.stream && lastUser(r.body).includes(marker))
  try {
    const ac = new AbortController()
    const run = llm.classifyIntent('t', `apresentação ${marker}`, { signal: ac.signal })
    await hold.entered
    ac.abort()
    assert.equal(await within(run, ABORT_BUDGET_MS, 'classifyIntent'), null)
    await within(hold.aborted, ABORT_BUDGET_MS, 'gateway observes the abort')
  } finally {
    hold.release()
  }
})

test('embed: the signal cancels the embeddings request', async () => {
  const marker = `embed-abort-${Date.now()}`
  const hold = gw.hold((r) => r.path === '/serving-endpoints/embeddings' && JSON.stringify(r.body?.input || '').includes(marker))
  try {
    const ac = new AbortController()
    const run = llm.embed('t', [marker], { signal: ac.signal })
    await hold.entered
    ac.abort()
    await assert.rejects(within(run, ABORT_BUDGET_MS, 'embed'), (e) => e.name === 'AbortError')
  } finally {
    hold.release()
  }
})

test('generateTitle: the turn signal cancels the post-answer title request', async () => {
  const marker = `title-abort-${Date.now()}`
  const hold = gw.hold((r) =>
    r.body &&
    !r.body.stream &&
    r.body.messages?.[0]?.content?.includes('You title chat conversations') &&
    lastUser(r.body).includes(marker)
  )
  try {
    const ac = new AbortController()
    const run = llm.generateTitle('t', marker, 'answer', { signal: ac.signal })
    await hold.entered
    ac.abort()
    await within(hold.aborted, ABORT_BUDGET_MS, 'the title request reaches the turn signal')
    await within(run, ABORT_BUDGET_MS, 'generateTitle unwinds after cancellation')
  } finally {
    hold.release()
  }
})

test('createTurnCancel: a close after the route ended the response is not a cancel', () => {
  const res = fakeRes()
  let released = 0
  const cancel = turn.createTurnCancel(res, () => () => released++)
  res.writableEnded = true // res.end() called, 'finish' not yet emitted
  res.emit('close')
  assert.equal(cancel.gone, false)
  assert.equal(released, 0)
})

test('createTurnCancel: guard(fn) runs a write only while the turn is live and rejects with AbortError after a cancel', async () => {
  const res = fakeRes()
  const cancel = turn.createTurnCancel(res, () => null)
  assert.equal(await cancel.guard(async () => 'row'), 'row')
  res.emit('close')
  let wrote = false
  await assert.rejects(
    cancel.guard(async () => {
      wrote = true
    }),
    (e) => e.name === 'AbortError'
  )
  assert.equal(wrote, false)
})
