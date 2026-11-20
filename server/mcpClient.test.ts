import test from 'node:test'
import assert from 'node:assert/strict'
import { McpToolError } from './mcpClient.ts'

test('McpToolError keeps main\'s own-key order (name, code): `code` is not a class field', () => {
  const e = new McpToolError('timeout', 'boom')
  assert.deepEqual(Object.keys(e), ['name', 'code'])
  assert.equal(e.code, 'timeout')
  assert.equal(e.name, 'McpToolError')
  assert.equal(e.message, 'boom')
})
