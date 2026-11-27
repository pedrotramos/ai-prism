// GEO_DATA_DIR: an operator adds a geo set as <id>.json; a bundled id can never be replaced
// and a bad file is skipped, not fatal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getGeoSet, listGeoSets, loadExtraGeoSets, matchGeo, resetGeoCache } from './geo.ts'

const set = (id: string, ids: string[]) => ({
  id,
  name: id,
  viewBox: [100, 100],
  regions: ids.map((r, i) => ({ id: r, name: `Zone ${r}`, d: `M${i * 10} 0L${i * 10 + 8} 0L${i * 10 + 8} 8Z` })),
})

test('GEO_DATA_DIR adds sets, keeps the bundled ones first and skips bad files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'geo-'))
  try {
    writeFileSync(path.join(dir, 'zones.json'), JSON.stringify(set('zones', ['Z1', 'Z2', 'Z3', 'Z4'])))
    writeFileSync(path.join(dir, 'world.json'), JSON.stringify(set('world-countries', ['AA', 'BB'])))
    writeFileSync(path.join(dir, 'broken.json'), '{nope')
    writeFileSync(path.join(dir, 'notes.txt'), 'ignored')
    assert.deepEqual(loadExtraGeoSets(dir).map((s) => s.id), ['world-countries', 'zones'])
    process.env.GEO_DATA_DIR = dir
    resetGeoCache()
    assert.deepEqual(listGeoSets().map((s) => s.id), ['world-countries', 'br-states', 'zones'])
    assert.ok((getGeoSet('world-countries')?.regions.length ?? 0) > 150, 'the bundled world set is not replaced')
    assert.equal(matchGeo(['Zone Z1', 'z2', 'Z3', 'Z4'])?.set.id, 'zones')
    assert.equal(getGeoSet('missing'), null)
  } finally {
    delete process.env.GEO_DATA_DIR
    resetGeoCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable GEO_DATA_DIR leaves the bundled sets', () => {
  assert.deepEqual(loadExtraGeoSets('/definitely/not/here'), [])
})
