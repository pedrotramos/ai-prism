### Performance

- **Server bundles carry one pdf.js build instead of four**: `pdf-parse` picks its pdf.js build with a dynamic `require`, so esbuild embedded all four (v1.9.426, v1.10.88, v1.10.100, v2.0.550) in both `server-dist/legacy.cjs` and the AppKit server chunk. A new esbuild plugin (`scripts/lib/esbuild-plugins.mjs`, used by `scripts/build-appkit.mjs`) pins the default v1.10.100 path, which is the only one the app uses, so text extraction is unchanged. `legacy.cjs` goes from 9.03 MB to 5.97 MB (further from the 10 MB per-file limit of Databricks Apps) and the whole `server-dist` from 21.72 MB to 15.60 MB. The build fails loudly if a future `pdf-parse` changes that line.

### Fixed

- **Small PDFs read correctly**: `server/files.ts` now hands `pdf-parse` a copy of the bytes (`new Uint8Array(buffer)`). pdf.js 1.10.100 reads `bytes.buffer` without looking at `byteOffset`, so a small file whose `Buffer` is a slice of Node's internal pool could be parsed from the wrong place and answer "bad XRef entry".
