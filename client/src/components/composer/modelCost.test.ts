import test from 'node:test'
import assert from 'node:assert/strict'
import { costTier } from './modelCost.ts'

const m = (id: string, i?: number, o?: number) => ({ id, in: i, out: o })
const catalog = [m('cheap', 0.1, 0.5), m('cheap2', 0.1, 0.5), m('mid', 2, 10), m('mid2', 2, 10), m('top', 10, 50), m('top2', 4, 20)]

test('cost tier splits the priced models into terciles of the blended price', () => {
  assert.equal(costTier(catalog[0]!, catalog), 1)
  assert.equal(costTier(catalog[2]!, catalog), 2)
  assert.equal(costTier(catalog[4]!, catalog), 3)
})

test('a model without a price has no tier (the dots are not drawn)', () => {
  assert.equal(costTier(m('x'), catalog), null)
  assert.equal(costTier(m('x', 0, 0), catalog), null)
  assert.equal(costTier(catalog[0]!, [catalog[0]!]), 2, 'a one-model catalog sits in the middle')
})

test('equal prices share a tier whatever the catalog size', () => {
  const same = [m('a', 1, 1), m('b', 1, 1), m('c', 1, 1)]
  assert.deepEqual(same.map((x) => costTier(x, same)), [2, 2, 2])
})
