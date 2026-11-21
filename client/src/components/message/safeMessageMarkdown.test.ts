// Every markdown string the chat renders (answer prose, tool questions, tool
// results) goes through safeMessageMarkdown before ReactMarkdown: raw HTML
// and script-bearing link destinations are neutralised by the shared helper
// (shared/markdownSafety.js), while code keeps its exact characters.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeMessageMarkdown } from './safeMessageMarkdown.ts'

test('raw HTML tags in prose are escaped to text', () => {
  assert.equal(safeMessageMarkdown('Hi <script>alert(1)</script> there'), 'Hi &lt;script>alert(1)&lt;/script> there')
  assert.equal(safeMessageMarkdown('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)>')
})

test('a javascript: link destination becomes #', () => {
  assert.equal(safeMessageMarkdown('[click](javascript:alert(1))'), '[click](#)')
  assert.equal(safeMessageMarkdown('[ok](https://example.com)'), '[ok](https://example.com)')
})

test('fenced code keeps its characters, so <div> is not shown as &lt;div>', () => {
  const md = 'Before <b>x</b>\n\n```html\n<div class="a">List<String></div>\n```\n\nAfter <iframe>'
  assert.equal(safeMessageMarkdown(md), 'Before <b>x</b>\n\n```html\n<div class="a">List<String></div>\n```\n\nAfter &lt;iframe>')
})

test('a tilde fence and a longer backtick fence are code too', () => {
  const md = '~~~\n<script>x</script>\n~~~\n\n````\n```\n<p>\n````\n<p>'
  assert.equal(safeMessageMarkdown(md), '~~~\n<script>x</script>\n~~~\n\n````\n```\n<p>\n````\n&lt;p>')
})

test('an unclosed fence (still streaming) is code to the end', () => {
  assert.equal(safeMessageMarkdown('Code:\n\n```js\nconst a = <T>() => 1'), 'Code:\n\n```js\nconst a = <T>() => 1')
})

test('inline code spans keep their characters, prose around them does not', () => {
  assert.equal(safeMessageMarkdown('Use `List<String>` not <em>x</em><svg>'), 'Use `List<String>` not <em>x</em>&lt;svg>')
  assert.equal(safeMessageMarkdown('``a <b` c``<svg>'), '``a <b` c``&lt;svg>')
})

test('an unmatched backtick does not open a code span', () => {
  assert.equal(safeMessageMarkdown('it`s <svg onload=x>'), 'it`s &lt;svg onload=x>')
})

test('non-string input gives an empty string', () => {
  assert.equal(safeMessageMarkdown(undefined), '')
  assert.equal(safeMessageMarkdown(null), '')
})
