// Source-level guard for the client's srcdoc frames (no browser in this suite):
// every <iframe> in client/src declares a sandbox, the DS thumbnail never falls
// back to "no sandbox" (the stored-XSS bug: sandbox={… : undefined}), and no
// frame combines allow-scripts with allow-same-origin (that pair lets framed
// script reach the app's origin). See SECURITY.md, "HTML de design system".
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'src')

function sources(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(p))
    else if (/\.(jsx?|tsx?)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
  }
  return out
}

// each JSX <iframe ...> opening element (up to its closing `>` / `/>`)
function jsxIframes(src) {
  const out = []
  const re = /<iframe\b/g
  let m
  while ((m = re.exec(src))) {
    let depth = 0
    let j = m.index
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') depth--
      else if (src[j] === '>' && depth === 0) break
    }
    out.push(src.slice(m.index, j + 1))
  }
  return out
}

const files = sources(CLIENT).map((f) => ({ f: path.relative(CLIENT, f), src: fs.readFileSync(f, 'utf8') }))

test('every <iframe> in client/src declares a sandbox attribute', () => {
  const frames = files.flatMap(({ f, src }) => jsxIframes(src).map((tag) => ({ f, tag })))
  assert.ok(frames.length >= 6, `expected the known srcdoc frames, found ${frames.length}`)
  for (const { f, tag } of frames) assert.match(tag, /\bsandbox=/, `${f}: ${tag}`)
})

test('the DS thumbnail never renders without a sandbox', () => {
  const { src } = files.find(({ f }) => f === path.join('components', 'DeckTemplatesSettings.jsx'))
  const tags = jsxIframes(src)
  assert.equal(tags.length, 1)
  assert.doesNotMatch(tags[0], /sandbox=\{[^}]*\bundefined\b/)
  assert.doesNotMatch(tags[0], /sandbox=\{[^}]*\bnull\b/)
  assert.match(tags[0], /sandbox=\{allowScripts \? 'allow-scripts' : ''\}/)
})

test('no frame combines allow-scripts with allow-same-origin', () => {
  for (const { f, src } of files) {
    for (const tag of jsxIframes(src)) {
      const s = (/sandbox=(?:"([^"]*)"|\{([^}]*)\})/.exec(tag) || []).slice(1).join(' ')
      assert.ok(!(/allow-scripts/.test(s) && /allow-same-origin/.test(s)), `${f}: ${tag}`)
    }
    // frames built with document.createElement('iframe') get their sandbox via setAttribute
    for (const m of src.matchAll(/setAttribute\('sandbox',\s*'([^']*)'\)/g)) {
      assert.ok(!(/allow-scripts/.test(m[1]) && /allow-same-origin/.test(m[1])), `${f}: ${m[0]}`)
    }
    if (/createElement\('iframe'\)/.test(src)) assert.match(src, /setAttribute\('sandbox'/, `${f} creates an iframe without a sandbox`)
  }
})
