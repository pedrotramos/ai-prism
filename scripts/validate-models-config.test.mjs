// The deploy-time models file validator (scripts/validate-models-config.mjs): shape rules, the two
// image model kinds, the workspace checks with the CLI stubbed, the CLI exit codes, and that the
// grammar it repeats is the one server/llm.ts enforces.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  validateModelsConfig,
  checkImageModels,
  formatModelList,
  isProviderName,
  isProviderTarget,
  IMAGE_ID_RE,
} from './validate-models-config.mjs'
import { isServingEndpointName, isModelProviderServiceName, isProviderTargetName, MODELS } from '../server/llm.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, 'validate-models-config.mjs')
const PROVIDER = 'main.external_models.gemini_models'
const chat = [{ id: 'databricks-claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }]

test('the shipped models.json is valid and lists curated, default-on chat models', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(here, '..', 'models.json'), 'utf8'))
  const r = validateModelsConfig(cfg)
  assert.deepEqual(r.errors, [])
  const curated = new Set(MODELS.filter((m) => !m.modality).map((m) => m.id))
  for (const m of r.models) assert.ok(curated.has(m.id), `${m.id} is a curated chat model`)
  // the same models the catalog enables on a fresh install, in the same order
  assert.deepEqual(r.models.map((m) => m.id), MODELS.filter((m) => !m.modality && m.defaultOn !== false).map((m) => m.id))
  assert.ok(r.imageModels.length >= 1)
})

test('models: non-empty list, id + label, unique ids, optional blurb and prices', () => {
  assert.deepEqual(validateModelsConfig({ models: chat }).errors, [])
  assert.match(validateModelsConfig({}).errors[0], /"models" list is missing or empty/)
  assert.match(validateModelsConfig({ models: [] }).errors[0], /missing or empty/)
  assert.match(validateModelsConfig([]).errors[0], /JSON object/)
  assert.match(validateModelsConfig({ models: [{ label: 'x' }] }).errors[0], /model 1 has no "id"/)
  assert.match(validateModelsConfig({ models: [{ id: 'a' }] }).errors[0], /has no "label"/)
  assert.match(validateModelsConfig({ models: [...chat, ...chat] }).errors[0], /more than once/)
  assert.match(validateModelsConfig({ models: [{ ...chat[0], blurb: 3 }] }).errors[0], /blurb/)
  assert.match(validateModelsConfig({ models: [{ ...chat[0], priceIn: -1 }] }).errors[0], /priceIn/)
  assert.match(validateModelsConfig({ models: [{ ...chat[0], priceOut: 'x' }] }).errors[0], /priceOut/)
  assert.deepEqual(validateModelsConfig({ models: [{ ...chat[0], blurb: 'b', priceIn: 0, priceOut: 1.5 }] }).errors, [])
})

test('imageModels: absent = null, [] = off, both kinds, never mixed', () => {
  assert.equal(validateModelsConfig({ models: chat }).imageModels, null)
  assert.deepEqual(validateModelsConfig({ models: chat, imageModels: [] }), { errors: [], models: chat, imageModels: [] })
  const ok = validateModelsConfig({
    models: chat,
    imageModels: [
      { id: 'databricks-gemini-3-1-flash-image', label: 'NB2' },
      { provider: PROVIDER, model: 'gemini-3.1-flash-image', label: 'NB2 (provider)', blurb: 'fast' },
    ],
  })
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.imageModels.map((m) => [m.type, m.id]), [['serving', 'databricks-gemini-3-1-flash-image'], ['provider', `${PROVIDER}/gemini-3.1-flash-image`]])
  const bad = (imageModels) => validateModelsConfig({ models: chat, imageModels }).errors.join('|')
  assert.match(bad('x'), /must be a list/)
  assert.match(bad(['x']), /must be an object/)
  assert.match(bad([{ id: 'a', provider: PROVIDER, model: 'm', label: 'x' }]), /mixes the two kinds/)
  assert.match(bad([{ provider: PROVIDER, label: 'x' }]), /no "model"/)
  assert.match(bad([{ model: 'm', label: 'x' }]), /no "provider"/)
  assert.match(bad([{ provider: 'two.parts', model: 'm', label: 'x' }]), /invalid "provider"/)
  assert.match(bad([{ provider: PROVIDER, model: 'a..b', label: 'x' }]), /invalid "model"/)
  assert.match(bad([{ id: '--flag', label: 'x' }]), /invalid "id"/)
  assert.match(bad([{ id: 'ok-id' }]), /no "label"/)
  assert.match(bad([{ label: 'x' }]), /no "id"/)
  assert.match(bad([{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }]), /more than once in "imageModels"/)
  assert.match(bad([{ id: chat[0].id, label: 'x' }]), /also in "models"/)
})

