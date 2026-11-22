// W4-5: MCP Apps host, the server half (design-w4.md Part 2, §2.4).
//
//   AC1  off by default: no `extensions` capability in initialize, nothing captured
//   AC2  on: initialize carries extensions['io.modelcontextprotocol/ui'].mimeTypes = [MCP_APP_MIME], then
//        resources/read after the model's call; the staged record carries the HTML, the CSP and a sha256
//   AC3  an app-only tool is never offered to the model
//   AC4  buildViewCsp: the default, the declared lists, the 32-source cap, the app/workspace hosts, http:,
//        quotes, semicolons, paths, no 'self' outside frame-ancestors, no 'unsafe-eval'
//   AC7  a resource over 1 MiB, a wrong MIME or a timeout -> the plain tool result, a logged code, no record
//   AC9  under app_sp nothing is captured
//
//   node --test server/mcpApps.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  MCP_APP_MIME,
  MCP_APP_EXTENSION_ID,
  MCP_APPS_LIMITS,
  toolUiMeta,
  sanitizeCspDomains,
  buildViewCsp,
  sanitizeCsp,
  viewResponseHeaders,
  fetchUiResource,
  mcpAppsEnabled,
  isModelVisible,
  isAppVisible,
} from './mcpApps.ts'
import { listMcpServer } from './mcpClient.ts'
import { startMcpAppServer, APP_URI } from '../tests/helpers/mcpAppServer.mjs'
import { withRunIdentity } from './runIdentity.ts'

const HOSTS = { appHost: 'prism-123.aws.databricksapps.com', workspaceHost: 'adb-111.11.azuredatabricks.net' }
const EMPTY = { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }

// ---- constants -------------------------------------------------------------------------------------------------

test('the spec constants are copied as literals', () => {
  assert.equal(MCP_APP_MIME, 'text/html;profile=mcp-app')
  assert.equal(MCP_APP_EXTENSION_ID, 'io.modelcontextprotocol/ui')
  assert.deepEqual({ ...MCP_APPS_LIMITS }, { htmlMaxBytes: 1048576, structuredMaxBytes: 262144, sourcesPerDirective: 32, cspMaxChars: 4096, appsPerTurn: 4 })
})

// ---- toolUiMeta / visibility -----------------------------------------------------------------------------------

test('toolUiMeta reads a validated _meta.ui: ui:// uri, visibility defaults to both', () => {
  assert.deepEqual(toolUiMeta({ _meta: { ui: { resourceUri: 'ui://a/b.html' } } }), { resourceUri: 'ui://a/b.html', visibility: ['model', 'app'] })
  assert.deepEqual(toolUiMeta({ _meta: { ui: { resourceUri: 'ui://a/b.html', visibility: ['app'] } } }), { resourceUri: 'ui://a/b.html', visibility: ['app'] })
  assert.equal(toolUiMeta({}), null)
  assert.equal(toolUiMeta({ _meta: { ui: { resourceUri: 'https://evil/x.html' } } }), null, 'only ui://')
  assert.equal(toolUiMeta({ _meta: { ui: { resourceUri: 'ui://' + 'a'.repeat(520) } } }), null, 'uri over 512 chars')
  assert.equal(toolUiMeta({ _meta: { ui: { resourceUri: 'ui://a', visibility: ['sidecar'] } } }), null, 'unknown visibility')
  assert.equal(toolUiMeta({ _meta: { ui: { resourceUri: 'ui://a', visibility: [] } } }), null, 'empty visibility')
  assert.equal(toolUiMeta({ _meta: 'nope' }), null)
})

test('visibility: model-visible and app-visible predicates', () => {
  assert.equal(isModelVisible({ _meta: { ui: { resourceUri: 'ui://a', visibility: ['app'] } } }), false)
  assert.equal(isModelVisible({ _meta: { ui: { resourceUri: 'ui://a', visibility: ['model'] } } }), true)
  assert.equal(isModelVisible({}), true, 'a tool without UI meta is a normal tool')
  assert.equal(isAppVisible({ _meta: { ui: { resourceUri: 'ui://a', visibility: ['model'] } } }), false)
  assert.equal(isAppVisible({ _meta: { ui: { resourceUri: 'ui://a' } } }), true)
  assert.equal(isAppVisible({}), false, 'a tool with no UI meta is not callable from a View')
})

