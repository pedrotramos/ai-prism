# ADR 0001: Databricks AppKit as the default boot, adopted incrementally

- **Status:** Accepted (2026-11-18; proposed 2026-11-17 after the spike)
- **Date:** 2026-11-18
- **Scope:** server bootstrap, packaging, Lakebase, telemetry, AppKit plugins
- **Tested with:** `@databricks/appkit@0.76.1` (exact pin in `devDependencies`), Node 22.22.3 (local), Node from `.nvmrc` (CI)

## Context

AI Prism runs an Express app written in JS (`server/index.js` plus `server/routes/*`), bundled
by esbuild and served as a Databricks App through `app.yaml` → `node server-dist/index.cjs`.
The deploy has no `node_modules` (the repo's `.npmrc` sets `omit=dev` and the bundle is
pre-built), so **all runtime code must be inside the bundle**.

The plan asks for an incremental (strangler) adoption of `@databricks/appkit`: AppKit's
`server()` plugin owns the listener, `/health` and request telemetry; the existing routes are
mounted inside it, not rewritten. Before this ADR the AppKit boot existed only as an opt-in
spike (`APPKIT_BOOT=1`, separate `build:server:appkit` script), and flipping it on in
production would have needed a different `command` and a rebuild.

## Evidence

Spike (`feat/appkit-spike`, temporary artifacts not versioned) and this change
(`tests/appkit-boot.test.mjs`).

| # | Check | Method | Result |
|---|---|---|---|
| E1 | AppKit is ESM-only and needs Node ≥ 22 | `node_modules/@databricks/appkit/package.json` (`"type": "module"`, `exports` with `import` only, `engines`) | confirmed |
| E2 | An ESM bundle without stubs fails | `esbuild … --bundle --format=esm --target=node22` | fails on `@babel/preset-typescript/package.json` (via `@babel/core`) and `fsevents.node` (no loader) |
| E3 | The ESM bundle needs `require` for CJS dependencies | run without a banner | `Dynamic require of "node:http" is not supported` (sdk-experimental) → fixed with a `createRequire(import.meta.url)` banner |
| E4 | `vite` and `@ast-grep/napi` are imported statically | reading the bundle | without stubs: `Cannot find package 'vite'` outside `node_modules` |
| E5 | The stubbed bundle runs outside `node_modules` | `scripts/build-appkit.mjs` → `server-dist/appkit.mjs`, copied to a folder without `node_modules` | `/health` → `{"status":"ok"}`; SPA at `/`; `/api/me` without a token → 401; with `x-forwarded-access-token` → 200 |
| E6 | Boot requirements | env variations | without `DATABRICKS_HOST`/auth: `Databricks authentication failed`. With `lakebase()` in the plugin list and outside `NODE_ENV=development`: `Missing required resources: postgres [lakebase]` without `PGPORT`/`PGSSLMODE`, and `PGUSER` or `DATABRICKS_CLIENT_ID` required |
| E7 | HTTP calls during boot | mock workspace on 127.0.0.1 recording requests | `GET /api/2.0/preview/scim/v2/Me`, whose response must carry `x-databricks-org-id` (otherwise `resourceNotFound("Workspace ID")`). **Boot does not connect to Postgres** (`pg.Pool` is lazy) |
| E8 | AppKit's body parser runs before ours | `plugins/server/index.js` (`express.json({ limit: bodyLimit ?? "1mb" })`) | the 1 mb default would reject bodies our `express.json({ limit: '40mb' })` accepts → **`server({ bodyLimit: '40mb' })` is mandatory** |
| E9 | Seam without rewriting routes | `server/index.js` exports `app` and only listens when `APPKIT_BOOT !== '1'`; `server/appkit.js` does `appkit.server.extend(app => app.use(legacyApp))` | `/health` comes from AppKit (registered before extensions); every other route from our app |
| E10 | The legacy bundle has no `/health` | CJS bundle, `GET /health` | 200 **only because the SPA catch-all answers** with HTML |
| E11 | Without the flag the legacy app also listens | AppKit bundle without `APPKIT_BOOT=1` | two listeners. The "do not listen" flag must be set before `index.js` is evaluated on every AppKit path |
| E12 | AppKit as CJS | `--format=cjs` with the top-level `await` wrapped | builds and runs; the only blocker is the top-level `await` in `server/appkit.js` |
| E13 | Dev without a bundle | `node server/appkit.js` (with `node_modules`) | `/health` 200, `/` 200 (static, because `client/dist` exists) |
| E14 | `tsc --noEmit` | `npm run typecheck` (`allowJs`, `checkJs: false`) | exit 0 |
| E15 | Lockfile | `npm install --save-dev --include=dev --save-exact @databricks/appkit@0.76.1 …` | 305 packages added (AppKit tree, including `@opentelemetry/*`); URLs point at `registry.npmjs.org` |
| E16 | Default boot through the launcher (G-boot) | `tests/appkit-boot.test.mjs`: build into a temp folder (or `APPKIT_BOOT_DIST=server-dist` after `npm run bundle`), copy away from `node_modules`, clean env, mock workspace | default: `/health` JSON `{"status":"ok"}`, SPA, `/api/me` 401, 2 MB JSON POST to `/api/deck-templates` → 401 (not 413), SCIM `/Me` called, with `legacy.cjs` **absent**; `APPKIT_BOOT=0`: SPA, 401, 2 MB POST → 401, no `/health` JSON and no workspace call, with `appkit.mjs` **absent**; no `PG*` variables needed |
| E17 | Artifact sizes | `npm run build:server` | `appkit.mjs` ≈ 12.5 MB, `legacy.cjs` ≈ 8.8 MB, `index.cjs` ≈ 1 KB (≈ 21.3 MB total) |

