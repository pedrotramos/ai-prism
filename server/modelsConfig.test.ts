// models.json at run time (server/modelsConfig.ts): parsing into catalog rows and the content hash, the
// image list normalizer, what the file turns off, the boot registration and what the picker shows from
// it on a fresh install; plus that the shipped file is the catalog's own default.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const mc = await import('./modelsConfig.ts')
const llm = await import('./llm.ts')
const serving = await import('./serving.ts')

const PROVIDER = 'main.ext.gemini'
const file = (cfg: unknown): string => JSON.stringify(cfg)
const chat = [
  { id: 'databricks-claude-sonnet-5-5', label: 'Sonnet' },
  { id: ' databricks-gpt-6-luna ', label: 'Luna', blurb: 'b', priceIn: 1, priceOut: 2 },
  { label: 'no id' },
]

test('parseModelsConfig: chat rows in file order with trimmed ids, prices only when valid', () => {
  const cfg = mc.parseModelsConfig(file({ models: [...chat, { id: 'x', label: 'X', priceIn: -1, priceOut: 'a' }] }))!
  assert.deepEqual(cfg.rows.map((r) => [r.id, r.sortOrder, r.priceIn, r.priceOut]), [
    ['databricks-claude-sonnet-5-5', 0, null, null],
    ['databricks-gpt-6-luna', 1, 1, 2],
    ['x', 2, null, null],
  ])
  assert.equal(cfg.imageRows, null, 'no imageModels key')
  assert.equal(mc.parseModelsConfig(file({ models: [] })), null)
  assert.equal(mc.parseModelsConfig(file({})), null)
  assert.throws(() => mc.parseModelsConfig('{ nope'))
})

test('the hash follows the content: same rows same hash; a change to either list changes it; the image key counts', () => {
  const a = mc.parseModelsConfig(file({ models: chat }))!
  assert.equal(mc.parseModelsConfig(file({ _readme: ['ignored'], models: chat }))!.hash, a.hash, 'unknown keys do not count')
  assert.notEqual(mc.parseModelsConfig(file({ models: [chat[1], chat[0]] }))!.hash, a.hash, 'the order counts')
  const withImages = mc.parseModelsConfig(file({ models: chat, imageModels: [] }))!
  assert.notEqual(withImages.hash, a.hash, 'an empty imageModels (off) is not the absent key')
  assert.deepEqual(withImages.imageRows, [])
  const one = mc.parseModelsConfig(file({ models: chat, imageModels: [{ id: 'ep-1', label: 'E' }] }))!
  assert.notEqual(one.hash, withImages.hash)
  assert.match(a.hash, /^[0-9a-f]{16}$/)
})

test('normalizeImageModels: both kinds, derived ids, invalid / mixed / duplicate / chat-id items left out', () => {
  const rows = mc.normalizeImageModels(
    [
      { id: 'ep-1', label: 'E1', blurb: 'fast' },
      { provider: PROVIDER, model: 'gemini-3-pro-image', label: 'Pro' },
      { id: 'ep-1', label: 'dup' },
      { id: 'a/b', label: 'bad id' },
      { id: 'ep-2', provider: PROVIDER, model: 'm', label: 'mixed' },
      { provider: 'two.parts', model: 'm', label: 'bad provider' },
      { id: 'databricks-gpt-6-luna', label: 'is a chat model' },
      { label: 'nothing' },
      null,
    ] as unknown[],
    new Set(['databricks-gpt-6-luna'])
  )!
  assert.deepEqual(rows.map((r) => [r.id, r.displayName, r.sortOrder, r.provider ?? null, r.model ?? null]), [
    ['ep-1', 'E1', 0, null, null],
    [`${PROVIDER}/gemini-3-pro-image`, 'Pro', 1, PROVIDER, 'gemini-3-pro-image'],
  ])
  assert.equal(mc.normalizeImageModels('x', new Set()), null)
  assert.equal(mc.normalizeImageModels(undefined, new Set()), null)
})

