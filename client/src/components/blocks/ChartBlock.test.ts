// ChartBlock keeps the pre-TypeScript failure mode for a series without `data`:
// rendering throws (the message's block error boundary shows the fallback card)
// instead of drawing an empty chart. The component is a .tsx that Node cannot
// import, so the test bundles it with esbuild, together with React and
// react-dom/server so both share one React instance.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let dir: string | undefined
// any: a test-only dynamic import of the bundled component and React helpers
let mod: any

before(async () => {
  const out = await build({
    stdin: {
      contents: "export { default as ChartBlock } from './ChartBlock.tsx'\nexport { createElement } from 'react'\nexport { renderToString } from 'react-dom/server'\n",
      resolveDir: HERE,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' },
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  })
  dir = mkdtempSync(path.join(tmpdir(), 'chartblock-test-'))
  const file = path.join(dir, 'chartblock.mjs')
  writeFileSync(file, (out.outputFiles[0] as { text: string }).text)
  mod = await import(pathToFileURL(file).href)
})

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

test('a series without data throws while rendering (the error boundary handles it)', () => {
  const block = { type: 'chart', chartType: 'bar', title: 'Malformed series', series: [{ name: 'series without data' }] }
  assert.throws(() => mod.renderToString(mod.createElement(mod.ChartBlock, { block })), /map/)
})

test('a well-formed bar chart renders its title', () => {
  const block = { type: 'chart', chartType: 'bar', title: 'Revenue', series: [{ name: 'Q1', data: [{ label: 'a', value: 1 }] }] }
  assert.match(mod.renderToString(mod.createElement(mod.ChartBlock, { block })), /Revenue/)
})

const html = (props: Record<string, unknown>) => mod.renderToString(mod.createElement(mod.ChartBlock, props))

test('a donut and a map render their card with the kind marked', () => {
  const data = [
    { label: 'Brasil', value: 60 },
    { label: 'Chile', value: 40 },
  ]
  assert.match(html({ block: { type: 'chart', chartType: 'donut', title: 'Share', series: [{ name: 'Revenue', data }] } }), /data-chart-type="donut"/)
  // the geo set loads after mount: the server render holds the loading state of the map
  const map = html({ block: { type: 'chart', chartType: 'map', title: 'By country', geo: 'world-countries', series: [{ name: 'Revenue', data }] } })
  assert.match(map, /data-chart-type="map"/)
  assert.match(map, /role="img"/)
})

test('"Use in slides" shows only when the host can act on it, and never on a pivot', () => {
  const series = [{ name: 'Revenue', data: [{ label: 'a', value: 1 }] }]
  const buttons = (props: Record<string, unknown>) => (html(props).match(/<button/g) || []).length
  const bar = { type: 'chart', chartType: 'bar', title: 'Revenue', series }
  assert.equal(buttons({ block: bar, onUseInSlides: () => {} }), buttons({ block: bar }) + 1)
  assert.equal(buttons({ block: { ...bar, chartType: 'pivot' }, onUseInSlides: () => {} }), buttons({ block: { ...bar, chartType: 'pivot' } }))
})
