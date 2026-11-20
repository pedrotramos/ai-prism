// Guards for the per-domain UI catalogs (locales/<lang>/<domain>.js, merged by
// locales/index.js).
//
// 1. Snapshot: every key resolves to the exact string recorded in
//    __snapshots__/<domain>.json, so a refactor of the catalog layout can never
//    change, drop or add copy without the diff showing up in review. When you add
//    or change strings on purpose, regenerate the snapshots and commit them with
//    the change:
//      UPDATE_LOCALE_SNAPSHOTS=1 node --test client/src/lib/locales/catalogs.test.js
// 2. Parity: pt, en and es carry the same key set, domain by domain, so no
//    language silently falls back to another one.
// 3. Partition: a key namespace (the part before the first '.') lives in exactly
//    one domain file, so two domain files can never define the same key and the
//    merge order in index.js cannot matter.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LANGS = ['pt', 'en', 'es']
const DOMAINS = ['common', 'composer', 'message', 'sidebar', 'welcome', 'settings', 'admin', 'studios', 'errors', 'projects']
const snapshotUrl = (domain) => new URL(`./__snapshots__/${domain}.json`, import.meta.url)
const UPDATE = process.env.UPDATE_LOCALE_SNAPSHOTS === '1'

const loadIndex = () => import('./index.js')

function sorted(obj) {
  const out = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]
  return out
}

function readSnapshot(domain) {
  return JSON.parse(readFileSync(fileURLToPath(snapshotUrl(domain)), 'utf8'))
}

test('index.js exposes the ten domains for each language', async () => {
  const { DOMAINS: exported, PARTS } = await loadIndex()
  assert.deepEqual(exported, DOMAINS)
  for (const lang of LANGS) assert.deepEqual(Object.keys(PARTS[lang]), DOMAINS, lang)
})

test('each domain file matches its snapshot, in every language', async () => {
  const { PARTS } = await loadIndex()
  for (const domain of DOMAINS) {
    const actual = {}
    for (const lang of LANGS) actual[lang] = sorted(PARTS[lang][domain])
    if (UPDATE) {
      writeFileSync(fileURLToPath(snapshotUrl(domain)), JSON.stringify(actual, null, 2) + '\n')
      continue
    }
    assert.deepEqual(actual, readSnapshot(domain), `locales/*/${domain}.js drifted from __snapshots__/${domain}.json`)
  }
})

test('merged catalogs resolve every key to the snapshot string', async () => {
  const merged = await loadIndex()
  for (const lang of LANGS) {
    const expected = {}
    for (const domain of DOMAINS) Object.assign(expected, readSnapshot(domain)[lang])
    assert.deepEqual(sorted(merged[lang]), sorted(expected), lang)
    assert.equal(merged.default[lang], merged[lang], `default export ${lang}`)
  }
})

test('pt, en and es have identical key sets, per domain and merged', async () => {
  const merged = await loadIndex()
  const keys = (o) => Object.keys(o).sort()
  for (const domain of DOMAINS) {
    const pt = keys(merged.PARTS.pt[domain])
    for (const lang of ['en', 'es']) {
      assert.deepEqual(keys(merged.PARTS[lang][domain]), pt, `${lang}/${domain}.js vs pt/${domain}.js`)
    }
  }
  for (const lang of ['en', 'es']) assert.deepEqual(keys(merged[lang]), keys(merged.pt), `${lang} vs pt`)
})

test('a key namespace lives in exactly one domain file', async () => {
  const { PARTS } = await loadIndex()
  for (const lang of LANGS) {
    const owner = new Map()
    for (const domain of DOMAINS) {
      for (const key of Object.keys(PARTS[lang][domain])) {
        const ns = key.split('.')[0]
        const prev = owner.get(ns)
        assert.ok(!prev || prev === domain, `${lang}: namespace "${ns}" is split across ${prev}.js and ${domain}.js`)
        owner.set(ns, domain)
      }
    }
  }
})

test('every catalog value is a non-empty string', async () => {
  const merged = await loadIndex()
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(merged[lang])) {
      assert.equal(typeof value, 'string', `${lang} ${key}`)
      assert.ok(value.length > 0, `${lang} ${key} is empty`)
    }
  }
})
