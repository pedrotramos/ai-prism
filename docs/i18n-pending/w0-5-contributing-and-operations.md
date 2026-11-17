<!--
PENDING TRANSLATIONS: fold into the final docs layout, then delete this file.
Owner: whoever converts CONTRIBUTING.md and docs/operations.md to the EN-canonical
layout (docs i18n tasks W1-10 / W2-10). Source of truth today: the pt-BR text
added by W0-5 in CONTRIBUTING.md ("Testes e QA", the pre-built artifacts rule
under "Fluxo de desenvolvimento", the changelog paragraph under "Padrões de
commit", the CI bullets under "Abrindo um Pull Request") and in
docs/operations.md (§5.1 row S6, §5.3 "Smoke na CI", the §6.1 prerequisite).
-->

# W0-5 docs: English and Spanish versions (pending fold-in)

This file carries the **English (canonical)** and **Spanish** text of the sections
W0-5 added in Portuguese to `CONTRIBUTING.md` and `docs/operations.md`. These files
are still pt-BR only. When the trilingual layout lands, paste each part into its
file and remove this one.

Contents:

- [English](#english)
  - [EN: CONTRIBUTING.md, pre-built artifacts (development flow)](#en-contributingmd-pre-built-artifacts-development-flow)
  - [EN: CONTRIBUTING.md, changelog paragraph](#en-contributingmd-changelog-paragraph)
  - [EN: CONTRIBUTING.md, Tests and QA](#en-contributingmd-tests-and-qa)
  - [EN: CONTRIBUTING.md, Opening a pull request (CI bullets)](#en-contributingmd-opening-a-pull-request-ci-bullets)
  - [EN: docs/operations.md, §5.1 row S6 and §5.3](#en-docsoperationsmd-51-row-s6-and-53)
  - [EN: docs/operations.md, §6.1 prerequisite](#en-docsoperationsmd-61-prerequisite)
- [Español](#español)
  - [ES: CONTRIBUTING.md, artefactos precompilados (flujo de desarrollo)](#es-contributingmd-artefactos-precompilados-flujo-de-desarrollo)
  - [ES: CONTRIBUTING.md, párrafo del changelog](#es-contributingmd-párrafo-del-changelog)
  - [ES: CONTRIBUTING.md, Pruebas y QA](#es-contributingmd-pruebas-y-qa)
  - [ES: CONTRIBUTING.md, Abrir un pull request (CI)](#es-contributingmd-abrir-un-pull-request-ci)
  - [ES: docs/operations.md, §5.1 fila S6 y §5.3](#es-docsoperationsmd-51-fila-s6-y-53)
  - [ES: docs/operations.md, requisito previo de §6.1](#es-docsoperationsmd-requisito-previo-de-61)

---

## English

### EN: CONTRIBUTING.md, pre-built artifacts (development flow)

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

### EN: CONTRIBUTING.md, changelog paragraph

Changes that matter to people who use or deploy the app get a **changelog fragment**:
a file `changelog.d/<task-or-branch>.md` with the same sections as
[CHANGELOG.md](../../CHANGELOG.md) (`### Added`, `### Fixed`…). Do not edit `CHANGELOG.md`
directly. With several PRs open, all editing the same `## [Unreleased]` lines, every
rebase turned into a conflict. Fragments are folded in at release time; see
[`changelog.d/README.md`](../../changelog.d/README.md).

### EN: CONTRIBUTING.md, Tests and QA

Everything below runs **offline, without a workspace**. CI runs the same checks
([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)).

| Command | What it covers | Needs |
|---|---|---|
| `npm test` | Every `*.test.js`/`*.test.mjs` under `server`, `shared`, `scripts`, `tests` and `client/src`: unit tests, two-user isolation, HTTP routes, the fake gateway | A local Postgres with pgvector for isolation and routes (`npm run local:up`). Without it those suites are skipped and the summary says so |
| `npm run qa` | Deterministic deck, spreadsheet and Python UDF checks | nothing |
| `npm run smoke` | A real user's path against a URL (see below) | a running server |
| `npm run test:e2e` | Browser flows + the accessibility regression bar | Node ≥ 22.19 (a Lighthouse requirement; the app itself runs on any Node 22), `npm run build:client` and `npx playwright install chromium` |

#### Unit and route tests

```bash
npm run local:up        # Postgres 17 + pgvector on 127.0.0.1:55432 (once)
npm test                # discovers and runs everything; prints files, totals and skips
node tests/run.mjs --list                                          # only list the files
node tests/run.mjs --fail-on-skip --expect server/isolation.test.js=10   # same as CI
```

Always use `npm test` (or `node tests/run.mjs`), not a bare `node --test`. With no file
list, Node falls back to its default glob, which also matches `scripts/load-test.mjs`
(`*-test.mjs`).

The route tests (`tests/routes.test.mjs`) start the real `app` on an ephemeral port
(`APPKIT_BOOT=1`, `LOCAL_DEV_MODE=1`) with the fake gateway and two `*.test.invalid`
users. The rows they create are deleted at the end.

#### Fake AI Gateway

`scripts/fake-gateway.mjs` answers in the shapes `server/llm.js` reads:
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

#### Local smoke

The same script as post-deploy, against the local server and the fake:

```bash
npm run fake-gateway -- --port 8787 &
LOCAL_DEV_MODE=1 DATABRICKS_HOST=http://127.0.0.1:8787 PGHOST=127.0.0.1 PGPORT=55432 \
  PGUSER=ai_prism PGPASSWORD=ai_prism PGDATABASE=ai_prism PGSSLMODE=disable node server/index.js &
APP_URL=http://127.0.0.1:8000 SMOKE_SKIP_ARTIFACT=0 npm run smoke
```

#### E2E and accessibility (`client/e2e/`)

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

### EN: CONTRIBUTING.md, Opening a pull request (CI bullets)

- [CI](../../.github/workflows/ci.yml) must be green, with at least one approval before
  merge. It runs:
  - `npm test` (no skipped tests, isolation 10/10) and `npm run qa`;
  - the build (the check that `client/dist`/`server-dist` are current runs only on release PRs);
  - the smoke against the fake gateway;
  - `npm audit` (report only);
  - the E2E + accessibility job and the typecheck.
- CI also requires a fragment in `changelog.d/` (or a `CHANGELOG.md` edit). If the change
  does not matter to people who use or deploy the app (docs, chore, CI tweaks), apply the
  `skip-changelog` label to the PR to waive this check.

### EN: docs/operations.md, §5.1 row S6 and §5.3

Row S6, column "Measured today": `npm run smoke`; the same script runs on every PR in CI
([§5.3](#53-smoke-in-ci)).

#### 5.3 Smoke in CI

The post-deploy `scripts/smoke.mjs` (S6) also runs on every PR and every push to `main`,
in the `Build & QA` job. A break in the user's path then shows up before merge, not only
after a deploy. The step:

1. starts `scripts/fake-gateway.mjs` on `127.0.0.1:8787`. It is a fake AI Gateway whose
   shapes (streaming, `tool_calls`, `usage`, embeddings) are pinned to a recording of a
   real gateway (`tests/fixtures/gateway-shapes.live.json`);
2. starts `node server/index.js` with `LOCAL_DEV_MODE=1`, `DATABRICKS_HOST` pointing at
   the fake and the CI service's pgvector Postgres;
3. runs `npm run smoke` with `SMOKE_SKIP_ARTIFACT=0` and `SMOKE_EXPECT_EMAIL`. It checks
   the SPA, identity, models, a chat turn over SSE, persistence, listing, the artifact and
   cleanup. For the artifact, the fake answers the document request with a `document`
   block, which the server saves;
4. on failure, prints the server and fake logs in the job.

What this smoke does **not** prove: the Apps proxy authentication, a real Lakebase, real
models and latency. Those stay with the post-deploy smoke against the App URL
([§6.1](#61-deploy)). To reproduce it locally, see "Local smoke" in CONTRIBUTING.md.

### EN: docs/operations.md, §6.1 prerequisite

Prerequisite: artifacts rebuilt with `npm run bundle` right before the deploy. Feature PRs
do not commit `client/dist` or `server-dist`; release PRs (branch `release/*` or label
`release`) rebuild and commit them, and only those PRs get the CI check that they are
current. `deploy.sh` does not run the build on its own yet.

---

## Español

### ES: CONTRIBUTING.md, artefactos precompilados (flujo de desarrollo)

La app ejecuta artefactos **precompilados** (`client/dist` + `server-dist/index.cjs`).

**No hagas commit de `client/dist` ni de `server-dist` en los PR de funcionalidades.** Los
nombres de esos archivos llevan un hash del contenido, así que dos PR de cliente abiertos
a la vez siempre entrarían en conflicto en ellos. Estos artefactos se regeneran y se
incluyen en el commit **solo en los PR de release**: rama `release/*` o etiqueta `release`.
Solo en esos PR la CI comprueba que coinciden con el código. En los demás, la CI ejecuta
`npm run bundle` (el build debe pasar) y avisa de que los artefactos se rehacen en el
release. Si el build cambia esos archivos en tu rama, descarta los cambios:
`git checkout -- client/dist server-dist`.

**Antes de cualquier despliegue, ejecuta `npm run bundle`.** `bundle deploy` y
`apps deploy` publican lo que haya en `client/dist` y `server-dist`. Hoy `deploy.sh` y
`deploy.ps1` todavía **no** ejecutan ese build por sí solos.

### ES: CONTRIBUTING.md, párrafo del changelog

Los cambios relevantes para quien usa o despliega la app llevan un **fragmento de
changelog**: un archivo `changelog.d/<tarea-o-rama>.md` con las mismas secciones que
[CHANGELOG.md](../../CHANGELOG.md) (`### Added`, `### Fixed`…). No edites `CHANGELOG.md`
directamente. Con varios PR abiertos, todos editando las mismas líneas de
`## [Unreleased]`, cada rebase terminaba en un conflicto. Los fragmentos se consolidan en
el release; consulta [`changelog.d/README.md`](../../changelog.d/README.md).

### ES: CONTRIBUTING.md, Pruebas y QA

Todo lo siguiente funciona **sin conexión y sin workspace**. La CI ejecuta las mismas
verificaciones ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)).

| Comando | Qué cubre | Necesita |
|---|---|---|
| `npm test` | Todos los `*.test.js`/`*.test.mjs` de `server`, `shared`, `scripts`, `tests` y `client/src`: unitarias, aislamiento entre dos usuarios, rutas HTTP, el gateway falso | Un Postgres local con pgvector para aislamiento y rutas (`npm run local:up`). Sin él, esas suites se omiten y el resumen lo indica |
| `npm run qa` | Verificaciones deterministas de deck, hoja de cálculo y UDF Python | nada |
| `npm run smoke` | El recorrido real de un usuario contra una URL (ver abajo) | un servidor en marcha |
| `npm run test:e2e` | Flujos en el navegador + la vara de accesibilidad | Node ≥ 22.19 (requisito de Lighthouse; la app en sí funciona con cualquier Node 22), `npm run build:client` y `npx playwright install chromium` |

#### Pruebas unitarias y de rutas

```bash
npm run local:up        # Postgres 17 + pgvector en 127.0.0.1:55432 (una vez)
npm test                # descubre y ejecuta todo; muestra archivos, totales y omitidas
node tests/run.mjs --list                                          # solo lista los archivos
node tests/run.mjs --fail-on-skip --expect server/isolation.test.js=10   # igual que la CI
```

Usa siempre `npm test` (o `node tests/run.mjs`), no `node --test` sin argumentos. Sin
lista de archivos, Node usa su glob por defecto, que también coincide con
`scripts/load-test.mjs` (`*-test.mjs`).

Las pruebas de rutas (`tests/routes.test.mjs`) levantan la `app` real en un puerto
efímero (`APPKIT_BOOT=1`, `LOCAL_DEV_MODE=1`), con el gateway falso y dos usuarios
`*.test.invalid`. Las filas creadas se borran al final.

#### Gateway falso de IA

`scripts/fake-gateway.mjs` responde con los formatos que lee `server/llm.js`:
- streaming: `delta.content`, `reasoning_content`, `tool_calls` indexados, `usage` y `[DONE]`;
- sin streaming: `message.content`;
- embeddings de 1024 dimensiones y el listado de endpoints.

El comportamiento depende del último mensaje del usuario:
- pedir un documento genera un bloque `document`;
- `[fake:tool]` genera una llamada a una tool;
- `[fake:error]` genera un HTTP 503.

```bash
npm run fake-gateway -- --port 8787
DATABRICKS_HOST=http://127.0.0.1:8787 npm run dev:server:local   # toda la app sin workspace
```

Los formatos están fijados en `tests/fixtures/gateway-shapes.live.json`, una grabación de
un gateway real que solo guarda rutas de claves y tipos. Para volver a grabarla cuando el
gateway cambie (6 llamadas pequeñas a modelos baratos; el token nunca se imprime):

```bash
DATABRICKS_HOST=https://<workspace> \
DATABRICKS_TOKEN="$(databricks auth token -p <PROFILE> -o json | jq -r .access_token)" \
node tests/live/record-gateway-shapes.mjs
```

#### Smoke local

El mismo script del post-despliegue, contra el servidor local y el gateway falso:

```bash
npm run fake-gateway -- --port 8787 &
LOCAL_DEV_MODE=1 DATABRICKS_HOST=http://127.0.0.1:8787 PGHOST=127.0.0.1 PGPORT=55432 \
  PGUSER=ai_prism PGPASSWORD=ai_prism PGDATABASE=ai_prism PGSSLMODE=disable node server/index.js &
APP_URL=http://127.0.0.1:8000 SMOKE_SKIP_ARTIFACT=0 npm run smoke
```

#### E2E y accesibilidad (`client/e2e/`)

El navegador ejecuta el **cliente compilado** (`client/dist`) detrás de
`client/e2e/fixture-server.mjs`. Ese servidor responde `/api/*` con fixtures grabadas
(`client/e2e/fixtures/api.json`), así que no hace falta backend, base de datos ni gateway.

```bash
npm run build:client
npx playwright install chromium
npm run test:e2e                         # flujos + vara de accesibilidad
E2E_STRICT=1 npm run test:e2e            # también falla ante cualquier violación serious/critical
```

- `flows.spec.mjs` cubre:
  - una respuesta en streaming (el shim de `fetch` alimenta `/api/chat` con eventos SSE reales);
  - un HTTP 500 al enviar;
  - Configuración y Slides Studio;
  - el historial en móvil;
  - ninguna petición sin fixture.
- `a11y.spec.mjs` ejecuta axe en bienvenida, chat, Configuración y Slides Studio, en tema
  oscuro y claro, a 1440 y 390 px (16 ejecuciones). También mide:
  - los objetivos táctiles de menos de 24 px;
  - los elementos interactivos sin nombre;
  - Lighthouse (accesibilidad) en bienvenida, chat e historial;
  - los estilos sueltos de `client/src` (`token-audit.mjs`).
- **Vara de regresión:** `client/e2e/baseline.json` guarda los números por sistema
  operativo. El job falla si sube cualquier conteo o baja una nota de Lighthouse. Cuando
  mejores alguno, graba la nueva vara con `E2E_UPDATE_BASELINE=1 npm run test:e2e` y haz
  commit de `baseline.json`.
- Informe: `client/e2e/.output/a11y-report.json` y `client/e2e/.output/report/`
  (en la CI, el artefacto `e2e-report`).

Cuando una pantalla empiece a llamar a un endpoint nuevo, falla la prueba de cobertura de
fixtures. Vuelve a grabarlas contra un servidor local con datos sembrados:

```bash
npm run local:up
npm run fake-gateway -- --port 8787 &
# servidor local con DATABRICKS_HOST=http://127.0.0.1:8787 y
# DATABRICKS_USER_EMAIL=e2e-user@example.com APP_OWNER_EMAIL=e2e-user@example.com
DATABRICKS_USER_EMAIL=e2e-user@example.com npm run local:seed
IDS=$(node client/e2e/record/seed-rich.mjs)
APP_URL=http://127.0.0.1:8000 IDS="$IDS" node client/e2e/record/record-fixtures.mjs
```

El grabador se niega a guardar fixtures que contengan tokens, hosts de workspace o
correos `@databricks.com`.

Ejecuta el QA antes de abrir un PR que toque la generación de decks, hojas de cálculo o
documentos. Para cambios de UI, ejecuta `npm run test:e2e`. Valida contra un workspace
real con `bundle deploy` cuando tenga sentido.

### ES: CONTRIBUTING.md, Abrir un pull request (CI)

- La [CI](../../.github/workflows/ci.yml) debe estar en verde, con al menos una aprobación
  antes del merge. Ejecuta:
  - `npm test` (sin pruebas omitidas, aislamiento 10/10) y `npm run qa`;
  - el build (la verificación de que `client/dist`/`server-dist` están al día solo en los PR de release);
  - el smoke contra el gateway falso;
  - `npm audit` (solo informe);
  - el job E2E + accesibilidad y el typecheck.
- La CI también exige un fragmento en `changelog.d/` (o una edición de `CHANGELOG.md`).
  Si el cambio no es relevante para quien usa o despliega la app (docs, chore, ajustes de
  CI), aplica la etiqueta `skip-changelog` al PR para omitir esta verificación.

### ES: docs/operations.md, §5.1 fila S6 y §5.3

Fila S6, columna "Medición hoy": `npm run smoke`; el mismo script se ejecuta en cada PR
en la CI ([§5.3](#53-smoke-en-la-ci)).

#### 5.3 Smoke en la CI

El `scripts/smoke.mjs` del post-despliegue (S6) también se ejecuta en cada PR y en cada
push a `main`, en el job `Build & QA`. Así, una rotura en el recorrido del usuario aparece
antes del merge y no solo después del despliegue. El paso:

1. levanta `scripts/fake-gateway.mjs` en `127.0.0.1:8787`. Es un AI Gateway falso cuyos
   formatos (streaming, `tool_calls`, `usage`, embeddings) están fijados a una grabación de
   un gateway real (`tests/fixtures/gateway-shapes.live.json`);
2. levanta `node server/index.js` con `LOCAL_DEV_MODE=1`, `DATABRICKS_HOST` apuntando al
   gateway falso y el Postgres con pgvector del servicio de la CI;
3. ejecuta `npm run smoke` con `SMOKE_SKIP_ARTIFACT=0` y `SMOKE_EXPECT_EMAIL`. Verifica
   la SPA, la identidad, los modelos, un turno de chat por SSE, la persistencia, el
   listado, el artefacto y la limpieza. Para el artefacto, el gateway falso responde al
   pedido de documento con un bloque `document`, que el servidor guarda;
4. si algo falla, imprime los logs del servidor y del gateway falso en el propio job.

Lo que este smoke **no** prueba: la autenticación del proxy de Apps, un Lakebase real, ni
modelos y latencia reales. Eso sigue a cargo del smoke post-despliegue contra la URL de la
App ([§6.1](#61-deploy)). Para reproducirlo en local, consulta "Smoke local" en
CONTRIBUTING.md.

### ES: docs/operations.md, requisito previo de §6.1

Requisito previo: artefactos regenerados con `npm run bundle` justo antes del despliegue.
Los PR de funcionalidades no incluyen `client/dist` ni `server-dist` en el commit; los PR
de release (rama `release/*` o etiqueta `release`) los regeneran y los incluyen, y solo en
esos la CI comprueba que están al día. `deploy.sh` todavía no ejecuta el build por sí solo.
