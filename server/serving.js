// Discovery of AI Gateway serving endpoints + merge with the curated static
// catalog and the admin overrides. Three layers:
//   1. LIVE endpoints from GET /api/2.0/serving-endpoints (task=llm/v1/chat)
//   2. CURATED defaults from MODELS in llm.js (rich flags: noTemperature, maxOut,
//      vision, streamUsage, promptCache — sondados ao vivo, ver memória)
//   3. ADMIN overrides from model_catalog_overrides (enabled + display name/blurb)
// so a brand-new endpoint served in the gateway shows up on the admin's Models
// tab automatically (with a derived label), the admin flips it on and names it,
// and only enabled endpoints reach regular users via GET /api/models.
import { MODELS, deriveMaxOut } from './llm.js'

// Image-generation endpoints are served through the SAME task=llm/v1/chat as
// chat models (sondado ao vivo), so discovery can't tell them apart by task —
// only by name. Everything matching this is classified modality:'image' and
// kept out of the chat picker (and into the image picker). Curated entries in
// MODELS carry an explicit `modality` that always wins over this heuristic.
const IMAGE_NAME_RE = /-image\b|imagen|dall-?e|flux|stable-?diffusion|nano-banana/i
export function deriveModality(id) {
  return IMAGE_NAME_RE.test(id || '') ? 'image' : 'chat'
}

function host() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

const LIST_TTL_MS = 5 * 60 * 1000
const listCache = new Map() // host -> { ts, endpoints }

// GET the live chat serving endpoints. Best-effort: on any failure returns []
// and the caller falls back to the curated MODELS list (graceful degradation,
// same pattern the rest of the app uses).
export async function listChatEndpoints(token) {
  const h = host()
  const cached = listCache.get(h)
  if (cached && Date.now() - cached.ts < LIST_TTL_MS) return cached.endpoints
  try {
    const res = await fetch(`${h}/api/2.0/serving-endpoints`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) return []
    const d = await res.json()
    const endpoints = []
    for (const ep of d.endpoints || []) {
      // keep only chat-completions endpoints. The task lives on the endpoint or
      // (older shape) on the served entity's foundation-model metadata.
      const task =
        ep.task ||
        ep.config?.served_entities?.[0]?.foundation_model?.task ||
        ep.config?.served_models?.[0]?.foundation_model?.task ||
        ''
      if (task && !String(task).includes('llm/v1/chat')) continue
      // when task is absent we can't be sure; include it — the admin decides.
      endpoints.push({ id: ep.name })
    }
    listCache.set(h, { ts: Date.now(), endpoints })
    return endpoints
  } catch {
    return []
  }
}

const FAMILY_PROVIDER = [
  [/gpt-oss/, 'OpenAI (OSS)'],
  [/gpt/, 'OpenAI'],
  [/claude/, 'Anthropic'],
  [/gemini/, 'Google'],
  [/kimi/, 'Moonshot AI'],
  [/llama/, 'Meta'],
  [/qwen/, 'Alibaba'],
  [/glm/, 'Zhipu AI'],
]

export function deriveProvider(id) {
  const s = (id || '').toLowerCase()
  for (const [re, provider] of FAMILY_PROVIDER) if (re.test(s)) return provider
  return 'Outros'
}

