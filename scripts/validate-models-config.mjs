#!/usr/bin/env node
// Validates the deploy-time models file (models.json, or an alternative one).
//
//   node scripts/validate-models-config.mjs <file.json> [--profile <PROFILE>] [--list]
//
// Shape: "models" is a non-empty list with "id" and "label" (text) on each item. "imageModels", when
// present, is a list whose items are of one of two kinds:
//   - serving endpoint: { "id", "label", "blurb"? }. The id is a serving endpoint name: letters, digits,
//     "-" and "_", up to 63 characters, starting with a letter or digit (IMAGE_ID_RE);
//   - Unity Catalog Model Provider Service: { "provider", "model", "label", "blurb"? }. "provider" is the
//     3-part UC name, each part with letters, digits and "_" (up to 255); "model" is the Google target
//     (PROVIDER_TARGET_RE, no ".."). The internal id is "<provider>/<model>" (providerImageModelId in
//     server/llm.ts).
// An item does not mix the two kinds; ids (the derived one, for a provider) are unique and none repeats
// one of "models". Optional on a chat model: "blurb" (text), "priceIn" / "priceOut" (numbers >= 0).
// With --profile, each image model is checked in the workspace:
//   - provider: `databricks ai-gateway get-model-provider-service model-provider-services/<provider>
//     -p <PROFILE>`; the target must be in config.targets[].model, or config.allow_all_targets on;
//   - serving: `databricks serving-endpoints get <id> -p <PROFILE>`. When the endpoint is missing from
//     `databricks serving-endpoints list` a WARNING is printed (an alias can answer the GET and still
//     404 on the call).
// --list prints the chat and image models. Exits 1 on any error; warnings do not change the code.
// Used by deploy.sh, deploy.ps1, the installer notebook and the tests (scripts/validate-models-config.test.mjs).
// The grammar below repeats isServingEndpointName / isModelProviderServiceName / isProviderTargetName of
// server/llm.ts so the script runs without TypeScript on the deployer's machine; the test pins them equal.
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const nonEmptyText = (v) => typeof v === 'string' && v.trim().length > 0
export const IMAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/
export const UC_NAME_PART_RE = /^[A-Za-z0-9_]{1,255}$/
export const PROVIDER_TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

export function isProviderName(fqn) {
  const parts = typeof fqn === 'string' ? fqn.split('.') : []
  return parts.length === 3 && parts.every((p) => UC_NAME_PART_RE.test(p))
}
export function isProviderTarget(model) {
  return typeof model === 'string' && PROVIDER_TARGET_RE.test(model) && !model.includes('..')
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// One imageModels item → { entry } normalized ({ type, id, label, provider?, model? }) or { error }.
function imageEntry(m, n) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: `image model ${n} must be an object` }
  const isProvider = has(m, 'provider') || has(m, 'model')
  if (isProvider && has(m, 'id')) {
    return { error: `image model ${n} mixes the two kinds: use "id" (serving endpoint) or "provider" + "model" (Unity Catalog Model Provider Service)` }
  }
  if (isProvider) {
    if (!nonEmptyText(m.provider)) return { error: `image model ${n} has no "provider"` }
    if (!nonEmptyText(m.model)) return { error: `image model ${n} has no "model"` }
    const provider = m.provider.trim()
    const model = m.model.trim()
    if (!isProviderName(provider)) {
      return { error: `image model ${n} has an invalid "provider" ${JSON.stringify(provider).slice(0, 120)}: use the 3-part UC name catalog.schema.service, each part with letters, digits and "_" only` }
    }
    if (!isProviderTarget(model)) {
      return { error: `image model ${n} has an invalid "model" ${JSON.stringify(model).slice(0, 80)}: use the provider's target (letters, digits, ".", "-" and "_", up to 63 characters, starting with a letter or digit, no "..")` }
    }
    return { entry: { type: 'provider', id: `${provider}/${model}`, provider, model, label: m.label, blurb: m.blurb } }
  }
  if (!nonEmptyText(m.id)) return { error: `image model ${n} has no "id" (serving endpoint) nor "provider" + "model" (Unity Catalog Model Provider Service)` }
  const id = m.id.trim()
  if (!IMAGE_ID_RE.test(id)) {
    return { error: `image model ${n} has an invalid "id" ${JSON.stringify(id).slice(0, 80)}: use letters, digits, "-" and "_" only (up to 63 characters, starting with a letter or digit)` }
  }
  return { entry: { type: 'serving', id, label: m.label, blurb: m.blurb } }
}

