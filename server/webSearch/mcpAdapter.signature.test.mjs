import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const adapter = existsSync(new URL('./mcpAdapter.ts', import.meta.url))
  ? './mcpAdapter.ts'
  : './mcpAdapter.js'
const { search } = await import(adapter)

test('MCP search keeps its default options argument and runtime arity', () => {
  assert.equal(search.length, 1, 'search(query, options = {}) has one required parameter')
})