test('overridesToDisable: chat models outside the file; image ones only when the file has the key', () => {
  const withKey = { rows: [{ id: 'chat-a' }, { id: 'chat-b' }], imageRows: [{ id: 'img-a' }] } as Parameters<typeof mc.overridesToDisable>[1]
  const withoutKey = { rows: withKey.rows, imageRows: null } as Parameters<typeof mc.overridesToDisable>[1]
  const isImage = (id: string) => id.startsWith('img-')
  const enabled = ['chat-a', 'chat-z', 'img-a', 'img-z']
  assert.deepEqual(mc.overridesToDisable(enabled, withKey, isImage), ['chat-z', 'img-z'])
  assert.deepEqual(mc.overridesToDisable(enabled, withoutKey, isImage), ['chat-z'], 'an image model an admin enabled survives a file without imageModels')
  assert.deepEqual(mc.overridesToDisable(['chat-b'], withKey, isImage), [])
  // the default classifier: the catalog's own image models and the registered ones
  assert.deepEqual(mc.overridesToDisable(['databricks-gemini-3-1-flash-image', 'databricks-kimi-k3'], withKey), ['databricks-gemini-3-1-flash-image', 'databricks-kimi-k3'])
})

test('bootModelsConfig: MODELS_CONFIG_PATH registers the file; a missing or broken file counts as absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-boot-'))
  const prev = process.env.MODELS_CONFIG_PATH
  try {
    const good = path.join(dir, 'models.json')
    fs.writeFileSync(good, file({ models: [{ id: 'databricks-kimi-k3', label: 'Kimi', blurb: 'B' }], imageModels: [{ provider: PROVIDER, model: 'gemini-3.1-flash-image', label: 'NB2' }] }))
    process.env.MODELS_CONFIG_PATH = good
    const cfg = mc.bootModelsConfig()!
    assert.equal(cfg.rows.length, 1)
    assert.equal(mc.modelsConfigSyncPending(), true, 'booted, not compared with the catalog yet')
    assert.deepEqual(llm.getConfiguredChatModels(), [{ id: 'databricks-kimi-k3', label: 'Kimi', blurb: 'B' }])
    const id = `${PROVIDER}/gemini-3.1-flash-image`
    assert.deepEqual(llm.getConfiguredImageModels()?.map((m) => m.id), [id])
    assert.equal(llm.isImageModel(id), true)
    assert.equal(serving.deriveModality(id), 'image')

    process.env.MODELS_CONFIG_PATH = path.join(dir, 'missing.json')
    assert.equal(mc.bootModelsConfig(), null)
    assert.equal(mc.modelsConfigSyncPending(), false, 'no file: nothing to apply')
    assert.equal(llm.getConfiguredChatModels(), null)
    assert.equal(llm.getConfiguredImageModels(), null)

    const broken = path.join(dir, 'broken.json')
    fs.writeFileSync(broken, '{ nope')
    process.env.MODELS_CONFIG_PATH = broken
    assert.equal(mc.bootModelsConfig(), null)
    assert.equal(llm.getConfiguredChatModels(), null)
  } finally {
    if (prev === undefined) delete process.env.MODELS_CONFIG_PATH
    else process.env.MODELS_CONFIG_PATH = prev
    mc.bootModelsConfig()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('syncModelsConfigOnce: only an admin applies it; a failure is retried by the next admin request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-sync-'))
  const prev = process.env.MODELS_CONFIG_PATH
  try {
    process.env.MODELS_CONFIG_PATH = path.join(dir, 'models.json')
    fs.writeFileSync(process.env.MODELS_CONFIG_PATH, file({ models: [{ id: 'databricks-kimi-k3', label: 'Kimi' }] }))
    mc.bootModelsConfig()
    mc.resetModelsConfigSync()
    assert.equal(await mc.syncModelsConfigOnce('u@x', 'tok', { admin: false }), false)
    assert.equal(mc.modelsConfigSyncPending(), true, 'a non-admin request leaves it pending')
  } finally {
    if (prev === undefined) delete process.env.MODELS_CONFIG_PATH
    else process.env.MODELS_CONFIG_PATH = prev
    mc.bootModelsConfig()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a fresh install (no catalog rows) shows the file\'s list, in file order, with its names; without a file the curated defaults', () => {
  llm.setConfiguredChatModels([
    { id: 'databricks-kimi-k3', label: 'Kimi (company)', blurb: '' },
    { id: 'databricks-claude-sonnet-5-5', label: 'Sonnet', blurb: 'Custom blurb' },
  ])
  try {
    const models = serving.buildUserModels({})
    assert.deepEqual(models.map((m) => m.id), ['databricks-kimi-k3', 'databricks-claude-sonnet-5-5'])
    assert.equal(models[0]!.label, 'Kimi (company)')
    assert.equal(models[0]!.blurb, llm.MODELS.find((m) => m.id === 'databricks-kimi-k3')!.blurb, 'a blurb left out keeps the curated one')
    assert.equal(models[1]!.blurb, 'Custom blurb')
    assert.equal(models[0]!.in, 3, 'curated price and flags')
    assert.equal(models[0]!.vision, true)
    // once the catalog has rows it speaks for itself
    const withRows = serving.buildUserModels({ 'databricks-glm-5-3': { endpointId: 'databricks-glm-5-3', enabled: true, sortOrder: 0 } })
    assert.deepEqual(withRows.map((m) => m.id), ['databricks-glm-5-3'])
  } finally {
    llm.setConfiguredChatModels(null)
  }
  assert.equal(serving.buildUserModels({})[0]!.id, 'databricks-claude-sonnet-5-5')
})

