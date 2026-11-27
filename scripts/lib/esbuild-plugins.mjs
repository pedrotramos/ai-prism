// esbuild plugins for the server bundles (scripts/build-appkit.mjs).
import { readFileSync } from 'node:fs'
import path from 'node:path'

// The one pdf.js build the server uses: pdf-parse's default (server/files.ts calls
// pdfParse(buffer) without options).
export const PDF_JS_VERSION = 'v1.10.100'

// pdf-parse (lib/pdf-parse.js) loads pdf.js through a require with a dynamic path,
//   require(`./pdf.js/${options.version}/build/pdf.js`)
// and esbuild, which cannot know the version, bundles ALL FOUR builds (v1.9.426,
// v1.10.88, v1.10.100, v2.0.550: ~3 MB per bundle, and the server is bundled twice).
// This plugin swaps that single require for the fixed path of the default version,
// guarded so a caller asking for another `options.version` gets an error instead of
// silently running v1.10.100 (server/files.ts never passes options). Same code executed,
// same text extraction, minus the three builds that are never used.
// The build FAILS, instead of silently bloating the bundles again or pinning the wrong
// build, if a future pdf-parse changes that line or its DEFAULT_OPTIONS.version.
const DYNAMIC_REQUIRE = 'require(`./pdf.js/${options.version}/build/pdf.js`)'
const DEFAULT_VERSION_RE = /DEFAULT_OPTIONS\s*=\s*\{[^}]*?\bversion:\s*'([^']+)'/

const pinned = (version) =>
  `(options.version === '${version}' ? require('./pdf.js/${version}/build/pdf.js') : ` +
  `(() => { throw new Error('pdf-parse: pdf.js ' + options.version + ' is not bundled (the server pins ${version}, see scripts/lib/esbuild-plugins.mjs)') })())`

export const pdfParsePinPlugin = {
  name: 'pdf-parse-pin-pdfjs',
  setup(build) {
    build.onLoad({ filter: /[\\/]pdf-parse[\\/]lib[\\/]pdf-parse\.js$/ }, (args) => {
      const src = readFileSync(args.path, 'utf8')
      if (src.split(DYNAMIC_REQUIRE).length !== 2) {
        throw new Error(
          `pdf-parse: the dynamic pdf.js require is not as expected in ${args.path}; ` +
            'update scripts/lib/esbuild-plugins.mjs (otherwise the bundle goes back to carrying all 4 pdf.js builds)'
        )
      }
      const def = src.match(DEFAULT_VERSION_RE)?.[1]
      if (def !== PDF_JS_VERSION) {
        throw new Error(
          `pdf-parse: DEFAULT_OPTIONS.version is ${def ?? 'not found'} in ${args.path}, but scripts/lib/esbuild-plugins.mjs pins ${PDF_JS_VERSION}; ` +
            'update PDF_JS_VERSION (the server calls pdfParse(buffer) without options, so it must be pdf-parse\'s default)'
        )
      }
      return {
        contents: src.replace(DYNAMIC_REQUIRE, pinned(PDF_JS_VERSION)),
        loader: 'js',
        resolveDir: path.dirname(args.path),
      }
    })
  },
}
