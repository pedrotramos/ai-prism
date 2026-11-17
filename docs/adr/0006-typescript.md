# ADR 0006: TypeScript by ownership, strict for `.ts` only

- **Status:** Accepted
- **Date:** 2026-11-17
- **Scope:** `tsconfig.json`, `shared/**`, the rule every later conversion follows
- **Tested with:** TypeScript 5.9.3, esbuild 0.24, Vite 6; Node 22.22.3 (local), 22.23.4 (CI), and 22.17.0 / 22.18.0 / 22.23.5 for the floor check

## Context

AI Prism is JavaScript (ESM) end to end. The server is bundled by esbuild into a single CJS
file (`server-dist/index.cjs`), the client by Vite (`client/dist`), and scripts and tests run
on plain Node. A `typecheck` CI job existed, but with `strict: false`, `checkJs: false` and no
`.ts` file it checked nothing: it passed vacuously.

The interfaces where regressions have cost the most are the ones crossing modules: the theme
tokens both deck renderers read, the spreadsheet layout the exporter and the preview must
agree on (a one-sided auto-spacer once shifted exported formulas by a row), the markdown
sanitizer the server and the browser both apply. These live in `shared/**` and are imported by
all three runtimes, so they are where types pay off first and where a toolchain mistake shows
up first.

A big-bang conversion of ~40k lines is not an option while a dozen PRs run in parallel: it
would touch every hot file at once.

## Decision

1. **Convert by ownership.** A file you own and materially edit becomes `.ts` in the same PR.
   `shared/**` is converted now (`deckTheme`, `markdownSafety`, `pythonUdf`, `sheetModel`).
2. **`.js` re-export shims.** `foo.js` keeps one line, `export * from './foo.ts'` (plus
   `export { default } from './foo.ts'` when the module has a default export). Importers keep
   their `.js` specifiers, so a conversion never edits a file its owner does not own.
3. **Strict for `.ts`, nothing new for `.js`.** `tsconfig.json` sets `strict`,
   `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` and
   `allowImportingTsExtensions` (with `noEmit`). `allowJs` keeps the JS in the program and
   `checkJs: false` keeps it unchecked, so no JS file has to change.
4. **Erasable syntax only, so dev needs no build step.** Node 22.18+ runs `.ts` by stripping
   the types (on by default from 22.18; `process.features.typescript === 'strip'`), which is
   why `enum`, `namespace` and parameter properties are banned (`erasableSyntaxOnly`). In
   production nothing changes: esbuild and Vite already compile `.ts`, and the deployed app
   runs the bundle.
5. **`alwaysStrict: false`.** `strict` implies `alwaysStrict`, and esbuild reads it from
   `tsconfig.json`: it then emits a `"use strict"` prologue at the top of the single-file CJS
   bundle, which would switch every bundled CommonJS dependency into strict mode. Our `.ts`
   files are ES modules, which tsc already checks as strict code ("Modules are automatically in
   strict mode"), so turning the option off loses no check. A test pins it
   (`shared/typescript.test.js`).
6. **Tests stay `*.test.js`/`*.test.mjs`** until the runner (`tests/run.mjs`) and CI discover
   `*.test.ts` (planned with the server leaf-module conversion). They import the `.js` shims,
   so they cover the path real importers take.

## Consequences

- `npm run typecheck` now fails on a type error in any `.ts` file; it no longer passes
  vacuously.
- The build output is unchanged in behaviour. Compared with the base build, the non-minified
  server bundle differs only by the file names in module comments and two rewrites made to
  satisfy the strict checks, each with the same runtime result: `hexOr` narrows `c` before
  calling `startsWith`, and `safeLinkDestination` reads the scheme group once.
- `npm run qa` output is the same as on the base (the only varying line is the size of the
  generated `.xlsx`, which jitters by a byte between runs on either tree).
- **Node floor for development is 22.18.0**, verified with real runs: on 22.17.0
  `import('./shared/deckTheme.js')` fails with `ERR_UNKNOWN_FILE_EXTENSION` and
  `process.features.typescript` is `false`; on 22.18.0 it imports and reports `'strip'`, with
  no warning. `package.json` `engines` (and the lockfile's root entry) say `>=22.18.0`.
  `.nvmrc` says `22.23`, not `22.18`: every CI job installs Node from it, and the E2E job's
  Lighthouse needs `>=22.19`; 22.23 is the line CI already ran (22.23.4). A test in
  `shared/typescript.test.js` fails if `.nvmrc`, `engines` or the lockfile drift below the floor.
- **The deployed app does not need type stripping.** `app.yaml` runs `node server-dist/index.cjs`,
  which esbuild compiled; it contains no `.ts` import. The Databricks Apps environment documents
  only "Node.js version 22", so its minor version may be below 22.18: that is fine for the
  bundle, and `npm install` there only warns (`EBADENGINE`, verified under 22.17.0 with this
  repository's `.npmrc`; `engine-strict` is off), so the raised `engines` floor cannot block a
  deploy.
- Every `.ts` file adds a shim file. They disappear when the last importer of a module is
  itself converted and imports `./foo.ts` directly.

## Alternatives considered

- **JSDoc types with `checkJs: true`.** No file renames, but every JS file would be checked at
  once (hundreds of errors in files nobody owns this wave) or per-file `// @ts-check`
  pragmas that are easy to drop. Type syntax in JSDoc is also harder to read and review.
- **Big-bang conversion.** Every hot file in one PR; conflicts with all parallel work.
- **`tsc` emit, `ts-node` or `tsx` for dev.** An extra build step or runtime dependency for
  what Node 22.18+ does natively; the production path already compiles TypeScript.
- **Editing importers to `.ts` specifiers instead of shims.** Each conversion would touch files
  owned by other tasks.

## Rollback

Per module: move `foo.ts` back to `foo.js` and delete the type annotations (erasable syntax
means removing them is the whole change), then drop the shim. Toolchain: revert
`tsconfig.json`; nothing else depends on it at runtime.
