<!--
PENDING TRANSLATIONS: fold into the final docs layout, then delete this file.
Owner: whoever converts CONTRIBUTING.md to the EN-canonical layout (docs i18n
tasks W1-10 / W2-10). Source of truth today: the pt-BR text added by W1-11 in
CONTRIBUTING.md (the "TypeScript" section and its entry in the table of
contents, the Node.js 22.18+ prerequisite, and the `npm run typecheck` row of
the "Testes e QA" table).
-->

# W1-11 docs: English and Spanish versions (pending fold-in)

This file carries the **English (canonical)** and **Spanish** text of the parts W1-11
added in Portuguese to `CONTRIBUTING.md`, which is still pt-BR only. When the trilingual
layout lands, paste each part into its file and remove this one.

Contents:

- [English](#english)
  - [EN: CONTRIBUTING.md, prerequisites (Node.js)](#en-contributingmd-prerequisites-nodejs)
  - [EN: CONTRIBUTING.md, TypeScript](#en-contributingmd-typescript)
  - [EN: CONTRIBUTING.md, Tests and QA (typecheck row)](#en-contributingmd-tests-and-qa-typecheck-row)
- [Español](#español)
  - [ES: CONTRIBUTING.md, requisitos previos (Node.js)](#es-contributingmd-requisitos-previos-nodejs)
  - [ES: CONTRIBUTING.md, TypeScript](#es-contributingmd-typescript)
  - [ES: CONTRIBUTING.md, Pruebas y QA (fila de typecheck)](#es-contributingmd-pruebas-y-qa-fila-de-typecheck)

---

## English

### EN: CONTRIBUTING.md, prerequisites (Node.js)

- **Node.js 22.18+** (see [`.nvmrc`](.nvmrc); `nvm use` picks the right version). From 22.18
  on, Node runs `.ts` files directly by stripping their types; on an older 22 the tests and
  the dev server fail when they import `shared/*.ts`.

### EN: CONTRIBUTING.md, TypeScript

Add `- [TypeScript](#typescript)` to the table of contents, after "Server module map".

## TypeScript

The code moves to TypeScript **by ownership**: a file you own and materially change becomes
`.ts` in the same PR. The decision and its reasons are in
[ADR 0006](docs/adr/0006-typescript.md). `shared/**` is already TypeScript.

- **Source in `.ts`, shim in `.js`.** `foo.js` becomes `foo.ts`, and `foo.js` keeps a single
  line, `export * from './foo.ts'`. Code that imports `./foo.js` stays as it is: do not edit
  the importers. A module with an `export default` also needs
  `export { default } from './foo.ts'` in the shim.
- **`strict` applies to `.ts` only.** [`tsconfig.json`](tsconfig.json) turns on `strict`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` and
  `allowImportingTsExtensions`. The remaining JavaScript is not checked (`checkJs: false`).
- **Erasable syntax only.** No `enum`, `namespace` or parameter properties: in dev, Node runs
  `.ts` by removing the types and nothing else. Use literal unions (`'a' | 'b'`) or
  `as const` objects.
- **Import with the real extension.** Between `.ts` files, use `./bar.ts`; for a module that
  is still JS, `./baz.js`. Types come in with `import type { … }` (required by
  `verbatimModuleSyntax`).
- **An index can be `undefined`.** With `noUncheckedIndexedAccess`, `arr[i]` and `obj[key]`
  have type `T | undefined`. Handle the case; use `!` only where the invariant is guaranteed
  right there (for example `i < arr.length`), and do not change runtime behaviour while
  converting.
- **Tests stay `*.test.js`/`*.test.mjs`** until the runner discovers `*.test.ts`; they import
  the `.js` shim, so they exercise the same path as the importers.
- **How it runs:** in dev and in tests, Node ≥ 22.18 strips the types; in the build, esbuild
  (`server-dist/index.cjs`) and Vite (`client/dist`) compile the `.ts`. No `.js` is generated
  in the repository.
- **Before the PR:** `npm run typecheck` (`tsc --noEmit`) must exit with 0 errors, as well as
  `npm test`, `npm run qa` and `npm run bundle`.

### EN: CONTRIBUTING.md, Tests and QA (typecheck row)

| Command | What it covers | Needs |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit`: the `.ts` files under `strict` (see [TypeScript](#typescript)) | nothing |

---

## Español

### ES: CONTRIBUTING.md, requisitos previos (Node.js)

- **Node.js 22.18+** (consulta [`.nvmrc`](.nvmrc); `nvm use` elige la versión correcta). Desde
  la 22.18, Node ejecuta archivos `.ts` directamente quitando los tipos; con una 22 anterior,
  las pruebas y el servidor de desarrollo fallan al importar `shared/*.ts`.

### ES: CONTRIBUTING.md, TypeScript

Agrega `- [TypeScript](#typescript)` al índice, después de "Mapa de módulos del servidor".

## TypeScript

El código pasa a TypeScript **por responsable**: el archivo que te pertenece y que cambias de
forma relevante se convierte en `.ts` en el mismo PR. La decisión y sus motivos están en el
[ADR 0006](docs/adr/0006-typescript.md). `shared/**` ya está en TypeScript.

- **Fuente en `.ts`, shim en `.js`.** `foo.js` pasa a ser `foo.ts`, y `foo.js` conserva una sola
  línea, `export * from './foo.ts'`. El código que importa `./foo.js` no cambia: no edites a
  quienes lo importan. Un módulo con `export default` también necesita
  `export { default } from './foo.ts'` en el shim.
- **`strict` se aplica solo a `.ts`.** [`tsconfig.json`](tsconfig.json) activa `strict`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` y
  `allowImportingTsExtensions`. El JavaScript restante no se verifica (`checkJs: false`).
- **Solo sintaxis borrable.** Nada de `enum`, `namespace` ni parameter properties: en
  desarrollo, Node ejecuta el `.ts` quitando los tipos y nada más. Usa uniones de literales
  (`'a' | 'b'`) u objetos `as const`.
- **Importa con la extensión real.** Entre archivos `.ts`, usa `./bar.ts`; para un módulo que
  sigue en JS, `./baz.js`. Los tipos entran con `import type { … }` (lo exige
  `verbatimModuleSyntax`).
- **Un índice puede ser `undefined`.** Con `noUncheckedIndexedAccess`, `arr[i]` y `obj[clave]`
  tienen tipo `T | undefined`. Trata el caso; usa `!` solo donde el invariante esté garantizado
  en ese punto (por ejemplo, `i < arr.length`) y no cambies el comportamiento en tiempo de
  ejecución al convertir.
- **Las pruebas siguen siendo `*.test.js`/`*.test.mjs`** hasta que el runner descubra
  `*.test.ts`; importan el shim `.js`, así que recorren el mismo camino que quienes importan.
- **Cómo se ejecuta:** en desarrollo y en las pruebas, Node ≥ 22.18 quita los tipos; en el
  build, esbuild (`server-dist/index.cjs`) y Vite (`client/dist`) compilan el `.ts`. No se
  genera ningún `.js` en el repositorio.
- **Antes del PR:** `npm run typecheck` (`tsc --noEmit`) debe terminar con 0 errores, además de
  `npm test`, `npm run qa` y `npm run bundle`.

### ES: CONTRIBUTING.md, Pruebas y QA (fila de typecheck)

| Comando | Qué cubre | Requiere |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit`: los archivos `.ts` con `strict` (consulta [TypeScript](#typescript)) | nada |