// ---- sanitizeCspDomains / buildViewCsp -------------------------------------------------------------------------

test('sanitizeCspDomains keeps https origins and https://*.host, lowercased, deduped', () => {
  assert.deepEqual(sanitizeCspDomains(['https://CDN.Example.com', 'https://cdn.example.com', 'https://*.example.org', 'https://api.example.com:8443'], HOSTS), [
    'https://cdn.example.com',
    'https://*.example.org',
    'https://api.example.com:8443',
  ])
  assert.deepEqual(sanitizeCspDomains('nope', HOSTS), [])
  assert.deepEqual(sanitizeCspDomains(undefined, HOSTS), [])
})

test('sanitizeCspDomains refuses the app and workspace hosts and Databricks hosts', () => {
  const out = sanitizeCspDomains(
    [
      `https://${HOSTS.appHost}`,
      `https://${HOSTS.workspaceHost}`,
      'https://other.databricksapps.com',
      'https://*.databricksapps.com',
      'https://dbc-1.cloud.databricks.com',
      'https://*.cloud.databricks.com',
      'https://*.aws.databricksapps.com',
      'https://ok.example.com',
    ],
    HOSTS
  )
  assert.deepEqual(out, ['https://ok.example.com'])
})

test('sanitizeCspDomains refuses a wildcard that covers the app or workspace host, and a bare TLD wildcard', () => {
  assert.deepEqual(sanitizeCspDomains(['https://*.databricksapps.com', 'https://*.azuredatabricks.net', 'https://*.net', 'https://*.com'], HOSTS), [])
})

test('sanitizeCspDomains refuses http:, schemes, quotes, semicolons, whitespace, paths, queries, userinfo', () => {
  const bad = [
    'http://example.com',
    'ws://example.com',
    'wss://example.com',
    'data:',
    '*',
    "'self'",
    "https://ex'ample.com",
    'https://example.com;script-src *',
    'https://example.com script-src',
    'https://example.com/path',
    'https://example.com/',
    'https://example.com?x=1',
    'https://user@example.com',
    'https://exa mple.com',
    'https://',
    'https://*',
    'https://a.*.example.com',
    'example.com',
    42,
    null,
    { a: 1 },
  ]
  assert.deepEqual(sanitizeCspDomains(bad, HOSTS), [])
})

test('sanitizeCspDomains caps a directive at 32 sources', () => {
  const many = Array.from({ length: 80 }, (_, i) => `https://h${i}.example.com`)
  const out = sanitizeCspDomains(many, HOSTS)
  assert.equal(out.length, MCP_APPS_LIMITS.sourcesPerDirective)
  assert.equal(out[0], 'https://h0.example.com')
})

test('buildViewCsp with no declared domains is the strict default, exactly', () => {
  assert.equal(
    buildViewCsp(EMPTY),
    "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'self'"
  )
})

test('buildViewCsp puts the declared lists in the directives they belong to', () => {
  const csp = buildViewCsp(
    { connectDomains: ['https://api.example.com'], resourceDomains: ['https://cdn.example.com', 'https://*.fonts.example.org'], frameDomains: ['https://embed.example.com'], baseUriDomains: ['https://base.example.com'] },
    HOSTS
  )
  assert.match(csp, /^sandbox allow-scripts allow-forms; default-src 'none';/)
  assert.match(csp, /script-src 'unsafe-inline' https:\/\/cdn\.example\.com https:\/\/\*\.fonts\.example\.org;/)
  assert.match(csp, /style-src 'unsafe-inline' https:\/\/cdn\.example\.com https:\/\/\*\.fonts\.example\.org;/)
  assert.match(csp, /img-src data: blob: https:\/\/cdn\.example\.com/)
  assert.match(csp, /font-src data: https:\/\/cdn\.example\.com/)
  assert.match(csp, /media-src data: blob: https:\/\/cdn\.example\.com/)
  assert.match(csp, /connect-src https:\/\/api\.example\.com;/)
  assert.match(csp, /form-action https:\/\/api\.example\.com;/)
  assert.match(csp, /frame-src https:\/\/embed\.example\.com;/)
  assert.match(csp, /base-uri https:\/\/base\.example\.com;/)
  assert.match(csp, /object-src 'none'; frame-ancestors 'self'$/)
})

