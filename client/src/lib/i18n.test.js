// Locale resolution of the UI. i18n.jsx is a React module (.jsx), which Node
// cannot import directly, so the test bundles it once with esbuild (already a
// devDependency) into a temp ESM file and imports that.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const SRC = fileURLToPath(new URL('./i18n.jsx', import.meta.url))
let dir
let mod

before(async () => {
  const out = await build({ entryPoints: [SRC], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent', jsx: 'automatic' })
  dir = mkdtempSync(path.join(tmpdir(), 'i18n-test-'))
  const file = path.join(dir, 'i18n.mjs')
  writeFileSync(file, out.outputFiles[0].text)
  mod = await import(pathToFileURL(file).href)
})

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

test('the fallback locale is English', () => {
  assert.equal(mod.FALLBACK_LOCALE, 'en')
})

test('auto follows the browser language when we ship it', () => {
  assert.equal(mod.resolveLocale('auto', 'pt-BR'), 'pt')
  assert.equal(mod.resolveLocale('auto', 'es-MX'), 'es')
  assert.equal(mod.resolveLocale('auto', 'en-GB'), 'en')
})

test('a browser language we do not ship falls back to English, not Portuguese', () => {
  assert.equal(mod.resolveLocale('auto', 'fr-FR'), 'en')
  assert.equal(mod.resolveLocale('auto', 'de'), 'en')
  assert.equal(mod.resolveLocale('auto', ''), 'en')
  assert.equal(mod.resolveLocale(undefined, undefined), 'en')
})

test('an explicit preference wins over the browser; an unknown one falls back like auto', () => {
  assert.equal(mod.resolveLocale('pt-BR', 'en-US'), 'pt')
  assert.equal(mod.resolveLocale('es', 'pt-BR'), 'es')
  assert.equal(mod.resolveLocale('it', 'es-AR'), 'es')
  assert.equal(mod.resolveLocale('it', 'ja-JP'), 'en')
})

test('translate: an unknown locale reads the English catalog; an unknown key returns the key', () => {
  assert.equal(mod.translate('fr', 'sidebar.newChat'), 'New chat')
  assert.equal(mod.translate('pt', 'sidebar.newChat'), 'Nova conversa')
  assert.equal(mod.translate('en', 'no.such.key'), 'no.such.key')
  assert.equal(mod.translate('en', 'history.deleteSelected', { n: 3 }), 'Delete 3 selected')
})
