// Report-only CSP + Permissions-Policy on every response, the CSP violation
// endpoint (one JSON log line per violation, no PII) and the per-route JSON
// body limits.
//
//   node --test server/middleware/security.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import {
  security,
  REPORT_ONLY_POLICY,
  PERMISSIONS_POLICY,
  summarizeCspReports,
  jsonBodyParser,
  jsonLimitFor,
  JSON_ROUTE_LIMITS,
  BODY_LIMIT_CLASSES,
  APPKIT_BODY_LIMIT,
  parseBytes,
} from './security.js'

const EXPECTED_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'"

function fakeRes() {
  return {
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v
    },
  }
}

test('policy constants are the reviewed ones', () => {
  assert.equal(REPORT_ONLY_POLICY, EXPECTED_POLICY)
  assert.equal(PERMISSIONS_POLICY, 'microphone=(self), camera=()')
})

test('headers: Permissions-Policy and the report-only CSP (with its report endpoint) on any request', () => {
  for (const path of ['/', '/api/me', '/assets/x.js']) {
    const res = fakeRes()
    let passed = false
    security({ log: () => {} })({ method: 'GET', path, headers: {} }, res, () => (passed = true))
    assert.equal(passed, true, path)
    assert.equal(res.headers['permissions-policy'], 'microphone=(self), camera=()', path)
    const ro = res.headers['content-security-policy-report-only']
    assert.ok(ro.startsWith(EXPECTED_POLICY + ';'), `${path}: ${ro}`)
    assert.match(ro, /report-uri \/api\/csp-report/)
    assert.match(ro, /report-to csp-endpoint/)
    assert.equal(res.headers['reporting-endpoints'], 'csp-endpoint="/api/csp-report"')
  }
})

test('the report-only policy never touches the enforced CSP header', () => {
  const res = fakeRes()
  security({ log: () => {} })({ method: 'GET', path: '/', headers: {} }, res, () => {})
  assert.equal(res.headers['content-security-policy'], undefined)
})

// ---- the /api/csp-report endpoint, over a real Express app -----------------

async function withApp(opts, fn) {
  const app = express()
  app.use(security(opts))
  app.use((req, res) => res.status(418).end()) // anything that falls through
  const server = http.createServer(app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    return await fn(server.address().port)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

function post(port, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    const r = http.request(
      { host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-length': Buffer.byteLength(payload), ...headers } },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      }
    )
    r.on('error', reject)
    r.end(payload)
  })
}

const LEGACY_REPORT = {
  'csp-report': {
    'document-uri': 'https://ai-prism.example.com/?session=42&email=ana@example.com',
    referrer: 'https://ai-prism.example.com/',
    'violated-directive': 'script-src-elem',
    'effective-directive': 'script-src-elem',
    'original-policy': EXPECTED_POLICY,
    disposition: 'report',
    'blocked-uri': 'https://fonts.example.net/kit.js?user=ana@example.com',
    'status-code': 200,
    'script-sample': 'secret prompt text typed by ana@example.com',
    'source-file': 'https://ai-prism.example.com/assets/index.js',
    'line-number': 3,
  },
}

test('csp-report (legacy application/csp-report): 204 and ONE JSON log line, without PII', async () => {
  const lines = []
  const status = await withApp({ log: (l) => lines.push(l) }, (port) =>
    post(port, '/api/csp-report', LEGACY_REPORT, { 'content-type': 'application/csp-report', origin: 'null', 'x-forwarded-email': 'ana@example.com' })
  )
  assert.equal(status, 204)
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.deepEqual(entry, {
    event: 'csp_violation',
    directive: 'script-src-elem',
    blocked: 'https://fonts.example.net',
    document: '/',
    disposition: 'report',
  })
  assert.doesNotMatch(lines[0], /ana@|session=|secret prompt|user=/)
})

test('csp-report (Reporting API application/reports+json): one line per violation', async () => {
  const lines = []
  const batch = [
    {
      type: 'csp-violation',
      age: 1,
      url: 'https://ai-prism.example.com/',
      body: {
        documentURL: 'https://ai-prism.example.com/x?y=1',
        effectiveDirective: 'img-src',
        blockedURL: 'https://cdn.example.org/a.png',
        disposition: 'report',
        sample: 'private',
      },
    },
    { type: 'csp-violation', body: { documentURL: 'about:srcdoc', effectiveDirective: 'script-src-elem', blockedURL: 'inline', disposition: 'report' } },
    { type: 'deprecation', body: { id: 'x' } }, // not a CSP report: ignored
  ]
  const status = await withApp({ log: (l) => lines.push(l) }, (port) =>
    post(port, '/api/csp-report', batch, { 'content-type': 'application/reports+json' })
  )
  assert.equal(status, 204)
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0]), { event: 'csp_violation', directive: 'img-src', blocked: 'https://cdn.example.org', document: '/x', disposition: 'report' })
  assert.deepEqual(JSON.parse(lines[1]), { event: 'csp_violation', directive: 'script-src-elem', blocked: 'inline', document: 'about:srcdoc', disposition: 'report' })
})

