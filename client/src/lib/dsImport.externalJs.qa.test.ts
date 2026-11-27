import { test } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { entriesFromZip, importDesignSystemBundle } from './dsImport.ts'

test('reports an external script URL from JavaScript inlined into a card', async () => {
  const zip = new JSZip()
  zip.file('_ds_manifest.json', JSON.stringify({
    namespace: 'inlined_js_kit',
    globalCssPaths: ['colors_and_type.css'],
    cards: [{ path: 'cards/type.html', group: 'Type' }],
  }))
  zip.file('colors_and_type.css', ':root{}')
  zip.file('cards/type.html', '<html><head><script src="card.js"></script></head><body>x</body></html>')
  zip.file('cards/card.js', [
    "const script = document.createElement('script')",
    "script.src = 'https://cdn.example.com/loader.js'",
    'document.head.appendChild(script)',
  ].join(';'))

  const entries = await entriesFromZip(await zip.generateAsync({ type: 'uint8array' }))
  const imported = await importDesignSystemBundle(entries, { downscaleImage: null })

  assert.match(imported.dsCards[0]!.html, /https:\/\/cdn\.example\.com\/loader\.js/)
  assert.deepEqual(imported._importReport.externalRefs, [
    { kind: 'other', host: 'cdn.example.com', count: 1 },
  ])
})
