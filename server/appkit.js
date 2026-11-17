// AppKit bootstrap (Phase 1 spike, behind APPKIT_BOOT=1 — see docs/adr/0001-appkit.md).
//
// Strangler seam: AppKit's server plugin owns the HTTP listener, /health and the
// request-metrics/error middleware; our existing Express app (server/index.js) is
// mounted as a sub-application through `appkit.server.extend`, so no route is
// rewritten. Importing index.js registers every route on `app` (its own listen is
// skipped when APPKIT_BOOT=1).
import { createApp, server, lakebase } from '@databricks/appkit'
import { app as legacyApp } from './index.js'

const PORT = parseInt(process.env.PORT || '8000', 10)

await createApp({
  // Internal AppKit telemetry (usage pings to Databricks) is opt-out; keep it off.
  disableInternalTelemetry: true,
  plugins: [
    server({
      port: PORT,
      host: '0.0.0.0',
      // AppKit's express.json defaults to 1mb and runs BEFORE our app's parser.
      // Our routes accept up to 40mb (design-system bundle import), so match it
      // or large JSON bodies are rejected upstream with 413.
      bodyLimit: '40mb',
    }),
    // Lakebase plugin: SP pool only (no route uses asUser yet). Requires
    // LAKEBASE_ENDPOINT (or PGPASSWORD for local) + PGHOST/PGDATABASE/PGUSER.
    lakebase(),
  ],
  onPluginsReady(appkit) {
    appkit.server.extend((expressApp) => {
      expressApp.use(legacyApp)
    })
  },
})
