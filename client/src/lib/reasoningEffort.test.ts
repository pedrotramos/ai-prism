//   node --test client/src/lib/reasoningEffort.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { effortLevelsOf, reasoningEffortFor, setReasoningEffort, getReasoningEffort, EFFORT_CHOICES } from './reasoningEffort.ts'

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
  assert.equal(reasoningEffortFor(models, 'a', 'auto'), undefined, 'auto sends nothing')
  assert.equal(reasoningEffortFor(models, 'a', 'default'), undefined)
  assert.equal(reasoningEffortFor(models, 'b', 'high'), undefined, 'model lost the flag')
  assert.equal(reasoningEffortFor(models, 'gone', 'high'), undefined)
})

test('the store defaults to "auto", keeps "default" as an alias and ignores unknown levels', () => {
  assert.equal(getReasoningEffort(), 'auto')
  setReasoningEffort('high')
  assert.equal(getReasoningEffort(), 'high')
  setReasoningEffort('bogus')
  assert.equal(getReasoningEffort(), 'auto')
  setReasoningEffort('low')
  setReasoningEffort('default')
  assert.equal(getReasoningEffort(), 'auto')
})

test('the choices offered are Auto first, then the known levels', () => {
  assert.deepEqual(EFFORT_CHOICES, ['auto', 'low', 'medium', 'high'])
})
