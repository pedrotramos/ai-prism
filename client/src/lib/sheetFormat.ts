// Number formatting for the spreadsheet studio's grid and selection footer. It follows the interface language
// (the i18n provider's locale: en / pt / es). The exported .xlsx is built on the server and is not formatted here.

const BCP47: Record<string, string> = { en: 'en-US', pt: 'pt-BR', es: 'es-ES' }
const tag = (locale: string) => BCP47[locale] ?? BCP47.pt!

const fixed = (n: number, locale: string, digits: number) =>
  n.toLocaleString(tag(locale), { minimumFractionDigits: digits, maximumFractionDigits: digits })

export function fmtNumber(value: unknown, format: string | undefined, locale: string): string {
  if (value == null || value === '') return ''
  const n = Number(value)
  const isNum = typeof value === 'number' || !isNaN(n)
  if (isNum) {
    if (format === 'currency') return 'R$ ' + fixed(n, locale, 2)
    if (format === 'usd') return '$' + fixed(n, locale, 2)
    if (format === 'eur') return '€ ' + fixed(n, locale, 2)
    if (format === 'percent') return fixed(n * 100, locale, 1) + '%'
    if (format === 'percent0') return Math.round(n * 100) + '%'
    if (format === 'integer') return Math.round(n).toLocaleString(tag(locale))
    if (format === 'number') return fixed(n, locale, 2)
  }
  return String(value)
}

// compact number for the stats footer (thousands separator, up to 2 decimals)
export function fmtStat(n: number, locale: string): string {
  if (!isFinite(n)) return '—'
  return Number(n).toLocaleString(tag(locale), { maximumFractionDigits: 2 })
}
