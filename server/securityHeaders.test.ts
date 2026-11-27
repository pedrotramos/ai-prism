// Response hardening: security headers, numeric id params, final error handler.
//
//   node --test server/securityHeaders.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { securityHeaders, CONTENT_SECURITY_POLICY, buildContentSecurityPolicy, buildEnforcedCsp, egressDirectives, warnUnknownEgressMode, numericIdParam, finalErrorHandler } from './securityHeaders.ts'
import { createEgressSetting } from './egressSetting.ts'
import { EMPTY_EGRESS_POLICY } from '../shared/urlEgressPolicy.ts'

function fakeRes() {
  return {
    headers: {} as Record<string, string>,
    statusCode: 200,
    headersSent: false,
    body: undefined as Record<string, string> | undefined,
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v
    },
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: Record<string, string>) {
      this.body = b
      return this
    },
  }
}

const parse = (csp: string) =>
  Object.fromEntries(
    csp
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => d.split(/\s+/))
      .map(([k, ...v]) => [k, v.join(' ')])
  ) as Record<string, string>
const policyOf = (origins: string[]) => ({ allowedOrigins: origins.map((origin) => ({ origin })) })
const EGRESS = ['img-src', 'font-src', 'style-src', 'media-src', 'connect-src', 'frame-src']

test('cabeçalhos: nosniff, Referrer-Policy, X-Frame-Options e CSP em toda resposta', () => {
  const res = fakeRes()
  let passed = false
  securityHeaders({ env: {}, origins: () => [] })({}, res, () => {
    passed = true
  })
  assert.equal(passed, true)
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['referrer-policy'], 'same-origin')
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN')
  assert.equal(res.headers['content-security-policy'], buildEnforcedCsp({}, []))
  assert.equal(res.headers['content-security-policy'], CONTENT_SECURITY_POLICY)
})

test('CSP aplicada por padrão: as quatro diretivas antigas + as seis de egress + report-uri/report-to', () => {
  const d = parse(CONTENT_SECURITY_POLICY)
  assert.equal(d['frame-ancestors'], "'self'")
  assert.equal(d['base-uri'], "'self'")
  assert.equal(d['object-src'], "'none'")
  assert.equal(d['form-action'], "'self'")
  assert.equal(d['img-src'], "'self' data: blob:")
  assert.equal(d['font-src'], "'self' data:")
  assert.equal(d['style-src'], "'self' 'unsafe-inline'")
  assert.equal(d['media-src'], "'self' data: blob:")
  assert.equal(d['connect-src'], "'self'")
  assert.equal(d['frame-src'], "'self' blob:")
  assert.equal(d['report-uri'], '/api/csp-report')
  assert.equal(d['report-to'], 'csp-endpoint')
  // T11 (ADR-9): inline script only (the slide editor runtime and DS scripts are inline), no remote script
  assert.equal(d['default-src'], "'self'")
  assert.equal(d['script-src'], "'self' 'unsafe-inline'")
  assert.equal(d['child-src'], undefined, 'child-src must not be set')
  assert.equal(CONTENT_SECURITY_POLICY, buildContentSecurityPolicy({ mode: 'enforce', policy: EMPTY_EGRESS_POLICY }))
})

test('T11: enforce emite exatamente default-src e script-src, com e sem origens do admin e do ambiente, e na ordem prevista', () => {
  const lists: Array<[Record<string, string>, string[]]> = [
    [{}, []],
    [{}, ['https://fonts.example.com']],
    [{ EXTERNAL_ASSET_ORIGINS: 'https://cdn.example.org' }, ['https://a.example.com', 'https://jsdelivr.example.net']],
  ]
  for (const [env, origins] of lists) {
    const csp = buildEnforcedCsp(env, origins)
    const d = parse(csp)
    assert.equal(d['default-src'], "'self'")
    assert.equal(d['script-src'], "'self' 'unsafe-inline'")
    // invariant: never an allowlist origin, blob:, 'unsafe-eval' or *
    for (const k of ['default-src', 'script-src']) assert.doesNotMatch(d[k]!, /https?:|blob:|unsafe-eval|\*/, k)
    const keys = Object.keys(d)
    assert.ok(keys.indexOf('form-action') < keys.indexOf('default-src'))
    assert.ok(keys.indexOf('default-src') < keys.indexOf('script-src'))
    assert.ok(keys.indexOf('script-src') < keys.indexOf('img-src'))
    assert.equal(csp.split('script-src').length, 2, 'script-src appears once')
  }
})

test('T11: report não emite default-src nem script-src (mesmo com origens)', () => {
  for (const csp of [buildEnforcedCsp({ CSP_EGRESS: 'report' }, ['https://a.example.com']), buildContentSecurityPolicy({ mode: 'report', policy: policyOf(['https://a.example.com']) })]) {
    assert.doesNotMatch(csp, /default-src|script-src/)
  }
})