test('csp-report: reports beyond the per-user cap are dropped silently (204, not logged)', async () => {
  const lines = []
  await withApp({ log: (l) => lines.push(l), env: { CSP_REPORT_PER_MIN: '3' } }, async (port) => {
    for (let i = 0; i < 6; i++) {
      const s = await post(port, '/api/csp-report', LEGACY_REPORT, { 'content-type': 'application/csp-report', 'x-forwarded-email': 'ana@example.com' })
      assert.equal(s, 204)
    }
  })
  assert.equal(lines.length, 3)
})

test('csp-report: garbage body is accepted and not logged', async () => {
  const lines = []
  const status = await withApp({ log: (l) => lines.push(l) }, (port) =>
    post(port, '/api/csp-report', '{"nope":', { 'content-type': 'application/csp-report' })
  )
  assert.equal(status, 204)
  assert.equal(lines.length, 0)
})

test('csp-report: only POST is handled; other paths fall through', async () => {
  await withApp({ log: () => {} }, async (port) => {
    assert.equal(await post(port, '/api/csp-reports', LEGACY_REPORT, { 'content-type': 'application/json' }), 418)
  })
})

test('summarizeCspReports: unusual blocked values collapse to a keyword', () => {
  const one = (blocked) => summarizeCspReports({ 'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': blocked } })[0].blocked
  assert.equal(one('data'), 'data')
  assert.equal(one('blob:https://ai-prism.example.com/1234-uuid'), 'blob')
  assert.equal(one('data:image/png;base64,AAAA'), 'data')
  assert.equal(one('eval'), 'eval')
  assert.equal(one(''), 'unknown')
  assert.equal(one('javascript:alert(1)'), 'other')
})

// ---- JSON body limits ------------------------------------------------------

// Measured payloads behind the classes (canonical Databricks DS bundle, real
// asset sizes, real client export code): export-html of a 40-slide deck with a
// brand background on every slide = 25.6 MB; a full 8-sheet workbook at the
// sanitizer caps (500 rows x 20 cols) = 0.94 MB with plain cells.
const MB = 1024 * 1024

test('jsonLimitFor: the deck studio routes share the studio-media class (48 MiB)', () => {
  for (const [method, path] of [
    ['PATCH', '/api/decks/9'],
    ['POST', '/api/decks/9/tweak'],
    ['POST', '/api/decks/9/export-html'],
    ['POST', '/api/spreadsheets/3/tweak'], // reference images ride along as data: URLs
  ]) {
    assert.equal(jsonLimitFor({ method, path }), 48 * MB, `${method} ${path}`)
  }
})

