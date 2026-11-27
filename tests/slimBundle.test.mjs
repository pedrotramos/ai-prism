// Slim server bundle: scripts/lib/esbuild-plugins.mjs pins pdf-parse to its default pdf.js build
// (v1.10.100) so the bundles stop embedding all four (v1.9.426, v1.10.88, v1.10.100, v2.0.550).
// The behaviour has to be IDENTICAL to the unbundled library:
//   - text, page count and metadata of the bundled pdf-parse equal the unbundled pdf-parse;
//   - the build fails loudly when pdf-parse's dynamic require line changes;
//   - server/files.ts reads a small PDF whose Buffer is a slice of Node's internal pool
//     (byteOffset != 0), which the raw pdf-parse misreads ("bad XRef entry");
//   - the real server bundles carry only that build.
// The server boot from server-dist is gated by tests/appkit-boot.test.mjs, which builds
// with the same plugin.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_PDF = path.join(ROOT, 'tests/fixtures/sample-text.pdf')
const EXPECTED_TEXT =
  '\n\nAI Prism - cost report\nLine two: required tags Initiative, Direction.\nTotal: 1234.56\n\nPage 2\nClosing text with plain words and numbers 2026.'
// Version strings that identify each pdf.js build inside a minified bundle.
const OTHER_BUILDS = ['1.9.426', '1.10.88', '2.0.550']

const { pdfParsePinPlugin, PDF_JS_VERSION } = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/esbuild-plugins.mjs')).href)

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ai-prism-slim-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

/** Bundles `entry` (CJS, like the legacy server bundle) with the plugin; options override the defaults. */
async function bundle(entry, outfile, extra = {}) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile,
    logLevel: 'silent',
    plugins: [pdfParsePinPlugin],
    absWorkingDir: ROOT,
    ...extra,
  })
  return outfile
}

/** Bundles pdf-parse's lib entry alone. */
async function bundlePdfParse(dir, extra = {}) {
  mkdirSync(dir, { recursive: true })
  const entry = path.join(dir, 'entry.mjs')
  writeFileSync(entry, `import pdfParse from 'pdf-parse/lib/pdf-parse.js'\nexport default pdfParse\n`)
  return bundle(entry, path.join(dir, 'pdf-bundle.cjs'), { nodePaths: [path.join(ROOT, 'node_modules')], ...extra })
}

