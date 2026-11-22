// Component test for the error boundaries (client/src/app/ErrorBoundary.tsx).
// `node --test` cannot load JSX, so the component is bundled with esbuild (a
// devDependency already used for the server build) together with React and
// react-dom/server, written to a temp file and imported. React's server
// renderer does not run error boundaries, so the catching contract is checked
// through the boundary's own lifecycle (getDerivedStateFromError /
// getDerivedStateFromProps / render), and the fallback card is rendered to
// markup under the real I18nProvider in each UI language.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let dir: string | undefined
// any: the esbuild bundle of ErrorBoundary.tsx is imported dynamically, so its shape is not known statically
let m: any

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'error-boundary-test-'))
  const out = await build({
    stdin: {
      contents: `
        export { default as ErrorBoundary, BlockErrorBoundary } from './ErrorBoundary.tsx'
        export { I18nProvider } from '../lib/i18n.tsx'
        export { createElement } from 'react'
        export { renderToStaticMarkup } from 'react-dom/server'
      `,
      resolveDir: HERE,
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.png': 'dataurl', '.svg': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    // react-dom/server is CommonJS and requires node builtins
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: 'silent',
  })
  const file = path.join(dir, 'bundle.mjs')
  writeFileSync(file, out.outputFiles[0]!.text)
  m = await import(pathToFileURL(file).href)
})

after(() => dir && rmSync(dir, { recursive: true, force: true }))

const markup = (el: unknown, uiLang: string = 'en') => m.renderToStaticMarkup(m.createElement(m.I18nProvider, { uiLang }, el))

// Mount a boundary element the way React does, make its child throw, and
// return what it renders next.
// any: the element comes out of the dynamically imported bundle (see `m`)
function renderAfterThrow(element: any, error: unknown = new TypeError("Cannot read properties of null (reading 'map')")) {
  const Boundary = element.type
  const inst = new Boundary(element.props)
  inst.state = { ...inst.state, ...Boundary.getDerivedStateFromError(error) }
  return inst.render()
}

test('BlockErrorBoundary renders its children while nothing throws', () => {
  const child = m.createElement('p', null, 'Q3 revenue grew 12%')
  const html = markup(m.createElement(m.BlockErrorBoundary, { blockType: 'chart' }, child))
  assert.equal(html, '<p>Q3 revenue grew 12%</p>')
})

test('a block that throws becomes an inline card naming the part, not the message', () => {
  const el = m.BlockErrorBoundary({ blockType: 'chart', children: m.createElement('p', null, 'chart') })
  const html = markup(renderAfterThrow(el))
  assert.match(html, /role="alert"/)
  assert.match(html, /Could not display this part of the message\./)
  assert.doesNotMatch(html, /Could not display this message\./)
  assert.match(html, /data-block-type="chart"/)
})

test('the raw error stays behind a Details disclosure, with the block type', () => {
  const el = m.BlockErrorBoundary({ blockType: 'chart', children: null })
  const html = markup(renderAfterThrow(el))
  assert.match(html, /<details[^>]*><summary[^>]*>Details<\/summary>/)
  assert.match(html, /chart: TypeError: Cannot read properties of null \(reading &#x27;map&#x27;\)/)
})

test('the block card is translated (pt-BR and es)', () => {
  const el = m.BlockErrorBoundary({ blockType: 'table', children: null })
  assert.match(markup(renderAfterThrow(el), 'pt-BR'), /Não foi possível exibir esta parte da mensagem\.[\s\S]*Detalhes/)
  assert.match(markup(renderAfterThrow(el), 'es'), /No se pudo mostrar esta parte del mensaje\.[\s\S]*Detalles/)
})

test('a new resetKey clears the error so the block renders again', () => {
  const { ErrorBoundary } = m
  const cleared = ErrorBoundary.getDerivedStateFromProps({ resetKey: 'v2' }, { error: new Error('x'), key: 'v1' })
  assert.deepEqual(cleared, { error: null, key: 'v2' })
  assert.equal(ErrorBoundary.getDerivedStateFromProps({ resetKey: 'v1' }, { error: new Error('x'), key: 'v1' }), null)
})

test('the message-level card keeps its own text', () => {
  const html = markup(renderAfterThrow(m.createElement(m.ErrorBoundary, { variant: 'message' }, null)))
  assert.match(html, /Could not display this message\./)
})
