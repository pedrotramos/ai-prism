import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recommendedIds, splitCatalog, filterModels, visionBadgeMode, showsVisionBadge } from './modelGroups.ts'

// shape of GET /api/models entries (server/serving.js buildUserModels)
const m = (id: string, provider: string, vision: boolean = true, extra: Record<string, unknown> = {}) => ({ id, label: id.toUpperCase(), provider, blurb: '', vision, tools: true, ...extra })
const CATALOG = [
  m('sonnet', 'Anthropic'),
  m('opus', 'Anthropic'),
  m('haiku', 'Anthropic'),
  m('sol', 'OpenAI'),
  m('luna', 'OpenAI'),
  m('argon', 'Google'),
  m('glm', 'Zhipu AI', false),
  m('qwen', 'Alibaba', false),
]

test('recommended = the first model of each of the first three providers, in catalog order', () => {
  assert.deepEqual(recommendedIds(CATALOG), ['sonnet', 'sol', 'argon'])
})

test('models flagged recommended by the server come first', () => {
  const cat = CATALOG.map((x) => (x.id === 'qwen' ? { ...x, recommended: true } : x))
  assert.deepEqual(recommendedIds(cat), ['qwen', 'sonnet', 'sol'])
})

test('with fewer than three providers the rest is filled in catalog order', () => {
  assert.deepEqual(recommendedIds([m('a', 'X'), m('b', 'X'), m('c', 'Y'), m('d', 'Y')]), ['a', 'c', 'b'])
  assert.deepEqual(recommendedIds([m('a', 'X')]), ['a'])
  assert.deepEqual(recommendedIds([]), [])
})

test('splitCatalog puts the rest under "more", grouped by provider in catalog order', () => {
  const { recommended, more } = splitCatalog(CATALOG)
  assert.deepEqual(recommended.map((x) => x?.id), ['sonnet', 'sol', 'argon'])
  assert.deepEqual(
    more.map((g) => [g.provider, g.models.map((x) => x.id)]),
    [
      ['Anthropic', ['opus', 'haiku']],
      ['OpenAI', ['luna']],
      ['Zhipu AI', ['glm']],
      ['Alibaba', ['qwen']],
    ]
  )
})

test('a catalog of three or fewer has nothing under "more"', () => {
  const { recommended, more } = splitCatalog(CATALOG.slice(0, 3))
  assert.equal(recommended.length, 3)
  assert.deepEqual(more, [])
})

test('filterModels matches label, provider and id, ignoring case and accents', () => {
  const cat = [m('a', 'Anthropic', true, { label: 'Visão Pro' }), m('b', 'OpenAI'), m('c', 'Google')]
  assert.deepEqual(filterModels(cat, 'visao').map((x) => x.id), ['a'])
  assert.deepEqual(filterModels(cat, '  OPENai ').map((x) => x.id), ['b'])
  assert.deepEqual(filterModels(cat, 'c').map((x) => x.id), ['a', 'c']) // "c" in "Anthropic" and the id
  assert.deepEqual(filterModels(cat, '').map((x) => x.id), ['a', 'b', 'c'])
})

test('vision badge: shown only on the minority, never when every model agrees', () => {
  assert.equal(visionBadgeMode(CATALOG), 'noVision') // 6 of 8 take images: mark the 2 that do not
  assert.equal(visionBadgeMode([m('a', 'X', false), m('b', 'X', false), m('c', 'X', true)]), 'vision')
  assert.equal(visionBadgeMode([m('a', 'X'), m('b', 'X')]), null)
  assert.equal(visionBadgeMode([m('a', 'X', false)]), null)
  assert.equal(visionBadgeMode([]), null)
})

test('showsVisionBadge follows the mode', () => {
  assert.equal(showsVisionBadge(m('glm', 'Z', false), 'noVision'), true)
  assert.equal(showsVisionBadge(m('sonnet', 'A', true), 'noVision'), false)
  assert.equal(showsVisionBadge(m('sonnet', 'A', true), 'vision'), true)
  assert.equal(showsVisionBadge(m('glm', 'Z', false), 'vision'), false)
  assert.equal(showsVisionBadge(m('sonnet', 'A', true), null), false)
})
