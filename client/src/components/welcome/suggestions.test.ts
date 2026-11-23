// Welcome screen model: which starter suggestions appear for the capabilities
// this installation actually has, which one is the single primary action, and
// the time-of-day greeting. Pure functions, so the rules are tested here and the
// component only renders them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pt, en, es } from '../../lib/locales/index.ts'
import {
  SUGGESTION_IDS,
  buildSuggestions,
  recencyBucket,
  pickRecents,
  greetingKey,
  firstNameFromEmail,
} from './suggestions.ts'

test('exactly three start cards: data, artifact, documents', () => {
  assert.deepEqual(SUGGESTION_IDS, ['data', 'artifact', 'docs'])
  assert.deepEqual(buildSuggestions().map((s) => s.id), ['data', 'artifact', 'docs'])
})

test('recents: newest first, at most three, untitled and invalid rows skipped', () => {
  const rows = [
    { id: 1, title: 'old', updatedAt: '2026-11-01T10:00:00Z' },
    { id: 2, title: '  ', updatedAt: '2026-11-20T10:00:00Z' },
    { id: 3, title: 'newest', updatedAt: '2026-11-22T10:00:00Z' },
    { id: 4, title: 'bad date', updatedAt: 'nope' },
    { id: 5, title: 'mid', updatedAt: '2026-11-10T10:00:00Z' },
    { id: 6, title: 'older', updatedAt: '2026-10-01T10:00:00Z' },
  ]
  assert.deepEqual(pickRecents(rows).map((r) => r.id), [3, 5, 1])
  assert.deepEqual(pickRecents(undefined), [])
  assert.equal(pickRecents(rows, 1).length, 1)
})

test('recency bucket is by local calendar day', () => {
  const now = new Date(2026, 10, 23, 9, 0)
  assert.equal(recencyBucket(new Date(2026, 10, 23, 0, 5), now), 'today')
  assert.equal(recencyBucket(new Date(2026, 10, 22, 23, 55), now), 'yesterday')
  assert.equal(recencyBucket(new Date(2026, 10, 20, 12, 0), now), 'earlier')
  assert.equal(recencyBucket('garbage', now), 'earlier')
})

test('every suggestion has a title and a prompt in pt, en and es', () => {
  for (const [lang, cat] of Object.entries({ pt, en, es })) {
    for (const id of SUGGESTION_IDS) {
      for (const part of ['title', 'desc', 'prompt']) {
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
  const at = (h: number) => new Date(2026, 10, 17, h, 30)
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
