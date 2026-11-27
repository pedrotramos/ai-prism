// G-boot: the deployed entrypoint `node server-dist/index.cjs` boots AppKit by
// default and the legacy Express listener with APPKIT_BOOT=0 (ADR 0001).
//
// The artifacts run the way the Apps runtime runs them: copied into a folder
// with no node_modules anywhere above it, next to a client/dist, with
// cwd = app root. AppKit's boot calls the workspace (SCIM /Me, which must
// answer with an x-databricks-org-id header — ADR 0001 E7), so a mock
// workspace on 127.0.0.1 stands in for it. No Postgres is needed: boot never
// opens a connection (pg.Pool is lazy) and the lakebase() plugin is not used.
//
//   node --test tests/appkit-boot.test.mjs
//       builds the three entrypoints into a temp folder (scripts/build-appkit.mjs)
//   APPKIT_BOOT_DIST=server-dist node --test tests/appkit-boot.test.mjs
//       checks an existing build instead (the CI G-boot step, after npm run bundle)
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MB = 1024 * 1024
const BOOT_TIMEOUT_MS = 45_000
const SPA_MARKER = 'appkit-boot-test-spa'
const PKG_VERSION = JSON.parse(readFileSync(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'package.json'), 'utf8')).version
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ORG_ID = '1234567890123456'
// Databricks Apps rejects a deploy when ANY app file is over 10 MB ("App files
// can't exceed 10 MB", docs.databricks.com/.../databricks-apps/app-development).
// Fail at 9.5 MB so CI warns before the platform refuses the deploy.
const FILE_LIMIT_BYTES = 10_000_000
const FILE_GATE_BYTES = 9_500_000

const work = mkdtempSync(path.join(tmpdir(), 'ai-prism-boot-'))
let distDir

async function buildDist() {
  if (process.env.APPKIT_BOOT_DIST) return path.resolve(ROOT, process.env.APPKIT_BOOT_DIST)
  const mod = await import('../scripts/build-appkit.mjs')
  assert.equal(typeof mod.buildServer, 'function', 'scripts/build-appkit.mjs must export buildServer({ outdir })')
  const outdir = path.join(work, 'build')
  await mod.buildServer({ outdir })
  return outdir
}

/** Every file the build wrote (server-dist is flat). */
function distFiles() {
  return readdirSync(distDir, { withFileTypes: true }).map((e) => {
    assert.ok(e.isFile(), `server-dist must stay flat (chunks resolve client/dist and migrations from their own folder): ${e.name}`)
    return e.name
  })
}

/** An app root like the deployed one: server-dist/<files> + client/dist, nothing else. */
function deployDir(name, files) {
  const dir = path.join(work, name)
  mkdirSync(path.join(dir, 'server-dist'), { recursive: true })
  for (const f of files) cpSync(path.join(distDir, f), path.join(dir, 'server-dist', f))
  mkdirSync(path.join(dir, 'client', 'dist'), { recursive: true })
  writeFileSync(path.join(dir, 'client', 'dist', 'index.html'), `<!doctype html><html><body><div id="root"></div><!-- ${SPA_MARKER} --></body></html>`)
  return dir
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

/** Workspace stand-in: SCIM /Me with the org-id header; records every request. */
async function startMockWorkspace() {
  const requests = []
  const srv = createServer((req, res) => {
    requests.push(`${req.method} ${req.url.split('?')[0]}`)
    if (req.method === 'GET' && req.url.startsWith('/api/2.0/preview/scim/v2/Me')) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-databricks-org-id': ORG_ID })
      res.end(JSON.stringify({ id: '42', userName: 'boot-test@example.com', displayName: 'Boot Test', active: true, emails: [{ value: 'boot-test@example.com', primary: true }] }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error_code: 'NOT_FOUND', message: 'mock workspace' }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${srv.address().port}`, requests, close: () => new Promise((r) => srv.close(r)) }
}

/** Boots `node server-dist/index.cjs` from `cwd` with a clean env and waits until it answers. */
async function boot(cwd, workspaceUrl, extraEnv = {}) {
  const port = await freePort()
  const home = path.join(work, `home-${port}`)
  mkdirSync(home, { recursive: true })
  // Clean env on purpose: no PG*, no LOCAL_DEV_MODE, no ~/.databrickscfg — only
  // what the Apps runtime would hand the process (host + credentials + PORT).
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    NODE_ENV: 'production',
    PORT: String(port),
    DATABRICKS_APP_NAME: 'ai-prism',
    DATABRICKS_HOST: workspaceUrl,
    DATABRICKS_TOKEN: 'fake-token',
    DATABRICKS_CONFIG_FILE: path.join(home, 'no-databrickscfg'),
    ...extraEnv,
  }
  const child = spawn(process.execPath, ['server-dist/index.cjs'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => (output += d))
  child.stderr.on('data', (d) => (output += d))
  let exited = null
  child.on('exit', (code, signal) => (exited = { code, signal }))
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  for (;;) {
    if (exited) throw new Error(`server exited (${JSON.stringify(exited)}) before answering:\n${output}`)
    try {
      await fetch(`${base}/api/me`, { signal: AbortSignal.timeout(1000) })
      break
    } catch {
      if (Date.now() > deadline) {
        child.kill('SIGKILL')
        throw new Error(`server did not answer within ${BOOT_TIMEOUT_MS} ms:\n${output}`)
      }
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  return {
    base,
    output: () => output,
    stop: () =>
      new Promise((r) => {
        if (exited) return r()
        child.once('exit', r)
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 3000).unref()
      }),
  }
}

// POST /api/deck-templates is the design-system import: the JSON route that
// really carries multi-MB bodies (per-route limits in server/middleware/security.js; 40 MB on this route)
const twoMbJson = JSON.stringify({ name: 'boot-test', html: 'x'.repeat(2 * MB) })
const postBig = (base) => fetch(`${base}/api/deck-templates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: twoMbJson })

// Raw request so the test controls Content-Length vs chunked (fetch picks for itself).
function send(base, method, urlPath, body, { chunked = false } = {}) {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': Buffer.byteLength(body) }) }
    const r = httpRequest({ host: hostname, port, method, path: urlPath, headers }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => {
        let json = null
        try {
          json = JSON.parse(text)
        } catch {}
        resolve({ status: res.statusCode, json })
      })
    })
    r.on('error', reject)
    if (chunked) {
      for (let i = 0; i < body.length; i += 64 * 1024) r.write(body.slice(i, i + 64 * 1024))
      r.end()
    } else r.end(body)
  })
}

