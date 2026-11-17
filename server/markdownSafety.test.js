import test from 'node:test'
import assert from 'node:assert/strict'
import { safeLinkDestination, stripUnsafeMarkdownHtml } from '../shared/markdownSafety.js'
import { sanitizeDocument } from './blocks.js'

test('raw tags become text; the harmless formatting tags stay', () => {
  assert.equal(stripUnsafeMarkdownHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)>')
  assert.equal(stripUnsafeMarkdownHtml('a <b>forte</b> e <br>'), 'a <b>forte</b> e <br>')
  assert.equal(stripUnsafeMarkdownHtml('<!-- c --> <script>x</script>'), '&lt;!-- c --> &lt;script>x&lt;/script>')
})

test('autolinks for http, https and mailto stay', () => {
  assert.equal(stripUnsafeMarkdownHtml('<https://example.com>'), '<https://example.com>')
})

test('javascript:, data: (non-image) and similar link destinations become #', () => {
  assert.equal(stripUnsafeMarkdownHtml('[x](javascript:alert(1))'), '[x](#)')
  assert.equal(stripUnsafeMarkdownHtml('[x](jav&#x09;ascript:alert(1))'), '[x](#)')
  assert.equal(stripUnsafeMarkdownHtml('[x](data:text/html;base64,AAAA)'), '[x](#)')
  assert.equal(stripUnsafeMarkdownHtml('![x](data:image/png;base64,AAAA)'), '![x](data:image/png;base64,AAAA)')
  assert.equal(stripUnsafeMarkdownHtml('[x]: javascript:alert(1)'), '[x]: #')
})

test('http, https, mailto and tel links are kept', () => {
  assert.equal(stripUnsafeMarkdownHtml('[a](https://x.example/p) [b](mailto:a@b.c)'), '[a](https://x.example/p) [b](mailto:a@b.c)')
  assert.equal(safeLinkDestination('tel:+5511999'), true)
})

test('idempotent', () => {
  const once = stripUnsafeMarkdownHtml('<img src=x> [l](javascript:x)')
  assert.equal(stripUnsafeMarkdownHtml(once), once)
})

test('non-strings give an empty string', () => {
  assert.equal(stripUnsafeMarkdownHtml(undefined), '')
})

test('document writes are neutralized by sanitizeDocument', () => {
  const doc = sanitizeDocument({ type: 'document', title: 'T', markdown: '# Oi\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))' })
  assert.doesNotMatch(doc.markdown, /<img/)
  assert.match(doc.markdown, /&lt;img/)
  assert.match(doc.markdown, /\(#\)/)
})

test('truncation marker is appended after neutralization, so it stays a comment marker', () => {
  const big = 'x'.repeat(200_000 + 10)
  const doc = sanitizeDocument({ type: 'document', markdown: big })
  assert.ok(doc.markdown.endsWith('<!-- truncado -->'))
})
