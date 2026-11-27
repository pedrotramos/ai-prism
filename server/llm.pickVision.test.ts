// pickVisionModel: the asset-label model comes from the enabled catalog only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickVisionModel, modelById } from './llm.ts'

const SONNET = 'databricks-claude-sonnet-5-5'
const OPUS = 'databricks-claude-opus-5-5'
const NO_VISION = 'databricks-glm-5-3'

test('precondition: the ids used here have the vision flag the cases rely on', () => {
  assert.equal(Boolean(modelById(SONNET).vision), true)
  assert.equal(Boolean(modelById(OPUS).vision), true)
  assert.equal(Boolean(modelById(NO_VISION).vision), false)
})

test('the selected model is used when it is enabled and takes images', () => {
  assert.equal(pickVisionModel(OPUS, [{ id: SONNET }, { id: OPUS }]), OPUS)
})

test('a selection disabled since (not in the enabled list) is never used, even with vision', () => {
  assert.equal(pickVisionModel(OPUS, [{ id: SONNET }]), SONNET)
})

test('a selection outside the whole enabled list falls to no labels when no enabled model takes images', () => {
  assert.equal(pickVisionModel(OPUS, [{ id: NO_VISION }]), null)
})

test('a removed/unknown selection falls to the first enabled vision model, in catalog order', () => {
  assert.equal(pickVisionModel('databricks-removed-model', [{ id: NO_VISION }, { id: SONNET }, { id: OPUS }]), SONNET)
})

test('an enabled selection without vision falls to the first enabled vision model', () => {
  assert.equal(pickVisionModel(NO_VISION, [{ id: NO_VISION }, { id: OPUS }]), OPUS)
})

test('no selection, or an empty enabled list, keeps the previous behaviour', () => {
  assert.equal(pickVisionModel(null, [{ id: NO_VISION }, { id: SONNET }]), SONNET)
  assert.equal(pickVisionModel(SONNET, []), null)
})