test('jsonLimitFor: design-system import 40 MB, workbook saves 4 MB, everything else 1 MB', () => {
  for (const [method, path] of [
    ['POST', '/api/deck-templates'],
    ['PATCH', '/api/deck-templates/7'],
    ['POST', '/api/deck-templates/label-assets'],
  ]) {
    assert.equal(jsonLimitFor({ method, path }), 40 * MB, `${method} ${path}`)
  }
  assert.equal(jsonLimitFor({ method: 'PATCH', path: '/api/spreadsheets/3' }), 4 * MB)
  for (const [method, path] of [
    ['PATCH', '/api/sessions/1'],
    ['PATCH', '/api/documents/1'], // markdown only; the AI edit refuses > 120k chars
    ['POST', '/api/documents/1/tweak'],
    ['POST', '/api/sessions/1/continue'],
    ['POST', '/api/deck-templates/7/select'],
    ['POST', '/api/decks/9'], // no such route: not a deck-studio request
    ['GET', '/api/decks/9'],
    ['POST', '/api/deck-templatesX'],
    ['POST', '/api/x/api/deck-templates'],
    ['POST', '/api/decks/9/tweak/extra'],
  ]) {
    assert.equal(jsonLimitFor({ method, path }), 1 * MB, `${method} ${path}`)
  }
})

test('jsonLimitFor: Express-style matching (case-insensitive, optional trailing slash)', () => {
  assert.equal(jsonLimitFor({ method: 'POST', path: '/API/Decks/9/Tweak' }), 48 * MB)
  assert.equal(jsonLimitFor({ method: 'POST', path: '/api/decks/9/export-html/' }), 48 * MB)
})

test('JSON_ROUTE_LIMITS: every entry names a known class, once per method + path', () => {
  const seen = new Set()
  for (const r of JSON_ROUTE_LIMITS) {
    assert.ok(BODY_LIMIT_CLASSES[r.class], `${r.method} ${r.path}: unknown class ${r.class}`)
    const key = `${r.method} ${r.path}`
    assert.ok(!seen.has(key), `duplicate ${key}`)
    seen.add(key)
  }
  for (const [name, c] of Object.entries(BODY_LIMIT_CLASSES)) {
    assert.ok(c.env && c.fallback && c.why, `class ${name} documents env, fallback and why`)
  }
})

test('jsonLimitFor: env override per class', () => {
  const env = { BODY_LIMIT_JSON: '2mb', BODY_LIMIT_DECK_TEMPLATES: '50mb', BODY_LIMIT_STUDIO_MEDIA: '30mb', BODY_LIMIT_WORKBOOK: '8mb' }
  assert.equal(jsonLimitFor({ method: 'PATCH', path: '/api/sessions/1' }, env), 2 * MB)
  assert.equal(jsonLimitFor({ method: 'POST', path: '/api/deck-templates' }, env), 50 * MB)
  assert.equal(jsonLimitFor({ method: 'POST', path: '/api/decks/1/export-html' }, env), 30 * MB)
  assert.equal(jsonLimitFor({ method: 'PATCH', path: '/api/spreadsheets/1' }, env), 8 * MB)
  // an unparseable value keeps the default rather than lifting the limit
  assert.equal(jsonLimitFor({ method: 'PATCH', path: '/api/sessions/1' }, { BODY_LIMIT_JSON: 'big' }), 1 * MB)
})

async function withParser(fn, { upstream = null } = {}) {
  const app = express()
  // `upstream` stands for a parser that runs before ours (AppKit's own
  // express.json at 40 MB): body-parser then skips the request as already parsed
  if (upstream) app.use(upstream)
  app.use(jsonBodyParser({ env: {} }))
  app.use((req, res) => res.json({ ok: true, keys: Object.keys(req.body || {}).length }))
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ status: err.status }))
  const server = http.createServer(app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    return await fn(server.address().port)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('jsonBodyParser: a 2 MB JSON is 413 on a normal route and parsed on /api/deck-templates', async () => {
  const big = JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) })
  await withParser(async (port) => {
    assert.equal(await post(port, '/api/sessions/1', big, { 'content-type': 'application/json' }), 413)
    assert.equal(await post(port, '/api/deck-templates', big, { 'content-type': 'application/json' }), 200)
  })
})

