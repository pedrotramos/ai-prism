// Pure rules behind the chat message UI (Message.jsx and message/*.jsx).
// Expected values are written by hand from the acceptance criteria of W1-8.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  coerceAttachments,
  splitTrailingNotice,
  toolCallView,
  showThinkingRow,
  showActionToolbar,
} from './logic.js'

// --- attachments (ux#3: an object in the list must never reach JSX as a child)

test('attachments: a JSON list of names is returned as is', () => {
  assert.deepEqual(coerceAttachments('["a.pdf","b.xlsx"]'), ['a.pdf', 'b.xlsx'])
})

test('attachments: objects become their name, and nulls are dropped', () => {
  const raw = JSON.stringify([{ name: 'q3.xlsx', size: 12 }, null, 'notes.txt', { filename: 'x.csv' }, { size: 3 }, 42])
  assert.deepEqual(coerceAttachments(raw), ['q3.xlsx', 'notes.txt', 'x.csv', '42'])
})

test('attachments: an already-parsed array is accepted too', () => {
  assert.deepEqual(coerceAttachments([{ title: 'Deck' }, 'a']), ['Deck', 'a'])
})

test('attachments: malformed JSON, a non-list or nothing gives an empty list', () => {
  assert.deepEqual(coerceAttachments('{not json'), [])
  assert.deepEqual(coerceAttachments('{"name":"a"}'), [])
  assert.deepEqual(coerceAttachments(null), [])
  assert.deepEqual(coerceAttachments(''), [])
})

// --- trailing notices written by the server (truncation, stopped early, error)

test('notice: a trailing ⚠️ paragraph is split off as an error notice', () => {
  const r = splitTrailingNotice('The answer.\n\n⚠️ The reply hit the output limit.')
  assert.deepEqual(r, { body: 'The answer.', notice: { kind: 'error', text: 'The reply hit the output limit.' } })
})

test('notice: a trailing ℹ️ paragraph is a stopped-early notice', () => {
  const r = splitTrailingNotice('Partial data.\n\nℹ️ I reached the time limit for queries in this turn.')
  assert.deepEqual(r, { body: 'Partial data.', notice: { kind: 'stopped', text: 'I reached the time limit for queries in this turn.' } })
})

test('notice: a notice that is the whole message leaves an empty body', () => {
  assert.deepEqual(splitTrailingNotice('⚠️ AI Gateway returned 503'), {
    body: '',
    notice: { kind: 'error', text: 'AI Gateway returned 503' },
  })
})

test('notice: an emoji in the middle of the answer is not a notice', () => {
  const text = '⚠️ Careful with this step.\n\nThen run the job.'
  assert.deepEqual(splitTrailingNotice(text), { body: text, notice: null })
})

test('notice: no text, no notice', () => {
  assert.deepEqual(splitTrailingNotice(''), { body: '', notice: null })
  assert.deepEqual(splitTrailingNotice(undefined), { body: '', notice: null })
})

// --- tool-call chip state (running → done with duration, failed with reason)

test('tool chip: running shows the live elapsed seconds', () => {
  assert.deepEqual(toolCallView({ status: 'running', elapsedMs: 4200 }), { state: 'running', seconds: '4s', reason: null })
  assert.deepEqual(toolCallView({ status: 'running' }), { state: 'running', seconds: null, reason: null })
})

test('tool chip: done shows the duration with one decimal', () => {
  assert.deepEqual(toolCallView({ status: 'ok', durationMs: 612 }), { state: 'done', seconds: '0.6s', reason: null })
  assert.deepEqual(toolCallView({ status: 'ok' }), { state: 'done', seconds: null, reason: null })
})

test('tool chip: failed carries the first line of the result as the reason', () => {
  const v = toolCallView({ status: 'error', durationMs: 1500, result: 'PERMISSION_DENIED: no USE CATALOG on main\nstack…' })
  assert.deepEqual(v, { state: 'failed', seconds: '1.5s', reason: 'PERMISSION_DENIED: no USE CATALOG on main' })
})

test('tool chip: a long failure reason is cut at 120 characters with an ellipsis', () => {
  const v = toolCallView({ status: 'error', result: 'x'.repeat(200) })
  assert.equal(v.reason.length, 120)
  assert.ok(v.reason.endsWith('…'))
})

// --- "Thinking…" row (ux#33: never two progress signals at once)

const md = { kind: 'md', text: 'hi' }
const runningTool = { kind: 'toolcall', tc: { status: 'running' } }
const doneTool = { kind: 'toolcall', tc: { status: 'ok' } }

test('thinking row: shown while streaming with nothing rendered yet', () => {
  assert.equal(showThinkingRow({ streaming: true, segments: [] }), true)
})

test('thinking row: hidden while a tool chip is running', () => {
  assert.equal(showThinkingRow({ streaming: true, segments: [md, runningTool] }), false)
})

test('thinking row: hidden while a block is loading (its chip is the signal)', () => {
  assert.equal(showThinkingRow({ streaming: true, segments: [md, { kind: 'loading' }] }), false)
})

test('thinking row: shown after a finished tool while the model decides', () => {
  assert.equal(showThinkingRow({ streaming: true, segments: [md, doneTool] }), true)
})

test('thinking row: hidden while prose is streaming (the cursor is the signal) and when not streaming', () => {
  assert.equal(showThinkingRow({ streaming: true, segments: [md] }), false)
  assert.equal(showThinkingRow({ streaming: false, segments: [] }), false)
})

// --- action toolbar (ux#4: no Copy/Listen/PDF on an empty or failed row)

test('toolbar: shown on a finished answer with text', () => {
  assert.equal(showActionToolbar({ streaming: false, error: null, plainText: 'Hello', segments: [md] }), true)
})

test('toolbar: shown on a finished answer that is only a block', () => {
  assert.equal(showActionToolbar({ streaming: false, plainText: '', segments: [{ kind: 'block' }] }), true)
})

test('toolbar: hidden while streaming, on an empty row and on an errored row', () => {
  assert.equal(showActionToolbar({ streaming: true, plainText: 'Hello', segments: [md] }), false)
  assert.equal(showActionToolbar({ streaming: false, plainText: '', segments: [] }), false)
  assert.equal(showActionToolbar({ streaming: false, error: 'HTTP 500', plainText: '', segments: [] }), false)
})
