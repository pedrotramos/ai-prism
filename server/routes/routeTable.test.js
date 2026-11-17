// Characterization test of the HTTP surface: the full route table (method,
// path and the middleware chain of each route) and the order of the app-level
// middleware. Splitting server/index.js into modules must not add, drop or
// re-guard a single route, so any change here has to be deliberate.
//
// Imports the app without listening (APPKIT_BOOT=1) and without a database:
// registering routes touches no Postgres or workspace.
//
//   node --test server/routes/routeTable.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.APPKIT_BOOT = '1'
process.env.LOCAL_DEV_MODE = '1'

const { app } = await import('../index.js')

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist')

const name = (fn) => fn.name || '<anonymous>'

function routeLines() {
  const out = []
  for (const layer of app._router.stack) {
    if (!layer.route) continue
    const chain = layer.route.stack.map(name).join(',')
    for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${layer.route.path} [${chain}]`)
  }
  return out
}

// every route, sorted; the chain shows auth/requireAdmin/upload guards per route
const EXPECTED_ROUTES = [
  'DELETE /api/admin/mcp-catalog/:name [auth,requireAdmin,<anonymous>]',
  'DELETE /api/admins/:principal [auth,requireAdmin,<anonymous>]',
  'DELETE /api/deck-templates/:id [auth,<anonymous>]',
  'DELETE /api/mcp/connections/:name [auth,<anonymous>]',
  'DELETE /api/sessions/:id [auth,<anonymous>]',
  'DELETE /api/skills/:id [auth,<anonymous>]',
  'GET * [<anonymous>]',
  'GET /api/admin/mcp-catalog [auth,requireAdmin,<anonymous>]',
  'GET /api/admin/model-endpoints [auth,requireAdmin,<anonymous>]',
  'GET /api/admins [auth,requireAdmin,<anonymous>]',
  'GET /api/admins/candidates [auth,requireAdmin,<anonymous>]',
  'GET /api/deck-templates [auth,<anonymous>]',
  'GET /api/deck-templates/:id [auth,<anonymous>]',
  'GET /api/deck-templates/selected [auth,<anonymous>]',
  'GET /api/decks/:id [auth,<anonymous>]',
  'GET /api/documents/:id [auth,<anonymous>]',
  'GET /api/documents/:id/export [auth,<anonymous>]',
  'GET /api/image-models [auth,<anonymous>]',
  'GET /api/images/:id [auth,<anonymous>]',
  'GET /api/keepalive [auth,<anonymous>]',
  'GET /api/mcp/connections [auth,<anonymous>]',
  'GET /api/me [auth,<anonymous>]',
  'GET /api/models [auth,<anonymous>]',
  'GET /api/search [auth,<anonymous>]',
  'GET /api/sessions [auth,<anonymous>]',
  'GET /api/sessions/:id/messages [auth,<anonymous>]',
  'GET /api/skills [auth,<anonymous>]',
  'GET /api/skills/:id [auth,<anonymous>]',
  'GET /api/spreadsheets/:id [auth,<anonymous>]',
  'GET /api/spreadsheets/:id/export [auth,<anonymous>]',
  'GET /api/tool-policy [auth,<anonymous>]',
  'GET /api/tools/genie/search [auth,<anonymous>]',
  'GET /api/tools/mcp/external/search [auth,<anonymous>]',
  'GET /api/tools/search [auth,<anonymous>]',
  'GET /api/tools/vector-search/search [auth,<anonymous>]',
  'GET /api/usage/summary [auth,<anonymous>]',
  'PATCH /api/deck-templates/:id [auth,<anonymous>]',
  'PATCH /api/decks/:id [auth,<anonymous>]',
  'PATCH /api/documents/:id [auth,<anonymous>]',
  'PATCH /api/messages/:id/activate [auth,<anonymous>]',
  'PATCH /api/sessions/:id [auth,<anonymous>]',
  'PATCH /api/spreadsheets/:id [auth,<anonymous>]',
  'POST /api/admin/mcp-catalog/inspect [auth,requireAdmin,<anonymous>]',
  'POST /api/admins [auth,requireAdmin,<anonymous>]',
  'POST /api/chat [auth,multerMiddleware,rebindUsageScope,<anonymous>]',
  'POST /api/deck-templates [auth,<anonymous>]',
  'POST /api/deck-templates/:id/scope [auth,requireAdmin,<anonymous>]',
  'POST /api/deck-templates/:id/select [auth,<anonymous>]',
  'POST /api/deck-templates/label-assets [auth,<anonymous>]',
  'POST /api/decks/:id/export-html [auth,<anonymous>]',
  'POST /api/decks/:id/tweak [auth,<anonymous>]',
  'POST /api/documents/:id/tweak [auth,<anonymous>]',
  'POST /api/mcp/connections/:name [auth,<anonymous>]',
  'POST /api/mcp/connections/:name/probe [auth,<anonymous>]',
  'POST /api/sessions/:id/compact [auth,<anonymous>]',
  'POST /api/sessions/:id/continue [auth,<anonymous>]',
  'POST /api/sessions/:id/messages/:messageId/edit [auth,<anonymous>]',
  'POST /api/sessions/:id/messages/:messageId/question-answers [auth,<anonymous>]',
  'POST /api/sessions/:id/messages/:messageId/regenerate [auth,<anonymous>]',
  'POST /api/skills [auth,writeSkillHandler]',
  'POST /api/skills/upload [auth,multerMiddleware,rebindUsageScope,<anonymous>]',
  'POST /api/spreadsheets/:id/tweak [auth,<anonymous>]',
  'PUT /api/admin/mcp-catalog/:name [auth,requireAdmin,<anonymous>]',
  'PUT /api/admin/model-endpoints-order [auth,requireAdmin,<anonymous>]',
  'PUT /api/admin/model-endpoints/:endpointId [auth,requireAdmin,<anonymous>]',
  'PUT /api/admin/tool-policy/:key [auth,requireAdmin,<anonymous>]',
  'PUT /api/image-models/selected [auth,<anonymous>]',
  'PUT /api/skills/:id [auth,<anonymous>]',
]

test('route table: same routes with the same middleware chain', () => {
  assert.deepEqual([...routeLines()].sort(), EXPECTED_ROUTES)
})

test('route table: no duplicate method+path', () => {
  const keys = routeLines().map((l) => l.replace(/ \[.*$/, ''))
  assert.equal(new Set(keys).size, keys.length)
})

test('app middleware: installed in order (CSRF guard before body parsing)', () => {
  const layers = app._router.stack.filter((l) => !l.route).map((l) => name(l.handle))
  // requestId/security are pass-through placeholders (server/middleware/) until
  // the request-id and rate/body-limit work fills them
  const expected = [
    'query',
    'expressInit',
    'requestIdMiddleware',
    'securityHeadersMiddleware',
    'securityMiddleware',
    'csrfGuardMiddleware',
    'jsonParser',
  ]
  if (fs.existsSync(DIST)) expected.push('serveStatic')
  expected.push('finalErrorHandlerMiddleware')
  assert.deepEqual(layers, expected)
  const csrf = app._router.stack.find((l) => name(l.handle) === 'csrfGuardMiddleware')
  assert.ok(csrf.regexp.test('/api/chat'), 'CSRF guard is mounted on /api')
  assert.ok(!csrf.regexp.test('/index.html'), 'CSRF guard is not mounted on the static frontend')
})

test('app middleware: numeric :id / :messageId params are validated app-wide', () => {
  assert.deepEqual(Object.keys(app._router.params).sort(), ['id', 'messageId'])
})

test('static catch-all comes after every API route; the error handler is last', { skip: !fs.existsSync(DIST) && 'client/dist not built' }, () => {
  const stack = app._router.stack
  const catchAll = stack.findIndex((l) => l.route?.path === '*')
  const lastApi = stack.findLastIndex((l) => l.route?.path?.startsWith('/api/'))
  assert.ok(catchAll > lastApi, 'GET * is registered after the last /api route')
  assert.equal(name(stack[catchAll - 1].handle), 'serveStatic')
  assert.equal(name(stack[stack.length - 1].handle), 'finalErrorHandlerMiddleware')
})
