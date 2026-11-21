# Contributing to AI Prism

**English** · [Português (Brasil)](docs/pt-BR/CONTRIBUTING.md) · [Español](docs/es/CONTRIBUTING.md)

Thanks for your interest in contributing! This guide covers how to set up the environment,
the development flow, and the conventions we keep in the repository.

> AI Prism is an **open-source solution accelerator**, not an official Databricks product.
> Each person deploys their own copy in their own workspace. See the [README](README.md) and the
> [deployment onboarding](docs/onboarding-deployment.md).

## Contents

- [Code of conduct](#code-of-conduct)
- [Prerequisites](#prerequisites)
- [Setting up the environment](#setting-up-the-environment)
- [Development flow](#development-flow)
- [Server module map](#server-module-map)
- [TypeScript](#typescript)
- [Commit conventions](#commit-conventions)
- [Tests and QA](#tests-and-qa)
- [Opening a pull request](#opening-a-pull-request)
- [Reporting bugs and suggesting features](#reporting-bugs-and-suggesting-features)
- [Security](#security)

## Code of conduct

This project adopts the [Contributor Covenant](CODE_OF_CONDUCT.md). By taking part,
you agree to keep interactions respectful and welcoming.

## Prerequisites

- **Node.js 22.18+** for development (`engines` in `package.json`). From 22.18 on, Node runs
  `.ts` files directly by stripping their types; on an older 22 the tests, QA and the dev
  server fail when they import `shared/*.ts` (`ERR_UNKNOWN_FILE_EXTENSION`).
  [`.nvmrc`](.nvmrc) pins the line CI uses (22.23; `nvm use` picks it). The deployed app runs
  the compiled bundle (`server-dist/index.cjs`), which contains no `.ts`, so it does not depend
  on this; and npm only warns (`EBADENGINE`) if the Databricks Apps runtime is older, without
  blocking the install. `shared/typescript.test.js` fails if `.nvmrc` or `engines` drop below
  22.18.
- **PostgreSQL 17 + pgvector** (`brew install postgresql@17 pgvector`); Docker is not required.
- **Databricks CLI ≥ 1.8** for deploying and for running the app against a real workspace.
- Access to a Databricks workspace with AI Gateway, Serverless SQL and Lakebase enabled,
  if you want to exercise the full flow (the offline QA does not need a workspace).

## Setting up the environment

```bash
nvm use                 # Node from the version in .nvmrc
npm install
cp .env.local.example .env.local
npm run local:up
npm run dev:local
# in another terminal: npm run local:seed
```

Vite proxies `/api` to `http://localhost:8000`. Outside the Databricks App runtime, local mode
uses native Postgres on `127.0.0.1:55432` and does not require Lakebase tokens.
Use [`.env.example`](.env.example) + `npm run dev` only for hybrid development against real
workspace resources.

## Development flow

1. Create a branch from `main` with a descriptive name and a type prefix:
   `feat/…`, `fix/…`, `docs/…`, `chore/…`, `perf/…`.
2. Make your changes, keeping the style of the surrounding code (comments, names, language).
3. Run the [QA](#tests-and-qa) and validate locally what is affected.
4. Make small, cohesive commits following the [commit conventions](#commit-conventions).
5. Open a [pull request](#opening-a-pull-request) against `main`.

The app runs **pre-built** artifacts (`client/dist` + `server-dist/index.cjs`).

**Do not commit `client/dist` or `server-dist` in feature PRs.** Their file names carry a
content hash, so any two client PRs open at the same time would always conflict there.
These artifacts are rebuilt and committed **only in release PRs**: branch `release/*` or
label `release`. Only those PRs get the CI check that they match the code. On every other
PR, CI runs `npm run bundle` (the build must pass) and notes that the artifacts are rebuilt
at release. If the build changes those files on your branch, discard the changes:
`git checkout -- client/dist server-dist`.

**Before any deploy, run `npm run bundle`.** `bundle deploy` and `apps deploy` publish
whatever is in `client/dist` and `server-dist`. Today `deploy.sh` and `deploy.ps1` do
**not** run that build on their own.

## Server module map

The Express server (`server/`) is split by responsibility. `server/index.js` only assembles the
app: it installs the middleware, registers the route modules in the order of the `routes` list,
serves the static frontend, and installs the final error handler.

| Module | What it contains |
| --- | --- |
| `server/index.js` | Creates the `app`, `installMiddleware(app)`, the `routes` list, the static frontend, the final error handler, and the `listen` (skipped with `APPKIT_BOOT=1`). |
| `server/middleware/index.ts` | `installMiddleware(app)` in this order: request id, security headers, `security`, CSRF guard on `/api`, numeric validation of `:id`/`:messageId`, `express.json`. It also exports `upload` (multer) and `fixFilename`. |
| `server/middleware/auth.ts` | `auth`: proxy identity, email-to-token binding, and the cost meter scope. |
| `server/middleware/requireAdmin.ts` | `requireAdmin`: 403 for anyone who is not an admin. |
| `server/middleware/ensureReady.ts` | `ensureReady`: creates the schema once per process (a promise latch, so simultaneous requests wait for the same DDL) and tries the SP grants on every request. |
| `server/middleware/{requestId,security}.js` | Extension points that, for now, only pass the request along. |
| `server/sse.ts` | `openSse(res)` and `makeSend(res)`: headers and SSE event writing for the turn routes. |
| `server/turn.ts` | The three routes that generate a response (`POST /api/chat`, `/api/sessions/:id/continue`, `/api/sessions/:id/messages/:messageId/regenerate`) and what they share: history window, tools, `runAssistantTurn`, notices, deck by outline, and artifact persistence. |
| `server/models.ts` | Cache of the user's model catalog, `getUserModels`, `resolveModelId`, `invalidateUserModels`. |
| `server/lib/tweak.ts` | Utilities for the AI "tweaks" (deck, spreadsheet, document). |
| `server/lib/embeddings.ts` | Session and message embeddings, and the history backfill. |
| `server/routes/admins.js` | `/api/me` and the app administrators. |
| `server/routes/models.js` | Chat and image models, tool policy, cost summary, and the admin model catalog. |
| `server/routes/sessions.js` | Sessions: list, search, keep-alive, messages, compaction, edit, and delete. |
| `server/routes/toolsSearch.js` | Search for attachable tools (UC Functions, Genie, Vector Search, external MCP). |
| `server/routes/mcpConnections.js` | The user's MCP connections. |
| `server/routes/mcpCatalog.js` | The admin's MCP catalog. |
| `server/routes/skills.js` | Authored skills. |
| `server/routes/deckTemplates.js` | Design systems (presentation templates). |
| `server/routes/decks.js` | Deck Studio: read, edit, tweak, and `.pptx` export. |
| `server/routes/images.js` | Bytes of the generated images. |
| `server/routes/spreadsheets.js` | Spreadsheet studio. |
| `server/routes/documents.js` | Document studio. |
| `server/routes/messages.js` | Active variant, prompt editing, and `deck-questions` answers. |
| `server/routes/static.js` | `client/dist` and the SPA fallback; registered after all the API routes. |

Rules:

- **New endpoint** = a new file `server/routes/<name>.js` that exports `register(app)` + **one
  line** at the end of the `routes` list in `server/index.js`.
- Routes are registered **directly on the `app`**, not on an `express.Router`: the
  `app.param(['id', 'messageId'])` does not apply inside a router, and the routes would lose the
  numeric validation of the ids.
- The CSRF guard goes **before** any body parser. Do not change the order in `installMiddleware`.
- Turn post-processing (blocks, deck, cost, title) applies to **all three** routes in
  `server/turn.ts`; the SSE stream always comes from `server/sse.ts`.
- `server/routes/routeTable.test.js` pins the route table (method, path, and middleware chain).
  When you add or change a route, update the expected list in the same PR.

## TypeScript

The code moves to TypeScript **by ownership**: a file you own and materially change becomes
`.ts` in the same PR. The decision and its reasons are in
[ADR 0006](docs/adr/0006-typescript.md). `shared/**` is already TypeScript.

- **Conversion recipe (server modules).** Follow these steps in order:
  1. `git mv server/foo.js server/foo.ts`, and its test: `git mv server/foo.test.js server/foo.test.ts`.
  2. Type it with `tsc` as the judge: `npm run typecheck`. Give exports explicit parameter and
     return types, declare the shapes a module passes around as `interface`/`type` and keep them
     module-private: `export` a type only when another module actually imports it (a
     conversion must not widen the module's API). Never change a signature, an exported name or
     a return shape (it is a conversion, not a refactor).
  3. No `any` without a one-line comment saying why; no `// @ts-ignore`; `@ts-expect-error`
     only with a reason.
  4. Update every importer to the real extension (`./foo.ts`, `../foo.ts`, and dynamic
     `import('./foo.ts')`). Keep a one-line `foo.js` shim (`export * from './foo.ts'`, plus
     `export { default } from './foo.ts'` for a default export) only when some importer cannot
     import `.ts`. `shared/**` keeps its shims.
  5. Check the three consumers: `npm run typecheck`, `node tests/run.mjs --list` (the
     `foo.test.ts` is listed) and `npm run bundle` (esbuild compiles the `.ts` into
     `server-dist`; do not commit `client/dist` or `server-dist` in a feature PR).
  6. A module without a test of its own gets a minimal `foo.test.ts` in the same PR.
- **Conversion recipe (client modules: `client/src/lib`, `hooks`, root modules, then components).**
  Same rules as the server recipe (steps 2 to 4), plus what is specific to the browser code:
  1. `git mv client/src/lib/foo.js client/src/lib/foo.ts` (and `foo.test.js` to `foo.test.ts`).
     A file that contains JSX is `.jsx` to `.tsx`; a plain module or a hook without JSX stays `.ts`.
  2. **React and Vite types are already installed.** `@types/react` and `@types/react-dom`
     (React 18) are devDependencies, and `tsconfig.json` lists `vite/client` next to `node` in
     `types`, so `import.meta.env`, `?raw` and `?url` imports and `*.css` imports type-check. One
     `tsconfig.json` checks server, shared and client together; the client files use the DOM
     `lib`, which is global and harmless for the server. Do not drop `node` or `strict` to quiet
     an error.
  3. **Props.** Declare `interface FooProps { … }` above the component, keep it module-private
     (`export` only if another module imports it) and write `function Foo({ a, b }: FooProps)`.
     Do not use `React.FC`; do not make a prop optional that every caller passes. Children are
     `children?: ReactNode` (`import type { ReactNode } from 'react'`).
  4. **Events and refs.** Use the React types: `React.ChangeEvent<HTMLInputElement>`,
     `React.KeyboardEvent<HTMLElement>`, `React.MouseEvent<HTMLButtonElement>`;
     `useRef<HTMLDivElement>(null)` for a DOM ref and `useState<Item[]>([])` whenever the
     initial value alone would infer `never[]` or `null`. Native listeners (`addEventListener`)
     take the DOM types (`KeyboardEvent`, `FocusEvent`), not the React ones.
  5. **JSON from the server.** `r.json()` is `any`; the helpers in `client/src/api.ts` return
     `Promise<T>` with `T = unknown` by default. Give `T` the shape the caller reads
     (`getJSON<Session[]>(…)`) instead of casting later.
  6. **Locale catalogs.** `en/<domain>.ts` is the source of the keys. `pt/` and `es/` are typed
     `Record<keyof typeof en, string>`, so a missing or extra key is a type error before the
     parity test even runs. The runtime object does not change.
  7. **Tests.** A `*.test.ts` imports its module with the real extension (`./foo.ts`) and runs
     natively under `node --test` (Node strips the types). Node cannot load `.tsx`/`.jsx`, so a
     test of a component bundles it first with esbuild (see `client/src/lib/i18n.test.ts`).
     Test doubles for browser objects (`fetch`, `FileReader`) are cast once, with a comment:
     `as unknown as typeof fetch`.
  8. **Check the consumers:** `npm run typecheck`, `node tests/run.mjs --list` (the renamed
     test is listed), `npm run build:client` (Vite compiles the `.ts`/`.tsx`), and the
     `client/e2e` smoke specs. Scripts that scan source files by extension (such as
     `client/src/a11yBudget.test.ts`) must match both `.jsx` and `.tsx`.
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
- **Tests are `*.test.ts`.** `tests/run.mjs` discovers `*.test.js`, `*.test.mjs`, `*.test.ts` and
  `*.test.mts`; CI runs them in the unit job, and `tests/runner.test.mjs` fails if a tracked
  `*.test.*` file is not in the discovered list (a test that never runs passes forever).
  Test files are type-checked like any other `.ts`. Existing `.test.js`/`.test.mjs` files stay
  as they are until their module is converted.
- **How it runs:** in dev and in tests, Node ≥ 22.18 strips the types; in the build, esbuild
  (`server-dist/index.cjs`) and Vite (`client/dist`) compile the `.ts`. No `.js` is generated
  in the repository.
- **Before the PR:** `npm run typecheck` (`tsc --noEmit`) must exit with 0 errors, as well as
  `npm test`, `npm run qa` and `npm run bundle`.

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/). The scope is optional
but recommended; the description can be in Portuguese.

<!-- i18n: code-translated en=c3a8a92f8237 -->
```
<type>(<scope>): <description in the imperative mood>
```

Types used in the project: `feat`, `fix`, `docs`, `chore`, `perf`, `refactor`, `test`.

Real examples from the history:

```
feat(deck): Fase 3 — tweaks de IA melhores (região, prévia, recompor, histórico)
fix(blocks): documento com bloco de código vazava JSON cru no chat
perf: fluidez de streaming + TTFT
```

Changes that matter to people who use or deploy the app get a **changelog fragment**:
a file `changelog.d/<task-or-branch>.md` with the same sections as
[CHANGELOG.md](CHANGELOG.md) (`### Added`, `### Fixed`…). Do not edit `CHANGELOG.md`
directly. With several PRs open, all editing the same `## [Unreleased]` lines, every
rebase turned into a conflict. Fragments are folded in at release time; see
[`changelog.d/README.md`](changelog.d/README.md).

## Tests and QA

Everything below runs **offline, without a workspace**. CI runs the same checks
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

| Command | What it covers | Needs |
|---|---|---|
| `npm test` | Every `*.test.js`/`*.test.mjs`/`*.test.ts`/`*.test.mts` under `server`, `shared`, `scripts`, `tests` and `client/src`: unit tests, two-user isolation, HTTP routes, the fake gateway | A local Postgres with pgvector for isolation and routes (`npm run local:up`). Without it those suites are skipped and the summary says so |
| `npm run qa` | Deterministic deck, spreadsheet and Python UDF checks | nothing |
| `npm run typecheck` | `tsc --noEmit`: the `.ts` files under `strict` (see [TypeScript](#typescript)) | nothing |
| `npm run smoke` | A real user's path against a URL (see below) | a running server |
| `npm run test:e2e` | Browser flows + the accessibility regression bar | Node ≥ 22.19 (a Lighthouse requirement), `npm run build:client` and `npx playwright install chromium` |

### Unit and route tests

```bash
npm run local:up        # Postgres 17 + pgvector on 127.0.0.1:55432 (once)
npm test                # discovers and runs everything; prints files, totals and skips
node tests/run.mjs --list                                          # only list the files
node tests/run.mjs --fail-on-skip --expect server/isolation.test.js=19 --expect server/rls.test.js=16   # same as CI: fails on any skip except '[infra-skip:' ones (warnings)
```

Always use `npm test` (or `node tests/run.mjs`), not a bare `node --test`. With no file
list, Node falls back to its default glob, which also matches `scripts/load-test.mjs`
(`*-test.mjs`).

The route tests (`tests/routes.test.mjs`) start the real `app` on an ephemeral port
(`APPKIT_BOOT=1`, `LOCAL_DEV_MODE=1`) with the fake gateway and two `*.test.invalid`
users. The rows they create are deleted at the end.

### Fake AI Gateway

`scripts/fake-gateway.mjs` answers in the shapes `server/llm.ts` reads:
- streaming: `delta.content`, `reasoning_content`, indexed `tool_calls`, `usage` and `[DONE]`;
- non-streaming: `message.content`;
- 1024-dimension embeddings and the endpoint listing.

Behaviour follows the last user message:
- asking for a document yields a `document` block;
- `[fake:tool]` yields a tool call;
- `[fake:error]` yields an HTTP 503.

```bash
npm run fake-gateway -- --port 8787
DATABRICKS_HOST=http://127.0.0.1:8787 npm run dev:server:local   # the whole app without a workspace
```

The shapes are pinned to `tests/fixtures/gateway-shapes.live.json`, a recording of a real
gateway that keeps only key paths and types. To re-record it when the gateway changes
(6 small calls to cheap models; the token is never printed):

```bash
DATABRICKS_HOST=https://<workspace> \
DATABRICKS_TOKEN="$(databricks auth token -p <PROFILE> -o json | jq -r .access_token)" \
node tests/live/record-gateway-shapes.mjs
```

### Local smoke

The same script as post-deploy, against the local server and the fake:

```bash
npm run fake-gateway -- --port 8787 &
LOCAL_DEV_MODE=1 DATABRICKS_HOST=http://127.0.0.1:8787 PGHOST=127.0.0.1 PGPORT=55432 \
  PGUSER=ai_prism PGPASSWORD=ai_prism PGDATABASE=ai_prism PGSSLMODE=disable node server/index.js &
APP_URL=http://127.0.0.1:8000 SMOKE_SKIP_ARTIFACT=0 npm run smoke
```

### E2E and accessibility (`client/e2e/`)

The browser runs the **built client** (`client/dist`) behind
`client/e2e/fixture-server.mjs`. That server answers `/api/*` with recorded fixtures
(`client/e2e/fixtures/api.json`), so no backend, database or gateway is needed.

```bash
npm run build:client
npx playwright install chromium
npm run test:e2e                         # flows + accessibility regression bar
E2E_STRICT=1 npm run test:e2e            # also fail on any serious/critical violation
```

- `flows.spec.mjs` covers:
  - a streamed answer (the `fetch` shim feeds `/api/chat` with real SSE events);
  - an HTTP 500 on send;
  - Settings and the Slides Studio;
  - history on mobile;
  - no request without a fixture.
- `a11y.spec.mjs` runs axe on welcome, chat, Settings and the Slides Studio, in dark and
  light themes, at 1440 and 390 px (16 runs). It also measures:
  - touch targets under 24 px;
  - interactive elements without a name;
  - Lighthouse accessibility on welcome, chat and history;
  - the one-off styles in `client/src` (`token-audit.mjs`).
- **Regression bar:** `client/e2e/baseline.json` holds the numbers per operating system.
  The job fails when any count rises or a Lighthouse score drops. When you improve one,
  record the new bar with `E2E_UPDATE_BASELINE=1 npm run test:e2e` and commit
  `baseline.json`.
- Report: `client/e2e/.output/a11y-report.json` and `client/e2e/.output/report/`
  (the `e2e-report` artifact in CI).

When a screen starts calling a new endpoint, the fixture-coverage test fails.
Re-record the fixtures against a local server with seeded data:

```bash
npm run local:up
npm run fake-gateway -- --port 8787 &
# local server with DATABRICKS_HOST=http://127.0.0.1:8787 and
# DATABRICKS_USER_EMAIL=e2e-user@example.com APP_OWNER_EMAIL=e2e-user@example.com
DATABRICKS_USER_EMAIL=e2e-user@example.com npm run local:seed
IDS=$(node client/e2e/record/seed-rich.mjs)
APP_URL=http://127.0.0.1:8000 IDS="$IDS" node client/e2e/record/record-fixtures.mjs
```

The recorder refuses to save fixtures that contain tokens, workspace hosts or
`@databricks.com` e-mails.

Run QA before opening a PR that touches deck, spreadsheet or document generation. For
UI changes, run `npm run test:e2e`. Validate against a real workspace with
`bundle deploy` when it makes sense.

## Opening a pull request

- Fill in the [PR template](.github/pull_request_template.md).
- Describe **what** and **why**, not only the *how*.
- List how you tested (QA, local dev, deploy to a workspace).
- Small, focused PRs are reviewed faster.
- [CI](.github/workflows/ci.yml) must be green, with at least one approval before
  merge. It runs:
  - `npm test` (no unexpected skips: a skip whose reason starts with `[infra-skip:` is only a warning; isolation 19/19, RLS 16/16) and `npm run qa`;
  - the build (the check that `client/dist`/`server-dist` are current runs only on release PRs);
  - the smoke against the fake gateway;
  - `npm audit` (report only);
  - the E2E + accessibility job and the typecheck.
- The [Lakebase branch](.github/workflows/lakebase-branch.yml) workflow runs the migrations
  (up, down to 0, up) and the isolation + RLS suites against an ephemeral Lakebase branch. It
  skips with a notice, and stays green, when the `LAKEBASE_CI_*` secrets are not set (forks,
  repos without a CI service principal). See
  [operations.md](docs/operations.md#ci-ephemeral-lakebase-branch).
- CI also requires a fragment in `changelog.d/` (or a `CHANGELOG.md` edit). If the change
  does not matter to people who use or deploy the app (docs, chore, CI tweaks), apply the
  `skip-changelog` label to the PR to waive this check.

## Reporting bugs and suggesting features

Use the issue templates in `.github/ISSUE_TEMPLATE/`. For bugs, include steps to reproduce,
expected vs. actual behaviour, and the environment (cloud, CLI version, model).

## Security

**Do not** open public issues for vulnerabilities. Follow the [security policy](SECURITY.md).
