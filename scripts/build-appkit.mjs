// Builds the production server artifacts (`npm run build:server`, docs/adr/0001-appkit.md):
//
//   server-dist/index.cjs   launcher (server/boot.cjs, copied as is): AppKit unless APPKIT_BOOT=0
//   server-dist/appkit.mjs  AppKit boot (server/appkit.js + our Express app), ESM, Node 22
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
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stub = path.join(root, 'scripts/appkit/stubs')

// The legacy server/index.js and server/db/migrate.js read import.meta.url only when
// __dirname is undefined (ESM dev); in the CJS bundle __dirname is server-dist/.
const quietImportMeta = { 'empty-import-meta': 'silent' }

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
    logOverride: quietImportMeta,
    external: ['pg-native', 'pg-cloudflare'],
  })
}

function buildAppkit(outfile) {
  return build({
    entryPoints: [path.join(root, 'server/appkit.js')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    logLevel: 'warning',
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

/** Writes index.cjs, appkit.mjs and legacy.cjs into `outdir`; returns their sizes in bytes. */
export async function buildServer({ outdir = path.join(root, 'server-dist') } = {}) {
  mkdirSync(outdir, { recursive: true })
  await Promise.all([buildLegacy(path.join(outdir, 'legacy.cjs')), buildAppkit(path.join(outdir, 'appkit.mjs'))])
  copyFileSync(path.join(root, 'server/boot.cjs'), path.join(outdir, 'index.cjs'))
  const sizes = {}
  for (const f of ['index.cjs', 'appkit.mjs', 'legacy.cjs']) sizes[f] = statSync(path.join(outdir, f)).size
  return sizes
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outdir = path.resolve(root, process.argv[2] || 'server-dist')
  const sizes = await buildServer({ outdir })
  const mb = (n) => `${(n / 1e6).toFixed(2)} MB`
  const total = Object.values(sizes).reduce((a, b) => a + b, 0)
  for (const [f, n] of Object.entries(sizes)) console.log(`[build-server] ${path.relative(root, path.join(outdir, f))} ${n < 1e6 ? `${n} B` : mb(n)}`)
  console.log(`[build-server] total ${mb(total)}`)
}