// Family price book (USD per 1M tokens, [in, out]) — a scalable default so a
// brand-new endpoint of a KNOWN family inherits a sane list price automatically,
// with NO admin action. Order matters (first match wins): most specific tier
// first. These are approximate public list prices used only for the chat's
// cost-estimate flourish; the authoritative spend comes from the system tables
// (see the admin cost dashboard). An admin override always wins over this, and
// an unknown family falls through to null → shown as "não precificado", never
// NaN. Keep tiers coarse: the goal is "roughly right without manual entry",
// not per-SKU precision (that's the override's job).
const FAMILY_PRICE_BOOK = [
  [/claude.*opus/, [15, 75]],
  [/claude.*sonnet/, [3, 15]],
  [/claude.*haiku/, [0.8, 4]],
  [/claude.*fable/, [1, 5]],
  [/claude/, [3, 15]], // unknown Claude tier → assume Sonnet-class
  [/gpt.*mini/, [0.25, 2]],
  [/gpt.*nano/, [0.1, 0.4]],
  [/gpt-oss/, [0.3, 1.0]],
  [/gpt/, [1.25, 10]], // frontier GPT default
  [/gemini.*flash/, [0.3, 2.5]],
  [/gemini/, [1.25, 10]], // Gemini Pro-class default
  [/kimi.*k3/, [0.5, 2.5]],
  [/llama/, [0.5, 1.5]],
  [/qwen/, [0.4, 1.2]],
  [/glm/, [0.6, 2]],
]

// Resolves [priceIn, priceOut] for an endpoint from its name. Returns null when
// no family matches — the caller then leaves pricing undefined (honest "não
// precificado") rather than inventing a number.
export function derivePrice(id) {
  const s = (id || '').toLowerCase()
  for (const [re, price] of FAMILY_PRICE_BOOK) if (re.test(s)) return price
  return null
}

const FAMILY_LABEL = { gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', kimi: 'Kimi', llama: 'Llama', qwen: 'Qwen', glm: 'GLM' }

// databricks-gpt-5-6-terra -> "GPT 5.6 Terra". Strips the databricks- prefix,
// maps the family token to its display form, joins adjacent numbers with a dot
// (5-6 -> 5.6), Title-Cases the rest. Conservative — the admin can always edit.
export function deriveLabel(id) {
  let s = (id || '').replace(/^databricks-/, '')
  const tokens = s.split('-').filter(Boolean)
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const fam = FAMILY_LABEL[t.toLowerCase()]
    if (fam) {
      out.push(fam)
      continue
    }
    // fold a run of pure-number tokens into a dotted version (5-6 -> 5.6)
    if (/^\d+$/.test(t)) {
      const nums = [t]
      while (i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) {
        nums.push(tokens[++i])
      }
      out.push(nums.join('.'))
      continue
    }
    out.push(t.charAt(0).toUpperCase() + t.slice(1))
  }
  return out.join(' ') || id
}

// The static MODELS list keyed by id, for the curated-flag layer.
const CURATED = Object.fromEntries(MODELS.map((m) => [m.id, m]))

// Builds the ADMIN view: every live endpoint (discovered) unioned with any
// endpoint that has an override or a curated entry, each annotated with:
//   discovered, curated, enabled, displayName (override ?? curated ?? derived),
//   blurb, provider. The admin tab renders this list with a toggle + editable
//   name/blurb.
export function buildAdminCatalog(discovered, overrides) {
  const ids = new Set()
  for (const e of discovered) ids.add(e.id)
  for (const id of Object.keys(overrides || {})) ids.add(id)
  for (const id of Object.keys(CURATED)) ids.add(id)
  const discoveredIds = new Set(discovered.map((e) => e.id))
  const list = []
  for (const id of ids) {
    const ov = overrides?.[id]
    const cur = CURATED[id]
    // Pre-filled prices are for CURATED models ONLY. A non-curated endpoint must
    // NEVER arrive with a guessed price — the admin is required to enter in/out
    // costs before enabling it (the "Add model" gate keys off inferredPrice
    // being null). The family price book is NOT used as a placeholder here, on
    // purpose: it would silently pre-fill non-curated endpoints.
    const inferredIn = cur?.in ?? null
    const inferredOut = cur?.out ?? null
    list.push({
      id,
      discovered: discoveredIds.has(id),
      curated: !!cur,
      enabled: ov ? ov.enabled : false,
      displayName: (ov?.displayName || cur?.label || deriveLabel(id)),
      blurb: ov?.blurb ?? cur?.blurb ?? '',
      provider: cur?.provider || deriveProvider(id),
      // curated modality wins; otherwise infer from the endpoint name so a
      // newly-discovered image endpoint lands in the right bucket automatically.
      modality: cur?.modality || deriveModality(id),
      // pricing: the admin's explicit override (or null if unset) + the inferred
      // default the UI shows as a placeholder (CURATED only) + whether the
      // effective price came from an override / the curated list / nothing.
      // Non-curated endpoints have no inferred price on purpose (admin must set).
      priceIn: ov?.priceIn ?? null,
      priceOut: ov?.priceOut ?? null,
      inferredPriceIn: inferredIn ?? null,
      inferredPriceOut: inferredOut ?? null,
      priceSource:
        ov?.priceIn != null || ov?.priceOut != null
          ? 'override'
          : cur?.in != null
            ? 'curated'
            : 'none',
      sortOrder: ov?.sortOrder ?? null,
    })
  }
  // enabled first, then by sortOrder, then label
  list.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    const so = (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9)
    if (so) return so
    return a.displayName.localeCompare(b.displayName)
  })
  return list
}