// The largest deck AI edit the client sends today (QA round 2): four 6 MiB
// raster attachments (one copy each), a 9 MiB speaker note and 40 full slides.
const MiB = 1024 * 1024
const rasterDataUrl = (t) => 'data:image/png;base64,' + t.repeat(Math.ceil((6 * MiB) / 3) * 4)
const worstDeckTweak = JSON.stringify({
  instruction: 'x',
  slides: Array.from({ length: 40 }, (_, i) => {
    const html = '<section>' + String(i % 10).repeat(59_980) + '</section>'
    return i === 0 ? { html, notes: 'n'.repeat(9 * MiB) } : html
  }),
  images: ['a', 'b', 'c', 'd'].map((t) => ({ dataUrl: rasterDataUrl(t) })),
  preview: true,
})

before(async () => {
  distDir = await buildDist()
})

after(() => rmSync(work, { recursive: true, force: true }))

describe('default boot (APPKIT_BOOT unset): AppKit', () => {
  let ws
  let srv
  before(async () => {
    ws = await startMockWorkspace()
    // legacy.cjs is deliberately absent: the AppKit path must never load it
    srv = await boot(deployDir('appkit', distFiles().filter((f) => f !== 'legacy.cjs')), ws.url)
  })
  after(async () => {
    await srv?.stop()
    await ws?.close()
  })

  test('GET /health answers {"status":"ok"} as JSON', async () => {
    const r = await fetch(`${srv.base}/health`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type') || '', /application\/json/)
    assert.deepEqual(await r.json(), { status: 'ok' })
  })

  test('GET / serves the SPA', async () => {
    const r = await fetch(`${srv.base}/`)
    assert.equal(r.status, 200)
    assert.match(await r.text(), new RegExp(SPA_MARKER))
  })

  test('GET /api/me without proxy headers is 401', async () => {
    const r = await fetch(`${srv.base}/api/me`)
    assert.equal(r.status, 401)
  })

  test('a 2 MB JSON POST to a JSON route is not rejected with 413', async () => {
    const r = await postBig(srv.base)
    assert.notEqual(r.status, 413)
    assert.equal(r.status, 401) // parsed, then refused by auth
  })

  // Body limits on the real artifact: AppKit's parser (APPKIT_BODY_LIMIT, 64 MB)
  // runs first on every route, then the per-route classes apply.
  test('the worst deck tweak the client sends (~45 MB) passes the 64 MB parser and the 46 MiB class', async () => {
    const bytes = Buffer.byteLength(worstDeckTweak)
    assert.ok(bytes > 45 * 1000 * 1000 && bytes < 48 * MiB, `body ${bytes}`)
    const r = await send(srv.base, 'POST', '/api/decks/1/tweak', worstDeckTweak)
    assert.notEqual(r.status, 413)
    assert.equal(r.status, 401) // parsed and admitted, then refused by auth (no proxy headers)
  })

  test('a 2 MiB JSON on a 1 MB route is 413 even though AppKit already parsed it', async () => {
    const r = await send(srv.base, 'PATCH', '/api/sessions/1', JSON.stringify({ title: 'x'.repeat(2 * MiB) }))
    assert.equal(r.status, 413)
    assert.equal(r.json?.code, 'payload_too_large')
  })

  test('chunked JSON (no Content-Length) is 411 under AppKit, even when it parses small', async () => {
    const r = await send(srv.base, 'POST', '/api/sessions/1/continue', ' '.repeat(2 * MiB) + '{"ok":true}', { chunked: true })
    assert.equal(r.status, 411)
    assert.equal(r.json?.code, 'length_required')
  })

  test('a body over the 64 MB parser limit is 413 from AppKit itself', async () => {
    const r = await send(srv.base, 'POST', '/api/decks/1/tweak', JSON.stringify({ pad: 'z'.repeat(70 * 1000 * 1000) }))
    assert.equal(r.status, 413)
  })

  test('our app resolved client/dist from its chunk: unknown /api path is its JSON 404', async () => {
    // registerStaticRoutes (server/routes/static.js) is only mounted when the
    // DIST path computed inside the bundled index.js exists; AppKit's own static
    // server would serve the SPA either way, so `/` alone cannot prove it.
    const r = await fetch(`${srv.base}/api/does-not-exist`)
    assert.equal(r.status, 404)
    assert.deepEqual(await r.json(), { error: 'not found' })
  })

  test('the launcher logs the boot path it chose', () => {
    assert.match(srv.output(), /\[boot\] APPKIT_BOOT=\(unset\): AppKit/)
  })

  // AppKit answers /health itself, before our app runs (QA W1-3 round 1)
  test("AppKit's own /health carries the incoming x-request-id", async () => {
    const r = await fetch(`${srv.base}/health`, { headers: { 'x-request-id': 'appkit-probe-1' } })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('x-request-id'), 'appkit-probe-1')
  })

  test("AppKit's own /health gets a fresh uuid without one", async () => {
    const r = await fetch(`${srv.base}/health`)
    await r.arrayBuffer()
    assert.match(r.headers.get('x-request-id') || '', UUID)
  })

  test('a route of our app under AppKit keeps one id per request', async () => {
    const a = await fetch(`${srv.base}/api/does-not-exist`, { headers: { 'x-request-id': 'appkit-probe-2' } })
    await a.arrayBuffer()
    assert.equal(a.headers.get('x-request-id'), 'appkit-probe-2')
    const b = await fetch(`${srv.base}/api/does-not-exist`)
    await b.arrayBuffer()
    assert.match(b.headers.get('x-request-id') || '', UUID)
    // the access line of our app carries the id AppKit's layer set
    const id = b.headers.get('x-request-id')
    // written on 'finish', which can land just after the client has the body
    for (let i = 0; i < 50 && !srv.output().includes(`"request_id":"${id}"`); i++) await new Promise((r) => setTimeout(r, 20))
    assert.ok(srv.output().includes(`"request_id":"${id}"`), 'the access line carries the response id')
  })

  test('the bundle knows its version without package.json (fixture has none)', () => {
    assert.match(srv.output(), new RegExp(`"msg":"AI Prism version ${PKG_VERSION.replace(/\./g, '\\.')}"`))
  })

  test('boot went through AppKit: it looked up the workspace (SCIM /Me)', () => {
    assert.ok(ws.requests.includes('GET /api/2.0/preview/scim/v2/Me'), `workspace requests: ${JSON.stringify(ws.requests)}`)
  })
})

