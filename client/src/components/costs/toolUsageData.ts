// Pure helpers of the web-search cost tile (WebSearchCostTile.jsx): the API
// query, the zero-filled per-day series, the tile state, the price editor rows
// and input parsing. No React here, so node --test covers it
// (toolUsageData.test.js).

export const TOOL_KIND = 'web_search'
export const MAX_PRICE_PER_1K_USD = 1000
const DAY_MS = 86_400_000

interface ToolDay {
  day: string
  calls?: number
  costUsd?: number
  unpricedCalls?: number
}
interface ToolUsageData {
  prices?: Record<string, number | null>
  byProvider?: Array<{ provider: string; pricePer1k?: number | null }>
}
interface PriceRow {
  key: string
  provider: string | null
  override: number | null
  effective: number | null
}

export function toolUsageQuery({ from, to, kind = TOOL_KIND }: { from: string; to: string; kind?: string }) {
  return new URLSearchParams({ kind, from, to }).toString()
}

/** One point per UTC day of the period (inclusive), zeros where the ledger has no row. */
export function fillDays(byDay: ToolDay[] | null | undefined, period: { from: string; to: string }) {
  const seen = new Map((byDay || []).map((d) => [d.day, d]))
  const out: Array<{ day: string; calls: number; costUsd: number }> = []
  const end = Date.parse(`${period.to}T00:00:00Z`)
  for (let t = Date.parse(`${period.from}T00:00:00Z`); t <= end; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10)
    const d = seen.get(day)
    out.push({ day, calls: d?.calls ?? 0, costUsd: d?.costUsd ?? 0 })
  }
  return out
}

/** empty (no calls), unpriced (some calls carry no price) or ok. */
export function tileState(totals?: { calls?: number; unpricedCalls?: number; pricedCalls?: number; costUsd?: number } | null) {
  if (!totals || !totals.calls) return 'empty'
  return totals.unpricedCalls! > 0 ? 'unpriced' : 'ok'
}

/** The ChartBlock input for calls per day: a line, whose x axis thins its ticks (a bar chart prints every day). */
export function dailyChartBlock(points: Array<{ day: string; calls: number; costUsd?: number }>, { title, seriesLabel }: { title: string; seriesLabel: string }) {
  return {
    type: 'chart',
    chartType: 'line',
    title,
    series: [{ name: seriesLabel, data: points.map((p) => ({ label: p.day, value: p.calls })) }],
  }
}

/**
 * The editor rows: 'web_search' (every provider) first, then each provider seen
 * that has a price key of its own. `override` is what an admin saved (null = none),
 * `effective` the price a provider's calls get now (override, env or seed).
 */
export function priceEditorRows(data?: ToolUsageData | null) {
  const prices: Record<string, number | null> = data?.prices || {}
  const rows: PriceRow[] = [{ key: TOOL_KIND, provider: null, override: prices[TOOL_KIND] ?? null, effective: null }]
  for (const p of data?.byProvider || []) {
    const key = `${TOOL_KIND}:${p.provider}`
    if (!(key in prices)) continue
    rows.push({ key, provider: p.provider, override: prices[key] ?? null, effective: p.pricePer1k ?? null })
  }
  return rows
}

/**
 * The text of a price field → { ok: true, value } (a number 0..1000, or null for a
 * blank field = clear the override) or { ok: false }. A decimal comma is accepted.
 */
export function parsePriceInput(text: unknown): { ok: true; value: number | null } | { ok: false } {
  const s = String(text ?? '').trim()
  if (!s) return { ok: true, value: null }
  if (!/^\d+([.,]\d+)?$/.test(s)) return { ok: false }
  const v = Number(s.replace(',', '.'))
  return v >= 0 && v <= MAX_PRICE_PER_1K_USD ? { ok: true, value: v } : { ok: false }
}

/** Page state for a failed request: HTTP status + the server's {code}. */
export function toolErrorState(status: number, code?: string | null) {
  if (status === 403) return 'notAdmin'
  if (code === 'bad_period') return 'badPeriod'
  return 'error'
}

/** A user hash for display: the keyed 'h2:' prefix is dropped, the rest shortened. */
export function shortHash(h?: string | null) {
  return String(h || '').replace(/^h2:/, '').slice(0, 8)
}

// Every catalog key the tile uses (toolUsageData.test.js checks en, pt and es).
export const WEB_SEARCH_TILE_I18N_KEYS = [
  'costs.web.title',
  'costs.web.subtitle',
  'costs.web.calls',
  'costs.web.cost',
  'costs.web.unpriced',
  'costs.web.daily',
  'costs.web.series',
  'costs.web.byProvider',
  'costs.web.topUsers',
  'costs.web.topUsersHint',
  'costs.web.col.provider',
  'costs.web.col.calls',
  'costs.web.col.cost',
  'costs.web.col.unpriced',
  'costs.web.col.price',
  'costs.web.col.user',
  'costs.web.loading',
  'costs.web.empty.title',
  'costs.web.empty.hint',
  'costs.web.error.title',
  'costs.web.error.hint',
  'costs.web.unpricedEstimate',
  'costs.web.unpricedNoPrice',
  'costs.web.price.title',
  'costs.web.price.hint',
  'costs.web.price.all',
  'costs.web.price.label',
  'costs.web.price.save',
  'costs.web.price.saved',
  'costs.web.price.invalid',
  'costs.web.price.failed',
  'costs.web.price.inEffect',
  'costs.web.price.none',
  'costs.web.tableCaption',
]
