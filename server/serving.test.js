import { test } from 'node:test'
import assert from 'node:assert/strict'
import { staleSeededPriceIds, recommendedModelIds, buildUserModels, buildUserImageModels, buildAdminCatalog, derivePrice } from './serving.js'
import { MODELS } from './llm.js'

const ov = (endpointId, priceIn, priceOut, extra = {}) => ({ endpointId, priceIn, priceOut, enabled: true, ...extra })

test('staleSeededPriceIds: clears prices the old seed froze, keeps admin-typed and non-curated ones', () => {
  const overrides = {
    'databricks-kimi-k3': ov('databricks-kimi-k3', 0.5, 2.5), // old seed price
    'databricks-claude-sonnet-5': ov('databricks-claude-sonnet-5', 2, 10), // equals current curated
    'databricks-gpt-5-6-sol': ov('databricks-gpt-5-6-sol', 7, 30), // admin-typed
    'databricks-glm-5-2': ov('databricks-glm-5-2', null, null), // already following curated
    'my-custom-endpoint': ov('my-custom-endpoint', 1, 2), // non-curated: price lives only here
  }
  assert.deepEqual(staleSeededPriceIds(overrides).sort(), ['databricks-claude-sonnet-5', 'databricks-kimi-k3'])
})

test('recommendedModelIds: curated chat defaults missing from the catalog, never defaultOn:false or image', () => {
  const rec = recommendedModelIds({ 'databricks-claude-sonnet-5-5': ov('databricks-claude-sonnet-5-5', null, null) })
  assert.ok(!rec.includes('databricks-claude-sonnet-5-5'))
  assert.ok(rec.includes('databricks-gemini-4-argon'))
  for (const id of rec) {
    const m = MODELS.find((x) => x.id === id)
    assert.notEqual(m.defaultOn, false)
    assert.equal(m.modality, undefined)
  }
})

test('fresh install fallback excludes the previous generation', () => {
  const ids = buildUserModels({}).map((m) => m.id)
  assert.equal(ids[0], 'databricks-claude-sonnet-5-5')
  assert.ok(!ids.includes('databricks-claude-sonnet-5'))
})

test('a seeded row with NULL price follows the curated price', () => {
  const [m] = buildUserModels({ 'databricks-kimi-k3': ov('databricks-kimi-k3', null, null, { sortOrder: 0 }) })
  assert.equal(m.in, 3)
  assert.equal(m.out, 15)
})

test('family price book: new tiers, errs high on unknown members', () => {
  assert.deepEqual(derivePrice('databricks-gemini-4-argon'), [4, 20])
  assert.deepEqual(derivePrice('databricks-gpt-7-astra'), [10, 50])
  assert.deepEqual(derivePrice('databricks-claude-fable-6'), [10, 50])
  assert.deepEqual(derivePrice('databricks-glm-6-flash'), [0.15, 0.5])
  assert.equal(derivePrice('databricks-unknown-model'), null)
})

// W2-11b AC-7: the web search price rows ('tool:web_search', 'tool:web_search:<provider>')
// reuse the model-override table but are never models.
test('tool:* price override rows never reach the admin catalog or either picker', () => {
  const chatId = MODELS.find((m) => (m.modality || 'chat') === 'chat').id
  const overrides = {
    [chatId]: { endpointId: chatId, enabled: true, sortOrder: 0 },
    'tool:web_search': { endpointId: 'tool:web_search', enabled: true, priceIn: 7 },
    'tool:web_search:firecrawl-mcp': { endpointId: 'tool:web_search:firecrawl-mcp', enabled: true, priceIn: 16 },
  }
  const ids = (list) => list.map((m) => m.id)
  assert.ok(!ids(buildAdminCatalog([], overrides)).some((id) => id.startsWith('tool:')))
  assert.ok(ids(buildAdminCatalog([], overrides)).includes(chatId))
  assert.deepEqual(ids(buildUserModels(overrides)), [chatId])
  assert.ok(!ids(buildUserImageModels(overrides)).some((id) => id.startsWith('tool:')))
  // an org whose only overrides are tool prices falls back to the curated defaults
  const onlyTools = { 'tool:web_search': { endpointId: 'tool:web_search', enabled: true, priceIn: 7 } }
  assert.ok(buildUserModels(onlyTools).length > 0)
  assert.ok(!ids(buildUserModels(onlyTools)).some((id) => id.startsWith('tool:')))
})