test('jsonBodyParser: 3 MB on the deck studio tweak and export are parsed (not 413)', async () => {
  const big = JSON.stringify({ slides: ['<section>' + 'x'.repeat(3 * MB) + '</section>'] })
  await withParser(async (port) => {
    assert.equal(await post(port, '/api/decks/9/tweak', big, { 'content-type': 'application/json' }), 200)
    assert.equal(await post(port, '/api/decks/9/export-html', big, { 'content-type': 'application/json' }), 200)
  })
})

// ---- the limit holds when another parser already read the body (X1) --------

test('upstream parser (Content-Length): a 2 MB JSON is still 413 on a normal route, 200 on /api/deck-templates', async () => {
  const big = JSON.stringify({ blob: 'x'.repeat(2 * MB) })
  await withParser(
    async (port) => {
      assert.equal(await post(port, '/api/sessions/1', big, { 'content-type': 'application/json' }), 413)
      assert.equal(await post(port, '/api/deck-templates', big, { 'content-type': 'application/json' }), 200)
      assert.equal(await post(port, '/api/sessions/1', JSON.stringify({ title: 'ok' }), { 'content-type': 'application/json' }), 200)
    },
    { upstream: express.json({ limit: APPKIT_BODY_LIMIT }) }
  )
})

function postChunked(port, path, payload) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    r.on('error', reject)
    for (let i = 0; i < payload.length; i += 64 * 1024) r.write(payload.slice(i, i + 64 * 1024))
    r.end()
  })
}

// The parsed object says nothing about the wire size (whitespace, escapes), so
// under the AppKit boot a JSON body has to declare its length: chunked → 411.
test('upstream parser (chunked, no Content-Length): 411 Length Required, even for a small parsed object', async () => {
  const padded = ' '.repeat(2 * MB) + '{"ok":true}' // QA repro: 2 MiB of whitespace, tiny object
  await withParser(
    async (port) => {
      assert.equal(await postChunked(port, '/api/sessions/1/continue', padded), 411)
      assert.equal(await postChunked(port, '/api/sessions/1', JSON.stringify({ title: 'ok' })), 411)
      assert.equal(await postChunked(port, '/api/deck-templates', JSON.stringify({ blob: 'x'.repeat(2 * MB) })), 411)
    },
    { upstream: express.json({ limit: APPKIT_BODY_LIMIT }) }
  )
})

test('legacy boot (no upstream parser): body-parser measures the chunked stream itself', async () => {
  const padded = ' '.repeat(2 * MB) + '{"ok":true}'
  await withParser(async (port) => {
    assert.equal(await postChunked(port, '/api/sessions/1/continue', padded), 413)
    assert.equal(await postChunked(port, '/api/sessions/1', JSON.stringify({ title: 'ok' })), 200)
  })
})

test('upstream parser: the 413 goes through the normal error path (status 413, entity.too.large)', () => {
  const mw = jsonBodyParser({ env: {} })
  let err = null
  mw({ method: 'PATCH', path: '/api/sessions/1', headers: { 'content-length': String(2 * MB) }, _body: true, body: {} }, {}, (e) => (err = e))
  assert.equal(err?.status, 413)
  assert.equal(err?.type, 'entity.too.large')
  assert.equal(err?.limit, 1 * MB)
  let passed = null
  mw({ method: 'PATCH', path: '/api/sessions/1', headers: { 'content-length': '20' }, _body: true, body: { title: 'x' } }, {}, (e) => (passed = e ?? 'next'))
  assert.equal(passed, 'next')
})

