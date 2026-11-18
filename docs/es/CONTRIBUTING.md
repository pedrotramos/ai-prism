<!-- i18n: source=CONTRIBUTING.md source-hash=fd7f3033f0b8df8c6c60c05a7a26fb7e30275996 status=machine -->
# Cómo contribuir a AI Prism

[English](../../CONTRIBUTING.md) · [Português (Brasil)](../pt-BR/CONTRIBUTING.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../../CONTRIBUTING.md) es la referencia.

¡Gracias por tu interés en contribuir! Esta guía explica cómo preparar el entorno, el flujo
de desarrollo y las convenciones que seguimos en el repositorio.

> AI Prism es un **acelerador de soluciones de código abierto**, no un producto oficial de
> Databricks. Cada persona despliega su propia copia en su propio workspace. Consulta el
> [README](../../README.es.md) y el [onboarding de despliegue](../onboarding-deployment.md).

## Índice

- [Código de conducta](#código-de-conducta)
- [Requisitos previos](#requisitos-previos)
- [Configurar el entorno](#configurar-el-entorno)
- [Flujo de desarrollo](#flujo-de-desarrollo)
- [Mapa de módulos del servidor](#mapa-de-módulos-del-servidor)
- [TypeScript](#typescript)
- [Convenciones de commit](#convenciones-de-commit)
- [Pruebas y QA](#pruebas-y-qa)
- [Abrir un pull request](#abrir-un-pull-request)
- [Reportar bugs y sugerir funcionalidades](#reportar-bugs-y-sugerir-funcionalidades)
- [Seguridad](#seguridad)

## Código de conducta

Este proyecto adopta el [Contributor Covenant](../../CODE_OF_CONDUCT.md). Al participar,
aceptas mantener las interacciones respetuosas y acogedoras.

## Requisitos previos

- **Node.js 22.18+** para desarrollar (`engines` en `package.json`). Desde la 22.18, Node
  ejecuta archivos `.ts` directamente quitando los tipos; con una 22 anterior, las pruebas, el
  QA y el servidor de desarrollo fallan al importar `shared/*.ts` (`ERR_UNKNOWN_FILE_EXTENSION`).
  [`.nvmrc`](../../.nvmrc) fija la línea que usa la CI (22.23; `nvm use` la elige). La app desplegada
  ejecuta el bundle compilado (`server-dist/index.cjs`), que no contiene ningún `.ts`, así que
  no depende de esto; y npm solo avisa (`EBADENGINE`) si el runtime de Databricks Apps es más
  antiguo, sin bloquear la instalación. `shared/typescript.test.js` falla si `.nvmrc` o
  `engines` bajan de la 22.18.
- **PostgreSQL 17 + pgvector** (`brew install postgresql@17 pgvector`); no requiere Docker.
- **Databricks CLI ≥ 1.8** para desplegar y para ejecutar la app contra un workspace real.
- Acceso a un workspace de Databricks con AI Gateway, Serverless SQL y Lakebase habilitados,
  si quieres ejercitar el flujo completo (el QA offline no necesita workspace).

## Configurar el entorno

```bash
nvm use                 # Node de la versión indicada en .nvmrc
npm install
cp .env.local.example .env.local
npm run local:up
npm run dev:local
# en otra terminal: npm run local:seed
```

Vite hace proxy de `/api` a `http://localhost:8000`. Fuera del runtime de la Databricks App,
el modo local usa Postgres nativo en `127.0.0.1:55432` y no requiere tokens de Lakebase.
Usa [`.env.example`](../../.env.example) + `npm run dev` solo para desarrollo híbrido contra
recursos reales del workspace.

## Flujo de desarrollo

1. Crea una rama a partir de `main` con un nombre descriptivo y un prefijo de tipo:
   `feat/…`, `fix/…`, `docs/…`, `chore/…`, `perf/…`.
2. Haz los cambios manteniendo el estilo del código alrededor (comentarios, nombres, idioma).
3. Ejecuta el [QA](#pruebas-y-qa) y valida localmente lo que se vea afectado.
4. Haz commits pequeños y cohesivos siguiendo las [convenciones de commit](#convenciones-de-commit).
5. Abre un [pull request](#abrir-un-pull-request) contra `main`.

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

## Mapa de módulos del servidor

El servidor Express (`server/`) está dividido por responsabilidad. `server/index.js` solo arma
la app: instala el middleware, registra los módulos de rutas en el orden de la lista `routes`,
sirve el frontend estático e instala el manejador de errores final.

| Módulo | Qué contiene |
| --- | --- |
| `server/index.js` | Crea la `app`, `installMiddleware(app)`, la lista `routes`, el frontend estático, el manejador de errores final y el `listen` (se omite con `APPKIT_BOOT=1`). |
| `server/middleware/index.js` | `installMiddleware(app)` en este orden: request id, encabezados de seguridad, `security`, guarda CSRF en `/api`, validación numérica de `:id`/`:messageId`, `express.json`. También exporta `upload` (multer) y `fixFilename`. |
| `server/middleware/auth.js` | `auth`: identidad del proxy, vínculo correo↔token y alcance del taxímetro. |
| `server/middleware/requireAdmin.js` | `requireAdmin`: 403 para quien no es administrador. |
| `server/middleware/ensureReady.js` | `ensureReady`: crea el schema una vez por proceso (latch de promesa: las solicitudes simultáneas esperan el mismo DDL) e intenta los grants del SP en cada solicitud. |
| `server/middleware/{requestId,security}.js` | Puntos de extensión que, por ahora, solo pasan la solicitud al siguiente paso. |
| `server/sse.js` | `openSse(res)` y `makeSend(res)`: encabezados y escritura de eventos SSE de las rutas de turno. |
| `server/turn.js` | Las tres rutas que generan una respuesta (`POST /api/chat`, `/api/sessions/:id/continue`, `/api/sessions/:id/messages/:messageId/regenerate`) y lo que comparten: ventana de historial, herramientas, `runAssistantTurn`, avisos, deck por outline y persistencia de artefactos. |
| `server/models.js` | Caché del catálogo de modelos del usuario, `getUserModels`, `resolveModelId`, `invalidateUserModels`. |
| `server/lib/tweak.js` | Utilidades de los "tweaks" de IA (deck, hoja de cálculo, documento). |
| `server/lib/embeddings.js` | Embeddings de sesión y de mensaje, y el backfill del historial. |
| `server/routes/admins.js` | `/api/me` y los administradores de la app. |
| `server/routes/models.js` | Modelos de chat e imagen, política de herramientas, resumen de costos y catálogo de modelos del admin. |
| `server/routes/sessions.js` | Sesiones: lista, búsqueda, keep-alive, mensajes, compactación, edición y eliminación. |
| `server/routes/toolsSearch.js` | Búsqueda de herramientas adjuntables (UC Functions, Genie, Vector Search, MCP externo). |
| `server/routes/mcpConnections.js` | Conexiones MCP del usuario. |
| `server/routes/mcpCatalog.js` | Catálogo MCP del admin. |
| `server/routes/skills.js` | Skills de autor. |
| `server/routes/deckTemplates.js` | Design systems (plantillas de presentación). |
| `server/routes/decks.js` | Deck Studio: lectura, edición, tweak y exportación `.pptx`. |
| `server/routes/images.js` | Bytes de las imágenes generadas. |
| `server/routes/spreadsheets.js` | Estudio de hojas de cálculo. |
| `server/routes/documents.js` | Estudio de documentos. |
| `server/routes/messages.js` | Variante activa, edición de prompt y respuestas de `deck-questions`. |
| `server/routes/static.js` | `client/dist` y el fallback de la SPA; se registra después de todas las rutas de API. |

Reglas:

- **Endpoint nuevo** = archivo nuevo `server/routes/<nombre>.js` que exporta `register(app)` +
  **una línea** al final de la lista `routes` en `server/index.js`.
- Las rutas se registran **directamente en `app`**, no en un `express.Router`: `app.param(['id', 'messageId'])`
  no aplica dentro de un router, y las rutas perderían la validación numérica de los ids.
- El guarda CSRF va **antes** de cualquier parser de cuerpo; no cambies el orden de `installMiddleware`.
- El posprocesamiento del turno (bloques, deck, costo, título) aplica a **las tres** rutas de
  `server/turn.js`; el stream SSE sale siempre de `server/sse.js`.
- `server/routes/routeTable.test.js` fija la tabla de rutas (método, ruta y cadena de middleware).
  Al agregar o cambiar una ruta, actualiza la lista esperada en el mismo PR.

## TypeScript

El código pasa a TypeScript **por responsable**: el archivo que te pertenece y que cambias de
forma relevante se convierte en `.ts` en el mismo PR. La decisión y sus motivos están en el
[ADR 0006](../adr/0006-typescript.md). `shared/**` ya está en TypeScript.

- **Fuente en `.ts`, shim en `.js`.** `foo.js` pasa a ser `foo.ts`, y `foo.js` conserva una sola
  línea, `export * from './foo.ts'`. El código que importa `./foo.js` no cambia: no edites a
  quienes lo importan. Un módulo con `export default` también necesita
  `export { default } from './foo.ts'` en el shim.
- **`strict` se aplica solo a `.ts`.** [`tsconfig.json`](../../tsconfig.json) activa `strict`,
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

## Convenciones de commit

Usamos [Conventional Commits](https://www.conventionalcommits.org/). El scope es opcional
pero recomendado; la descripción puede estar en portugués.

<!-- i18n: code-translated -->
```
<tipo>(<ámbito>): <descripción en imperativo>
```

Tipos usados en el proyecto: `feat`, `fix`, `docs`, `chore`, `perf`, `refactor`, `test`.

Ejemplos reales del historial:

```
feat(deck): Fase 3 — tweaks de IA melhores (região, prévia, recompor, histórico)
fix(blocks): documento com bloco de código vazava JSON cru no chat
perf: fluidez de streaming + TTFT
```

Los cambios relevantes para quien usa o despliega la app llevan un **fragmento de
changelog**: un archivo `changelog.d/<tarea-o-rama>.md` con las mismas secciones que
[CHANGELOG.md](../../CHANGELOG.md) (`### Added`, `### Fixed`…). No edites `CHANGELOG.md`
directamente. Con varios PR abiertos, todos editando las mismas líneas de
`## [Unreleased]`, cada rebase terminaba en un conflicto. Los fragmentos se consolidan en
el release; consulta [`changelog.d/README.md`](../../changelog.d/README.md).

## Pruebas y QA

Todo lo siguiente funciona **sin conexión y sin workspace**. La CI ejecuta las mismas
verificaciones ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)).

| Comando | Qué cubre | Necesita |
|---|---|---|
| `npm test` | Todos los `*.test.js`/`*.test.mjs` de `server`, `shared`, `scripts`, `tests` y `client/src`: unitarias, aislamiento entre dos usuarios, rutas HTTP, el gateway falso | Un Postgres local con pgvector para aislamiento y rutas (`npm run local:up`). Sin él, esas suites se omiten y el resumen lo indica |
| `npm run qa` | Verificaciones deterministas de deck, hoja de cálculo y UDF Python | nada |
| `npm run typecheck` | `tsc --noEmit`: los archivos `.ts` con `strict` (consulta [TypeScript](#typescript)) | nada |
| `npm run smoke` | El recorrido real de un usuario contra una URL (ver abajo) | un servidor en marcha |
| `npm run test:e2e` | Flujos en el navegador + la vara de accesibilidad | Node ≥ 22.19 (requisito de Lighthouse), `npm run build:client` y `npx playwright install chromium` |

### Pruebas unitarias y de rutas

```bash
npm run local:up        # Postgres 17 + pgvector en 127.0.0.1:55432 (una vez)
npm test                # descubre y ejecuta todo; muestra archivos, totales y omitidas
node tests/run.mjs --list                                          # solo lista los archivos
node tests/run.mjs --fail-on-skip --expect server/isolation.test.js=19 --expect server/rls.test.js=14   # igual que la CI
```

Usa siempre `npm test` (o `node tests/run.mjs`), no `node --test` sin argumentos. Sin
lista de archivos, Node usa su glob por defecto, que también coincide con
`scripts/load-test.mjs` (`*-test.mjs`).

Las pruebas de rutas (`tests/routes.test.mjs`) levantan la `app` real en un puerto
efímero (`APPKIT_BOOT=1`, `LOCAL_DEV_MODE=1`), con el gateway falso y dos usuarios
`*.test.invalid`. Las filas creadas se borran al final.

### Gateway falso de IA

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

### Smoke local

El mismo script del post-despliegue, contra el servidor local y el gateway falso:

```bash
npm run fake-gateway -- --port 8787 &
LOCAL_DEV_MODE=1 DATABRICKS_HOST=http://127.0.0.1:8787 PGHOST=127.0.0.1 PGPORT=55432 \
  PGUSER=ai_prism PGPASSWORD=ai_prism PGDATABASE=ai_prism PGSSLMODE=disable node server/index.js &
APP_URL=http://127.0.0.1:8000 SMOKE_SKIP_ARTIFACT=0 npm run smoke
```

### E2E y accesibilidad (`client/e2e/`)

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

## Abrir un pull request

- Completa la [plantilla de PR](../../.github/pull_request_template.md).
- Describe **qué** y **por qué**, no solo el *cómo*.
- Indica cómo lo probaste (QA, desarrollo local, despliegue en un workspace).
- Los PR pequeños y enfocados se revisan más rápido.
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

## Reportar bugs y sugerir funcionalidades

Usa las plantillas de issue en `.github/ISSUE_TEMPLATE/`. Para bugs, incluye los pasos
para reproducirlos, el comportamiento esperado frente al obtenido y el entorno (cloud,
versión de la CLI, modelo).

## Seguridad

**No** abras issues públicos para vulnerabilidades. Sigue la
[política de seguridad](../../SECURITY.md).
