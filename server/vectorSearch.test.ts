// Vector Search column cache (audit F4): the index ref (incl. sourceTable) comes
// from the client's enabledTools, so the cache must be per user, and the table
// identifier must be quoted safely. No warehouse: `exec` is injected.
//
//   node --test server/vectorSearch.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeVectorIndexColumns, quoteTableName } from './vectorSearch.ts'

function fakeExec(columnsByTable: Record<string, string[]>) {
  const statements: string[] = []
  const exec = async (_token: string, statement: string) => {
    statements.push(statement)
    const table = Object.keys(columnsByTable).find((t) => statement.includes(t.split('.').pop() as string))
    return { rows: ((table && columnsByTable[table]) || []).map((c) => [c, 'string', null]) }
  }
  return { exec, statements }
}

test('quoteTableName: cada parte entre crases, crase interna duplicada', () => {
  assert.equal(quoteTableName('main.docs.chunks'), '`main`.`docs`.`chunks`')
  assert.equal(quoteTableName('main.docs.x` UNION SELECT 1 --'), '`main`.`docs`.`x`` UNION SELECT 1 --`')
})

test('DESCRIBE usa o identificador escapado', async () => {
  const { exec, statements } = fakeExec({})
  const ref = { indexName: `idx-esc-${Date.now()}`, sourceTable: 'main.docs.ev`il', embeddingColumns: [] }
  await describeVectorIndexColumns('tok', ref, { userEmail: 'a@example.com', exec })
  assert.equal(statements[0], 'DESCRIBE TABLE `main`.`docs`.`ev``il`')
})

test('cache por usuário: o ref de A não envenena as colunas de B para o mesmo índice', async () => {
  const indexName = `main.docs.idx_${Date.now()}`
  const { exec, statements } = fakeExec({
    'main.a.table_of_a': ['a_only', 'emb'],
    'main.b.table_of_b': ['id', 'text', 'emb'],
  })
  // A aims B's index at a table of their own
  const colsA = await describeVectorIndexColumns(
    'tok-a',
    { indexName, sourceTable: 'main.a.table_of_a', embeddingColumns: ['emb'] },
    { userEmail: 'a@example.com', exec }
  )
  assert.deepEqual(colsA, ['a_only'])
  const colsB = await describeVectorIndexColumns(
    'tok-b',
    { indexName, sourceTable: 'main.b.table_of_b', embeddingColumns: ['emb'] },
    { userEmail: 'b@example.com', exec }
  )
  assert.deepEqual(colsB, ['id', 'text'])
  assert.equal(statements.length, 2)
})

test('cache: o mesmo usuário (qualquer caixa) reaproveita as colunas do mesmo índice', async () => {
  const indexName = `main.docs.idx_same_${Date.now()}`
  const { exec, statements } = fakeExec({ 'main.docs.t': ['id', 'emb'] })
  const ref = { indexName, sourceTable: 'main.docs.t', embeddingColumns: ['emb'] }
  await describeVectorIndexColumns('tok', ref, { userEmail: 'Ana@Example.com', exec })
  const again = await describeVectorIndexColumns('tok', ref, { userEmail: 'ana@example.com', exec })
  assert.deepEqual(again, ['id'])
  assert.equal(statements.length, 1)
})

test('a malformed DESCRIBE row (non-string name) still throws TypeError, as before the conversion', async () => {
  const exec = async () => ({ rows: [[7, 'int']] })
  await assert.rejects(
    () => describeVectorIndexColumns('tok', { indexName: `idx-malformed-${Date.now()}`, sourceTable: 'main.docs.t' }, { exec }),
    TypeError
  )
})
