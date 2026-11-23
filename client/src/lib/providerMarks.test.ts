import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODELS } from '../../../server/llm.ts'
import { BY_ID, BY_PROVIDER, MARK_PATHS, markFor } from './providerMarks.ts'
import type { ProviderMarkId } from './providerMarks.ts'

// Providers in MODELS that deliberately get the neutral dot (no vendor mark).
const FALLBACK_OK = new Set(['Outros'])

test('every MODELS entry resolves to a mark, or its provider is in FALLBACK_OK', () => {
  assert.ok(MODELS.length > 0)
  const bad = MODELS.filter((m) => markFor(m) === null && !FALLBACK_OK.has(m.provider)).map((m) => `${m.id} (${m.provider})`)
  assert.deepEqual(bad, [])
})

test('every provider named in MODELS is mapped by BY_PROVIDER or listed in FALLBACK_OK', () => {
  const providers = new Set(MODELS.map((m) => m.provider))
  for (const p of providers) assert.ok(p in BY_PROVIDER || FALLBACK_OK.has(p), `provider without a mark: ${p}`)
})

test('BY_ID puts specific before generic (fixtures)', () => {
  const f = (id: string) => markFor({ provider: 'Outros', id })
  assert.equal(f('databricks-gpt-oss-120b'), 'openai')
  assert.equal(f('databricks-claude-sonnet-5-5'), 'claude')
  assert.equal(f('databricks-qwen3-embedding-0-6b'), 'qwen')
  assert.equal(f('databricks-meta-llama-3-3-70b-instruct'), 'meta')
  assert.equal(f('databricks-gemini-3-flash'), 'gemini')
  assert.equal(f('databricks-gemma-3-12b'), 'gemini')
  assert.equal(f('databricks-deepseek-v3'), 'deepseek')
  assert.equal(f('databricks-glm-5-3'), 'zhipu')
  assert.equal(f('databricks-kimi-k3'), 'kimi')
  assert.equal(f('o3-mini'), 'openai')
  assert.equal(f('foo-bar'), null)
})

test('a known provider wins over the id; an unknown provider falls back to the id', () => {
  assert.equal(markFor({ provider: 'Anthropic', id: 'whatever' }), 'claude')
  assert.equal(markFor({ provider: 'Moonshot AI', id: 'x' }), 'kimi')
  assert.equal(markFor({ provider: 'Somebody', id: 'my-claude-ft' }), 'claude')
  assert.equal(markFor({ provider: 'OpenAI (OSS)', id: 'x' }), 'openai')
})

test('markFor tolerates missing input', () => {
  assert.equal(markFor(null), null)
  assert.equal(markFor(undefined), null)
  assert.equal(markFor({}), null)
  assert.equal(markFor({ provider: null, id: null }), null)
})

test('BY_ID and BY_PROVIDER only point at marks that have path data', () => {
  for (const [, id] of BY_ID) assert.ok(MARK_PATHS[id].length > 0, id)
  for (const id of Object.values(BY_PROVIDER)) assert.ok(MARK_PATHS[id].length > 0, id)
})

test('MARK_PATHS has non-empty path data for all 9 marks, including mcp', () => {
  const ids: ProviderMarkId[] = ['claude', 'openai', 'gemini', 'deepseek', 'zhipu', 'kimi', 'qwen', 'meta', 'mcp']
  for (const id of ids) {
    assert.ok(MARK_PATHS[id].length > 0, id)
    for (const d of MARK_PATHS[id]) assert.match(d, /^M/, `${id} path starts with a moveto`)
  }
})

test('provider names that match Object.prototype members fall back to the id, then to null', () => {
  for (const provider of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.equal(markFor({ provider, id: 'claude-custom-endpoint' }), 'claude', `${provider}: id fallback`)
    assert.equal(markFor({ provider, id: 'unknown-endpoint' }), null, `${provider}: unknown fallback`)
  }
})