// Builds the USER-facing model list for GET /api/models: only endpoints the
// admin enabled, in override sort order, carrying the curated flags the chat
// body needs (noTemperature/streamUsage/maxOut/tools/vision/promptCache) merged
// with the admin's display name + blurb. If NO overrides exist yet (fresh
// install, admin never opened the tab), falls back to the full curated MODELS
// so the picker is never empty.
function mapOverrideToModel(o) {
  const cur = CURATED[o.endpointId] || {}
  const fam = derivePrice(o.endpointId) || [undefined, undefined]
  // price resolution: admin override > curated list > family price book > undefined
  const priceIn = o.priceIn ?? cur.in ?? fam[0]
  const priceOut = o.priceOut ?? cur.out ?? fam[1]
  return {
    // curated flags first (safe defaults for uncurated endpoints), then the
    // admin's display fields on top
    id: o.endpointId,
    provider: cur.provider || deriveProvider(o.endpointId),
    in: priceIn,
    out: priceOut,
    vision: cur.vision ?? false,
    streamUsage: cur.streamUsage ?? false,
    noTemperature: cur.noTemperature ?? true, // conservative: never causes a 400
    tools: cur.tools ?? true,
    // uncurated endpoints reach for their family's output ceiling (deriveMaxOut)
    // instead of a flat floor; the runtime clamp (postChat/learnedMaxOut) lowers
    // it automatically if this specific endpoint's real ceiling is smaller.
    maxOut: cur.maxOut ?? deriveMaxOut(o.endpointId),
    promptCache: cur.promptCache ?? false,
    modality: cur.modality || deriveModality(o.endpointId),
    label: o.displayName || cur.label || deriveLabel(o.endpointId),
    blurb: o.blurb || cur.blurb || '',
  }
}

// Enabled models of a given modality, in override sort order. Falls back to the
// curated MODELS of that modality when the admin never opened the tab (fresh
// install) so neither picker is ever empty. Chat and image are strictly
// separated: an image endpoint never surfaces in the chat picker and vice-versa.
function buildEnabledByModality(overrides, modality) {
  const curatedOfModality = MODELS.filter((m) => (m.modality || 'chat') === modality)
  const hasAny = overrides && Object.keys(overrides).length > 0
  if (!hasAny) return curatedOfModality
  const enabled = Object.values(overrides)
    .filter((o) => o.enabled)
    .map(mapOverrideToModel)
    .filter((m) => (m.modality || 'chat') === modality)
  if (!enabled.length) return curatedOfModality // never strand the org with zero
  enabled.sort((a, b) => {
    const ao = overrides[a.id]?.sortOrder ?? 1e9
    const bo = overrides[b.id]?.sortOrder ?? 1e9
    return ao - bo
  })
  return enabled
}

export function buildUserModels(overrides) {
  return buildEnabledByModality(overrides, 'chat')
}

// The image-generation models the user can pick from (Settings → image model).
export function buildUserImageModels(overrides) {
  return buildEnabledByModality(overrides, 'image')
}
