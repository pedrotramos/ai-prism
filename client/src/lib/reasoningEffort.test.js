//   node --test client/src/lib/reasoningEffort.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { effortLevelsOf, reasoningEffortFor, setReasoningEffort, getReasoningEffort } from './reasoningEffort.js'

const capable = { id: 'a', reasoning: { param: 'openai', levels: ['low', 'high'] } }
const plain = { id: 'b' }

test('levels: none without the flag, the intersection with the known levels otherwise', () => {
  assert.deepEqual(effortLevelsOf(plain), [])
  assert.deepEqual(effortLevelsOf(undefined), [])
  assert.deepEqual(effortLevelsOf(capable), ['low', 'high'])
  assert.deepEqual(effortLevelsOf({ reasoning: { param: 'openai' } }), ['low', 'medium', 'high'])
})

test('the body gets an effort only for a capable model and a level it lists (stale client safe)', () => {
  const models = [capable, plain]
  assert.equal(reasoningEffortFor(models, 'a', 'high'), 'high')
  assert.equal(reasoningEffortFor(models, 'a', 'medium'), undefined, 'level not probed for this model')
  assert.equal(reasoningEffortFor(models, 'a', 'default'), undefined)
  assert.equal(reasoningEffortFor(models, 'b', 'high'), undefined, 'model lost the flag')
  assert.equal(reasoningEffortFor(models, 'gone', 'high'), undefined)
})

test('the store defaults to "default" and ignores unknown levels', () => {
  assert.equal(getReasoningEffort(), 'default')
  setReasoningEffort('high')
  assert.equal(getReasoningEffort(), 'high')
  setReasoningEffort('bogus')
  assert.equal(getReasoningEffort(), 'default')
})