export function validateModelsConfig(cfg) {
  const errors = []
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { errors: ['the file must be a JSON object'], models: [], imageModels: null }
  }
  const models = cfg.models
  if (!Array.isArray(models) || !models.length) {
    errors.push('the "models" list is missing or empty')
  } else {
    const seen = new Set()
    models.forEach((m, i) => {
      if (!m || typeof m !== 'object' || !nonEmptyText(m.id)) {
        errors.push(`model ${i + 1} has no "id"`)
        return
      }
      const id = m.id.trim()
      if (!nonEmptyText(m.label)) errors.push(`model ${i + 1} (${id}) has no "label"`)
      if (m.blurb != null && typeof m.blurb !== 'string') errors.push(`model ${i + 1} (${id}) has a "blurb" that is not text`)
      for (const k of ['priceIn', 'priceOut']) {
        if (m[k] != null && !(typeof m[k] === 'number' && Number.isFinite(m[k]) && m[k] >= 0)) errors.push(`model ${i + 1} (${id}) has a "${k}" that is not a number >= 0`)
      }
      if (seen.has(id)) errors.push(`model ${id} appears more than once in "models"`)
      seen.add(id)
    })
  }
  let imageModels = null
  if (has(cfg, 'imageModels')) {
    if (!Array.isArray(cfg.imageModels)) {
      errors.push('"imageModels" must be a list (use [] to turn image generation off)')
    } else {
      imageModels = []
      const chatIds = new Set((Array.isArray(models) ? models : []).map((m) => m?.id?.trim?.()).filter(Boolean))
      const seen = new Set()
      cfg.imageModels.forEach((m, i) => {
        const n = i + 1
        const { entry, error } = imageEntry(m, n)
        if (error) {
          errors.push(error)
          return
        }
        const { id } = entry
        if (!nonEmptyText(entry.label)) errors.push(`image model ${n} (${id}) has no "label"`)
        if (entry.blurb != null && typeof entry.blurb !== 'string') errors.push(`image model ${n} (${id}) has a "blurb" that is not text`)
        if (seen.has(id)) errors.push(`image model ${id} appears more than once in "imageModels"`)
        if (chatIds.has(id)) errors.push(`image model ${id} is also in "models"`)
        seen.add(id)
        imageModels.push(entry)
      })
    }
  }
  return { errors, models: Array.isArray(models) ? models : [], imageModels }
}

