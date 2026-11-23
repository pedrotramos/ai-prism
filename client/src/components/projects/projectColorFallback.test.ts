// ui-revamp W1-8: until lib/projectColor.ts (W1-1) lands, the project page derives the dot colour from the id,
// client-side, out of the chart tokens (Q10-A). W2-4 swaps this for the shared helper.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROJECT_COLOR_CLASSES, PROJECT_COLOR_VARS, projectColorClass, projectColorVar } from './projectColorFallback.ts'

test('W1-8 the same id always gets the same token', () => {
  assert.equal(projectColorVar(7), projectColorVar('7'))
  assert.equal(projectColorVar('abc'), projectColorVar('abc'))
})

test('W1-8 the colour is always one of the chart tokens, for any id', () => {
  for (const id of [0, 1, 2, 99, 'x', '', 'a-very-long-uuid-0000-1111', null, undefined, -3]) {
    assert.ok((PROJECT_COLOR_VARS as readonly string[]).includes(projectColorVar(id as never)), String(id))
  }
})

test('W1-8 ids spread over the palette', () => {
  const seen = new Set(Array.from({ length: 40 }, (_, i) => projectColorVar(i)))
  assert.ok(seen.size >= 4)
})

test('W1-8 the dot class is the class of the same token', () => {
  for (const id of [1, 2, 3, 'abc', 'zzz']) {
    const v = projectColorVar(id)
    assert.equal(projectColorClass(id), `bg-[${v}]`)
    assert.ok((PROJECT_COLOR_CLASSES as readonly string[]).includes(projectColorClass(id)))
  }
})