test("buildViewCsp never emits 'self' (except frame-ancestors), 'unsafe-eval', allow-same-origin, or a refused source", () => {
  const csp = buildViewCsp(
    {
      connectDomains: [`https://${HOSTS.appHost}`, 'http://plain.example.com', "https://q'uote.example.com", 'https://semi.example.com;x', 'https://path.example.com/a', 'https://ok.example.com'],
      resourceDomains: [`https://${HOSTS.workspaceHost}`, 'https://*.databricksapps.com', "'self'", "'unsafe-eval'", '*'],
      frameDomains: [],
      baseUriDomains: [],
    },
    HOSTS
  )
  const withoutAncestors = csp.replace("frame-ancestors 'self'", '')
  assert.equal(withoutAncestors.includes("'self'"), false)
  assert.equal(csp.includes('unsafe-eval'), false)
  assert.equal(csp.includes('allow-same-origin'), false)
  assert.equal(csp.includes(HOSTS.appHost), false)
  assert.equal(csp.includes(HOSTS.workspaceHost), false)
  assert.equal(csp.includes('databricksapps'), false)
  assert.equal(csp.includes('http://'), false)
  assert.match(csp, /connect-src https:\/\/ok\.example\.com;/)
  assert.match(csp, /script-src 'unsafe-inline';/, 'every refused resource source is dropped, the directive stays')
})

test('buildViewCsp: 32 sources per directive', () => {
  const many = Array.from({ length: 200 }, (_, i) => `https://h${i}.example.com`)
  const csp = buildViewCsp({ connectDomains: many, resourceDomains: many, frameDomains: many, baseUriDomains: many }, HOSTS)
  const connect = /connect-src ([^;]*);/.exec(csp)![1]!.split(' ')
  assert.equal(connect.length, 32)
})

test('the declared lists together stay under 4096 characters (later entries are dropped first)', () => {
  const long = Array.from({ length: 32 }, (_, i) => `https://${'a'.repeat(60)}.${'b'.repeat(60)}.h${i}.example.com`)
  const c = sanitizeCsp({ connectDomains: long, resourceDomains: long, frameDomains: long, baseUriDomains: long }, HOSTS)
  const total = [...c.connectDomains, ...c.resourceDomains, ...c.frameDomains, ...c.baseUriDomains].reduce((n, d) => n + d.length + 1, 0)
  assert.ok(total <= MCP_APPS_LIMITS.cspMaxChars, `declared ${total} chars`)
  assert.ok(c.connectDomains.length > 0, 'the first list is served first')
  assert.deepEqual(c.baseUriDomains, [], 'the last list is the first to go')
})

