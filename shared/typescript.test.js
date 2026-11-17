// TypeScript toolchain contract for shared/** (docs/adr/0006-typescript.md).
//
// shared/** is imported by the server (esbuild bundle), the client (Vite) and
// plain-Node scripts, so it is the first folder written in TypeScript. Each
// module's source is `<name>.ts`; `<name>.js` is a one-line re-export shim so
// that no importer has to change its specifier. These tests pin that layout,
// the strict compiler options that apply to `.ts` files, the public API the
// shims expose, and a clean `tsc --noEmit` over the whole project.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Public API of each shared module, written out by hand from the pre-TypeScript
// sources: converting a module must not add, drop or rename an export.
const PUBLIC_API = {
  deckTheme: [
    'DEFAULT_TEMPLATE_THEME',
    'THEME_COLOR_TOKENS',
    'blend',
    'contrastOn',
    'hexOr',
    'luminance',
    'pickDeckIllustration',
    'pickLogoForBg',
    'resolveDeckTheme',
    'resolveThemeColor',
  ],
  markdownSafety: ['safeLinkDestination', 'stripUnsafeMarkdownHtml'],
  pythonUdf: ['PYTHON_UDF_BODY', 'PYTHON_UDF_COMMENT', 'PYTHON_UDF_PARAM_COMMENT', 'pythonUdfDDL'],
  sheetModel: ['cellParts', 'colIndex', 'colKey', 'colLetter', 'isFormula', 'materializeWorkbook', 'norm', 'resolveFormula'],
}
const MODULES = Object.keys(PUBLIC_API)

function loadTsconfig() {
  const file = path.join(ROOT, 'tsconfig.json')
  const { config, error } = ts.readConfigFile(file, ts.sys.readFile)
  assert.equal(error, undefined, error && ts.flattenDiagnosticMessageText(error.messageText, '\n'))
  return ts.parseJsonConfigFileContent(config, ts.sys, ROOT, undefined, file)
}

test('tsconfig applies the strict TypeScript options to .ts files and leaves JS unchecked', () => {
  const { options, errors } = loadTsconfig()
  assert.deepEqual(errors, [])
  assert.equal(options.strict, true)
  assert.equal(options.noUncheckedIndexedAccess, true)
  assert.equal(options.verbatimModuleSyntax, true)
  assert.equal(options.erasableSyntaxOnly, true)
  assert.equal(options.allowImportingTsExtensions, true)
  assert.equal(options.noEmit, true)
  // the JS codebase keeps building while it migrates by ownership
  assert.equal(options.allowJs, true)
  assert.equal(options.checkJs, false)
})

for (const name of MODULES) {
  test(`shared/${name}: the source is ${name}.ts and ${name}.js is only a re-export shim`, () => {
    assert.ok(existsSync(path.join(ROOT, 'shared', `${name}.ts`)), `shared/${name}.ts missing`)
    const code = readFileSync(path.join(ROOT, 'shared', `${name}.js`), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .trim()
    assert.equal(code, `export * from './${name}.ts'`)
  })

  test(`shared/${name}.js exposes the same public API as before the conversion`, async () => {
    const mod = await import(`./${name}.js`)
    assert.deepEqual(Object.keys(mod).sort(), [...PUBLIC_API[name]].sort())
  })
}

test('tsc --noEmit over tsconfig.json reports 0 errors and type-checks every shared/*.ts', () => {
  const { options, fileNames } = loadTsconfig()
  const program = ts.createProgram(fileNames, options)
  const checked = new Set(program.getSourceFiles().map((f) => path.relative(ROOT, f.fileName)))
  for (const name of MODULES) assert.ok(checked.has(`shared/${name}.ts`), `shared/${name}.ts not in the program`)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  const text = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => '\n',
  })
  assert.equal(diagnostics.length, 0, text)
})

test('the esbuild server bundle of a shared .ts module adds no "use strict" directive', async () => {
  // `strict` implies `alwaysStrict`, which esbuild reads from tsconfig and turns
  // into a "use strict" prologue on the single-file CJS server bundle: every
  // bundled CommonJS dependency would then run in strict mode. Same flags as
  // `npm run build:server`.
  const { build } = await import('esbuild')
  const out = await build({
    entryPoints: [path.join(ROOT, 'shared', 'sheetModel.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    write: false,
    logLevel: 'silent',
  })
  const code = out.outputFiles[0].text
  assert.doesNotMatch(code, /^\s*(?:\/\/[^\n]*\n\s*)*["']use strict["']/)
  assert.match(code, /function colLetter\(idx\)/)
})

// The first Node release that runs `.ts` without a flag (type stripping on by
// default). Verified with real runs, not taken from release notes: on 22.17.0
// `import('./shared/deckTheme.js')` fails with ERR_UNKNOWN_FILE_EXTENSION and
// `process.features.typescript` is false; on 22.18.0 it imports and is 'strip'.
const TYPE_STRIPPING_FLOOR = [22, 18, 0]

/** '22' → [22,0,0], 'v22.19' → [22,19,0]: the lowest version a prefix selects. */
function lowestVersion(spec, label) {
  const m = String(spec).trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)
  assert.ok(m, `${label} must be a plain version prefix such as 22.23 (got ${JSON.stringify(spec)})`)
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}
const atLeast = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

test('the declared Node versions (.nvmrc, engines, lockfile) never allow a Node without type stripping', () => {
  const nvmrc = readFileSync(path.join(ROOT, '.nvmrc'), 'utf8')
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const engines = String(pkg.engines?.node ?? '')
  const floor = engines.match(/^>=\s*(\S+)$/)
  assert.ok(floor, `package.json engines.node must be ">=<version>" (got ${JSON.stringify(engines)})`)
  const enginesFloor = lowestVersion(floor[1], 'engines.node')
  assert.ok(atLeast(enginesFloor, TYPE_STRIPPING_FLOOR) >= 0, `engines.node ${engines} is below 22.18.0`)
  // `.nvmrc` is what CI (setup-node) and nvm install: every version it can select
  // must also satisfy engines
  assert.ok(atLeast(lowestVersion(nvmrc, '.nvmrc'), enginesFloor) >= 0, `.nvmrc ${nvmrc.trim()} is below ${engines}`)
  assert.equal(lock.packages?.['']?.engines?.node, engines, 'package-lock.json root engines must match package.json')
})

test('the Node running the suite strips TypeScript types natively', () => {
  assert.equal(process.features.typescript, 'strip')
})
