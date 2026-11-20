import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildToolRecap, appendToolRecap, TOOL_RECAP_TURN_MAX_CHARS } from './toolRecap.ts'

const call = (over = {}) => ({
  id: 'c1',
  name: 'ask_genie_one',
  label: 'Consulta de vendas',
  args: { question: 'receita do mês' },
  result: 'Receita: 1.234.567',
  status: 'ok',
  ...over,
})

test('an empty or missing tool list produces no record', () => {
  assert.equal(buildToolRecap(undefined), '')
  assert.equal(buildToolRecap([]), '')
  assert.equal(appendToolRecap('oi', 'assistant', [], 'm1'), 'oi')
})

test('the record lists each tool with its status, args and result, inside the system-generated frame', () => {
  const recap = buildToolRecap([call()], 'm-basic')
  assert.match(recap, /^--- System-generated record/)
  assert.match(recap, /- ask_genie_one \(Consulta de vendas\) \[ok\]/)
  assert.match(recap, /result: Receita: 1\.234\.567/)
  assert.match(recap, /--- End system-generated tool execution record ---$/)
})

test('a failed call is recorded as an error and a call without result says so', () => {
  const recap = buildToolRecap([call({ status: 'error', result: undefined })], 'm-err')
  assert.match(recap, /\[error\]/)
  assert.match(recap, /\(no recorded result\)/)
})

test('secrets in arguments and results are redacted before they are replayed', () => {
  const recap = buildToolRecap(
    [
      call({
        args: { api_key: 'sk-abcdefghijklmnop1234', note: 'ok' },
        result: 'Authorization: Bearer abcdef123456.token.value and password="hunter2"',
      }),
    ],
    'm-secret'
  )
  assert.doesNotMatch(recap, /sk-abcdefghijklmnop1234/)
  assert.doesNotMatch(recap, /hunter2/)
  assert.doesNotMatch(recap, /abcdef123456\.token\.value/)
})

test('a long turn is bounded by the turn limit and notes what was omitted', () => {
  const many = Array.from({ length: 60 }, (_, i) => call({ id: `c${i}`, name: `tool_${i}`, result: 'x'.repeat(1400) }))
  const recap = buildToolRecap(many, 'm-long')
  assert.ok(recap.length <= TOOL_RECAP_TURN_MAX_CHARS + 200)
  assert.match(recap, /additional tool record/)
})

test('the same message id and the same calls hit the cache and return the same text', () => {
  const calls = [call()]
  assert.equal(buildToolRecap(calls, 'cache-1'), buildToolRecap(calls, 'cache-1'))
})

test('appendToolRecap keeps the assistant text and adds the record after it', () => {
  const out = appendToolRecap('Resposta final', 'assistant', [call()], 'm-append')
  assert.match(out, /^Resposta final\n\n--- System-generated/)
  assert.equal(appendToolRecap('Pergunta', 'user', [call()], 'm-user'), 'Pergunta')
})