describe('APPKIT_BOOT=0: legacy Express listener', () => {
  let ws
  let srv
  before(async () => {
    ws = await startMockWorkspace()
    // appkit.mjs is deliberately absent: the rollback path must not need it
    srv = await boot(deployDir('legacy', ['index.cjs', 'legacy.cjs']), ws.url, { APPKIT_BOOT: '0' })
  })
  after(async () => {
    await srv?.stop()
    await ws?.close()
  })

  test('GET / serves the SPA and GET /api/me without proxy headers is 401', async () => {
    const page = await fetch(`${srv.base}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), new RegExp(SPA_MARKER))
    assert.equal((await fetch(`${srv.base}/api/me`)).status, 401)
  })

  test('a 2 MB JSON POST to a JSON route is not rejected with 413', async () => {
    const r = await postBig(srv.base)
    assert.notEqual(r.status, 413)
    assert.equal(r.status, 401)
  })

  test('the launcher logs the boot path it chose', () => {
    assert.match(srv.output(), /\[boot\] APPKIT_BOOT=0: legacy Express listener/)
  })

  test('the bundle knows its version without package.json (fixture has none)', () => {
    assert.match(srv.output(), new RegExp(`"msg":"AI Prism version ${PKG_VERSION.replace(/\./g, '\\.')}"`))
  })

  test('AppKit did not boot: no /health JSON, no workspace lookup', async () => {
    const r = await fetch(`${srv.base}/health`)
    assert.doesNotMatch(r.headers.get('content-type') || '', /application\/json/)
    assert.deepEqual(ws.requests, [])
  })
})

describe('artifacts', () => {
  test(`every file under server-dist is at most ${FILE_GATE_BYTES} bytes (Apps limit ${FILE_LIMIT_BYTES})`, () => {
    const files = distFiles()
    assert.ok(files.includes('appkit.mjs') && files.includes('legacy.cjs') && files.includes('index.cjs'), `entrypoints missing: ${files}`)
    const over = files.map((f) => [f, statSync(path.join(distDir, f)).size]).filter(([, n]) => n > FILE_GATE_BYTES)
    assert.deepEqual(over, [], `files over ${FILE_GATE_BYTES} bytes: ${over.map(([f, n]) => `${f} ${(n / 1e6).toFixed(2)} MB`).join(', ')}`)
  })

  test('the bundles embed one pdf.js build (v1.10.100), not the four pdf-parse ships', () => {
    // pdf-parse loads pdf.js through a dynamic require; scripts/lib/esbuild-plugins.mjs pins it
    // (tests/slimBundle.test.mjs covers the plugin itself). A build that bundles them all is ~3 MB heavier per bundle.
    const withPdfJs = distFiles().filter((f) => /\.(cjs|mjs)$/.test(f) && readFileSync(path.join(distDir, f), 'utf8').includes('"1.10.100"'))
    assert.ok(withPdfJs.length > 0, 'the pdf.js build must be in the bundle: PDF upload needs it')
    for (const f of withPdfJs) {
      const src = readFileSync(path.join(distDir, f), 'utf8')
      for (const v of ['1.9.426', '1.10.88', '2.0.550']) assert.ok(!src.includes(`"${v}"`), `${f} still embeds pdf.js ${v}`)
    }
  })

  test("app.yaml never sets APPKIT_BOOT to '1'", () => {
    // '1' is the internal "embedded, do not listen" signal of server/index.js. The
    // committed server-dist/index.cjs can be the pre-launcher legacy bundle until a
    // release PR rebuilds it, and with '1' that bundle never listens. Unset boots
    // AppKit in the launcher and listens in the old bundle, so every commit deploys.
    const lines = readFileSync(path.join(ROOT, 'app.yaml'), 'utf8')
      .split('\n')
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter(Boolean)
    const i = lines.findIndex((l) => /^-?\s*name:\s*['"]?APPKIT_BOOT['"]?$/.test(l))
    if (i === -1) return
    const value = (lines[i + 1] || '').match(/^value:\s*['"]?([^'"]*)['"]?$/)?.[1]
    assert.equal(value, '0', `app.yaml sets APPKIT_BOOT to ${JSON.stringify(value)}; only '0' (rollback) may be set`)
  })

  test('the launcher is small and loads each path lazily', () => {
    const src = readFileSync(path.join(distDir, 'index.cjs'), 'utf8')
    assert.ok(src.length < 4096, `index.cjs is ${src.length} bytes; it must be a thin launcher, not a bundle`)
    assert.ok(existsSync(path.join(distDir, 'legacy.cjs')))
  })

  // AppKit's JSON parser runs before our per-route limits, so it takes the shared
  // constant that server/middleware/security.test.js keeps above every class
  test('AppKit body parser uses the shared APPKIT_BODY_LIMIT', () => {
    const src = readFileSync(path.join(ROOT, 'server/appkit.js'), 'utf8').replace(/\/\/.*$/gm, '')
    assert.match(src, /bodyLimit:\s*APPKIT_BODY_LIMIT\b/)
    assert.match(src, /import\s*\{[^}]*\bAPPKIT_BODY_LIMIT\b[^}]*\}\s*from\s*'\.\/middleware\/security\.ts'/)
  })

  test('AppKit internal telemetry stays off', () => {
    const src = readFileSync(path.join(ROOT, 'server/appkit.js'), 'utf8')
    assert.match(src, /disableInternalTelemetry:\s*true/)
  })

  test('the lakebase() plugin is not in the plugin list', () => {
    const src = readFileSync(path.join(ROOT, 'server/appkit.js'), 'utf8').replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(src, /\blakebase\s*\(/)
  })
})
