import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectExternalRefs } from './dsExternalRefs.ts'

const find = (refs: ReturnType<typeof collectExternalRefs>, kind: string, host: string) =>
  refs.find((r) => r.kind === kind && r.host === host)

test('collectExternalRefs: Google Fonts <link> is a font stylesheet by host', () => {
  const refs = collectExternalRefs(['<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'])
  assert.deepEqual(refs, [{ kind: 'fontStylesheet', host: 'fonts.googleapis.com', count: 1 }])
})

test('collectExternalRefs: @import (url() and bare string forms)', () => {
  const refs = collectExternalRefs([
    '@import url("https://fonts.googleapis.com/css?family=Inter");\n@import "https://cdn.example.com/a.css";',
  ])
  assert.equal(find(refs, 'import', 'fonts.googleapis.com')?.count, 1)
  assert.equal(find(refs, 'import', 'cdn.example.com')?.count, 1)
  assert.equal(refs.length, 2, 'an @import url() is not double counted as url()')
})

test('collectExternalRefs: url() classified as font, image or other', () => {
  const refs = collectExternalRefs([
    '@font-face{src:url(https://cdn.example.com/f.woff2) format("woff2")}',
    '.a{background:url("https://img.example.org/bg.png")}',
    '.b{cursor:url(https://x.example.net/c)}',
  ])
  assert.ok(find(refs, 'fontUrl', 'cdn.example.com'))
  assert.ok(find(refs, 'imageUrl', 'img.example.org'))
  assert.ok(find(refs, 'other', 'x.example.net'))
})

test('collectExternalRefs: <img src>, <script src> and protocol-relative', () => {
  const refs = collectExternalRefs([
    '<img src="https://pics.example.com/a.jpg"><script src="http://js.example.com/x.js"></script><img src="//pics.example.com/b.jpg">',
  ])
  assert.equal(find(refs, 'img', 'pics.example.com')?.count, 2)
  assert.ok(find(refs, 'other', 'js.example.com'))
})

test('collectExternalRefs: dedups by kind+host across sources and counts', () => {
  const refs = collectExternalRefs([
    '.a{background:url(https://cdn.example.com/1.png)}',
    '.b{background:url(https://cdn.example.com/2.png)}',
    '.c{background:url(https://other.example.com/3.png)}',
  ])
  assert.equal(find(refs, 'imageUrl', 'cdn.example.com')?.count, 2)
  assert.equal(refs.length, 2)
})

test('collectExternalRefs: data:, relative and fragment refs are ignored', () => {
  const refs = collectExternalRefs([
    '<img src="data:image/png;base64,AAAA"><img src="assets/a.png"><a href="#x">x</a>',
    '.a{background:url(data:image/svg+xml;base64,AAAA)} .b{background:url(../img/a.png)}',
    '<a href="https://example.com/docs">link</a>',
  ])
  assert.deepEqual(refs, [])
})
