// Welcome screen model: which starter suggestions appear for the capabilities
// this installation actually has, which one is the single primary action, and
// the time-of-day greeting. Pure functions, so the rules are tested here and the
// component only renders them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pt, en, es } from '../../lib/locales/index.ts'
import {
  SUGGESTION_IDS,
  welcomeCapabilities,
  buildSuggestions,
  greetingKey,
  firstNameFromEmail,
} from './suggestions.js'

const ids = (list) => list.map((s) => s.id)

test('without known capabilities: the four artifact/writing starters, deck is primary', () => {
  const list = buildSuggestions()
  assert.deepEqual(ids(list), ['deck', 'sheet', 'doc', 'write'])
  assert.deepEqual(list.filter((s) => s.primary).map((s) => s.id), ['deck'])
})

test('a data tool makes the data question the first and only primary starter', () => {
  const list = buildSuggestions({ data: true })
  assert.deepEqual(ids(list), ['data', 'deck', 'sheet', 'doc', 'write'])
  assert.deepEqual(list.filter((s) => s.primary).map((s) => s.id), ['data'])
})

test('image generation adds the image starter; never more than six, never fewer than four', () => {
  assert.deepEqual(ids(buildSuggestions({ image: true })), ['deck', 'sheet', 'doc', 'image', 'write'])
  const all = buildSuggestions({ data: true, image: true })
  assert.deepEqual(ids(all), ['data', 'deck', 'sheet', 'doc', 'image', 'write'])
  for (const caps of [{}, { data: true }, { image: true }, { data: true, image: true }]) {
    const n = buildSuggestions(caps).length
    assert.ok(n >= 4 && n <= 6, `${JSON.stringify(caps)} -> ${n}`)
    assert.equal(buildSuggestions(caps).filter((s) => s.primary).length, 1)
  }
})

test('capabilities come from the enabled tools, the admin tool policy and the image models', () => {
  assert.deepEqual(welcomeCapabilities(), { data: false, image: false })
  const tools = [{ kind: 'genie-one' }, { kind: 'image-gen' }]
  const models = [{ id: 'databricks-gemini-image' }]
  assert.deepEqual(welcomeCapabilities({ enabledTools: tools, toolPolicy: {}, imageModels: models }), { data: true, image: true })
  // admin turned the tool off for everyone
  assert.deepEqual(
    welcomeCapabilities({ enabledTools: tools, toolPolicy: { 'genie-one': false, 'image-gen': false }, imageModels: models }),
    { data: false, image: false }
  )
  // image tool on, but no image model is served
  assert.equal(welcomeCapabilities({ enabledTools: tools, imageModels: [] }).image, false)
  // any data-shaped tool counts
  for (const kind of ['genie', 'uc', 'vector-search']) {
    assert.equal(welcomeCapabilities({ enabledTools: [{ kind }] }).data, true, kind)
  }
  assert.equal(welcomeCapabilities({ enabledTools: [{ kind: 'python' }] }).data, false)
})

test('every suggestion has a title and a prompt in pt, en and es', () => {
  for (const [lang, cat] of Object.entries({ pt, en, es })) {
    for (const id of SUGGESTION_IDS) {
      for (const part of ['title', 'prompt']) {
        const key = `welcome.suggestion.${id}.${part}`
        assert.ok(typeof cat[key] === 'string' && cat[key].trim(), `${lang}: ${key}`)
      }
    }
    for (const g of ['morning', 'afternoon', 'evening']) {
      assert.ok(cat[`welcome.greeting.${g}`], `${lang}: welcome.greeting.${g}`)
      assert.ok(cat[`welcome.greetingNamed.${g}`]?.includes('{name}'), `${lang}: welcome.greetingNamed.${g}`)
    }
  }
})

test('greeting follows the local hour', () => {
  const at = (h) => new Date(2026, 10, 17, h, 30)
  assert.equal(greetingKey(at(5)), 'morning')
  assert.equal(greetingKey(at(11)), 'morning')
  assert.equal(greetingKey(at(12)), 'afternoon')
  assert.equal(greetingKey(at(17)), 'afternoon')
  assert.equal(greetingKey(at(18)), 'evening')
  assert.equal(greetingKey(at(2)), 'evening')
})

test('first name only for a first.last style e-mail (never a service or test account)', () => {
  assert.equal(firstNameFromEmail('ana.souza@example.com'), 'Ana')
  assert.equal(firstNameFromEmail('JOSÉ_lima@example.com'), 'José')
  assert.equal(firstNameFromEmail('e2e-user@example.com'), null)
  assert.equal(firstNameFromEmail('a@example.com'), null)
  assert.equal(firstNameFromEmail('svc-1234@example.com'), null)
  assert.equal(firstNameFromEmail('pedro@example.com'), null)
  assert.equal(firstNameFromEmail('maria-clara.reis@example.com'), 'Maria')
  assert.equal(firstNameFromEmail(''), null)
  assert.equal(firstNameFromEmail(undefined), null)
})
