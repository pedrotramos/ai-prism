import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUsage, costOf, monthWindow, priceUsage, setPriceOverrides } from './usage.js'
import { resolvePrice } from './serving.js'
import { estimateTokens } from './llm.js'

test('normalizeUsage: Gemini reasoning outside completion_tokens is billed as output', () => {
  // sondado: Gemini 3.6 Flash
  assert.deepEqual(normalizeUsage({ prompt_tokens: 14, completion_tokens: 3, total_tokens: 136, reasoning_tokens: 119 }), {
    prompt: 14, output: 122, cacheRead: 0, cacheWrite: 0,
  })
  // sondado: Nano Banana 2 (image tokens only in total_tokens)
  assert.equal(normalizeUsage({ prompt_tokens: 7, completion_tokens: 0, total_tokens: 522 }).output, 515)
  // Claude/GPT: total = prompt + completion → completion stands
  assert.equal(normalizeUsage({ prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 }).output, 4)
  // Gemini's leading all-null chunk carries nothing billable
  assert.equal(normalizeUsage({ prompt_tokens: null, completion_tokens: null, total_tokens: null }), null)
})

test('normalizeUsage: cache fields from both Anthropic and OpenAI shapes', () => {
  const claude = normalizeUsage({ prompt_tokens: 6312, completion_tokens: 8, total_tokens: 6320, cache_read_input_tokens: 6303, cache_creation_input_tokens: 0 })
  assert.equal(claude.cacheRead, 6303)
  const gpt = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 } })
  assert.equal(gpt.cacheRead, 800)
})

test('costOf: list price math, cache discount only where the family bills it', () => {
  const price = { in: 2, out: 10 }
  const plain = costOf({ prompt: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 }, price, 'databricks-claude-sonnet-5-5')
  assert.ok(Math.abs(plain - 3) < 1e-9) // 1M×$2 + 0.1M×$10
  const cached = costOf({ prompt: 1_000_000, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, price, 'databricks-claude-sonnet-5-5')
  assert.ok(Math.abs(cached - 0.2) < 1e-9) // reads at 0.1×
  const written = costOf({ prompt: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }, price, 'databricks-claude-sonnet-5-5')
  assert.ok(Math.abs(written - 2.5) < 1e-9) // writes at 1.25×
  const kimi = costOf({ prompt: 1_000_000, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, { in: 3, out: 15 }, 'databricks-kimi-k3')
  assert.ok(Math.abs(kimi - 3) < 1e-9) // no discount assumed
  assert.equal(costOf({ prompt: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, null, 'x'), null)
})

test('resolvePrice: override > curated > internal > family > null', () => {
  assert.deepEqual(resolvePrice('databricks-kimi-k3', { 'databricks-kimi-k3': { priceIn: 9, priceOut: 9 } }), { in: 9, out: 9 })
  assert.deepEqual(resolvePrice('databricks-gemini-3-1-flash-image', {}), { in: 0.5, out: 60 })
  assert.deepEqual(resolvePrice('databricks-qwen3-embedding-0-6b', {}), { in: 0.02, out: 0 })
  assert.ok(resolvePrice('databricks-claude-sonnet-9', {})) // family book
  assert.equal(resolvePrice('totally-unknown', {}), null)
})

test('priceUsage uses the admin override pushed by the catalog refresh', () => {
  setPriceOverrides({ 'databricks-llama-4-maverick': { priceIn: 100, priceOut: 0 } })
  assert.ok(Math.abs(priceUsage('databricks-llama-4-maverick', { prompt_tokens: 10_000, completion_tokens: 0 }).costUsd - 1) < 1e-9)
  setPriceOverrides({})
})

test('monthWindow: UTC and zoned month boundaries', () => {
  const utc = monthWindow('UTC', new Date('2026-11-03T12:00:00Z'))
  assert.equal(utc.start.toISOString(), '2026-11-01T00:00:00.000Z')
  assert.equal(utc.end.toISOString(), '2026-12-01T00:00:00.000Z')
  // 22:00 on Oct 31 in São Paulo is already Nov in UTC — still October locally
  const sp = monthWindow('America/Sao_Paulo', new Date('2026-11-01T01:00:00Z'))
  assert.equal(sp.start.toISOString(), '2026-10-01T03:00:00.000Z')
  assert.equal(sp.end.toISOString(), '2026-11-01T03:00:00.000Z')
  const dec = monthWindow('UTC', new Date('2026-12-15T00:00:00Z'))
  assert.equal(dec.end.toISOString(), '2027-01-01T00:00:00.000Z')
  // DST: New York switches on Nov 1 2026 — November starts at EDT (UTC−4)
  const ny = monthWindow('America/New_York', new Date('2026-11-10T12:00:00Z'))
  assert.equal(ny.start.toISOString(), '2026-11-01T04:00:00.000Z')
  assert.equal(ny.end.toISOString(), '2026-12-01T05:00:00.000Z')
})

test('estimateTokens: ~4 chars/token plus a flat allowance per image', () => {
  assert.equal(estimateTokens([{ role: 'user', content: 'a'.repeat(400) }]), 100)
  assert.equal(estimateTokens([{ role: 'user', content: [{ type: 'text', text: 'abcd' }, { type: 'image_url', image_url: { url: 'x' } }] }]), 1001)
})
