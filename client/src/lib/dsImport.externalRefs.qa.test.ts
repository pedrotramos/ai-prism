import { test } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { entriesFromZip, importDesignSystemBundle } from './dsImport.ts'

test('reports external references from local CSS linked into a card', async () => {
  const zip = new JSZip()
  zip.file('_ds_manifest.json', JSON.stringify({
    namespace: 'linked_css_kit',
    globalCssPaths: ['colors_and_type.css'],
    cards: [{ path: 'cards/type.html', group: 'Type' }],
  }))
  zip.file('colors_and_type.css', ':root{--brand:#0e6b5c}')
  zip.file('cards/type.html', '<html><head><link rel="stylesheet" href="type.css"></head><body><h1>Type</h1></body></html>')
  zip.file('cards/type.css', '.hero{background-image:url(https://cdn.example.com/hero.png)}')

  const entries = await entriesFromZip(await zip.generateAsync({ type: 'uint8array' }))
  const imported = await importDesignSystemBundle(entries, { downscaleImage: null })

  assert.match(imported.dsCards[0]!.html, /https:\/\/cdn\.example\.com\/hero\.png/)
  assert.deepEqual(imported._importReport.externalRefs, [
    { kind: 'imageUrl', host: 'cdn.example.com', count: 1 },
  ])
})

test('a local stylesheet shared by two cards is counted once', async () => {
  const zip = new JSZip()
  zip.file('_ds_manifest.json', JSON.stringify({
    namespace: 'shared_css_kit',
    globalCssPaths: ['colors_and_type.css'],
    cards: [{ path: 'cards/a.html', group: 'Type' }, { path: 'cards/b.html', group: 'Type' }],
  }))
  zip.file('colors_and_type.css', ':root{--brand:#0e6b5c}')
  for (const n of ['a', 'b']) zip.file(`cards/${n}.html`, '<html><head><link rel="stylesheet" href="shared.css"></head><body>x</body></html>')
  zip.file('cards/shared.css', '.hero{background-image:url(https://cdn.example.com/hero.png)}')
  const imported = await importDesignSystemBundle(await entriesFromZip(await zip.generateAsync({ type: 'uint8array' })), { downscaleImage: null })
  assert.deepEqual(imported._importReport.externalRefs, [{ kind: 'imageUrl', host: 'cdn.example.com', count: 1 }])
})
