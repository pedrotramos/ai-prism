// Bundles the AppKit boot (server/appkit.js + our Express app) into an ESM Node 22
// artifact. Spike for docs/adr/0001-appkit.md — NOT wired into `npm run bundle` yet.
//
//   node scripts/build-appkit.mjs [outfile]      (default: server-dist/appkit.mjs)
//
// Why not the CJS/node18 build: AppKit is ESM-only (package.json "type": "module",
// exports only `import`) and requires Node >= 22. esbuild must emit ESM here, plus a
// createRequire banner because some bundled CJS packages (@databricks/sdk-experimental,
// pg, express internals) call require() at runtime.
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.resolve(root, process.argv[2] || 'server-dist/appkit.mjs')
const stub = path.join(root, 'scripts/appkit/stubs')

await build({
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

console.log(`[build-appkit] wrote ${path.relative(root, outfile)}`)
