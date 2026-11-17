// Response hardening: security headers, numeric id params, final error handler.
//
//   node --test server/securityHeaders.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { securityHeaders, CONTENT_SECURITY_POLICY, numericIdParam, finalErrorHandler } from './securityHeaders.js'

function fakeRes() {
  return {
    headers: {},
    statusCode: 200,
    headersSent: false,
    body: undefined,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v
    },
    status(c) {
      this.statusCode = c
      return this
    },
    json(b) {
      this.body = b
      return this
    },
  }
}

test('cabeçalhos: nosniff, Referrer-Policy, X-Frame-Options e CSP em toda resposta', () => {
  const res = fakeRes()
  let passed = false
  securityHeaders()({}, res, () => {
    passed = true
  })
  assert.equal(passed, true)
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['referrer-policy'], 'same-origin')
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN')
  assert.equal(res.headers['content-security-policy'], CONTENT_SECURITY_POLICY)
})

test('CSP conservadora: trava framing, base, plugins e destino de form; não restringe o que o SPA carrega', () => {
  const directives = Object.fromEntries(
    CONTENT_SECURITY_POLICY.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')])
  )
  assert.equal(directives['frame-ancestors'], "'self'")
  assert.equal(directives['base-uri'], "'self'")
  assert.equal(directives['object-src'], "'none'")
  assert.equal(directives['form-action'], "'self'")
  // srcdoc iframes inherit the page's CSP: the slide editor injects an inline
  // <script> and imported design systems carry inline scripts, fonts and images
  // from any host. Any of these would break deck preview/editing.
  for (const d of ['default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'frame-src', 'child-src']) {
    assert.equal(directives[d], undefined, `${d} must not be set`)
  }
})

test('id numérico: 1 a 18 dígitos seguem para a rota', () => {
  for (const v of ['1', '42', '9'.repeat(18)]) {
    let arg = 'not-called'
    numericIdParam({}, {}, (x) => (arg = x), v)
    assert.equal(arg, undefined, v)
  }
})

test("id não numérico, vazio ou longo demais: pula a rota (next('route') → 404)", () => {
  for (const v of ['abc', '2 OR 1=1', '1e3', '-1', '1.5', '', '9'.repeat(19), '99999999999999999999999']) {
    let arg = 'not-called'
    numericIdParam({}, {}, (x) => (arg = x), v)
    assert.equal(arg, 'route', JSON.stringify(v))
  }
})

function runHandler(err) {
  const res = fakeRes()
  const logged = []
  let forwarded
  finalErrorHandler({ log: (...a) => logged.push(a.join(' ')) })(err, { method: 'POST', originalUrl: '/api/x' }, res, (e) => {
    forwarded = e
  })
  return { res, logged, forwarded }
}

test('erro final: JSON malformado vira 400 JSON genérico, sem stack nem detalhe do parser', () => {
  const err = Object.assign(new SyntaxError('Unexpected token } in JSON at position 7'), {
    status: 400,
    statusCode: 400,
    type: 'entity.parse.failed',
    expose: true,
  })
  const { res, logged } = runHandler(err)
  assert.equal(res.statusCode, 400)
  assert.deepEqual(Object.keys(res.body).sort(), ['code', 'error'])
  assert.equal(res.body.code, 'bad_request')
  assert.doesNotMatch(JSON.stringify(res.body), /Unexpected token|position|SyntaxError/)
  assert.equal(logged.length, 1, 'detail goes to the server log')
})

test('erro final: corpo grande demais vira 413', () => {
  const err = Object.assign(new Error('request entity too large'), { status: 413, type: 'entity.too.large' })
  assert.equal(runHandler(err).res.statusCode, 413)
  const multer = Object.assign(new Error('File too large'), { name: 'MulterError', code: 'LIMIT_FILE_SIZE' })
  const r = runHandler(multer)
  assert.equal(r.res.statusCode, 413)
  assert.equal(r.res.body.code, 'payload_too_large')
})

test('erro final: erro interno (ex.: Postgres) vira 500 genérico; a mensagem só vai para o log', () => {
  const err = Object.assign(new Error('invalid input syntax for type bigint: "abc"'), { code: '22P02' })
  const { res, logged } = runHandler(err)
  assert.equal(res.statusCode, 500)
  assert.equal(res.body.code, 'internal_error')
  assert.doesNotMatch(JSON.stringify(res.body), /bigint|22P02/)
  assert.match(logged[0], /bigint/)
})

test('erro final: resposta já iniciada (SSE) é delegada ao Express para fechar a conexão', () => {
  const res = fakeRes()
  res.headersSent = true
  let forwarded
  const err = new Error('boom')
  finalErrorHandler({ log: () => {} })(err, {}, res, (e) => {
    forwarded = e
  })
  assert.equal(forwarded, err)
})