test('upstream parser without Content-Length: 411 through the normal error path', () => {
  const mw = jsonBodyParser({ env: {} })
  let err = null
  mw({ method: 'POST', path: '/api/sessions/1/continue', headers: { 'transfer-encoding': 'chunked' }, _body: true, body: { ok: true } }, {}, (e) => (err = e))
  assert.equal(err?.status, 411)
  assert.equal(err?.type, 'length.required')
})

// ---- the worst deck-tweak payload the client admits (review B1, round 2) -----

const MiB = 1024 * 1024
const rasterDataUrl = (tag) => 'data:image/png;base64,' + tag.repeat(Math.ceil((6 * MiB) / 3) * 4) // a 6 MiB file
const worstDeck = Array.from({ length: 40 }, (_, i) => '<section>' + String(i).repeat(59_980) + '</section>') // 40 x 60,000 chars

test('worst admitted deck tweak (4 x 6 MiB rasters sent once + 40 full slides) passes the AppKit parser + studioMedia', async () => {
  const body = JSON.stringify({ instruction: 'x', slides: worstDeck, images: ['a', 'b', 'c', 'd'].map((t) => ({ dataUrl: rasterDataUrl(t) })), preview: true })
  assert.ok(Buffer.byteLength(body) > 35 * 1000 * 1000 && Buffer.byteLength(body) < 40 * MiB, `body ${Buffer.byteLength(body)}`)
  await withParser(
    async (port) => assert.equal(await post(port, '/api/decks/9/tweak', body, { 'content-type': 'application/json' }), 200),
    { upstream: express.json({ limit: APPKIT_BODY_LIMIT }) }
  )
  await withParser(async (port) => assert.equal(await post(port, '/api/decks/9/tweak', body, { 'content-type': 'application/json' }), 200))
})

test('the old duplicated wire form at the client maximum (4 x 6 MiB with dataUrl + visionUrl, ~67 MB) is over every limit, which is why the client sends one copy', async () => {
  const body = JSON.stringify({ images: ['a', 'b', 'c', 'd'].map((t) => ({ dataUrl: rasterDataUrl(t), visionUrl: rasterDataUrl(t) })) })
  assert.ok(Buffer.byteLength(body) > parseBytes(APPKIT_BODY_LIMIT), `body ${Buffer.byteLength(body)}`)
  await withParser(async (port) => assert.equal(await post(port, '/api/decks/9/tweak', body, { 'content-type': 'application/json' }), 413))
})

// QA round 2: speaker notes travel with the slides and have no cap in the
// editor; four 6 MiB images plus one 9 MiB note made a 42,991,866-byte tweak.
test('worst measured deck tweak (4 x 6 MiB images + a 9 MiB speaker note + 40 full slides) passes the AppKit parser + studioMedia', async () => {
  const slides = worstDeck.map((html, i) => (i === 0 ? { html, notes: 'n'.repeat(9 * MiB) } : html))
  const body = JSON.stringify({ instruction: 'x', slides, images: ['a', 'b', 'c', 'd'].map((t) => ({ dataUrl: rasterDataUrl(t) })), preview: true })
  assert.ok(Buffer.byteLength(body) > 45 * 1000 * 1000 && Buffer.byteLength(body) < 48 * MiB, `body ${Buffer.byteLength(body)}`)
  await withParser(
    async (port) => assert.equal(await post(port, '/api/decks/9/tweak', body, { 'content-type': 'application/json' }), 200),
    { upstream: express.json({ limit: APPKIT_BODY_LIMIT }) }
  )
  await withParser(async (port) => assert.equal(await post(port, '/api/decks/9/tweak', body, { 'content-type': 'application/json' }), 200))
})

test('no body-limit class is larger than the AppKit parser, which runs first (64 MB)', () => {
  assert.equal(parseBytes(APPKIT_BODY_LIMIT), 64 * MiB)
  for (const [name, c] of Object.entries(BODY_LIMIT_CLASSES)) {
    assert.ok(parseBytes(c.fallback) <= parseBytes(APPKIT_BODY_LIMIT), `class ${name} (${c.fallback}) is capped upstream`)
  }
})
