import { test } from 'node:test'
import assert from 'node:assert/strict'
import { staleSeededPriceIds, recommendedModelIds, buildUserModels, buildUserImageModels, buildAdminCatalog, derivePrice } from './serving.ts'
import { MODELS } from './llm.ts'

const ov = (endpointId: string, priceIn: number | null, priceOut: number | null, extra: Record<string, unknown> = {}) => ({ endpointId, priceIn, priceOut, enabled: true, ...extra })

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
    assert.notEqual(m!.defaultOn, false)
    assert.equal(m!.modality, undefined)
  }
})

test('fresh install fallback excludes the previous generation', () => {
  const ids = buildUserModels({}).map((m) => m.id)
  assert.equal(ids[0], 'databricks-claude-sonnet-5-5')
  assert.ok(!ids.includes('databricks-claude-sonnet-5'))
})

test('a seeded row with NULL price follows the curated price', () => {
  const [m] = buildUserModels({ 'databricks-kimi-k3': ov('databricks-kimi-k3', null, null, { sortOrder: 0 }) })
  assert.equal(m!.in, 3)
  assert.equal(m!.out, 15)
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
  const chatId = MODELS.find((m) => (m.modality || 'chat') === 'chat')!.id
  const overrides = {
    [chatId]: { endpointId: chatId, enabled: true, sortOrder: 0 },
    'tool:web_search': { endpointId: 'tool:web_search', enabled: true, priceIn: 7 },
    'tool:web_search:firecrawl-mcp': { endpointId: 'tool:web_search:firecrawl-mcp', enabled: true, priceIn: 16 },
  }
  const ids = (list: { id: string }[]) => list.map((m) => m.id)
  assert.ok(!ids(buildAdminCatalog([], overrides)).some((id) => id.startsWith('tool:')))
  assert.ok(ids(buildAdminCatalog([], overrides)).includes(chatId))
  assert.deepEqual(ids(buildUserModels(overrides)), [chatId])
  assert.ok(!ids(buildUserImageModels(overrides)).some((id) => id.startsWith('tool:')))
  // an org whose only overrides are tool prices falls back to the curated defaults
  const onlyTools = { 'tool:web_search': { endpointId: 'tool:web_search', enabled: true, priceIn: 7 } }
  assert.ok(buildUserModels(onlyTools).length > 0)
  assert.ok(!ids(buildUserModels(onlyTools)).some((id) => id.startsWith('tool:')))
})

// ---- image-model guard: the enabled set is the only source of image model ids ----
import { resolveImageModel, imageGenerationEnabled } from './serving.ts'
import { DEFAULT_IMAGE_MODEL } from './llm.ts'

test('resolveImageModel: requested wins when enabled, else saved, else default, else first, else null', () => {
  const enabled = ['img-a', 'img-b', DEFAULT_IMAGE_MODEL]
  assert.equal(resolveImageModel('img-b', enabled, { saved: 'img-a' }), 'img-b')
  assert.equal(resolveImageModel('gone', enabled, { saved: 'img-a' }), 'img-a')
  assert.equal(resolveImageModel('gone', enabled, { saved: 'also-gone' }), DEFAULT_IMAGE_MODEL)
  assert.equal(resolveImageModel(undefined, ['img-a', 'img-b'], { saved: null }), 'img-a')
  assert.equal(resolveImageModel('img-a', [], { saved: 'img-a' }), null)
})

test('resolveImageModel never returns a disabled id', () => {
  const enabled = ['img-b']
  for (const requested of ['img-a', DEFAULT_IMAGE_MODEL, '', undefined, null]) {
    for (const saved of ['img-a', DEFAULT_IMAGE_MODEL, null]) {
      assert.ok(enabled.includes(resolveImageModel(requested, enabled, { saved })!))
    }
  }
})

test('IMAGE_GENERATION=off (exact literal) turns the image model list empty', () => {
  const prev = process.env.IMAGE_GENERATION
  try {
    delete process.env.IMAGE_GENERATION
    assert.equal(imageGenerationEnabled(), true)
    assert.ok(buildUserImageModels({}).length > 0)
    for (const v of ['OFF', '0', 'false', 'Off ']) {
      process.env.IMAGE_GENERATION = v
      assert.equal(imageGenerationEnabled(), true, v)
    }
    process.env.IMAGE_GENERATION = 'off'
    assert.equal(imageGenerationEnabled(), false)
    assert.deepEqual(buildUserImageModels({}), [])
  } finally {
    if (prev === undefined) delete process.env.IMAGE_GENERATION
    else process.env.IMAGE_GENERATION = prev
  }
})

// QA r1: an admin who disabled every image model has NO image model (no curated fallback for image).
test('admin disabling every image override leaves no enabled image models', () => {
  const overrides = Object.fromEntries(
    MODELS.filter((model) => model.modality === 'image').map((model, sortOrder) => [
      model.id,
      { endpointId: model.id, enabled: false, sortOrder },
    ])
  )
  assert.deepEqual(buildUserImageModels(overrides), [])
})

test('image fallback to curated stays for a fresh install and for overrides that never touched image; chat is unchanged', () => {
  const chatId = MODELS.find((m) => (m.modality || 'chat') === 'chat')!.id
  assert.ok(buildUserImageModels({}).length > 0)
  assert.ok(buildUserImageModels({ [chatId]: { endpointId: chatId, enabled: true, sortOrder: 0 } }).length > 0)
  // every chat override disabled → chat still never strands (unchanged)
  const allChatOff = Object.fromEntries(
    MODELS.filter((m) => (m.modality || 'chat') === 'chat').map((m) => [m.id, { endpointId: m.id, enabled: false }])
  )
  assert.ok(buildUserModels(allChatOff).length > 0)
})
