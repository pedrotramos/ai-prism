// W4-4e: the agents.* copy — every error code, status and chip has a string in en, pt and es; no copy says
// "for a customer" (AC7); no key leaks a raw server message (AC5).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_ERROR_CODES, chipKey } from './agentsLogic.ts'
import { PARTS } from '../../lib/locales/index.ts'

const cats = PARTS as unknown as Record<string, Record<string, Record<string, string>>>

test('AC5: agents.errors.<code> exists in en, pt and es for every code the routes and validation can answer', () => {
  for (const lang of ['en', 'pt', 'es']) {
    const c = cats[lang]!.agents!
    for (const code of AGENT_ERROR_CODES) assert.ok(c[`agents.errors.${code}`], `${lang} agents.errors.${code}`)
  }
})

test('every agents.* key lives in the agents domain, with the same key set in the three languages', () => {
  const keys = (l: string) => Object.keys(cats[l]!.agents!).sort()
  assert.deepEqual(keys('pt'), keys('en'))
  assert.deepEqual(keys('es'), keys('en'))
  for (const k of keys('en')) assert.match(k, /^agents\./)
  for (const st of ['scheduled', 'approved', 'pending', 'draft', 'rejected', 'revoked']) assert.ok(cats.en!.agents![`agents.chip.${st}`], st)
  assert.ok(cats.en!.agents![chipKey({ status: 'draft', enabled: false } as never)])
})

test('AC7: no agents copy says "for a customer" / "para um cliente" / "para un cliente"', () => {
  for (const lang of ['en', 'pt', 'es']) for (const [k, v] of Object.entries(cats[lang]!.agents!)) assert.doesNotMatch(v, /for (a|the) customer|para (um|o) cliente|para (un|el) cliente/i, `${lang} ${k}`)
})

test('the admin screen states the identity of an unattended run (service principal, data visible to the app)', () => {
  assert.match(cats.en!.agents!['agents.admin.identity']!, /app/i)
  assert.match(cats.en!.agents!['agents.admin.identity']!, /service principal/i)
})
