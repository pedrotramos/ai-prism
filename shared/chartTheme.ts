// The colours a chart wears when it leaves the app as an IMAGE (the PNG behind a
// deck slide or a DOCX figure), where there are no CSS variables. They are the
// values of the AI Prism LIGHT theme tokens (client/src/styles/tokens.css), because a
// document or a slide figure sits on white; chartTheme.test.ts fails when a
// token changes and this table does not follow. In the app itself charts read
// the tokens directly (ChartBlock / blockData.seriesPalette).

export interface ChartTheme {
  /** --surface */
  bg: string
  /** --text */
  text: string
  /** --muted */
  muted: string
  /** --faint */
  faint: string
  /** --border */
  border: string
  /** --surface-3: also the "no data" fill of a map */
  empty: string
  /** --info, --success, --warning, --accent, --muted: the categorical order (blockData CATEGORICAL) */
  series: string[]
  /** --faint: the "prior period" colour of a two-series comparison (blockData NEUTRAL) */
  neutral: string
  /** ramp of a heatmap / map: --surface-3 → --info */
  heatLow: string
  heatHigh: string
  font: string
}

export const EXPORT_THEME: ChartTheme = {
  bg: '#ffffff',
  text: '#1a1f24',
  muted: '#5c6670',
  faint: '#626b75',
  border: '#e2e6ea',
  empty: '#e9edf1',
  series: ['#1d64d8', '#18794e', '#9a5b00', '#e5341f', '#5c6670'],
  neutral: '#626b75',
  heatLow: '#e9edf1',
  heatHigh: '#1d64d8',
  font: 'Inter',
}

// token name each EXPORT_THEME entry mirrors (chartTheme.test.ts reads them from tokens.css)
export const THEME_TOKENS = {
  bg: '--surface',
  text: '--text',
  muted: '--muted',
  faint: '--faint',
  border: '--border',
  empty: '--surface-3',
  neutral: '--faint',
  heatLow: '--surface-3',
  heatHigh: '--info',
} as const
export const SERIES_TOKENS = ['--info', '--success', '--warning', '--accent', '--muted'] as const
