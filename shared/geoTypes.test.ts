// Geo sets behind the `map` chart kind: the bundled sets are well formed, labels
// resolve by code, name and alias (accent- and case-insensitive), and an
// untrusted set is validated before it is used.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_GEO_SETS } from './geo/index.ts'
import { geoKey, matchGeoSet, parseGeoSet } from './geoTypes.ts'

const world = BUILTIN_GEO_SETS.find((s) => s.id === 'world-countries')!
const br = BUILTIN_GEO_SETS.find((s) => s.id === 'br-states')!

test('the bundled sets: a generic world map and an example region set, every region has a path', () => {
  assert.deepEqual(BUILTIN_GEO_SETS.map((s) => s.id), ['world-countries', 'br-states'])
  assert.ok(world.regions.length > 150)
  assert.equal(br.regions.length, 27)
  for (const set of BUILTIN_GEO_SETS) {
    assert.ok(parseGeoSet(set), `${set.id} passes its own validation`)
    assert.equal(new Set(set.regions.map((r) => r.id)).size, set.regions.length, `${set.id}: unique ids`)
    for (const r of set.regions) assert.match(r.d, /^M[0-9 .LZM-]+$/, `${set.id}/${r.id}: path data`)
  }
})

test('labels resolve by code, name in en/pt/es and alpha-3, ignoring case and accents', () => {
  const m = matchGeoSet(['BR', 'Brazil', 'Brasil', 'Alemanha', 'germany', 'USA', 'España'], [world, br])
  assert.equal(m?.set.id, 'world-countries')
  assert.deepEqual(m?.ids, ['BR', 'BR', 'BR', 'DE', 'DE', 'US', 'ES'])
  assert.equal(geoKey('São  Paulo'), 'saopaulo')
})

test('the best set wins and a column that is not regions matches nothing', () => {
  assert.equal(matchGeoSet(['SP', 'RJ', 'minas gerais', 'Bahia'], [world, br])?.set.id, 'br-states')
  assert.equal(matchGeoSet(['Produto A', 'Produto B', 'Produto C', 'Produto D'], [world, br]), null)
  // fewer than 3 distinct regions: not worth a map
  assert.equal(matchGeoSet(['SP', 'RJ'], [world, br]), null)
  // 70% coverage: 3 of 5 labels resolve is not enough
  assert.equal(matchGeoSet(['SP', 'RJ', 'MG', 'xx', 'yy'], [br]), null)
})

test('parseGeoSet rejects markup in path data, bad ids and sets with fewer than two regions', () => {
  const ok = { id: 'my-set', name: 'My set', viewBox: [100, 50], regions: [{ id: 'a', name: 'A', d: 'M0 0L10 0L10 10Z' }, { id: 'b', name: 'B', d: 'M20 0L30 0L30 10Z' }] }
  assert.equal(parseGeoSet(ok)?.regions[0]?.id, 'A')
  assert.equal(parseGeoSet({ ...ok, id: 'Bad Id' }), null)
  assert.equal(parseGeoSet({ ...ok, viewBox: [0, 50] }), null)
  assert.equal(parseGeoSet({ ...ok, regions: [ok.regions[0]] }), null)
  const evil = parseGeoSet({ ...ok, regions: [{ ...ok.regions[0], d: 'M0 0"/><script>' }, ok.regions[1], { id: 'c', name: 'C', d: 'M1 1L2 2L3 1Z' }] })
  assert.deepEqual(evil?.regions.map((r) => r.id), ['B', 'C'])
})
