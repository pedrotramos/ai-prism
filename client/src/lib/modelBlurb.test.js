// AC6: model blurbs follow the UI language; unknown ids and admin edits keep the stored text.
//   node --test client/src/lib/modelBlurb.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { modelBlurb } from './modelBlurb.js'
import { pt, en, es } from './locales/index.js'

// the same lookup order as i18n.jsx: language → en → pt → key
const CAT = { pt, en, es }
const tFor = (locale) => (k) => CAT[locale][k] ?? en[k] ?? pt[k] ?? k
const sonnet = { id: 'databricks-claude-sonnet-5-5', blurb: 'Equilibrado e rápido — ótimo padrão para agentes' }

test('a seeded blurb renders in en, pt-BR and es', () => {
  assert.equal(modelBlurb(sonnet, tFor('pt')), 'Equilibrado e rápido — ótimo padrão para agentes')
  assert.equal(modelBlurb(sonnet, tFor('en')), 'Balanced and fast — a great default for agents')
  assert.match(modelBlurb(sonnet, tFor('es')), /^Equilibrado y rápido/)
})

test('an empty stored blurb still localizes a curated model', () => {
  assert.equal(modelBlurb({ id: sonnet.id, blurb: '' }, tFor('en')), en[`modelPicker.blurb.${sonnet.id}`])
})

test('an unknown model id falls back to its stored blurb in every language', () => {
  const m = { id: 'databricks-brand-new', blurb: 'Texto guardado' }
  for (const l of ['pt', 'en', 'es']) assert.equal(modelBlurb(m, tFor(l)), 'Texto guardado')
  assert.equal(modelBlurb({ id: 'x' }, tFor('en')), '')
})

test('a blurb an admin edited is never replaced', () => {
  const m = { id: sonnet.id, blurb: 'Nosso padrão interno' }
  for (const l of ['pt', 'en', 'es']) assert.equal(modelBlurb(m, tFor(l)), 'Nosso padrão interno')
})

test('every blurb key exists in the three catalogs', () => {
  const keys = Object.keys(pt).filter((k) => k.startsWith('modelPicker.blurb.'))
  assert.ok(keys.length >= 24)
  for (const k of keys) assert.ok(en[k] && es[k], k)
})
