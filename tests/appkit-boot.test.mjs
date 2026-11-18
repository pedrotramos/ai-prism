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
import { createServer } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MB = 1024 * 1024
const BOOT_TIMEOUT_MS = 45_000
const SPA_MARKER = 'appkit-boot-test-spa'
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
    assert.match(src, /import\s*\{[^}]*\bAPPKIT_BODY_LIMIT\b[^}]*\}\s*from\s*'\.\/middleware\/security\.js'/)
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