test('CSP_EGRESS=report: o cabeçalho aplicado volta às quatro diretivas (as de egress ficam só no Report-Only)', () => {
  const d = parse(buildEnforcedCsp({ CSP_EGRESS: 'report' }, ['https://fonts.example.com']))
  assert.deepEqual(Object.keys(d).sort(), ['base-uri', 'form-action', 'frame-ancestors', 'object-src'])
  for (const k of EGRESS) assert.equal(d[k], undefined)
  assert.equal(buildContentSecurityPolicy({ mode: 'report', policy: EMPTY_EGRESS_POLICY }), buildEnforcedCsp({ CSP_EGRESS: 'report' }))
})

test('CSP_EGRESS inválido ou vazio cai em enforce (seguro por padrão); só "report" desliga', () => {
  for (const v of [undefined, '', 'enforce', 'ENFORCE', 'off', 'false', '0', 'reportonly', ' Report ', 'REPORT']) {
    assert.match(buildEnforcedCsp({ CSP_EGRESS: v }), /img-src/, String(v))
  }
  assert.doesNotMatch(buildEnforcedCsp({ CSP_EGRESS: 'report' }), /img-src/)
})

test('origem do ambiente: entra em img-src, font-src e style-src; nunca em connect-src, media-src ou frame-src', () => {
  const d = parse(buildEnforcedCsp({ EXTERNAL_ASSET_ORIGINS: 'https://fonts.example.com, https://cdn.example.org:8443' }))
  for (const k of ['img-src', 'font-src', 'style-src']) {
    assert.match(d[k]!, /https:\/\/fonts\.example\.com https:\/\/cdn\.example\.org:8443$/, k)
  }
  assert.equal(d['connect-src'], "'self'")
  assert.equal(d['media-src'], "'self' data: blob:")
  assert.equal(d['frame-src'], "'self' blob:")
})

test('origens inválidas do ambiente são descartadas (curinga, http, IP, caminho, host do app)', () => {
  const env = { EXTERNAL_ASSET_ORIGINS: 'https://*.example.com http://a.example.com https://10.0.0.1 https://b.example.com/path https://evil.example.com; script-src *' }
  const csp = buildEnforcedCsp(env)
  assert.doesNotMatch(csp, /\*|http:\/\/|10\.0\.0\.1|\/path|script-src/)
  assert.equal(parse(csp)['img-src'], "'self' data: blob:")
})

test('origens da configuração ∪ ambiente, sem duplicar e em ordem estável', () => {
  const env = { EXTERNAL_ASSET_ORIGINS: 'https://a.example.com' }
  const d = parse(buildEnforcedCsp(env, ['https://b.example.com', 'https://a.example.com']))
  assert.equal(d['img-src'], "'self' data: blob: https://a.example.com https://b.example.com")
  // an injected value can not smuggle a directive through the setting list either
  const evil = parse(buildEnforcedCsp({}, ['https://ok.example.com; connect-src *', "https://x.example.com 'unsafe-eval'"]))
  assert.equal(evil['connect-src'], "'self'")
  assert.doesNotMatch(evil['img-src']!, /unsafe-eval|ok\.example\.com/)
})

test('egressDirectives: as seis diretivas, origens só em img/font/style', () => {
  const list = egressDirectives(policyOf(['https://a.example.com']))
  assert.deepEqual(list.map((x) => x.split(' ')[0]), EGRESS)
  assert.equal(list.filter((x) => x.includes('https://a.example.com')).length, 3)
})

test('o cabeçalho lê a lista a cada resposta (sincronamente) e memoiza por lista', () => {
  let current: string[] = []
  let reads = 0
  const mw = securityHeaders({
    env: {},
    origins: () => {
      reads++
      return current
    },
  })
  const run = () => {
    const res = fakeRes()
    mw({}, res, () => {})
    return res.headers['content-security-policy']!
  }
  const first = run()
  assert.doesNotMatch(first, /fonts\.example\.com/)
  current = ['https://fonts.example.com']
  const second = run()
  assert.match(second, /img-src 'self' data: blob: https:\/\/fonts\.example\.com/)
  assert.equal(run(), second)
  assert.equal(reads, 3)
})

test('o cabeçalho nunca espera o banco: leitura que nunca resolve ainda responde na hora com o piso do ambiente', async () => {
  let started = 0
  const setting = createEgressSetting({
    read: () => {
      started++
      return new Promise<string[]>(() => {})
    },
    env: { EXTERNAL_ASSET_ORIGINS: 'https://floor.example.com' },
  })
  const mw = securityHeaders({ env: { EXTERNAL_ASSET_ORIGINS: 'https://floor.example.com' }, origins: () => setting.current() })
  const res = fakeRes()
  let passed = false
  mw({}, res, () => {
    passed = true
  })
  assert.equal(passed, true, 'next() ran synchronously')
  assert.match(res.headers['content-security-policy']!, /img-src 'self' data: blob: https:\/\/floor\.example\.com/)
  assert.equal(started, 1)
  mw({}, fakeRes(), () => {})
  assert.equal(started, 1, 'single-flight: the pending read is not started again')
})

