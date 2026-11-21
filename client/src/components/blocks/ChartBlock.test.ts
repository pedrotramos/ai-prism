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
