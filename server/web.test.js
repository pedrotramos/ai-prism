import test from 'node:test'
import assert from 'node:assert/strict'
import { htmlToReadableText, safeGet } from './web.js'

test('extrai texto e remove conteúdo não legível', () => {
  const page = htmlToReadableText('<title>A &amp; B</title><nav>menu</nav><main><h1>Título</h1><p>Texto <a href="/fonte">fonte</a>.</p></main><script>segredo()</script>')
  assert.equal(page.title, 'A & B')
  assert.match(page.text, /Título/)
  assert.match(page.text, /fonte \(\/fonte\)/)
  assert.doesNotMatch(page.text, /menu|segredo/)
})

test('bloqueia protocolos e destinos privados', async () => {
  await assert.rejects(() => safeGet('file:///etc/passwd'), /HTTP\/HTTPS/)
  await assert.rejects(() => safeGet('http://127.0.0.1/'), /privado/)
  await assert.rejects(() => safeGet('http://[::1]/'), /privado/)
})
