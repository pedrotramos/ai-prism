// esbuild plugins for the server bundles (scripts/build-appkit.mjs).
import { readFileSync } from 'node:fs'
import path from 'node:path'

// The one pdf.js build the server uses: pdf-parse's default (server/files.ts calls
// pdfParse(buffer) without options).
export const PDF_JS_VERSION = 'v1.10.100'

// pdf-parse (lib/pdf-parse.js) loads pdf.js through a require with a dynamic path,
//   require(`./pdf.js/${options.version}/build/pdf.js`)
// and esbuild, which cannot know the version, bundles ALL FOUR builds (v1.9.426,
// v1.10.88, v1.10.100, v2.0.550: ~4 MB per bundle, and the server is bundled twice).
// This plugin swaps that single require for the fixed path of the default version:
// same code executed, same text extraction, minus the three builds that are never used.
// If a future pdf-parse changes that line the build FAILS, instead of silently bloating
// the bundles again.
const DYNAMIC_REQUIRE = 'require(`./pdf.js/${options.version}/build/pdf.js`)'

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
      return {
        contents: src.replace(DYNAMIC_REQUIRE, `require('./pdf.js/${PDF_JS_VERSION}/build/pdf.js')`),
        loader: 'js',
        resolveDir: path.dirname(args.path),
      }
    })
  },
}
