import test from 'node:test'
import assert from 'node:assert/strict'
import { TranscriptionError } from './transcribe.ts'

test('TranscriptionError keeps main\'s own-key order (name, code): `code` is not a class field', () => {
  const e = new TranscriptionError('falhou')
  assert.deepEqual(Object.keys(e), ['name', 'code'])
  assert.equal(e.code, 'failed')
  assert.equal(new TranscriptionError('x', 'too_big').code, 'too_big')
})