Not verified here (see "Live validation"): a boot inside the Apps runtime, a real Lakebase
connection under the AppKit boot, OTLP export from the Apps runtime.

## Decision

1. **AppKit is the default boot, in strangler mode.** `server()` owns the listener and
   `/health`; the existing Express app is mounted as a sub-app via `appkit.server.extend`. No
   route is rewritten.
2. **Launcher (option A).** `app.yaml` keeps `command: node server-dist/index.cjs`.
   `server-dist/index.cjs` is `server/boot.cjs`, copied unbundled: `APPKIT_BOOT=0` →
   `require('./legacy.cjs')`; anything else → `import('./appkit.mjs')`. Each branch loads only
   its own artifact, so a broken AppKit bundle cannot break the rollback. `app.yaml` sets
   `APPKIT_BOOT: '1'` explicitly and documents `'0'`.
   - Rejected, option B (`command: node server-dist/appkit.mjs`): simpler, but a rollback
     would need a different `command` and the legacy artifact would no longer ship.
3. **Packaging.** `npm run build:server` (`scripts/build-appkit.mjs`, also part of
   `npm run bundle`) emits the three files. `appkit.mjs` is esbuild ESM `--target=node22` with
   throwing stubs for `vite`, `@ast-grep/napi`, `@babel/core`, `fsevents`
   (`scripts/appkit/stubs/`) and a `createRequire` banner. `legacy.cjs` keeps the build the app
   always had (CJS, `node18`), so the rollback path does not depend on the AppKit bundling.
   - Size budget: **`appkit.mjs` ≤ 15 MB** (asserted by G-boot). The legacy bundle repeats
     the Express app (≈ 8.8 MB) because the two outputs cannot share code across ESM/CJS; a
     shared-chunk ESM build would cut the total to ≈ 12.4 MB but makes the rollback depend on
     the same bundling as AppKit, so it was not chosen. The duplication ends when the legacy
     path is removed (follow-up below).
   - `server-dist/**` is rebuilt and committed by release PRs only, like `client/dist` (the
     CI dist drift check). Feature PRs do not commit it.
4. **`server/appkit.js` sets the internal `APPKIT_BOOT=1` before importing `index.js`** (a
   dynamic import, since static imports are hoisted), so `node server/appkit.js` and the
   bundle never open a second listener (E11). AppKit listens on the same interface rule as the
   legacy listener (`listenHost()`: loopback while the dev identity fallback is on).
5. **`bodyLimit: '40mb'`** on `server()` (E8); asserted by G-boot on both boot paths.
6. **The `lakebase()` plugin is not adopted.** `server/db.js` stays the owner of the Postgres
   pool; see "Lakebase" below.
