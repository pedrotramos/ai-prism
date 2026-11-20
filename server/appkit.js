// AppKit bootstrap — the default boot path (docs/adr/0001-appkit.md).
//
// Strangler seam: AppKit's server plugin owns the HTTP listener, /health and the
// request-metrics/error middleware; our existing Express app (server/index.js) is
// mounted as a sub-application through `appkit.server.extend`, so no route is
// rewritten.
//
// Production: server-dist/index.cjs (server/boot.cjs) imports the bundled copy of
// this file unless APPKIT_BOOT=0. Dev: `node server/appkit.js`.
import { createApp, server } from '@databricks/appkit'
import { listenHost } from './requestIdentity.ts'
import { requestIdHeader } from './middleware/requestId.js'
import { logger } from './log.js'
import { APPKIT_BODY_LIMIT } from './middleware/security.js'

// index.js listens on its own unless APPKIT_BOOT=1. Set it before index.js is
// evaluated (hence the dynamic import: static imports are hoisted), or the legacy
// listener and AppKit would both try to bind PORT (ADR 0001 E11).
process.env.APPKIT_BOOT = '1'
const { app: legacyApp } = await import('./index.js')

const PORT = parseInt(process.env.PORT || '8000', 10)

// Moves a middleware to the front of an Express 4 app's router stack (after
// Express's own query/init layers). AppKit offers no hook that runs before its
// routes; tests/appkit-boot.test.mjs asserts the header on AppKit's /health, so
// an AppKit upgrade that changes this layout fails the boot gate, not silently.
export function prependMiddleware(expressApp, fn) {
  expressApp.use(fn)
  const stack = expressApp._router?.stack
  const i = stack ? stack.findIndex((l) => l.handle === fn) : -1
  if (i < 0) {
    logger.warn('appkit: could not move the request-id layer ahead of AppKit routes; its own responses lack x-request-id')
    return
  }
  const [layer] = stack.splice(i, 1)
  const at = stack.findIndex((l) => l.name !== 'query' && l.name !== 'expressInit')
  stack.splice(at < 0 ? stack.length : at, 0, layer)
}

await createApp({
  // Internal AppKit telemetry (usage pings to Databricks) is opt-out; keep it off:
  // it is metadata egress out of the customer's workspace (ADR 0001, decision 7).
  disableInternalTelemetry: true,
  // No lakebase() plugin: server/db.js owns the Postgres pool (one SP role,
  // per-user isolation in SQL); the plugin would only add boot requirements
  // (PGPORT/PGSSLMODE/LAKEBASE_ENDPOINT) and its asUser() means one PG role per
  // user (ADR 0001, Lakebase).
  plugins: [
    server({
      port: PORT,
      // same rule as the legacy listener: loopback only while the dev identity
      // fallback is on, all interfaces in the Apps runtime
      host: listenHost(),
      // AppKit's express.json defaults to 1mb and runs BEFORE our app's parser,
      // on every route. It has to admit the largest body-limit class (the deck
      // studio's 48 MiB); the per-route limits in middleware/security.js then
      // apply from Content-Length (chunked JSON gets 411). This value is also
      // the raw-parse memory bound per request under this boot.
      bodyLimit: APPKIT_BODY_LIMIT,
    }),
  ],
  onPluginsReady(appkit) {
    appkit.server.extend((expressApp) => {
      // AppKit registers its own GET /health (and its body parser) before it
      // runs any extension, so a plain use() here would come after them. Put
      // the request-id header layer at the very front of AppKit's stack: every
      // response, AppKit's included, carries x-request-id (QA W1-3, AC2).
      prependMiddleware(expressApp, requestIdHeader())
      expressApp.use(legacyApp)
    })
  },
})
