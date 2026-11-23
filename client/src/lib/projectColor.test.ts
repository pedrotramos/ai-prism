// The colour dot of a project: derived from its id, from 8 tokens, never stored.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectColor, PROJECT_COLOR_COUNT } from './projectColor.ts'

test('is deterministic: the same id always gets the same token', () => {
  assert.equal(projectColor(41), projectColor(41))
})

test('maps ids onto the 8 project tokens', () => {
  const seen = new Set<string>()
  for (let id = 0; id < 64; id++) {
    const c = projectColor(id)
    assert.match(c, /^var\(--project-[0-7]\)$/)
    seen.add(c)
  }
  assert.equal(seen.size, PROJECT_COLOR_COUNT)
  assert.equal(projectColor(0), 'var(--project-0)')
  assert.equal(projectColor(9), 'var(--project-1)')
})

test('consecutive ids get different colours', () => {
  for (let id = 1; id < 40; id++) assert.notEqual(projectColor(id), projectColor(id + 1))
})

test('survives ids that are not small positive integers', () => {
  for (const id of [-3, 1.7, Number.NaN, Number.MAX_SAFE_INTEGER, '12' as unknown as number]) {
    assert.match(projectColor(id), /^var\(--project-[0-7]\)$/)
  }
  assert.equal(projectColor('12' as unknown as number), projectColor(12))
})
