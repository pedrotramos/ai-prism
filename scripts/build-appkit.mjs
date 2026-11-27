// Builds the production server artifacts (`npm run build:server`, docs/adr/0001-appkit.md):
//
//   server-dist/index.cjs   launcher (server/boot.cjs, copied as is): AppKit unless APPKIT_BOOT=0
//   server-dist/appkit.mjs  AppKit boot (server/appkit.js), ESM, Node 22, plus its split
//                           chunks server-dist/appkit-*.mjs (our Express app is one of them)
//   server-dist/legacy.cjs  legacy Express listener (server/index.js), CJS — the rollback path
//
//   node scripts/build-appkit.mjs [outdir]       (default: server-dist)
//
// Why two bundles: AppKit is ESM-only (package.json "type": "module", exports only
// `import`) and requires Node >= 22, so its bundle is ESM with a createRequire banner
// (some bundled CJS packages — @databricks/sdk-experimental, pg, express internals —
// call require() at runtime). The legacy bundle keeps the exact build it always had,
// so the rollback does not depend on the AppKit bundling (stubs, banner, ESM).
// The deploy ships no node_modules: everything the server needs is in these files.
//
// Databricks Apps rejects a deploy when ANY app file exceeds 10 MB, so the AppKit side
// is split (esbuild `splitting`): server/appkit.js loads index.js through a dynamic
// import(), which becomes its own chunk. Chunks sit flat in server-dist/ (not in a
// subfolder) because index.js and db/migrate.js resolve client/dist and the
// migrations relative to their own file. tests/appkit-boot.test.mjs gates every file.
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { copyServerAssets } from './copy-server-assets.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stub = path.join(root, 'scripts/appkit/stubs')

// The legacy server/index.js and server/db/migrate.js read import.meta.url only when
// __dirname is undefined (ESM dev); in the CJS bundle __dirname is server-dist/.
const quietImportMeta = { 'empty-import-meta': 'silent' }

// server/version.js: the deploy ships server-dist/ without package.json, so the
// app version is stamped into both bundles.
const VERSION_DEFINE = {
  __AI_PRISM_VERSION__: JSON.stringify(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version),
}

function buildLegacy(outfile) {
  return build({
    entryPoints: [path.join(root, 'server/index.js')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    minify: true,
    logLevel: 'warning',
    define: VERSION_DEFINE,
    logOverride: quietImportMeta,
    external: ['pg-native', 'pg-cloudflare'],
  })
}

function buildAppkit(outdir) {
  return build({
    entryPoints: { appkit: path.join(root, 'server/appkit.js') },
    outdir,
    outExtension: { '.js': '.mjs' },
    splitting: true,
    chunkNames: 'appkit-[name]-[hash]',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    logLevel: 'warning',
    define: VERSION_DEFINE,
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    // Dev/codegen-only packages that AppKit imports statically. Replaced by throwing
    // stubs so the production bundle links without node_modules (deploy ships none).
    alias: {
      vite: path.join(stub, 'vite.mjs'),
      '@ast-grep/napi': path.join(stub, 'native-dev.mjs'),
      '@babel/core': path.join(stub, 'native-dev.mjs'),
      fsevents: path.join(stub, 'native-dev.mjs'),
    },
    // Optional native accelerators: pg/ws probe for them inside try/catch at runtime.
    external: ['pg-native', 'bufferutil', 'utf-8-validate', '@opentelemetry/winston-transport'],
  })
}

const isChunk = (f) => /^appkit-.+\.mjs$/.test(f)

/** Writes index.cjs, legacy.cjs, appkit.mjs and its chunks into `outdir`; returns { file: bytes }. */
export async function buildServer({ outdir = path.join(root, 'server-dist') } = {}) {
  mkdirSync(outdir, { recursive: true })
  // chunk names are content-hashed: drop the previous build's, or they pile up
  for (const f of readdirSync(outdir)) if (isChunk(f)) rmSync(path.join(outdir, f))
  await Promise.all([buildLegacy(path.join(outdir, 'legacy.cjs')), buildAppkit(outdir)])
  copyFileSync(path.join(root, 'server/boot.cjs'), path.join(outdir, 'index.cjs'))
  // files the server reads at runtime (chart rasteriser: resvg wasm + Inter), flat next to the bundle
  copyServerAssets(outdir)
  const sizes = {}
  for (const f of readdirSync(outdir).sort()) sizes[f] = statSync(path.join(outdir, f)).size
  return sizes
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outdir = path.resolve(root, process.argv[2] || 'server-dist')
  const sizes = await buildServer({ outdir })
  const mb = (n) => `${(n / 1e6).toFixed(2)} MB`
  const total = Object.values(sizes).reduce((a, b) => a + b, 0)
  const chunks = Object.keys(sizes).filter(isChunk)
  for (const [f, n] of Object.entries(sizes)) if (!isChunk(f)) console.log(`[build-server] ${path.relative(root, path.join(outdir, f))} ${n < 1e6 ? `${n} B` : mb(n)}`)
  const largest = Object.entries(sizes).sort((a, b) => b[1] - a[1])[0]
  console.log(`[build-server] ${chunks.length} appkit-*.mjs chunks, ${mb(chunks.reduce((a, f) => a + sizes[f], 0))}`)
  console.log(`[build-server] largest file ${largest[0]} ${mb(largest[1])} (Apps limit: 10 MB per file); total ${mb(total)}`)
}
