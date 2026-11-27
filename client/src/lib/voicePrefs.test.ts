import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRate, VOICE_RATES } from './voicePrefs.ts'

test('every offered speed reads back as itself', () => {
  for (const r of VOICE_RATES) assert.equal(parseRate(String(r)), r)
})

test('anything else (missing, junk, out of range) reads as normal speed', () => {
  for (const raw of [null, undefined, '', 'fast', '0', '9', '-1', NaN]) assert.equal(parseRate(raw), 1)
})