test('id numérico: 1 a 18 dígitos seguem para a rota', () => {
  for (const v of ['1', '42', '9'.repeat(18)]) {
    let arg: string | undefined = 'not-called'
    numericIdParam({}, {}, (x) => (arg = x), v)
    assert.equal(arg, undefined, v)
  }
})

test("id não numérico, vazio ou longo demais: pula a rota (next('route') → 404)", () => {
  for (const v of ['abc', '2 OR 1=1', '1e3', '-1', '1.5', '', '9'.repeat(19), '99999999999999999999999']) {
    let arg: string | undefined = 'not-called'
    numericIdParam({}, {}, (x) => (arg = x), v)
    assert.equal(arg, 'route', JSON.stringify(v))
  }
})

function runHandler(err: unknown) {
  const res = fakeRes()
  const logged: string[] = []
  let forwarded: unknown
  finalErrorHandler({ log: (...a) => logged.push(a.join(' ')) })(err, { method: 'POST', originalUrl: '/api/x' }, res, (e?: unknown) => {
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
  assert.deepEqual(Object.keys(res.body!).sort(), ['code', 'error'])
  assert.equal(res.body!.code, 'bad_request')
  assert.doesNotMatch(JSON.stringify(res.body), /Unexpected token|position|SyntaxError/)
  assert.equal(logged.length, 1, 'detail goes to the server log')
})

test('erro final: corpo grande demais vira 413', () => {
  const err = Object.assign(new Error('request entity too large'), { status: 413, type: 'entity.too.large' })
  assert.equal(runHandler(err).res.statusCode, 413)
  const multer = Object.assign(new Error('File too large'), { name: 'MulterError', code: 'LIMIT_FILE_SIZE' })
  const r = runHandler(multer)
  assert.equal(r.res.statusCode, 413)
  assert.equal(r.res.body!.code, 'payload_too_large')
})

test('erro final: erro interno (ex.: Postgres) vira 500 genérico; a mensagem só vai para o log', () => {
  const err = Object.assign(new Error('invalid input syntax for type bigint: "abc"'), { code: '22P02' })
  const { res, logged } = runHandler(err)
  assert.equal(res.statusCode, 500)
  assert.equal(res.body!.code, 'internal_error')
  assert.doesNotMatch(JSON.stringify(res.body), /bigint|22P02/)
  assert.match(logged[0]!, /bigint/)
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

test('final error handler: 411 Length Required keeps its status (JSON body without a declared length)', () => {
  const res = fakeRes()
  finalErrorHandler({ log: () => {} })(Object.assign(new Error('length required'), { status: 411, type: 'length.required' }), { method: 'POST', originalUrl: '/api/x' }, res, () => {})
  assert.equal(res.statusCode, 411)
  assert.equal(res.body!.code, 'length_required')
})

test('final error handler: a 503 from the Lakebase fallback guard keeps its status and a generic message', () => {
  const res = fakeRes()
  finalErrorHandler({ log: () => {} })(Object.assign(new Error('role bypasses RLS'), { status: 503, code: 'lakebase_fallback_refused' }), { method: 'GET', originalUrl: '/api/x' }, res, () => {})
  assert.equal(res.statusCode, 503)
  assert.equal(res.body!.code, 'service_unavailable')
  assert.doesNotMatch(JSON.stringify(res.body), /bypass|RLS/)
})

test('a request with no platform identity never reaches the database through the default source', () => {
  const res = fakeRes()
  // default origins source, anonymous request: served from the env floor and the cache; no read can start (no PG in this test)
  securityHeaders({ env: {} })({ headers: {} }, res, () => {})
  assert.match(res.headers['content-security-policy']!, /img-src 'self' data: blob:(;|$)/)
})

test('warnUnknownEgressMode: one warning for a set value that is not exactly "report"; silent for unset, empty and "report"', () => {
  const seen: string[] = []
  for (const v of [undefined, '', 'report']) assert.equal(warnUnknownEgressMode({ CSP_EGRESS: v }, (m) => seen.push(m)), false)
  for (const v of [' Report ', 'REPORT', 'off']) assert.equal(warnUnknownEgressMode({ CSP_EGRESS: v }, (m) => seen.push(m)), true)
  assert.equal(seen.length, 3)
  assert.match(seen[0]!, /ENFORCED/)
})
