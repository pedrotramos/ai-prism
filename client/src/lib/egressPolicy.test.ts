// md-exfil T4: the client egress store (fails closed until /api/me answers) and
// the pure image verdict every markdown renderer shares.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getEgressPolicy, setExternalAssetOrigins, imageVerdict, blockedImageHtml } from './egressPolicy.ts'

const APP = 'https://app.example.test'

test('the store is EMPTY until /api/me answers (fail closed) and ignores junk', () => {
  assert.deepEqual(getEgressPolicy().allowedOrigins, [])
  setExternalAssetOrigins(undefined)
  assert.deepEqual(getEgressPolicy().allowedOrigins, [])
  setExternalAssetOrigins(['http://insecure.example', 'https://*.wild.example', 'not a url', 'https://cdn.example'])
  assert.deepEqual(getEgressPolicy().allowedOrigins.map((o) => o.origin), ['https://cdn.example'])
  setExternalAssetOrigins([])
  assert.deepEqual(getEgressPolicy().allowedOrigins, [])
})

test('imageVerdict: external is blocked with its host, safe sources render, allowlisted renders', () => {
  const empty = getEgressPolicy()
  assert.deepEqual(imageVerdict('https://evil.example/a.png?v=1', empty, APP), { blocked: true, host: 'evil.example' })
  assert.deepEqual(imageVerdict('//evil.example/a.png', empty, APP), { blocked: true, host: 'evil.example' })
  assert.equal(imageVerdict('/api/images/7', empty, APP).blocked, false)
  assert.equal(imageVerdict('data:image/png;base64,AAAA', empty, APP).blocked, false)
  assert.deepEqual(imageVerdict('', empty, APP), { blocked: true, host: null })
  assert.deepEqual(imageVerdict(undefined, empty, APP), { blocked: true, host: null })
  assert.deepEqual(imageVerdict('javascript:alert(1)', empty, APP), { blocked: true, host: null })
  setExternalAssetOrigins(['https://cdn.example'])
  assert.equal(imageVerdict('https://cdn.example/x.png', getEgressPolicy(), APP).blocked, false)
  assert.equal(imageVerdict('https://cdn.example.evil.example/x.png', getEgressPolicy(), APP).blocked, true)
  setExternalAssetOrigins([])
})

test('blockedImageHtml escapes everything, names the host, keeps the source only as inert data', () => {
  const html = blockedImageHtml({ alt: '"><img src=x onerror=1>', host: 'evil.example', src: 'https://evil.example/?a="b"', label: 'Image not loaded (evil.example)' })
  assert.match(html, /^<span class="md-image-blocked" role="img" aria-label="Image not loaded \(evil\.example\)"/)
  assert.ok(!/<img/i.test(html), html)
  assert.ok(!/"[^"]*"[^ >]*onerror/.test(html), html)
  assert.match(html, /data-md-src="https:\/\/evil\.example\/\?a=&quot;b&quot;"/)
  assert.match(html, /evil\.example<\/span>$/)
})