/** Runs `node -e` in a clean process (a fresh process has a fresh Buffer pool: deterministic). */
function runNode(code, ...args) {
  const r = spawnSync(process.execPath, ['-e', code, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

describe('pdf-parse pinned to pdf.js v1.10.100 (identical extraction)', () => {
  test('text, page count and metadata of the bundle equal the unbundled pdf-parse', async () => {
    const bundled = await bundlePdfParse(path.join(tmp, 'pin'))
    const plain = path.join(ROOT, 'node_modules/pdf-parse/lib/pdf-parse.js')
    // The raw pdf-parse (no `new Uint8Array`, see the files.ts test below) fails on pooled Buffers, so
    // hand both the same copy: this isolates the bundling from the Buffer pool.
    const code = `const p=require(process.argv[1]);const f=p.default??p;f(new Uint8Array(require('fs').readFileSync(process.argv[2]))).then(r=>console.log(JSON.stringify({text:r.text,numpages:r.numpages,info:r.info,version:r.version})))`
    const a = runNode(code, plain, FIXTURE_PDF)
    const b = runNode(code, bundled, FIXTURE_PDF)
    assert.deepEqual(b, a)
    assert.equal(b.numpages, 2)
    assert.equal(b.text, EXPECTED_TEXT)
  })

  test('the pdf-parse bundle embeds only the v1.10.100 build', async () => {
    const src = readFileSync(await bundlePdfParse(path.join(tmp, 'only')), 'utf8')
    assert.equal(PDF_JS_VERSION, 'v1.10.100')
    assert.ok(src.includes('"1.10.100"'), 'the v1.10.100 build must be in the bundle')
    for (const v of OTHER_BUILDS) assert.ok(!src.includes(`"${v}"`), `pdf.js ${v} must not be bundled`)
  })

  test('the build fails loudly when pdf-parse changes its dynamic require line', async () => {
    const fake = path.join(tmp, 'fake')
    const lib = path.join(fake, 'node_modules/pdf-parse/lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(path.join(lib, 'pdf-parse.js'), "module.exports = function () { return require('./other.js') }\n")
    writeFileSync(path.join(lib, 'other.js'), 'module.exports = 1\n')
    await assert.rejects(() => bundlePdfParse(path.join(fake, 'app'), { absWorkingDir: fake, nodePaths: [path.join(fake, 'node_modules')] }), /pdf-parse.*dynamic pdf\.js require/s)
  })
})

describe('server/files.ts reads a small PDF whatever the Buffer looks like', () => {
  test('extractText survives a Buffer that is a slice of the internal pool (byteOffset != 0)', async () => {
    const out = await bundle(path.join(ROOT, 'server/files.ts'), path.join(tmp, 'files.bundle.cjs'), { external: ['pg-native'] })
    // Fresh process: a file small enough for the pool (readFileSync gives byteOffset 8 on Node 22) is the case
    // that read "bad XRef entry"
    const pooled = `const raw=require('fs').readFileSync(process.argv[2]);const pooled=Buffer.from(Array.from(raw));const slice=Buffer.concat([Buffer.alloc(7),raw]).subarray(7);const {extractText}=require(process.argv[1]);Promise.all([raw,pooled,slice].map((b)=>extractText('a.pdf',b))).then((r)=>console.log(JSON.stringify({offsets:[raw,pooled,slice].map((b)=>b.byteOffset),texts:r})))`
    const r = runNode(pooled, out, FIXTURE_PDF)
    assert.ok(r.offsets.some((o) => o !== 0), `expected a Buffer with byteOffset != 0, got ${r.offsets}`)
    for (const t of r.texts) assert.equal(t, EXPECTED_TEXT)
  })
})

describe('server/files.ts hands pdf-parse a private copy of the bytes', () => {
  // pdf.js 1.10.100 reads `bytes.buffer` ignoring byteOffset, so what matters is the argument itself:
  // a plain Uint8Array that owns its whole ArrayBuffer (byteOffset 0), never the pooled Buffer. Node 22 (the
  // Apps runtime) misreads the raw call ("bad XRef entry", test above); Node 26 does not, so this one checks
  // the argument itself and fails on every Node version if the copy goes away.
  test('readPdf passes a Uint8Array with byteOffset 0 that owns an exact-size ArrayBuffer', async () => {
    const spy = {
      name: 'spy-pdf-parse',
      setup(b) {
        b.onResolve({ filter: /^pdf-parse\/lib\/pdf-parse\.js$/ }, () => ({ path: 'spy', namespace: 'spy' }))
        b.onLoad({ filter: /.*/, namespace: 'spy' }, () => ({
          contents: `module.exports = async (d) => { globalThis.__arg = { isBuffer: Buffer.isBuffer(d), isU8: d instanceof Uint8Array, byteOffset: d.byteOffset, owns: d.buffer.byteLength === d.byteLength, len: d.length }; return { text: 'ok' } }`,
          loader: 'js',
        }))
      },
    }
    const out = await bundle(path.join(ROOT, 'server/files.ts'), path.join(tmp, 'files.spy.cjs'), { plugins: [spy], external: ['pg-native'] })
    const code = `const raw=require('fs').readFileSync(process.argv[2]);const pooled=Buffer.from(Array.from(raw));const {extractText}=require(process.argv[1]);extractText('a.pdf',pooled).then((t)=>console.log(JSON.stringify({t,arg:globalThis.__arg,pooledOffset:pooled.byteOffset,len:raw.length})))`
    const r = runNode(code, out, FIXTURE_PDF)
    assert.equal(r.t, 'ok')
    assert.ok(r.pooledOffset !== 0, 'the input must be a pooled Buffer')
    assert.deepEqual(r.arg, { isBuffer: false, isU8: true, byteOffset: 0, owns: true, len: r.len })
  })
})

describe('the real server bundles (scripts/build-appkit.mjs)', () => {
  const out = path.join(tmp, 'server-dist')
  let sizes
  before(async () => {
    const { buildServer } = await import(pathToFileURL(path.join(ROOT, 'scripts/build-appkit.mjs')).href)
    sizes = await buildServer({ outdir: out })
  })

  test('legacy.cjs and the AppKit server chunk embed only the v1.10.100 pdf.js build', () => {
    const withPdf = readdirSync(out).filter((f) => /\.(cjs|mjs)$/.test(f) && readFileSync(path.join(out, f), 'utf8').includes('"1.10.100"'))
    assert.ok(withPdf.includes('legacy.cjs'), `files with pdf.js: ${withPdf}`)
    assert.equal(withPdf.length, 2, `legacy.cjs plus the AppKit chunk holding our app: ${withPdf}`)
    for (const f of withPdf) {
      const src = readFileSync(path.join(out, f), 'utf8')
      for (const v of OTHER_BUILDS) assert.ok(!src.includes(`"${v}"`), `${f} still embeds pdf.js ${v}`)
    }
  })

  test('the pin saves about 3 MB per bundle (legacy.cjs under 7 MB; it was 9.03 MB)', () => {
    assert.ok(sizes['legacy.cjs'] < 7_000_000, `legacy.cjs is ${sizes['legacy.cjs']} bytes`)
  })
})