7. **AppKit internal telemetry stays off** (`disableInternalTelemetry: true`; equivalent to
   `DISABLE_APPKIT_INTERNAL_TELEMETRY=true` or `DO_NOT_TRACK=1`). It sends `APP_STARTUP`,
   `HEARTBEAT` (every 5 min) and `REQUEST_METRICS` (per minute, per route) to Databricks with
   `app_id` = `DATABRICKS_CLIENT_ID`: metadata leaving the customer's workspace, which conflicts
   with how the product is positioned. Turning it on is a product-owner decision.
8. **Dependencies stay in `devDependencies`** (`@databricks/appkit`, `typescript`, `@types/*`,
   and `@opentelemetry/api@1.9.0`, pinned exactly for the app's own spans). The bundle is
   self-contained, so the deploy still runs no `npm install`.
9. **G-boot in CI.** The unit step runs `tests/appkit-boot.test.mjs` against a fresh build;
   after `npm run bundle` a dedicated step runs it against the real `server-dist/`. An AppKit
   upgrade that breaks the ESM bundle (stubs, banner, boot calls) fails CI, not production.

## Lakebase: AppKit `lakebase()` vs `server/db.js`

From `@databricks/lakebase@0.6.0` and `appkit/dist/plugins/lakebase/lakebase.js`:

| Aspect | `server/db.js` | `lakebase()` (AppKit 0.76.1) | Impact |
|---|---|---|---|
| Endpoint variable | `PG_ENDPOINT` (`valueFrom: lakebase`), host resolved via REST | `LAKEBASE_ENDPOINT`; `PGHOST` from the resource | rename in `app.yaml`; whether `valueFrom: lakebase` injects `LAKEBASE_ENDPOINT` is **not verified** |
| SP identity | own `client_credentials`, cached token, `password` as a per-connection function | SDK (`DATABRICKS_CLIENT_ID/SECRET`), refresh every hour with a 2 min buffer | functionally equivalent; not tested live |
| Per-user fallback | OBO token as password, role = user e-mail | `asUser(req)` creates **one pool per user** with the user's OAuth | **incompatible with the model**: both need a PG role per user. AI Prism uses one role (the SP) and isolates rows per user in SQL. **Never adopt `asUser`** |
| `PGPASSWORD` (dev) | per-user pool with a fixed password | `lakebase({ pool: { password } })` for the SP pool | covers local dev |
| SSL | `rejectUnauthorized: false` | `PGSSLMODE=require` → `rejectUnauthorized: true` | **stricter**; may fail if the chain is not trusted by the runtime's Node. Not tested live |
| Limits | `max 8`, idle 5 min (now 2 min, `PG_POOL_IDLE_TIMEOUT_MS`), `maxLifetime` 30 min, `query_timeout` 60 s | `max 10`, idle 30 s, no `maxLifetime`, optional `statement_timeout` | would lose `maxLifetime` and `query_timeout` |
| Boot | lazy, no I/O until the first query | username lookup + resource validation; needs `PGUSER`/`CLIENT_ID`, `PGPORT`, `PGSSLMODE`, `LAKEBASE_ENDPOINT` in production | adds boot requirements (E6) |
| Telemetry | none | `lakebase.query` spans and `lakebase.*` metrics, **only with OTLP configured** | a real gain, obtainable with our own spans |
| Scope | Autoscaling (`/api/2.0/postgres/...`) | Autoscaling only (`docs/faq.md`) | same |

Decision: keep `server/db.js`. The planned row-level security with a per-transaction identity needs
`SET LOCAL` on a pool the app controls, and `asUser` would reintroduce per-user Postgres roles.
AppKit's pool is a `pg.Pool`, so adopting the plugin later stays possible and reversible.

**Lakebase Provisioned** is out of scope: the bundle and `db.js` only implement Autoscaling
(`postgres_projects`/`postgres_endpoints`), as does AppKit. Provisioned support would be a new
feature with its own ADR.

## Telemetry (OpenTelemetry)

How AppKit behaves (`dist/telemetry/telemetry-manager.js`, `docs/configuration.md`):

- Without `OTEL_EXPORTER_OTLP_ENDPOINT` **nothing is exported**: no meter or logger is
  created, and the tracer only starts if a plugin registers a processor.
- With the endpoint it exports traces, metrics and logs over OTLP/HTTP-proto; `service.name`
  comes from `OTEL_SERVICE_NAME` or `DATABRICKS_APP_NAME`. `server()` registers http/express
  auto-instrumentation (span names `METHOD /route`).
- `@opentelemetry/api` is in the bundle, so app code can call `trace.getTracer(...)`; without
  a global provider the spans are no-ops.
- How the Databricks Apps runtime hands an OTLP endpoint to the process is **open** until
  verified live.

Manual spans and attributes are specified in the operations work (follow-up below). Rule kept
from the spike: span attributes never carry an e-mail address, prompt text or raw SQL.

## Plugins

| Plugin | Fit | Why |
|---|---|---|
| `server()` | **yes** | owns the listener, `/health`, error handling; mounts our app without rewriting routes |
| `lakebase()` | **no** (see Lakebase) | only adds boot requirements; `asUser` conflicts with the single-role model |
| `files()` | candidate | named volumes could cover `imageStore`, but the current flow uses specific SP/OBO identities |
| `analytics()` | new screens only | needs named SQL in `config/queries/` with typegen; does not replace dynamic warehouse calls or UC Functions |
| `genie()` | does not replace | covers AI/BI spaces; AI Prism uses Genie One over MCP |
| `serving()` | does not replace `llm.js` | invoke/stream proxy; our loop needs tool calls, the cost ledger, routing and the gateway's OpenAI-compatible API |
| `jobs()`, `database()` (beta), `agents()` (beta) | out | no use case today / beta |
| Chat SSE loop, studios, artifacts, multi-model catalog | **stay in Express** | no plugin covers them |

## Consequences

- **Positive:** a standard boot with a JSON liveness endpoint (`/health`), request telemetry
  available once a collector exists, a base for `@databricks/appkit-ui` in new screens, and a
  rollback that is an `app.yaml` value, not a rebuild.
- **Negative:** `server-dist` grows from ≈ 8.6 MB to ≈ 21.3 MB while both paths ship. If AppKit
  starts calling `vite` or `@ast-grep/napi` in production, the stubs throw an explicit error
  (G-boot catches it at upgrade time). One more exact-pinned 0.x dependency.
- **Risks:** a forgotten `bodyLimit` (413 on large uploads; asserted on both paths); internal
  telemetry turned on by default upstream (kept off explicitly); `asUser` used by mistake
  (reintroduces per-user roles).

## Rollback

- **AppKit misbehaves in production:** set `APPKIT_BOOT` to `'0'` in `app.yaml` and redeploy
  the **same** build (no rebuild): the launcher boots `legacy.cjs`. Restoring `'1'` brings
  AppKit back. Whether the Apps runtime also lets an operator change the variable without a
  redeploy is checked during live validation.
- **The launcher itself:** a code rollback (revert this change and rebuild) restores the
  single legacy bundle.
- AppKit changes no schema or data, so no rollback depends on a database migration.

## Live validation (pending)

Before this boot is considered proven in production, a test workspace deploy must show:
`/health`, one real chat turn, a Lakebase connection under the AppKit boot, one Genie One
on-behalf-of-user call, and the runtime's `process.version`, replica count and any `OTEL_*`
variables it injects.

## Follow-ups

- `docs/operations.md` §6.2 (rollback) documents `APPKIT_BOOT=0` as the boot rollback
  (owned by the operations/telemetry task, not by this change).
- After one release on AppKit, remove the legacy boot path (`server/boot.cjs`, the listen
  branch in `server/index.js`, `legacy.cjs`); rollback then means redeploying the previous
  release. This also ends the duplicated bundle.
- Manual spans (`chat.turn`, `llm.call`, `tool.call`, `db.query`) on `@opentelemetry/api`.

## References

- Package docs: `node_modules/@databricks/appkit/docs/` (v0.76.1): `plugins/server.md`,
  `plugins/lakebase.md`, `configuration.md`, `faq.md`, `privacy.md`, `architecture.md`;
  `node_modules/@databricks/lakebase/README.md`.
- Code: `server/boot.cjs`, `server/appkit.js`, `server/index.js` (seam),
  `scripts/build-appkit.mjs`, `scripts/appkit/stubs/`, `tests/appkit-boot.test.mjs`,
  `app.yaml`, `.github/workflows/ci.yml` (G-boot).
