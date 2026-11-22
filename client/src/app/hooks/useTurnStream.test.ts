import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from './useSessions.ts'
import { makeSSEHandler, detectTurnFailure, reconcileFailedTurn, retryPlan, stripNotices } from './useTurnStream.ts'

// requestAnimationFrame does not exist in Node: queue the callbacks and run
// them on demand, like one browser frame.
let frames: FrameRequestCallback[] = []
beforeEach(() => {
  frames = []
  globalThis.requestAnimationFrame = (cb) => frames.push(cb) // the id is never read
  globalThis.cancelAnimationFrame = () => {
    frames = []
  }
})
const flushFrame = () => {
  const f = frames
  frames = []
  f.forEach((cb) => cb(0))
}

// a target message the handler patches, plus spies for everything it calls
function harness() {
  let msg: ChatMessage = { role: 'assistant', content: '' }
  const calls: { errors: string[]; deckIds: unknown[]; streamingDeck: unknown[] } = { errors: [], deckIds: [], streamingDeck: [] }
  let deckId: string | number | null = null
  const h = makeSSEHandler({
    setTarget: (p) => {
      msg = typeof p === 'function' ? p(msg) : { ...msg, ...p }
    },
    accRef: { value: '' },
    onError: (e) => calls.errors.push(e),
    setDeckStudioId: (v) => {
      deckId = typeof v === 'function' ? v(deckId) : v
      calls.deckIds.push(deckId)
    },
    setStreamingDeck: (v) => calls.streamingDeck.push(typeof v === 'function' ? v(null) : v),
    deckFailMsg: 'deck failed',
  })
  return { h, calls, get msg() { return msg }, get deckId() { return deckId } }
}

test('tokens coalesce into one paint per frame and finalize paints the tail', () => {
  const x = harness()
  x.h({ type: 'token', value: 'Hel' })
  x.h({ type: 'token', value: 'lo' })
  assert.equal(frames.length, 1, 'one frame scheduled for two tokens')
  assert.equal(x.msg.content, '')
  flushFrame()
  assert.equal(x.msg.content, 'Hello')
  x.h({ type: 'token', value: '!' })
  x.h.finalize()
  assert.equal(x.msg.content, 'Hello!')
})

test('a tool call inserts its inline marker and a running chip, then the result updates it', () => {
  const x = harness()
  x.h({ type: 'token', value: 'Looking.' })
  x.h({ type: 'tool_call', id: 't1', name: 'genie', label: 'Genie', args: {} })
  x.h({ type: 'tool_result', id: 't1', status: 'ok', result: '3 rows', durationMs: 40 })
  assert.equal(x.msg.content, 'Looking.\n\n{{toolcall:t1}}\n\n')
  assert.deepEqual(x.msg.toolCalls, [{ id: 't1', name: 'genie', label: 'Genie', args: {}, status: 'ok', result: '3 rows', durationMs: 40 }])
})

test('an error event is reported, appended inline and remembered for the failure check', () => {
  const x = harness()
  x.h({ type: 'error', error: 'AI Gateway returned 503' })
  assert.deepEqual(x.calls.errors, ['AI Gateway returned 503'])
  assert.equal(x.msg.content, '⚠️ AI Gateway returned 503')
  assert.deepEqual(x.h.streamErrors, ['AI Gateway returned 503'])
})

test('a deck announced but never delivered is torn down with a message on finalize', () => {
  const x = harness()
  x.h({ type: 'deck_stream_start', title: 'Q3' })
  assert.equal(x.deckId, 'streaming')
  x.h.finalize()
  assert.equal(x.deckId, null)
  assert.deepEqual(x.calls.errors, ['deck failed'])
})

test('a delivered deck replaces the streaming one and finalize leaves it open', () => {
  const x = harness()
  x.h({ type: 'deck_stream_start', title: 'Q3' })
  x.h({ type: 'blocks', content: '{{block:0}}', blocks: [{ type: 'deck-html', deckId: 9 }] })
  x.h.finalize()
  assert.equal(x.deckId, 9)
  assert.deepEqual(x.calls.errors, [])
})

test('detectTurnFailure: a thrown error is a failure, an abort is not', () => {
  const err = new Error('HTTP 500')
  assert.deepEqual(detectTurnFailure({ thrown: err, streamErrors: [], text: '' }), { error: 'HTTP 500' })
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
  assert.equal(detectTurnFailure({ thrown: abort, streamErrors: [], text: '' }), null)
})

test('detectTurnFailure: a stream error with no answer is a failure; with an answer it is a notice', () => {
  assert.deepEqual(detectTurnFailure({ thrown: null, streamErrors: ['boom'], text: '⚠️ boom' }), { error: 'boom' })
  assert.equal(detectTurnFailure({ thrown: null, streamErrors: ['truncated'], text: 'Half an answer\n\n⚠️ truncated' }), null)
  assert.equal(detectTurnFailure({ thrown: null, streamErrors: [], text: '' }), null)
})

const user = (id: string, content: string): ChatMessage => ({ id, role: 'user', content })
const asst = (id: string, content: string): ChatMessage => ({ id, role: 'assistant', content })

