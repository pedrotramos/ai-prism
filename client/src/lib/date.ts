// Shared date helpers for the sidebar's chronological grouping and the
// History page's compact relative timestamps — kept in one place so both
// views agree on what "today"/"2d ago" mean. These return i18n KEYS (and
// interpolation vars) rather than literal strings, so the caller resolves them
// with its own useT() — keeping these pure, component-free helpers.
export function timeGroupKey(d: string | number | Date): string {
  const date = new Date(d)
  const now = new Date()
  const diff = (now.getTime() - date.getTime()) / 86400000
  if (diff < 1 && now.getDate() === date.getDate()) return 'time.today'
  if (diff < 2) return 'time.yesterday'
  if (diff < 7) return 'time.last7'
  if (diff < 30) return 'time.last30'
  return 'time.older'
}

// Short, absolute label for a message timestamp shown under the user bubble —
// "Jul 27" style (Claude-like). Drops the year for the current year, keeps it
// otherwise. Locale-aware via Intl. Returns '' for a missing/invalid date.
export function shortMessageDate(d: string | number | Date | null | undefined, locale = 'en'): string {
  if (!d) return ''
  const date = new Date(d)
  if (isNaN(date.getTime())) return ''
  const sameYear = date.getFullYear() === new Date().getFullYear()
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    }).format(date)
  } catch {
    return date.toDateString()
  }
}

// Returns { key, vars } for the relative timestamp, resolved by the caller's t().
export function relativeTime(d: string | number | Date): { key: string; vars?: { n: number } } {
  const diffMs = Date.now() - new Date(d).getTime()
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return { key: 'time.now' }
  if (min < 60) return { key: 'time.minsAgo', vars: { n: min } }
  const h = Math.floor(min / 60)
  if (h < 24) return { key: 'time.hoursAgo', vars: { n: h } }
  const days = Math.floor(h / 24)
  if (days < 30) return { key: 'time.daysAgo', vars: { n: days } }
  const months = Math.floor(days / 30)
  if (months < 12) return { key: 'time.monthsAgo', vars: { n: months } }
  return { key: 'time.yearsAgo', vars: { n: Math.floor(months / 12) } }
}
