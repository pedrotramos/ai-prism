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
  extractSql,
  stripSqlFence,
  stepKind,
  groupSegments,
  stepsSummary,
  toolKindCounts,
} from './logic.ts'

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

test('notice: only the last paragraph counts, even after an earlier ⚠️ paragraph', () => {
  const r = splitTrailingNotice('⚠️ Careful.\n\nThe answer.\n\nℹ️ Stopped on the round limit.\n')
  assert.deepEqual(r, { body: '⚠️ Careful.\n\nThe answer.', notice: { kind: 'stopped', text: 'Stopped on the round limit.' } })
})

test('notice: the bare symbol without the emoji selector counts too', () => {
  assert.deepEqual(splitTrailingNotice('Body.\n\n\u26a0 Gateway timeout').notice, { kind: 'error', text: 'Gateway timeout' })
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
  assert.equal(v.reason!.length, 120)
  assert.ok(v.reason!.endsWith('…'))
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

test('toolbar: a trailing error notice makes it an error row even with prose before it', () => {
  const notice = { kind: 'error' as const, text: 'The answer stopped after an upstream failure.' }
  assert.equal(showActionToolbar({ streaming: false, notice, plainText: 'Partial response.', segments: [md] }), false)
})

test('toolbar: a stopped-early notice keeps it (the answer above is usable)', () => {
  const notice = { kind: 'stopped' as const, text: 'Stopped on the round limit.' }
  assert.equal(showActionToolbar({ streaming: false, notice, plainText: 'Partial data.', segments: [md] }), true)
})

// --- W1-2: the reasoning card's rules

const GENIE_RESULT = 'Revenue fell.\n\nSQL executado pelo Genie:\n```sql\nSELECT 1\n```\n\nResultado:\n| a |\n|---|\n| 1 |'

test('extractSql: reads the first sql fence of a Genie result, null when there is none', () => {
  assert.equal(extractSql(GENIE_RESULT), 'SELECT 1')
  assert.equal(extractSql('no code here'), null)
  assert.equal(extractSql('```python\nprint(1)\n```'), null)
  assert.equal(extractSql(undefined), null)
  assert.equal(extractSql('```SQL\nselect 2\n```'), 'select 2')
})

test('stripSqlFence: drops the fence and its lead-in line but keeps the rest', () => {
  const out = stripSqlFence(GENIE_RESULT)
  assert.ok(!out.includes('SELECT 1'))
  assert.ok(!out.includes('SQL executado'))
  assert.ok(out.includes('Revenue fell.'))
  assert.ok(out.includes('| a |'))
  assert.equal(stripSqlFence('plain'), 'plain')
})

test('stepKind: names the family of a tool call from its name', () => {
  assert.equal(stepKind('execute_python'), 'python')
  assert.equal(stepKind('ask_genie_one'), 'genieOne')
  assert.equal(stepKind('genie__abc'), 'genie')
  assert.equal(stepKind('vs__index'), 'vector')
  assert.equal(stepKind('mcp_x__y'), 'mcp')
  assert.equal(stepKind('mcpext__x'), 'mcp')
  assert.equal(stepKind('web_search'), 'web')
  assert.equal(stepKind('generate_image'), 'image')
  assert.equal(stepKind('uc_query'), 'uc')
  assert.equal(stepKind(undefined), 'uc')
})

test('groupSegments: consecutive tool calls fold into one steps group at their position', () => {
  const tc = (id: string) => ({ kind: 'toolcall', tc: { id, status: 'ok' } })
  const items = groupSegments([{ kind: 'md' }, tc('a'), tc('b'), { kind: 'md' }, tc('c')], { leading: [], hasReasoning: false })
  assert.deepEqual(
    items.map((i) => (i.type === 'steps' ? `steps:${i.calls.map((c) => c.id).join('')}${i.tail ? ':tail' : ''}` : i.seg.kind)),
    ['md', 'steps:ab', 'md', 'steps:c:tail']
  )
})

test('groupSegments: reasoning or legacy calls open a lead group before the first prose', () => {
  const items = groupSegments([{ kind: 'md' }], { leading: [{ id: 'old' }], hasReasoning: false })
  assert.equal(items[0]!.type, 'steps')
  assert.equal((items[0] as { lead?: boolean }).lead, true)
  assert.deepEqual((items[0] as { calls: { id: string }[] }).calls.map((c) => c.id), ['old'])
  // reasoning with no tool calls at all: an empty lead group still carries the card
  const only = groupSegments([{ kind: 'md' }], { leading: [], hasReasoning: true })
  assert.equal(only[0]!.type, 'steps')
  assert.equal((only[0] as { calls: unknown[] }).calls.length, 0)
  // nothing to show: no group
  assert.equal(groupSegments([{ kind: 'md' }], { leading: [], hasReasoning: false })[0]!.type, 'seg')
})

test('groupSegments: legacy calls join a leading group instead of making a second one', () => {
  const items = groupSegments([{ kind: 'toolcall', tc: { id: 'n' } }, { kind: 'md' }], { leading: [{ id: 'old' }], hasReasoning: true })
  const steps = items.filter((i) => i.type === 'steps')
  assert.equal(steps.length, 1)
  assert.deepEqual((steps[0] as { calls: { id: string }[] }).calls.map((c) => c.id), ['old', 'n'])
  assert.equal((steps[0] as { lead?: boolean }).lead, true)
})

test('stepsSummary: counts steps, adds up the durations and flags a running one', () => {
  assert.deepEqual(stepsSummary([{ durationMs: 1400 }, { durationMs: 4100 }, { status: 'running', elapsedMs: 2000 }]), {
    count: 3,
    totalMs: 5500,
    running: true,
    failed: 0,
  })
  assert.deepEqual(stepsSummary([{ status: 'error', durationMs: 10 }, {}]), { count: 2, totalMs: 10, running: false, failed: 1 })
  assert.deepEqual(stepsSummary([]), { count: 0, totalMs: 0, running: false, failed: 0 })
})

test('toolKindCounts: one entry per family, in first-seen order, with counts', () => {
  const calls = [{ name: 'genie__a' }, { name: 'execute_python' }, { name: 'genie__b' }, { name: 'vs__i' }]
  assert.deepEqual(toolKindCounts(calls), [
    { kind: 'genie', count: 2 },
    { kind: 'python', count: 1 },
    { kind: 'vector', count: 1 },
  ])
  assert.deepEqual(toolKindCounts([]), [])
})