test('send failed before the server stored anything: the local prompt comes back with an error row', () => {
  const files = [{ name: 'a.csv' }] as File[] // a test double: only the name is read
  const out = reconcileFailedTurn([user('1', 'hi'), asst('2', 'hello')], { route: 'send', prompt: 'again', attachments: '["a.csv"]', files, error: 'HTTP 500', partial: '', model: 'm1' })
  assert.equal(out.length, 4)
  assert.deepEqual(out[2], { role: 'user', content: 'again', attachments: '["a.csv"]', local: true })
  assert.deepEqual(out[3], { role: 'assistant', content: '', model: 'm1', local: true, error: { message: 'HTTP 500', retry: { route: 'send', prompt: 'again', files } } })
})

test('send failed after the server stored the prompt: the error row follows the stored prompt', () => {
  const out = reconcileFailedTurn([user('1', 'again')], { route: 'send', prompt: 'again', error: 'boom', partial: '', model: 'm1' })
  assert.deepEqual(out.map((x) => [x.id, x.role]), [['1', 'user'], [undefined, 'assistant']])
  assert.equal(out[1]!.error!.message, 'boom')
})

test('send failed after the server stored an answer: that answer is marked as failed', () => {
  const out = reconcileFailedTurn([user('1', 'again'), asst('2', 'partial')], { route: 'send', prompt: 'again', error: 'boom', partial: 'partial', model: 'm1' })
  assert.equal(out.length, 2)
  assert.deepEqual(out[1], { ...asst('2', 'partial'), error: { message: 'boom', retry: { route: 'regenerate', messageId: '2' } } })
})

test('continue failed: the error row goes after the unanswered prompt', () => {
  const out = reconcileFailedTurn([user('1', 'q')], { route: 'continue', error: 'boom', partial: '', model: 'm1' })
  assert.equal(out.length, 2)
  assert.deepEqual(out[1]!.error, { message: 'boom', retry: { route: 'continue' } })
})

test('regenerate failed: the regenerated message is marked, the rest is untouched', () => {
  const list = [user('1', 'q'), asst('2', 'old answer')]
  const out = reconcileFailedTurn(list, { route: 'regenerate', messageId: '2', error: 'boom' })
  assert.deepEqual(out[0], list[0])
  assert.deepEqual(out[1], { ...list[1], error: { message: 'boom', retry: { route: 'regenerate', messageId: '2' } } })
  assert.deepEqual(reconcileFailedTurn(list, { route: 'regenerate', messageId: '404', error: 'boom' }), list)
})

test('retryPlan: a local failed send drops the pair and resends the prompt with its files', () => {
  const files = [{ name: 'a.csv' }] as File[] // a test double: only the name is read
  const list = reconcileFailedTurn([user('1', 'hi')], { route: 'send', prompt: 'again', files, error: 'x', model: 'm' })
  const plan = retryPlan(list, 2)
  assert.deepEqual(plan, { route: 'send', prompt: 'again', files, keep: 1 })
})

test('retryPlan: a stored prompt without answer continues; a stored answer regenerates', () => {
  const afterStoredPrompt = reconcileFailedTurn([user('1', 'q')], { route: 'send', prompt: 'q', error: 'x', model: 'm' })
  assert.deepEqual(retryPlan(afterStoredPrompt, 1), { route: 'continue', keep: 1 })
  const regen = reconcileFailedTurn([user('1', 'q'), asst('2', 'a')], { route: 'regenerate', messageId: '2', error: 'x' })
  assert.deepEqual(retryPlan(regen, 1), { route: 'regenerate', messageId: '2' })
})

test('retryPlan: a row without an error has nothing to retry', () => {
  assert.equal(retryPlan([user('1', 'q'), asst('2', 'a')], 1), null)
  assert.equal(retryPlan([], 0), null)
})

test('a repeated prompt that failed before it was stored does not mark the previous answer', () => {
  const before = [user('1', 'ok'), asst('2', 'good answer')]
  const out = reconcileFailedTurn(before, { route: 'send', prompt: 'ok', error: 'x', model: 'm', knownIds: ['1', '2'] })
  assert.deepEqual(out[1], before[1], 'the old answer is untouched')
  assert.deepEqual(out.slice(2).map((r) => [r.role, r.content, !!r.local]), [['user', 'ok', true], ['assistant', '', true]])
  assert.equal(out[3]!.error!.retry!.route, 'send')
})

test('a repeated prompt after an unanswered stored one gets its own local row', () => {
  const out = reconcileFailedTurn([user('1', 'ok')], { route: 'send', prompt: 'ok', error: 'x', model: 'm', knownIds: ['1'] })
  assert.deepEqual(out.map((r) => [r.id, r.role, r.content]), [['1', 'user', 'ok'], [undefined, 'user', 'ok'], [undefined, 'assistant', '']])
})

test('the text streamed before a failure is kept in the error row', () => {
  const out = reconcileFailedTurn([], { route: 'send', prompt: 'q', error: 'reset', partial: 'Half of it', model: 'm' })
  assert.equal(out[1]!.content, 'Half of it')
})

test('stripNotices removes the inline ⚠️ notices and keeps the answer', () => {
  assert.equal(stripNotices('Half an answer\n\n⚠️ truncated'), 'Half an answer')
  assert.equal(stripNotices('⚠️ boom'), '')
  assert.equal(stripNotices('plain'), 'plain')
})
