// Relative cost of a catalog model, as 1-3 bars in the picker. Terciles of the
// blended list price (input + output USD per 1M tokens) over the priced models,
// so the bars rank the models the user can actually pick, whatever the prices are.
interface Priced {
  id: string
  in?: number | null
  out?: number | null
}

const blended = (m: Priced): number | null => {
  const v = (Number(m.in) || 0) + (Number(m.out) || 0)
  return v > 0 ? v : null
}

export function costTier(model: Priced, catalog: Priced[]): 1 | 2 | 3 | null {
  const mine = blended(model)
  if (mine == null) return null
  const all = catalog.map(blended).filter((v): v is number => v != null).sort((a, b) => a - b)
  if (all.length < 2) return 2
  // the share of priced models strictly cheaper than this one, in [0, 1)
  const below = all.filter((v) => v < mine).length / all.length
  return below < 1 / 3 ? 1 : below < 2 / 3 ? 2 : 3
}
