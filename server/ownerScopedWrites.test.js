import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activateOwnedVariantGroup,
  historyWriteSql,
  insertOwnedToolCalls,
  ownedSessionSql,
  ownSessionSql,
  setOwnedGenieConversation,
  sessionAccessSql,
  setOwnedSkillEmbedding,
  upsertOwnedMessageEmbedding,
} from './ownerScopedWrites.js'

// records every statement; rowCount is what the database would report
function fakeClient(rowCount = 1) {
  const calls = []
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params })
      return { rowCount, rows: [] }
    },
  }
}

test('every owner-scoped write binds the caller e-mail as a parameter', async () => {
  const c = fakeClient()
  await activateOwnedVariantGroup(c, 'ana@example.com', 10, 7)
  await upsertOwnedMessageEmbedding(c, 'ana@example.com', 3, 10, '[0.1,0.2]')
  await setOwnedSkillEmbedding(c, 'ana@example.com', 5, [0.1])
  await setOwnedGenieConversation(c, 'ana@example.com', 3, 'space', 'conv')
  assert.equal(c.calls.length, 4)
  for (const { sql, params } of c.calls) {
    assert.match(sql, /user_email|owner_email/, sql)
    assert.ok(params.includes('ana@example.com'), `missing caller param in: ${sql}`)
  }
})

test('the e-mail is never interpolated into the SQL text', async () => {
  const c = fakeClient()
  await activateOwnedVariantGroup(c, "x' OR '1'='1", 10, 7)
  assert.doesNotMatch(c.calls[0].sql, /OR '1'/)
  assert.ok(c.calls[0].params.includes("x' OR '1'='1"))
})

test('a variant activation is scoped to the variant group AND the owner', async () => {
  const c = fakeClient()
  await activateOwnedVariantGroup(c, 'ana@example.com', 10, 7)
  const { sql, params } = c.calls[0]
  assert.match(sql, /m\.variant_group = \$2/)
  assert.match(sql, /os\.user_email = \$3/)
  assert.deepEqual(params, [10, 7, 'ana@example.com'])
})

test('tool calls go through an owned message, one row per trace entry, capped results', async () => {
  const c = fakeClient(1)
  const n = await insertOwnedToolCalls(c, 'ana@example.com', 42, [
    { id: 'c1', name: 'a', args: { q: 1 }, status: 'ok' },
    { name: 'b', status: 'error', result: 'x'.repeat(9000), durationMs: 4 },
  ])
  assert.equal(n, 2)
  assert.equal(c.calls.length, 2)
  for (const { sql } of c.calls) {
    assert.match(sql, /INSERT INTO chat_tool_calls/)
    assert.match(sql, /FROM chat_messages m/)
    assert.match(sql, /os\.user_email = \$10/)
  }
  assert.equal(c.calls[1].params[1], 1, 'seq increments')
  assert.equal(c.calls[1].params[6].length, 8000, 'result capped')
})

test('a foreign message writes nothing and the count says so', async () => {
  const n = await insertOwnedToolCalls(fakeClient(0), 'bia@example.com', 42, [{ name: 'a', status: 'ok' }])
  assert.equal(n, 0)
})

test('skill embeddings: only global rows or the caller own rows', async () => {
  const c = fakeClient()
  await setOwnedSkillEmbedding(c, 'ana@example.com', 5, [0.1])
  assert.match(c.calls[0].sql, /scope = 'global' OR \(scope = 'user' AND owner_email = \$3\)/)
})

test('ownedSessionSql: a personal chat of the caller, or a project chat she is a member of (W2-3)', () => {
  assert.equal(
    ownedSessionSql('m.session_id', '$2'),
    'EXISTS (SELECT 1 FROM chat_sessions os WHERE os.id = m.session_id AND ' +
      '((os.project_id IS NULL AND os.user_email = $2) OR ' +
      '(os.project_id IS NOT NULL AND os.project_id = ANY ((SELECT ai_prism.aip_my_project_ids())::bigint[]))))'
  )
})

test('N4: membership is the per-statement set; role levels keep the rank (ADR-0016)', () => {
  assert.equal(
    sessionAccessSql('s', '$2'),
    '((s.project_id IS NULL AND s.user_email = $2) OR ' +
      '(s.project_id IS NOT NULL AND s.project_id = ANY ((SELECT ai_prism.aip_my_project_ids())::bigint[])))'
  )
  assert.equal(
    ownSessionSql('s', '$2'),
    '(s.user_email = $2 AND (s.project_id IS NULL OR s.project_id = ANY ((SELECT ai_prism.aip_my_project_ids())::bigint[])))'
  )
  assert.equal(
    historyWriteSql('s', '$2'),
    '((s.project_id IS NULL AND s.user_email = $2) OR (s.project_id IS NOT NULL AND ai_prism.aip_project_rank(s.project_id) >= 2))'
  )
})