function runDatabricks(args) {
  const r = spawnSync('databricks', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) return { ok: false, stdout: '', stderr: r.error.message }
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function servingGet(id, profile) {
  const r = runDatabricks(['serving-endpoints', 'get', id, '-p', profile, '-o', 'json'])
  return { ok: r.ok, stderr: `${r.stderr}${!r.ok ? r.stdout : ''}` }
}

// Names from `serving-endpoints list`, or null when the listing fails.
function servingList(profile) {
  const r = runDatabricks(['serving-endpoints', 'list', '-p', profile, '-o', 'json'])
  if (!r.ok) return null
  try {
    const d = JSON.parse(r.stdout)
    const list = Array.isArray(d) ? d : d?.endpoints || []
    return list.map((e) => e?.name).filter(Boolean)
  } catch {
    return null
  }
}

// The provider's metadata. A CLI without the `ai-gateway` group falls back to `databricks api get` on
// the same REST route. The output is never printed: it carries the provider's configuration.
function providerGet(fqn, profile) {
  let r = runDatabricks(['ai-gateway', 'get-model-provider-service', `model-provider-services/${fqn}`, '-p', profile, '-o', 'json'])
  if (!r.ok && /unknown command/i.test(r.stderr)) {
    r = runDatabricks(['api', 'get', `/api/2.1/unity-catalog/model-provider-services/${fqn}`, '-p', profile])
  }
  if (!r.ok) return { ok: false, stderr: r.stderr }
  try {
    return { ok: true, details: JSON.parse(r.stdout) }
  } catch {
    return { ok: false, stderr: 'the CLI answer is not JSON' }
  }
}

const firstLine = (s) => String(s || '').trim().split('\n')[0] || 'unknown error'
const NOT_FOUND_RE = /does not exist|RESOURCE_DOES_NOT_EXIST|ENDPOINT_NOT_FOUND|not found/i

// Checks each image model in the workspace. `deps` swaps the CLI calls (tests): servingGet(id, profile)
// → { ok, stderr }, servingList(profile) → names or null, providerGet(fqn, profile) → { ok, details }
// or { ok: false, stderr }.
export function checkImageModels(imageModels, profile, deps = {}) {
  const get = deps.servingGet || servingGet
  const list = deps.servingList || servingList
  const provider = deps.providerGet || providerGet
  const errors = []
  const warnings = []
  const providers = new Map()
  let listed
  for (const m of imageModels || []) {
    if (m.type === 'provider') {
      const cmd = `databricks ai-gateway get-model-provider-service model-provider-services/${m.provider} -p ${profile}`
      if (!providers.has(m.provider)) providers.set(m.provider, provider(m.provider, profile))
      const r = providers.get(m.provider)
      if (!r.ok) {
        const detail = firstLine(r.stderr)
        errors.push(
          NOT_FOUND_RE.test(detail)
            ? `the Model Provider Service ${m.provider} does not exist in this workspace or you have no access to it (${cmd}): ${detail}`
            : `could not check the Model Provider Service ${m.provider} (${cmd}): ${detail}`
        )
        continue
      }
      const config = r.details?.config || r.details || {}
      const targets = (Array.isArray(config.targets) ? config.targets : []).map((t) => t?.model).filter(Boolean)
      if (config.allow_all_targets !== true && !targets.includes(m.model)) {
        errors.push(`the target ${m.model} is not allowed in the Model Provider Service ${m.provider} (targets: ${targets.join(', ') || 'none'}; ${cmd})`)
      }
      continue
    }
    const r = get(m.id, profile)
    if (!r.ok) {
      const detail = firstLine(r.stderr)
      errors.push(
        NOT_FOUND_RE.test(detail)
          ? `the image model ${m.id} does not exist in this workspace (databricks serving-endpoints get ${m.id} -p ${profile})`
          : `could not check the image model ${m.id} (databricks serving-endpoints get ${m.id} -p ${profile}): ${detail}`
      )
      continue
    }
    if (listed === undefined) listed = list(profile)
    if (listed && !listed.includes(m.id)) {
      warnings.push(
        `the image model ${m.id} answers serving-endpoints get but is not in serving-endpoints list; ` +
          'in this workspace it may not accept calls (404). If so, use "provider" + "model" entries (Unity Catalog Model Provider Service).'
      )
    }
  }
  return { errors, warnings }
}

const describe = (m) => (m.type === 'provider' ? `${m.model} (provider ${m.provider})` : m.id)

export function formatModelList({ models, imageModels }) {
  const lines = models.map((m, i) => `    ${i + 1}. ${String(m.label).padEnd(22)} ${m.id}`)
  if (imageModels) {
    lines.push('==> Image generation models (imageModels):')
    if (!imageModels.length) lines.push('    (empty list: image generation is off)')
    imageModels.forEach((m, i) => lines.push(`    ${i + 1}. ${String(m.label).padEnd(22)} ${describe(m)}`))
  }
  return lines.join('\n')
}

function main(argv) {
  const args = argv.slice(2)
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--profile')
  const pi = args.indexOf('--profile')
  const profile = pi >= 0 ? args[pi + 1] : ''
  if (!file || (pi >= 0 && !profile)) {
    console.error('usage: node scripts/validate-models-config.mjs <file.json> [--profile <PROFILE>] [--list]')
    return 2
  }
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`Invalid models JSON in ${file}: ${e.message}`)
    return 1
  }
  const result = validateModelsConfig(cfg)
  const errors = [...result.errors]
  let warnings = []
  if (!errors.length && profile && result.imageModels?.length) {
    const checked = checkImageModels(result.imageModels, profile)
    errors.push(...checked.errors)
    warnings = checked.warnings
  }
  for (const w of warnings) console.error(`WARNING: ${w}`)
  if (errors.length) {
    console.error(`Models file with problems (${file}):`)
    for (const e of errors) console.error(`  - ${e}`)
    return 1
  }
  if (args.includes('--list')) console.log(formatModelList(result))
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exit(main(process.argv))
}
