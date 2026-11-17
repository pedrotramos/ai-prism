import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCompaction,
  coverableMessages,
  withCompactionMarkers,
  prepareCompactedReplay,
  manualCompaction,
  compactionContext,
  compactConversation,
  summarizeConversation,
  CompactionError,
  estimateTokens,
} from './compaction.js'

// history rows as listMessages() returns them: string ids, ordered oldest first
const msg = (id, role, content = `texto ${id}`) => ({ id: String(id), role, content, tool_calls: null, blocks: null })
const thread = (n) =>
  Array.from({ length: n }, (_, i) => msg(i + 1, i % 2 === 0 ? 'user' : 'assistant'))

const fakeReq = { email: 'a@x.com', token: 't' }

test('applyCompaction uses the newest compaction whose anchor is in history', () => {
  const history = thread(10)
  const older = { id: '1', uptoMessageId: '4', content: 'antigo' }
  const newer = { id: '2', uptoMessageId: '7', content: 'novo' }
  const { summary, replay } = applyCompaction(history, [older, newer])
  assert.equal(summary.id, '2')
  assert.deepEqual(replay.map((m) => m.id), ['8', '9', '10'])
})

test('applyCompaction ignores a compaction whose anchor is not in history (e.g. a regenerate cut)', () => {
  const history = thread(5)
  const k = { id: '1', uptoMessageId: '99', content: 'x' }
  const { summary, replay } = applyCompaction(history, [k])
  assert.equal(summary, null)
  assert.equal(replay.length, 5)
})

test('coverableMessages never folds a trailing unanswered user turn', () => {
  const replay = thread(5) // ends on user (id 5)
  const covered = coverableMessages(replay)
  assert.deepEqual(covered.map((m) => m.id), ['1', '2', '3', '4'])
})

test('coverableMessages keeps the recent tail verbatim and starts it on a user turn', () => {
  const replay = thread(12) // ends on assistant (id 12)
  const covered = coverableMessages(replay, { keepRecent: 4 })
  // cut = 12 - 4 = 8 (index), replay[8] is id 9 (user) → covers ids 1..8
  assert.equal(covered.at(-1).id, '8')
})

test('withCompactionMarkers places each divider right after its anchor message', () => {
  const history = thread(4)
  const out = withCompactionMarkers(history, [{ id: '7', uptoMessageId: '2', content: 'R', auto: true, messages: 2 }])
  assert.deepEqual(out.map((m) => m.id), ['1', '2', 'compaction-7', '3', '4'])
  const divider = out[2]
  assert.equal(divider.role, 'compaction')
  assert.equal(divider.compaction.auto, true)
  assert.equal(divider.compaction.uptoMessageId, '2')
})

test('withCompactionMarkers returns the messages untouched when there are no compactions', () => {
  const history = thread(3)
  assert.equal(withCompactionMarkers(history, []), history)
})

test('compactionContext carries the summary as a system-facing memory note', () => {
  const text = compactionContext({ content: 'Fatos: receita 1.234' })
  assert.match(text, /Resumo da parte anterior/)
  assert.match(text, /Fatos: receita 1\.234$/)
})

test('prepareCompactedReplay leaves a short thread alone (no model call)', async () => {
  let called = false
  const history = thread(6)
  const out = await prepareCompactedReplay(fakeReq, {
    sessionId: '1',
    model: 'm',
    history,
    maxMessages: 40,
    compactions: [],
    compact: async () => {
      called = true
    },
  })
  assert.equal(called, false)
  assert.equal(out.summary, null)
  assert.equal(out.replay.length, 6)
})

test('prepareCompactedReplay folds an over-long replay into a summary and keeps the tail', async () => {
  const history = thread(50)
  const events = []
  const out = await prepareCompactedReplay(fakeReq, {
    send: (e) => events.push(e),
    sessionId: '1',
    model: 'm',
    history,
    maxMessages: 40,
    compactions: [],
    compact: async (req, args) => {
      assert.equal(args.auto, true)
      return { id: '9', uptoMessageId: args.covered.at(-1).id, content: 'R', auto: true, messages: args.covered.length }
    },
  })
  // the replay is what follows the anchor, and the anchor is the last covered message
  assert.equal(out.summary.uptoMessageId, '46')
  assert.ok(out.replay.length <= 40)
  assert.equal(out.replay.at(-1).id, '50')
  assert.deepEqual(
    events.map((e) => e.status),
    ['running', 'done']
  )
})

test('prepareCompactedReplay falls back to the plain window when the summary fails', async () => {
  const history = thread(50)
  const events = []
  const out = await prepareCompactedReplay(fakeReq, {
    send: (e) => events.push(e),
    sessionId: '1',
    model: 'm',
    history,
    maxMessages: 40,
    compactions: [],
    compact: async () => {
      throw new Error('gateway down')
    },
  })
  assert.equal(out.summary, null)
  assert.equal(out.replay.length, 50)
  assert.equal(events.at(-1).status, 'failed')
})

test('manualCompaction folds the thread so far and refuses when nothing new is there', async () => {
  const history = thread(5) // ends on user: id 5 is unanswered and stays out
  let saved = null
  await manualCompaction(fakeReq, {
    sessionId: '1',
    model: 'm',
    history,
    instructions: 'foco em preços',
    list: async () => [],
    compact: async (req, args) => {
      saved = args
      return { id: '1' }
    },
  })
  assert.equal(saved.covered.at(-1).id, '4')
  assert.equal(saved.auto, false)
  assert.equal(saved.instructions, 'foco em preços')
})

test('manualCompaction throws nothing_to_compact on a lone user message', async () => {
  const history = [msg(1, 'user')]
  await assert.rejects(
    () => manualCompaction(fakeReq, { sessionId: '1', model: 'm', history, compact: async () => ({}), list: async () => [] }),
    (e) => e instanceof CompactionError && e.code === 'nothing_to_compact'
  )
})

test('summarizeConversation retries once when the model answers too briefly, then fails', async () => {
  const long = thread(40)
  let calls = 0
  await assert.rejects(
    () =>
      summarizeConversation({
        token: 't',
        model: 'm',
        messages: long,
        complete: async () => {
          calls++
          return { text: 'ok' }
        },
      }),
    /não devolveu o resumo/
  )
  assert.equal(calls, 2)
})

test('compactConversation anchors the saved row at the last covered message and folds the previous count', async () => {
  const covered = thread(4)
  let saved = null
  const row = await compactConversation(fakeReq, {
    sessionId: '1',
    model: 'm',
    previous: { content: 'antes', messages: 10 },
    covered,
    auto: false,
    summarize: async () => ({ summary: 'S'.repeat(300), usage: { prompt_tokens: 5, completion_tokens: 7 } }),
    save: async (email, token, sessionId, r) => {
      saved = r
      return { ...r, id: '42' }
    },
  })
  assert.equal(saved.uptoMessageId, '4')
  assert.equal(saved.messages, 14)
  assert.equal(saved.promptTokens, 5)
  assert.equal(row.id, '42')
})

test('estimateTokens grows with content and is zero for an empty thread', () => {
  assert.equal(estimateTokens([]), 0)
  assert.ok(estimateTokens([msg(1, 'user', 'a'.repeat(3500))]) > estimateTokens([msg(1, 'user', 'a')]))
})
