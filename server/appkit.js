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
import { listenHost } from './requestIdentity.js'

// index.js listens on its own unless APPKIT_BOOT=1. Set it before index.js is
// evaluated (hence the dynamic import: static imports are hoisted), or the legacy
// listener and AppKit would both try to bind PORT (ADR 0001 E11).
process.env.APPKIT_BOOT = '1'
const { app: legacyApp } = await import('./index.js')

const PORT = parseInt(process.env.PORT || '8000', 10)

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
      // AppKit's express.json defaults to 1mb and runs BEFORE our app's parser.
      // Our routes accept up to 40mb (design-system bundle import), so match it
      // or large JSON bodies are rejected upstream with 413.
      bodyLimit: '40mb',
    }),
  ],
  onPluginsReady(appkit) {
    appkit.server.extend((expressApp) => {
      expressApp.use(legacyApp)
    })
  },
})