test('the grammar repeated by the script is the one of server/llm.ts', () => {
  const ids = ['a', 'A-b_c', '-a', '_a', 'a'.repeat(63), 'a'.repeat(64), 'a.b', 'a/b', '', 'a b', 'é']
  for (const id of ids) assert.equal(IMAGE_ID_RE.test(id), isServingEndpointName(id), `serving ${JSON.stringify(id)}`)
  const providers = [PROVIDER, 'a.b', 'a.b.c.d', 'a..c', 'a.b.', 'a-b.c.d', 'cat.sch.' + 'x'.repeat(255), 'cat.sch.' + 'x'.repeat(256), 5, null]
  for (const p of providers) assert.equal(isProviderName(p), isModelProviderServiceName(p), `provider ${String(p)}`)
  const targets = ['gemini-3.1-flash-image', 'a', '.a', 'a..b', 'a/b', 'x'.repeat(63), 'x'.repeat(64), '', 7]
  for (const t of targets) assert.equal(isProviderTarget(t), isProviderTargetName(t), `target ${String(t)}`)
})

const imageModels = [
  { type: 'serving', id: 'ep-ok', label: 'a' },
  { type: 'serving', id: 'ep-ghost', label: 'b' },
  { type: 'provider', id: `${PROVIDER}/gemini-3-pro-image`, provider: PROVIDER, model: 'gemini-3-pro-image', label: 'c' },
]

test('checkImageModels: a missing endpoint stops the deploy, an unlisted alias warns', () => {
  const servingGet = (id) => (id === 'ep-ghost' ? { ok: false, stderr: 'Error: RESOURCE_DOES_NOT_EXIST: endpoint ep-ghost does not exist' } : { ok: true, stderr: '' })
  const r = checkImageModels(imageModels.slice(0, 2), 'dev', { servingGet, servingList: () => ['ep-ok'] })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /ep-ghost does not exist in this workspace/)
  const alias = checkImageModels(imageModels.slice(0, 1), 'dev', { servingGet, servingList: () => ['other'] })
  assert.deepEqual(alias.errors, [])
  assert.match(alias.warnings[0], /not in serving-endpoints list/)
  // the listing failing (null) is not a warning
  assert.deepEqual(checkImageModels(imageModels.slice(0, 1), 'dev', { servingGet, servingList: () => null }), { errors: [], warnings: [] })
  // a CLI error that is not "not found" is reported as unverifiable
  const denied = checkImageModels(imageModels.slice(0, 1), 'dev', { servingGet: () => ({ ok: false, stderr: 'permission denied' }) })
  assert.match(denied.errors[0], /could not check the image model ep-ok/)
})

test('checkImageModels: the provider is read once and the target must be allowed', () => {
  let reads = 0
  const providerGet = () => (reads++, { ok: true, details: { config: { targets: [{ model: 'gemini-3-pro-image' }] } } })
  const two = [imageModels[2], { ...imageModels[2], id: `${PROVIDER}/gemini-3.1-flash-image`, model: 'gemini-3.1-flash-image' }]
  const r = checkImageModels(two, 'dev', { providerGet })
  assert.equal(reads, 1)
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /target gemini-3.1-flash-image is not allowed.*targets: gemini-3-pro-image/)
  const all = checkImageModels(two, 'dev', { providerGet: () => ({ ok: true, details: { allow_all_targets: true } }) })
  assert.deepEqual(all.errors, [])
  const missing = checkImageModels(imageModels.slice(2), 'dev', { providerGet: () => ({ ok: false, stderr: 'Error: model provider service does not exist' }) })
  assert.match(missing.errors[0], /does not exist in this workspace or you have no access/)
  const odd = checkImageModels(imageModels.slice(2), 'dev', { providerGet: () => ({ ok: false, stderr: 'boom' }) })
  assert.match(odd.errors[0], /could not check the Model Provider Service/)
})

test('formatModelList: chat models, then image models with their kind', () => {
  const out = formatModelList({ models: chat, imageModels: [imageModels[0], imageModels[2]] })
  assert.match(out, /1\. Claude Sonnet 5\.5\s+databricks-claude-sonnet-5-5/)
  assert.match(out, /Image generation models/)
  assert.match(out, /gemini-3-pro-image \(provider main\.external_models\.gemini_models\)/)
  assert.match(formatModelList({ models: chat, imageModels: [] }), /image generation is off/)
  assert.doesNotMatch(formatModelList({ models: chat, imageModels: null }), /Image generation/)
})

test('CLI: exit 0 for the shipped file, 1 with the problems listed, 2 without a file', () => {
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  const shipped = run(path.join(here, '..', 'models.json'), '--list')
  assert.equal(shipped.status, 0, shipped.stderr)
  assert.match(shipped.stdout, /databricks-claude-sonnet-5-5/)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-cfg-'))
  try {
    const bad = path.join(dir, 'bad.json')
    fs.writeFileSync(bad, JSON.stringify({ models: [{ id: 'a' }], imageModels: [{ id: 'x', provider: PROVIDER, model: 'm', label: 'y' }] }))
    const r = run(bad)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /has no "label"/)
    assert.match(r.stderr, /mixes the two kinds/)
    const broken = path.join(dir, 'broken.json')
    fs.writeFileSync(broken, '{ nope')
    assert.equal(run(broken).status, 1)
    assert.match(run(broken).stderr, /Invalid models JSON/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(run().status, 2)
  assert.equal(run('--profile', 'x').status, 2)
})
