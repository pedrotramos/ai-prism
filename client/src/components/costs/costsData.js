// Pure helpers of the admin Costs page (CostsPage.jsx): periods, locale-aware
// formatting, the CSV export, the API query string and the page states. No
// React here, so node --test covers it (costsData.test.js).

export const BREAKDOWNS = ['resource', 'model', 'person', 'tag']
export const PERIOD_PRESETS = [7, 30, 90]
export const MAX_PERIOD_DAYS = 366
const DAY_MS = 86_400_000

// Row columns per breakdown, in table order (same as server/costs.js).
export const COLUMNS = {
  resource: ['product', 'resource_id', 'dbus', 'usd'],
  model: ['endpoint_name', 'requests', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'dbus', 'usd'],
  person: ['user_email', 'requests', 'total_tokens', 'dbus', 'usd'],
  tag: ['tag_value', 'infra_usd', 'ai_usd', 'dbus', 'usd'],
}
export const LABEL_COLUMN = { resource: 'resource_id', model: 'endpoint_name', person: 'user_email', tag: 'tag_value' }
export const MONEY_COLUMNS = new Set(['usd', 'infra_usd', 'ai_usd'])
export const NUMBER_COLUMNS = new Set(['requests', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'dbus'])
// system.billing.usage billing_origin_product values with a friendly name
export const KNOWN_PRODUCTS = ['MODEL_SERVING', 'SQL', 'APPS', 'DATABASE', 'JOBS']

const isoDay = (d) => d.toISOString().slice(0, 10)
const todayIso = (now = new Date()) => isoDay(now)

/** The last `days` calendar days (UTC) ending today, as ISO days. */
export function presetPeriod(days, now = new Date()) {
  const to = new Date(`${todayIso(now)}T00:00:00Z`)
  return { from: isoDay(new Date(to.getTime() - (days - 1) * DAY_MS)), to: isoDay(to) }
}

/** Which preset a period is, or null for a custom range. */
export function presetOf(period, now = new Date()) {
  return PERIOD_PRESETS.find((d) => {
    const p = presetPeriod(d, now)
    return p.from === period.from && p.to === period.to
  }) ?? null
}

/** Same rules the server applies (it re-checks): real ISO days, from ≤ to ≤ today, ≤ 366 days. */
export function validPeriod(period, now = new Date()) {
  const ok = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoDay(new Date(`${s}T00:00:00Z`)) === s
  if (!ok(period?.from) || !ok(period?.to)) return false
  if (period.from > period.to || period.to > todayIso(now)) return false
  return (Date.parse(period.to) - Date.parse(period.from)) / DAY_MS + 1 <= MAX_PERIOD_DAYS
}

// The catalogs' language ('pt' | 'en' | 'es') as an Intl locale.
export function intlLocale(locale) {
  return locale === 'pt' ? 'pt-BR' : locale === 'en' ? 'en-US' : locale || 'en-US'
}

// ISO days are calendar days: format them in UTC, or a browser west of UTC
// shows the day before (2026-10-01 → 30/09 in São Paulo).
function dayLabel(iso, locale) {
  // pt-BR and en-US read best zero-padded (01/10/2026); Spanish usage is 1/10/2026
  const width = locale.startsWith('es') ? 'numeric' : '2-digit'
  return new Intl.DateTimeFormat(locale, { day: width, month: width, year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`))
}

export function periodLabel(period, locale) {
  return `${dayLabel(period.from, locale)} – ${dayLabel(period.to, locale)}`
}

export function formatUsd(v, locale) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const small = v !== 0 && Math.abs(v) < 0.01
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 4 : 2,
  }).format(v)
}

export function formatNumber(v, locale) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v)
}

// ---- CSV ---------------------------------------------------------------------

// A text cell a spreadsheet would run as a formula gets a leading apostrophe
// (OWASP CSV injection); numbers stay raw, so -1 is still a number.
function csvCell(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** RFC 4180 CSV (CRLF), machine column names in the header. */
export function toCsv(columns, rows) {
  const lines = [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))]
  return lines.join('\r\n') + '\r\n'
}

export function csvFilename(by, period) {
  return `ai-prism-costs-${by}-${period.from}_${period.to}.csv`
}

// ---- API -----------------------------------------------------------------------

export function costsQuery({ by, from, to, tag }) {
  const q = new URLSearchParams({ by, from, to })
  if (by === 'tag' && tag) q.set('tag', tag)
  return q.toString()
}

/** Page state for a failed request: HTTP status + the server's {code}. */
export function errorState(status, code) {
  if (status === 403) return code === 'no_access' ? 'noAccess' : 'notAdmin'
  if (code === 'no_warehouse') return 'noWarehouse'
  if (code === 'bad_period') return 'badPeriod'
  return 'error'
}

// ---- i18n ----------------------------------------------------------------------

// Every catalog key the page uses (costsData.test.js checks en, pt and es).
export const COSTS_I18N_KEYS = [
  'sidebar.costs',
  'costs.title',
  'costs.subtitle',
  'costs.back',
  'costs.period',
  ...PERIOD_PRESETS.map((d) => `costs.last${d}`),
  'costs.from',
  'costs.to',
  'costs.badPeriod',
  'costs.breakdownLabel',
  ...BREAKDOWNS.map((b) => `costs.by.${b}`),
  ...BREAKDOWNS.map((b) => `costs.note.${b}`),
  'costs.tagKey',
  'costs.total',
  'costs.totalDbus',
  'costs.export',
  'costs.retry',
  'costs.loading',
  'costs.untagged',
  'costs.chartTitle',
  'costs.tableCaption',
  'costs.lag',
  ...['empty', 'error', 'noAccess', 'notAdmin', 'noWarehouse'].flatMap((s) => [`costs.${s}.title`, `costs.${s}.hint`]),
  ...[...new Set(Object.values(COLUMNS).flat())].map((c) => `costs.col.${c}`),
  ...KNOWN_PRODUCTS.map((p) => `costs.product.${p}`),
]
