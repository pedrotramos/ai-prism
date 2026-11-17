// Tool-call chip labels built by the turn loop (server/turn.js toolCallLabel).
// A label error is not cosmetic: the label is built inside runAssistantTurn's
// tool loop, so a throw there ends the whole turn with an error event.
//
//   node --test server/turn.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.APPKIT_BOOT = '1'
process.env.LOCAL_DEV_MODE = '1'

const { toolCallLabel } = await import('./turn.js')

test('web-fetch label shows the URL', () => {
  assert.equal(toolCallLabel({ kind: 'web-fetch' }, { url: 'https://example.com/a' }, 'web_fetch'), 'Web Fetch · https://example.com/a')
})

test('web-fetch label cuts a long URL at 80 characters with an ellipsis', () => {
  const url = 'https://example.com/' + 'a'.repeat(80) // 100 chars
  assert.equal(toolCallLabel({ kind: 'web-fetch' }, { url }, 'web_fetch'), 'Web Fetch · https://example.com/' + 'a'.repeat(60) + '…')
})

test('genie-one label drops the question lead-in', () => {
  assert.equal(toolCallLabel({ kind: 'genie-one' }, { question: 'Qual foi a receita por mês?' }, 'genie_one'), 'Genie One · a receita por mês?')
})

test('python label uses the leading comment of the code', () => {
  assert.equal(toolCallLabel({ kind: 'python' }, { code: '# projeção de vendas\nx = 1' }, 'python'), 'Python · projeção de vendas')
})