test('image picker: the file\'s image list on a fresh install; [] switches generation off even with a catalog row', () => {
  const id = `${PROVIDER}/gemini-3-pro-image`
  llm.setConfiguredImageModels([{ id, label: 'Nano Banana Pro', blurb: '', provider: PROVIDER, model: 'gemini-3-pro-image' }])
  try {
    const [m] = serving.buildUserImageModels({})
    assert.equal(m!.id, id)
    assert.equal(m!.label, 'Nano Banana Pro')
    assert.equal(m!.modality, 'image')
    assert.equal(m!.in, 2, 'priced like databricks-gemini-3-pro-image')
    assert.equal(m!.out, 120)
    // the admin catalog lists it as an image model whatever its name
    const admin = serving.buildAdminCatalog([], { [id]: { endpointId: id, enabled: true, displayName: 'NBP' } })
    assert.equal(admin.find((e) => e.id === id)!.modality, 'image')
  } finally {
    llm.setConfiguredImageModels(null)
  }
  llm.setConfiguredImageModels([])
  try {
    assert.deepEqual(serving.buildUserImageModels({}), [])
    const row = { 'databricks-kimi-k3': { endpointId: 'databricks-kimi-k3', enabled: true, sortOrder: 0 } }
    assert.deepEqual(serving.buildUserImageModels(row), [], 'never falls back to the curated image model')
    assert.deepEqual(serving.buildUserModels(row).map((m) => m.id), ['databricks-kimi-k3'], 'chat is untouched')
  } finally {
    llm.setConfiguredImageModels(null)
  }
  assert.ok(serving.buildUserImageModels({}).some((m) => m.id === 'databricks-gemini-3-1-flash-image'))
})

test('the shipped models.example.json equals the catalog\'s fresh-install default, and no active models.json is shipped', () => {
  assert.equal(fs.existsSync(path.join(here, '..', 'models.json')), false)
  assert.equal(fs.existsSync(path.join(here, '..', 'deploy-config', 'models.json')), false, 'the staged file is generated, never tracked')
  const raw = fs.readFileSync(path.join(here, '..', 'models.example.json'), 'utf8')
  const cfg = mc.parseModelsConfig(raw)!
  assert.deepEqual(cfg.rows.map((r) => r.id), llm.MODELS.filter((m) => !m.modality && m.defaultOn !== false).map((m) => m.id))
  assert.ok(cfg.rows.every((r) => r.priceIn === null && r.priceOut === null), 'prices follow the curated list')
  assert.ok(cfg.rows.every((r) => r.blurb === ''), 'blurbs follow the curated, translated ones')
  assert.equal(cfg.imageRows, null, 'no imageModels key: the default image model stays')
})
