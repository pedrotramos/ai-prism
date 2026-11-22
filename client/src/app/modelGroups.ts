// How the header's model picker organises the catalog (GET /api/models).
//
// A flat list of 15 models is a choice-overload problem: the picker pins three
// recommended models, puts the rest under "More models" grouped by provider
// with a search box, and shows the image-input badge only where it tells the
// user something (the minority). Pure functions: modelGroups.test.js.

const RECOMMENDED = 3

// the catalog entry fields the picker reads (GET /api/models returns more)
interface PickerModel {
  id: string
  label?: string
  provider?: string
  recommended?: boolean
  vision?: boolean
}
type VisionBadgeMode = 'noVision' | 'vision' | null

/**
 * Ids of the pinned models: server-flagged `recommended` first, then the first
 * model of each provider in catalog order (the admin's order, whose first entry
 * is the default for new chats), then the catalog order.
 */
export function recommendedIds(models: PickerModel[] = [], n: number = RECOMMENDED): string[] {
  const out: string[] = []
  const add = (m: PickerModel | undefined) => out.length < n && m && !out.includes(m.id) && out.push(m.id)
  models.filter((m) => m.recommended === true).forEach(add)
  const seen = new Set<string | undefined>()
  for (const m of models) {
    if (seen.has(m.provider)) continue
    seen.add(m.provider)
    add(m)
  }
  models.forEach(add)
  return out
}

/** `{ recommended: Model[], more: { provider, models }[] }` in catalog order. */
export function splitCatalog<M extends PickerModel>(models: M[] = [], n: number = RECOMMENDED) {
  const ids = recommendedIds(models, n)
  // every id comes from this same list, so find() always hits
  const recommended = ids.map((id) => models.find((m) => m.id === id)) as M[]
  return { recommended, more: groupByProvider(models.filter((m) => !ids.includes(m.id))) }
}

export function groupByProvider<M extends PickerModel>(models: M[] = []) {
  const groups: { provider: string; models: M[] }[] = []
  for (const m of models) {
    const provider = m.provider || ''
    let g = groups.find((x) => x.provider === provider)
    if (!g) groups.push((g = { provider, models: [] }))
    g.models.push(m)
  }
  return groups
}

const fold = (s: unknown): string =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** Case- and accent-insensitive match on label, provider and id. */
export function filterModels<M extends PickerModel>(models: M[] = [], query: string = ''): M[] {
  const q = fold(query).trim()
  if (!q) return models
  return models.filter((m) => [m.label, m.provider, m.id].some((f) => fold(f).includes(q)))
}

/**
 * Which image-input badge the list shows: 'noVision' when most models accept
 * images (mark the ones that do not), 'vision' when most do not, null when every
 * model agrees (the badge would be on all or none and say nothing).
 */
export function visionBadgeMode(models: PickerModel[] = []): VisionBadgeMode {
  const withVision = models.filter((m) => m.vision).length
  if (withVision === 0 || withVision === models.length) return null
  return withVision > models.length / 2 ? 'noVision' : 'vision'
}

export function showsVisionBadge(model: PickerModel, mode: VisionBadgeMode): boolean {
  if (mode === 'noVision') return !model.vision
  if (mode === 'vision') return !!model.vision
  return false
}
