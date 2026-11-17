// How the header's model picker organises the catalog (GET /api/models).
//
// A flat list of 15 models is a choice-overload problem: the picker pins three
// recommended models, puts the rest under "More models" grouped by provider
// with a search box, and shows the image-input badge only where it tells the
// user something (the minority). Pure functions: modelGroups.test.js.

const RECOMMENDED = 3

/**
 * Ids of the pinned models: server-flagged `recommended` first, then the first
 * model of each provider in catalog order (the admin's order, whose first entry
 * is the default for new chats), then the catalog order.
 */
export function recommendedIds(models = [], n = RECOMMENDED) {
  const out = []
  const add = (m) => out.length < n && m && !out.includes(m.id) && out.push(m.id)
  models.filter((m) => m.recommended === true).forEach(add)
  const seen = new Set()
  for (const m of models) {
    if (seen.has(m.provider)) continue
    seen.add(m.provider)
    add(m)
  }
  models.forEach(add)
  return out
}

/** `{ recommended: Model[], more: { provider, models }[] }` in catalog order. */
export function splitCatalog(models = [], n = RECOMMENDED) {
  const ids = recommendedIds(models, n)
  const recommended = ids.map((id) => models.find((m) => m.id === id))
  return { recommended, more: groupByProvider(models.filter((m) => !ids.includes(m.id))) }
}

export function groupByProvider(models = []) {
  const groups = []
  for (const m of models) {
    const provider = m.provider || ''
    let g = groups.find((x) => x.provider === provider)
    if (!g) groups.push((g = { provider, models: [] }))
    g.models.push(m)
  }
  return groups
}

const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** Case- and accent-insensitive match on label, provider and id. */
export function filterModels(models = [], query = '') {
  const q = fold(query).trim()
  if (!q) return models
  return models.filter((m) => [m.label, m.provider, m.id].some((f) => fold(f).includes(q)))
}

/**
 * Which image-input badge the list shows: 'noVision' when most models accept
 * images (mark the ones that do not), 'vision' when most do not, null when every
 * model agrees (the badge would be on all or none and say nothing).
 */
export function visionBadgeMode(models = []) {
  const withVision = models.filter((m) => m.vision).length
  if (withVision === 0 || withVision === models.length) return null
  return withVision > models.length / 2 ? 'noVision' : 'vision'
}

export function showsVisionBadge(model, mode) {
  if (mode === 'noVision') return !model.vision
  if (mode === 'vision') return !!model.vision
  return false
}
