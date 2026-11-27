// Image-model guard (idea from jcsn13): a disabled image model is never sent to the gateway on any turn route,
// and generate_image has no silent fallback to a disabled default.
//
//   node --test server/imageModelGuard.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { generateImageStaged } from './tools.ts'
import { resolveTurnImageModel } from './turn.ts'
import { DEFAULT_IMAGE_MODEL } from './llm.ts'

const req = { email: 'guard@test.invalid', token: 'tok' }
const overridesWith = (...ids: string[]) =>
  Object.fromEntries(ids.map((id, i) => [id, { endpointId: id, enabled: true, sortOrder: i }]))
const IMG = ['databricks-gemini-3-1-flash-image', 'databricks-gemini-3-1-pro-image']

test('resolveTurnImageModel: a body.imageModel the admin disabled is replaced by the saved/enabled one', async () => {
  const deps = { listOverrides: async () => overridesWith(IMG[1]!), getSaved: async () => null }
  assert.equal(await resolveTurnImageModel(req, 'disabled-image-endpoint', deps), IMG[1])
  assert.equal(await resolveTurnImageModel(req, DEFAULT_IMAGE_MODEL, deps), IMG[1], 'a disabled default is not used either')
})

test('resolveTurnImageModel: saved selection that is now disabled is ignored; enabled requested wins', async () => {
  const deps = { listOverrides: async () => overridesWith(...IMG), getSaved: async () => 'old-disabled' }
  assert.equal(await resolveTurnImageModel(req, undefined, deps), DEFAULT_IMAGE_MODEL)
  assert.equal(await resolveTurnImageModel(req, IMG[1], deps), IMG[1])
})

test('resolveTurnImageModel: null when generation is off', async () => {
  const prev = process.env.IMAGE_GENERATION
  process.env.IMAGE_GENERATION = 'off'
  try {
    const deps = { listOverrides: async () => overridesWith(...IMG), getSaved: async () => IMG[0]! }
    assert.equal(await resolveTurnImageModel(req, IMG[0], deps), null)
  } finally {
    if (prev === undefined) delete process.env.IMAGE_GENERATION
    else process.env.IMAGE_GENERATION = prev
  }
})

test('generate_image without a resolved model is a tool error and never reaches the gateway', async () => {
  let called = 0
  const deps: any = { generateImage: async () => (called++, { dataUrls: [], usage: null }), putImageDataUrl: async () => ({}), deleteImageFile: async () => {} }
  await assert.rejects(() => generateImageStaged('tok', { prompt: 'a cat' }, { email: 'x@test.invalid' } as any, deps))
  assert.equal(called, 0)
})

test('chat, continue and regenerate all resolve the image model through prepareTurn', () => {
  const src = fs.readFileSync(new URL('./turn.ts', import.meta.url), 'utf8')
  // the three routes + the headless run build their turn with prepareTurn, which is the only place that resolves
  assert.ok((src.match(/await prepareTurn\(\{/g) || []).length >= 4)
  const body = src.slice(src.indexOf('async function prepareTurn('))
  assert.match(body, /resolveTurnImageModel\(req, opts\.imageModel\)/)
  assert.doesNotMatch(body, /opts\.imageModel \|\|/)
})

test('resolveTurnImageModel fails closed when the overrides cannot be read (no curated default)', async () => {
  const deps = { listOverrides: async () => { throw new Error('db down') }, getSaved: async () => IMG[0]! }
  assert.equal(await resolveTurnImageModel(req, IMG[0], deps), null)
})

test('resolveTurnImageModel: every image model disabled by the admin → null', async () => {
  const off = Object.fromEntries(IMG.map((id) => [id, { endpointId: id, enabled: false }]))
  const deps = { listOverrides: async () => off, getSaved: async () => null }
  assert.equal(await resolveTurnImageModel(req, DEFAULT_IMAGE_MODEL, deps), null)
})
