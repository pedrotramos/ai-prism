// Report-only CSP + Permissions-Policy on every response, the CSP violation
// endpoint (one JSON log line per violation, no PII) and the per-route JSON
// body limits.
//
//   node --test server/middleware/security.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import { security, REPORT_ONLY_POLICY, PERMISSIONS_POLICY, summarizeCspReports, jsonBodyParser, jsonLimitFor } from './security.js'

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

test('jsonLimitFor: 1 MB by default, 40 MB on /api/deck-templates*, 15 MB on the deck editor save only', () => {
  const MB = 1024 * 1024
  assert.equal(jsonLimitFor({ method: 'PATCH', path: '/api/sessions/1' }), 1 * MB)
  assert.equal(jsonLimitFor({ method: 'POST', path: '/api/deck-templates' }), 40 * MB)
  assert.equal(jsonLimitFor({ method: 'PATCH', path: '/api/deck-templates/7' }), 40 * MB)
  assert.equal(jsonLimitFor({ method: 'POST', path: '/api/deck-templates/label-assets' }), 40 * MB)
  assert.equal(jsonLimitFor({ method: 'PATCH', path: '/api/decks/9' }), 15 * MB)
  // the exceptions do not leak to neighbouring routes
  assert.equal(jsonLimitFor({ method: 'POST', path: '/api/decks/9/tweak' }), 1 * MB)
  assert.equal(jsonLimitFor({ method: 'POST', path: '/api/decks/9/export-html' }), 1 * MB)
  assert.equal(jsonLimitFor({ method: 'POST', path: '/api/decks/9' }), 1 * MB)
  assert.equal(jsonLimitFor({ method: 'POST', path: '/api/deck-templatesX' }), 1 * MB)
  assert.equal(jsonLimitFor({ method: 'POST', path: '/api/x/api/deck-templates' }), 1 * MB)
})

test('jsonLimitFor: env override', () => {
  const env = { BODY_LIMIT_JSON: '2mb', BODY_LIMIT_DECK_TEMPLATES: '50mb', BODY_LIMIT_DECK_EDIT: '20mb' }
  const MB = 1024 * 1024
  assert.equal(jsonLimitFor({ method: 'PATCH', path: '/api/sessions/1' }, env), 2 * MB)
  assert.equal(jsonLimitFor({ method: 'POST', path: '/api/deck-templates' }, env), 50 * MB)
  assert.equal(jsonLimitFor({ method: 'PATCH', path: '/api/decks/1' }, env), 20 * MB)
  // an unparseable value keeps the default rather than lifting the limit
  assert.equal(jsonLimitFor({ method: 'PATCH', path: '/api/sessions/1' }, { BODY_LIMIT_JSON: 'big' }), 1 * MB)
})

async function withParser(fn) {
  const app = express()
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