test('viewResponseHeaders is exactly the section 2.4 header set, with the CSP from buildViewCsp', () => {
  const csp = { ...EMPTY, connectDomains: ['https://api.example.com'] }
  const h = viewResponseHeaders(csp, HOSTS)
  assert.deepEqual(h, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': buildViewCsp(csp, HOSTS),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  })
})

// ---- mcpAppsEnabled --------------------------------------------------------------------------------------------

test('mcpAppsEnabled: off unless the admin turned it on, the env kill-switch wins', () => {
  assert.equal(mcpAppsEnabled({}, {}), false)
  assert.equal(mcpAppsEnabled({}, { mcpAppsEnabled: false }), false)
  assert.equal(mcpAppsEnabled({}, { mcpAppsEnabled: true }), true)
  assert.equal(mcpAppsEnabled({ MCP_APPS_DISABLED: '1' }, { mcpAppsEnabled: true }), false)
  assert.equal(mcpAppsEnabled({ MCP_APPS_DISABLED: '0' }, { mcpAppsEnabled: true }), true)
})

// ---- the handshake (AC1, AC2) ----------------------------------------------------------------------------------

test('AC1 off: initialize carries no extensions capability', async () => {
  const fx = await startMcpAppServer()
  try {
    const listed = await listMcpServer(fx.url, 't')
    assert.equal(fx.initializeCapabilities?.extensions, undefined)
    assert.ok(listed.tools.length >= 3)
  } finally {
    await fx.close()
  }
})

test('AC2 on: initialize carries extensions[io.modelcontextprotocol/ui].mimeTypes = [MCP_APP_MIME]; _meta.ui is kept on listed tools', async () => {
  const fx = await startMcpAppServer()
  try {
    const listed = await listMcpServer(fx.url, 't', { ui: true })
    assert.deepEqual(fx.initializeCapabilities?.extensions?.['io.modelcontextprotocol/ui'], { mimeTypes: [MCP_APP_MIME] })
    const chart = listed.tools.find((t) => t.name === 'show_chart')!
    assert.deepEqual(toolUiMeta(chart), { resourceUri: APP_URI, visibility: ['model', 'app'] })
    const plain = listed.tools.find((t) => t.name === 'plain')!
    assert.equal(toolUiMeta(plain), null)
  } finally {
    await fx.close()
  }
})

// ---- fetchUiResource (AC2, AC7) --------------------------------------------------------------------------------

const FETCH_OPTS = { serviceName: 'main.apps.chart', toolName: 'show_chart', ...HOSTS }

test('AC2 fetchUiResource reads the resource and returns the record with sha256 and the sanitized csp', async () => {
  const csp = { connectDomains: ['https://api.example.com', 'http://bad.example.com'], resourceDomains: [`https://${HOSTS.appHost}`, 'https://cdn.example.com'] }
  const fx = await startMcpAppServer({ csp, prefersBorder: false })
  try {
    const r = await fetchUiResource(fx.url, 't', APP_URI, { ...FETCH_OPTS, structuredContent: { points: [1] } })
    assert.ok(!('error' in r), JSON.stringify(r))
    assert.equal(r.v, 1)
    assert.equal(r.uri, APP_URI)
    assert.equal(r.serviceName, 'main.apps.chart')
    assert.equal(r.toolName, 'show_chart')
    assert.match(r.html, /hello from the view/)
    assert.equal(r.sha256, createHash('sha256').update(r.html).digest('hex'))
    assert.deepEqual(r.csp, { connectDomains: ['https://api.example.com'], resourceDomains: ['https://cdn.example.com'], frameDomains: [], baseUriDomains: [] })
    assert.equal(r.prefersBorder, false)
    assert.deepEqual(r.structuredContent, { points: [1] })
    assert.ok(!Number.isNaN(Date.parse(r.fetchedAt)))
    assert.deepEqual(fx.reads, [APP_URI])
  } finally {
    await fx.close()
  }
})

test('AC7 fetchUiResource: wrong MIME, over 1 MiB, a timeout and a server error each give a code and no record', async () => {
  const wrong = await startMcpAppServer({ mimeType: 'text/html' })
  const big = await startMcpAppServer({ extraBytes: MCP_APPS_LIMITS.htmlMaxBytes })
  const slow = await startMcpAppServer({ readDelayMs: 1500 })
  const broken = await startMcpAppServer({ readError: true })
  try {
    assert.deepEqual(await fetchUiResource(wrong.url, 't', APP_URI, FETCH_OPTS), { error: 'mime' })
    assert.deepEqual(await fetchUiResource(big.url, 't', APP_URI, FETCH_OPTS), { error: 'size' })
    assert.deepEqual(await fetchUiResource(slow.url, 't', APP_URI, { ...FETCH_OPTS, timeoutMs: 200 }), { error: 'timeout' })
    const e = await fetchUiResource(broken.url, 't', APP_URI, FETCH_OPTS)
    assert.ok('error' in e && (e.error === 'rpc' || e.error === 'not_found'))
  } finally {
    await Promise.all([wrong.close(), big.close(), slow.close(), broken.close()])
  }
})

test('structuredContent over 256 KiB is not kept (the View still gets the text content)', async () => {
  const fx = await startMcpAppServer()
  try {
    const huge = { blob: 'x'.repeat(MCP_APPS_LIMITS.structuredMaxBytes + 10) }
    const r = await fetchUiResource(fx.url, 't', APP_URI, { ...FETCH_OPTS, structuredContent: huge })
    assert.ok(!('error' in r))
    assert.equal(r.structuredContent, null)
  } finally {
    await fx.close()
  }
})

// ---- the tool path: buildToolDefs / invokeTool (AC1, AC2, AC3, AC7, AC9) ---------------------------------------

process.env.DATABRICKS_HOST ||= 'https://adb-111.11.azuredatabricks.net'
const { buildToolDefs, invokeTool } = await import('./tools.ts')
const { primeMcpServerCache } = await import('./mcpClient.ts')

const A = 'ana@test.invalid'
const REF = { kind: 'mcp-external', connectionName: 'main.apps.chart' }
const admit = () => ({ ok: true, credentialClass: 'per_user' })

// The tools' URL is derived from DATABRICKS_HOST; the fixture listens on loopback, so point the host at it per test.
async function withFixture<T>(opts: Parameters<typeof startMcpAppServer>[0], fn: (fx: Awaited<ReturnType<typeof startMcpAppServer>>) => Promise<T>): Promise<T> {
  const fx = await startMcpAppServer(opts)
  const prev = process.env.DATABRICKS_HOST
  process.env.DATABRICKS_HOST = fx.origin
  try {
    return await fn(fx)
  } finally {
    process.env.DATABRICKS_HOST = prev
    await fx.close()
  }
}

let seq = 0
const uniqueEmail = () => `w45-${++seq}-${Date.now()}@test.invalid` // the per-user listing cache is keyed by e-mail

test('AC3 an app-only tool is never offered to the model; a model-visible UI tool is', async () => {
  await withFixture({}, async () => {
    const email = uniqueEmail()
    const { tools } = await buildToolDefs([REF], 't', email, { includePython: false, mcpAdmission: admit, mcpApps: true })
    const names = tools.map((t: any) => t.function.name)
    assert.ok(names.some((n: string) => n.endsWith('__show_chart')))
    assert.ok(names.some((n: string) => n.endsWith('__plain')))
    assert.ok(names.some((n: string) => n.endsWith('__model_only')))
    assert.equal(names.some((n: string) => n.endsWith('__refresh_data')), false, 'visibility ["app"] stays out of the model tool list')
  })
})

test('AC1 off: no capability, no capture, no resources/read; an app-only tool stays hidden from the model either way', async () => {
  await withFixture({}, async (fx) => {
    const email = uniqueEmail()
    const { tools, resolvers } = await buildToolDefs([REF], 't', email, { includePython: false, mcpAdmission: admit, mcpApps: false })
    assert.equal(fx.initializeCapabilities?.extensions, undefined)
    assert.equal(tools.some((t: any) => t.function.name.endsWith('__refresh_data')), false)
    const chart = tools.find((t: any) => t.function.name.endsWith('__show_chart'))!
    const uiCapture = { count: 0 }
    const out = await invokeTool('t', resolvers.get(chart.function.name)!, { series: 'a' }, { email, uiCapture })
    assert.equal(out.uiResource, undefined)
    assert.deepEqual(fx.reads, [], 'no resources/read when off')
  })
})

test('AC2 on: after the model call the host reads the resource and stages the record; the tool text is unchanged', async () => {
  await withFixture({ csp: { connectDomains: ['https://api.example.com'] } }, async (fx) => {
    const email = uniqueEmail()
    const { tools, resolvers } = await buildToolDefs([REF], 't', email, { includePython: false, mcpAdmission: admit, mcpApps: true })
    assert.deepEqual(fx.initializeCapabilities?.extensions?.['io.modelcontextprotocol/ui'], { mimeTypes: [MCP_APP_MIME] })
    const chart = tools.find((t: any) => t.function.name.endsWith('__show_chart'))!
    const uiCapture = { count: 0 }
    const out = await invokeTool('t', resolvers.get(chart.function.name)!, { series: 'a' }, { email, uiCapture })
    assert.equal(out.resultText, 'chart ready')
    assert.equal(out.uiResource?.uri, APP_URI)
    assert.equal(out.uiResource?.serviceName, 'main.apps.chart')
    assert.equal(out.uiResource?.toolName, 'show_chart')
    assert.deepEqual(out.uiResource?.csp.connectDomains, ['https://api.example.com'])
    assert.deepEqual(out.uiResource?.structuredContent, { points: [1, 2, 3] })
    assert.equal(uiCapture.count, 1)
    assert.deepEqual(fx.reads, [APP_URI])
    // a tool with no UI meta is a plain call
    const plain = tools.find((t: any) => t.function.name.endsWith('__plain'))!
    const p = await invokeTool('t', resolvers.get(plain.function.name)!, {}, { email, uiCapture })
    assert.equal(p.uiResource, undefined)
  })
})

test('at most 4 Apps are captured per turn; the fifth is a plain result', async () => {
  await withFixture({}, async (fx) => {
    const email = uniqueEmail()
    const { tools, resolvers } = await buildToolDefs([REF], 't', email, { includePython: false, mcpAdmission: admit, mcpApps: true })
    const chart = tools.find((t: any) => t.function.name.endsWith('__show_chart'))!
    const uiCapture = { count: 0 }
    const got: boolean[] = []
    for (let i = 0; i < 6; i++) got.push(!!(await invokeTool('t', resolvers.get(chart.function.name)!, {}, { email, uiCapture })).uiResource)
    assert.deepEqual(got, [true, true, true, true, false, false])
    assert.equal(fx.reads.length, 4)
  })
})

test('AC9 under app_sp nothing is captured (no resources/read) and no capability is advertised', async () => {
  await withFixture({}, async (fx) => {
    const email = uniqueEmail()
    await withRunIdentity({ runAs: 'app_sp' }, async () => {
      const refDatabricks = { ...REF }
      const { tools, resolvers } = await buildToolDefs([refDatabricks], 't', email, { includePython: false, mcpAdmission: () => ({ ok: true, credentialClass: 'databricks' }), mcpApps: true })
      assert.equal(fx.initializeCapabilities?.extensions, undefined)
      const chart = tools.find((t: any) => t.function.name.endsWith('__show_chart'))!
      const out = await invokeTool('t', resolvers.get(chart.function.name)!, {}, { email, uiCapture: { count: 0 } })
      assert.equal(out.uiResource, undefined)
      assert.deepEqual(fx.reads, [])
    })
  })
})

test('AC7 a bad resource leaves the plain tool result and stages nothing', async () => {
  for (const opts of [{ mimeType: 'text/html' }, { extraBytes: MCP_APPS_LIMITS.htmlMaxBytes }, { readError: true }]) {
    await withFixture(opts, async () => {
      const email = uniqueEmail()
      const { tools, resolvers } = await buildToolDefs([REF], 't', email, { includePython: false, mcpAdmission: admit, mcpApps: true })
      const chart = tools.find((t: any) => t.function.name.endsWith('__show_chart'))!
      const uiCapture = { count: 0 }
      const out = await invokeTool('t', resolvers.get(chart.function.name)!, {}, { email, uiCapture })
      assert.equal(out.resultText, 'chart ready')
      assert.equal(out.uiResource, undefined)
      assert.equal(uiCapture.count, 0)
    })
  }
})

test('the listing cache keeps apps-on and apps-off listings apart (key suffix :ui1)', async () => {
  await withFixture({}, async (fx) => {
    const email = uniqueEmail()
    primeMcpServerCache(fx.url, email, { tools: [], instructions: '' })
    await buildToolDefs([REF], 't', email, { includePython: false, mcpAdmission: admit, mcpApps: true })
    assert.deepEqual(fx.initializeCapabilities?.extensions?.['io.modelcontextprotocol/ui'], { mimeTypes: [MCP_APP_MIME] }, 'the off-listing primed above is not reused for apps-on')
  })
})
