// AI Prism HTTP server: builds the Express app, installs the app-level
// middleware, mounts the route modules in order, then the static frontend and
// the final error handler, and listens. Route code lives in server/routes/ and
// server/turn.js; see "Server module map" in CONTRIBUTING.md.
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { setUsageSink } from './llm.ts'
import { bootModelsConfig } from './modelsConfig.ts'
import { startImageAvailabilityMonitoring } from './imageAvailability.ts'
import { recordUsage } from './usage.ts'
import { listenHost } from './requestIdentity.ts'
import { installMiddleware, finalErrorHandler } from './middleware/index.ts'
import registerAdminRoutes from './routes/admins.js'
import registerModelRoutes from './routes/models.js'
import registerSessionRoutes from './routes/sessions.js'
import registerToolsSearchRoutes from './routes/toolsSearch.js'
import registerMcpConnectionRoutes from './routes/mcpConnections.js'
import registerMcpCatalogRoutes from './routes/mcpCatalog.js'
import registerSkillRoutes from './routes/skills.js'
import registerDeckTemplateRoutes from './routes/deckTemplates.js'
import registerDeckRoutes from './routes/decks.js'
import registerImageRoutes from './routes/images.js'
import registerSpreadsheetRoutes from './routes/spreadsheets.js'
import registerDocumentRoutes from './routes/documents.js'
import registerTurnRoutes from './turn.ts'
import registerMessageRoutes from './routes/messages.js'
import registerStaticRoutes from './routes/static.js'
import registerHealthRoutes from './routes/health.js'
import registerCostRoutes from './routes/costs.js'
import registerWebSearchRoutes from './routes/webSearch.js'
import registerAdminSettingsRoutes from './routes/admin.js'
import registerProjectRoutes from './routes/projects.js'
import registerMemoryRoutes from './routes/memory.js'
import registerAdminUsageRoutes from './routes/adminUsage.js'
import registerAgentRoutes from './routes/agents.js'
import registerAdminAgentRoutes from './routes/adminAgents.js'
import registerMcpAppsRoutes from './routes/mcpApps.js'
import { startRetentionScheduler } from './retention.ts'
import { startAgentScheduler } from './scheduler/index.ts'
import { logger } from './log.ts'
import { APP_VERSION } from './version.ts'

// Resolve the app root for serving the built frontend. In the bundled CJS
// build, Node's native __dirname is the bundle's folder (server-dist/); in ESM
// dev we derive it from import.meta.url. `typeof __dirname` is safe in both.
// Kept in this entry file: both bundles (server-dist/index.cjs and the AppKit
// server-dist/appkit.mjs) sit one level below the root, like server/index.js.
function baseDir() {
  if (typeof __dirname !== 'undefined') return __dirname
  return path.dirname(fileURLToPath(import.meta.url))
}
const DIST = path.join(baseDir(), '..', 'client', 'dist')
const PORT = parseInt(process.env.PORT || '8000', 10)

// every gateway call made while serving a request is priced into the cost
// ledger (taxímetro) — see server/usage.js
setUsageSink(recordUsage)

// the deploy-time models.json (server/modelsConfig.ts): its models are registered now; the catalog is
// updated by the first admin request. Not under node --test, where the suites set their own catalog.
if (!process.env.NODE_TEST_CONTEXT) {
  bootModelsConfig()
  startImageAvailabilityMonitoring()
}

// which build is running: the first thing to check in an incident
logger.info(`AI Prism version ${APP_VERSION ?? 'unknown'}`)

const app = express()
installMiddleware(app)

// Route modules, mounted in this order. A new endpoint goes in a new
// server/routes/<name>.js appended to this list (one line). Each module
// registers its routes directly on `app`, not on an express.Router, so the
// app-wide :id/:messageId check from installMiddleware applies to them.
const routes = [
  registerAdminRoutes,
  registerModelRoutes,
  registerSessionRoutes,
  registerToolsSearchRoutes,
  registerMcpConnectionRoutes,
  registerMcpCatalogRoutes,
  registerSkillRoutes,
  registerDeckTemplateRoutes,
  registerDeckRoutes,
  registerImageRoutes,
  registerSpreadsheetRoutes,
  registerDocumentRoutes,
  registerTurnRoutes,
  registerMessageRoutes,
  registerHealthRoutes,
  registerCostRoutes,
  registerWebSearchRoutes,
  registerAdminSettingsRoutes,
  registerProjectRoutes,
  registerMemoryRoutes,
  registerAdminUsageRoutes,
  registerAgentRoutes,
  registerAdminAgentRoutes,
  registerMcpAppsRoutes,
]
for (const register of routes) register(app)

// the static frontend after every API route: its catch-all answers the rest
registerStaticRoutes(app, DIST)

// last: anything no route caught answers a generic JSON error (detail in the log)
app.use(finalErrorHandler())

// the daily retention sweep (server/retention.js; RETENTION_SWEEP=off disables
// it). Not under node --test: suites that import the app drive the sweep directly.
if (!process.env.NODE_TEST_CONTEXT) startRetentionScheduler()
// scheduled agents (server/scheduler/index.ts; off unless AGENTS_ENABLED=1, which also needs the admin's setting).
// No stop() on SIGTERM: this boot has no shutdown hook; a run cut off by a redeploy is failed as lease_expired by the
// next tick of any instance and never re-run (ADR-0018).
if (!process.env.NODE_TEST_CONTEXT) startAgentScheduler()

// APPKIT_BOOT=1: server/appkit.js (AppKit `createApp`) mounts this app inside
// AppKit's server plugin instead of listening here. Default boot path unchanged.
if (process.env.APPKIT_BOOT !== '1') {
  app.listen(PORT, listenHost(), () => {
    logger.info(`AI Prism listening on :${PORT}`)
  })
}

export { app }
