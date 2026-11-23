// Pure data rules behind the inline artifact blocks (document teaser, chart
// palette and "view data" table). Expected values are written by hand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { ChartBlockData } from './blockData.ts'
import { documentTeaser, chartToTable, seriesPalette, heatmapPalette, heatCell } from './blockData.ts'
import { contrastRatio, parseColor } from '../../../../shared/chartValue.js'

// --- document teaser (ux#20: first paragraph, never raw table syntax)

const MEMO =
  '# Q3 FY26 revenue memo\n\n## Summary\nRevenue grew **8.4% QoQ** to $104.1M.\n\n## By region\n' +
  '| Region | Q2 | Q3 | QoQ |\n|---|---|---|---|\n| North America | 41.2 | 41.5 | +0.7% |\n\n' +
  '## Recommendations\n- Escalate APAC renewals to the regional VP.\n'

test('teaser: the first prose paragraph, headings and emphasis removed', () => {
  assert.equal(documentTeaser(MEMO), 'Revenue grew 8.4% QoQ to $104.1M.')
})

test('teaser: a document that opens with a table skips the table', () => {
  const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\nThe numbers above are final.'
  assert.equal(documentTeaser(md), 'The numbers above are final.')
})

test('teaser: fenced code and horizontal rules are skipped', () => {
  const md = '```sql\nSELECT 1\n```\n\n---\n\nRun the query nightly.'
  assert.equal(documentTeaser(md), 'Run the query nightly.')
})

test('teaser: links keep their text and inline code loses its backticks', () => {
  const md = 'See [the runbook](https://example.com/rb) and run `make deploy` today.'
  assert.equal(documentTeaser(md), 'See the runbook and run make deploy today.')
})

test('teaser: a wrapped paragraph is joined into one line', () => {
  assert.equal(documentTeaser('First line\nsecond line.\n\nNext paragraph.'), 'First line second line.')
})

test('teaser: a paragraph longer than the limit is cut on a word with an ellipsis', () => {
  const md = 'alpha beta gamma delta epsilon zeta'
  assert.equal(documentTeaser(md, 20), 'alpha beta gamma…')
})

test('teaser: a document with only a heading and a table has no teaser', () => {
  assert.equal(documentTeaser('# Title\n\n| a |\n|---|\n| 1 |'), '')
  assert.equal(documentTeaser(''), '')
  assert.equal(documentTeaser(undefined), '')
})

// --- chart "view data" table (ux#25: reuse TableBlock)

const CHART: ChartBlockData = {
  type: 'chart',
  chartType: 'bar',
  title: 'Revenue by region, $M (Q2 vs Q3)',
  series: [
    { name: 'Q2', data: [{ label: 'North America', value: 41.2 }, { label: 'EMEA', value: 27.9 }] },
    { name: 'Q3', data: [{ label: 'North America', value: 41.5 }, { label: 'EMEA', value: null }] },
  ],
}

test('chart table: one row per label, one column per series', () => {
  assert.deepEqual(chartToTable(CHART, 'Category'), {
    type: 'table',
    title: null,
    columns: ['Category', 'Q2', 'Q3'],
    rows: [
      ['North America', '41.2', '41.5'],
      ['EMEA', '27.9', null],
    ],
  })
})

test('chart table: an unnamed series gets a numbered column', () => {
  const t = chartToTable({ series: [{ data: [{ label: 'a', value: 1 }] }] }, 'Label')
  assert.deepEqual(t.columns, ['Label', 'Series 1'])
})

// --- chart palette (ux#25: theme/DS tokens, neutral comparison series)

// what getComputedStyle would return: a DS may define --chart-*, the app always has the semantic tokens
const APP = { '--info': '#6ea8ff', '--success': '#3dd68c', '--warning': '#f5a524', '--accent': '#ff3621', '--muted': '#98a2b3', '--faint': '#858e9a' }
const read = (vars: Record<string, string>) => (name: string) => vars[name] || ''

test('palette: one series uses the primary colour', () => {
  assert.deepEqual(seriesPalette({ chartType: 'bar', count: 1, read: read(APP) }), ['#6ea8ff'])
})

test('palette: two series compare a neutral prior period with the primary current one', () => {
  assert.deepEqual(seriesPalette({ chartType: 'bar', count: 2, read: read(APP) }), ['#858e9a', '#6ea8ff'])
  assert.deepEqual(seriesPalette({ chartType: 'line', count: 2, read: read(APP) }), ['#858e9a', '#6ea8ff'])
})

test('palette: three or more series, and pie slices, are categorical and cycle', () => {
  assert.deepEqual(seriesPalette({ chartType: 'bar', count: 3, read: read(APP) }), ['#6ea8ff', '#3dd68c', '#f5a524'])
  assert.deepEqual(seriesPalette({ chartType: 'pie', count: 6, read: read(APP) }), ['#6ea8ff', '#3dd68c', '#f5a524', '#ff3621', '#98a2b3', '#6ea8ff'])
})

test('palette: the brand accent is never the first colour of a comparison', () => {
  const two = seriesPalette({ chartType: 'bar', count: 2, read: read(APP) })
  assert.ok(!two.includes('#ff3621'))
})

test('palette: design-system --chart-* tokens win over the app tokens', () => {
  const ds = { ...APP, '--chart-1': '#003366', '--chart-2': '#ffaa00', '--chart-neutral': '#cccccc' }
  assert.deepEqual(seriesPalette({ chartType: 'bar', count: 2, read: read(ds) }), ['#cccccc', '#003366'])
  assert.deepEqual(seriesPalette({ chartType: 'pie', count: 2, read: read(ds) }), ['#003366', '#ffaa00'])
})

test('palette: an unresolvable token falls back to currentColor, never to black or empty', () => {
  assert.deepEqual(seriesPalette({ chartType: 'bar', count: 1, read: () => '' }), ['currentColor'])
})

// --- W2-9 analysis kinds: palette, data table, heatmap shading

test('palette: scatter groups are categorical (no neutral "prior period"), a histogram is primary', () => {
  assert.deepEqual(seriesPalette({ chartType: 'scatter', count: 2, read: read(APP) }), ['#6ea8ff', '#3dd68c'])
  assert.deepEqual(seriesPalette({ chartType: 'histogram', count: 1, read: read(APP) }), ['#6ea8ff'])
  assert.deepEqual(seriesPalette({ chartType: 'pivot', count: 2, read: read(APP) }), ['#6ea8ff', '#3dd68c'])
})

test('chart table: a scatter lists one row per point with its x and y', () => {
  const t = chartToTable(
    { chartType: 'scatter', xLabel: 'Receita', yLabel: 'Pedidos', series: [{ name: 'Sul', data: [{ label: '', x: 10, y: 2 }] }, { name: 'Norte', data: [{ label: 'N1', x: 5, y: 1 }] }] },
    'Category'
  )
  assert.deepEqual(t, { type: 'table', title: null, columns: ['Category', 'Receita', 'Pedidos'], rows: [['Sul', '10', '2'], ['N1', '5', '1']] })
})

test('chart table: a pivot keeps the missing cells empty', () => {
  const t = chartToTable({ chartType: 'pivot', series: [{ name: 'Loja', data: [{ label: 'Sul', value: 1 }, { label: 'Norte', value: null }] }] }, 'Região')
  assert.deepEqual(t.rows, [['Sul', '1'], ['Norte', null]])
})

// Token values per theme, parsed from the real stylesheet (hex declarations only).
const TOKENS_CSS = readFileSync(new URL('../../styles/tokens.css', import.meta.url), 'utf8')
function themeTokens(theme: string): Record<string, string> {
  const sel = theme === 'dark' ? /:root\[data-theme='dark'\]\s*\{([^}]*)\}/ : /:root\[data-theme='light'\]\s*\{([^}]*)\}/
  const body = TOKENS_CSS.match(sel)![1]!
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) out[m[1]!] = m[2]!
  return out
}

// Colour-vision-deficiency simulation (Machado, Oliveira & Fernandes 2009,
// severity 1.0, applied in linear RGB), then CIE76 distance in CIELAB.
type Matrix = number[][]
const CVD: Record<string, Matrix> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
}
const toLinear = (c: number): number => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const simulate = (hex: string, m: Matrix): number[] => {
  const l = parseColor(hex)!.map(toLinear) as [number, number, number]
  return m.map((r) => Math.min(1, Math.max(0, r[0]! * l[0] + r[1]! * l[1] + r[2]! * l[2])))
}
const lab = (l: number[]): number[] => {
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const X = (0.4124 * l[0]! + 0.3576 * l[1]! + 0.1805 * l[2]!) / 0.95047
  const Y = 0.2126 * l[0]! + 0.7152 * l[1]! + 0.0722 * l[2]!
  const Z = (0.0193 * l[0]! + 0.1192 * l[1]! + 0.9505 * l[2]!) / 1.08883
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]
}
const deltaE = (a: number[], b: number[]): number => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]!))

for (const theme of ['dark', 'light']) {
  const tok = themeTokens(theme)
  const palette = seriesPalette({ chartType: 'pie', count: 5, read: (n) => tok[n] || '' })

  test(`palette (${theme}): every categorical colour is >= 3:1 against the chart card (--surface-2)`, () => {
    for (const c of palette) assert.ok(contrastRatio(c, tok['--surface-2']!) >= 3, `${c} on ${tok['--surface-2']}`)
  })

  test(`palette (${theme}): the categorical order stays distinguishable under protan/deutan/tritan`, () => {
    // measured minimum today: 7.9 (light, protanopia, --warning vs --accent);
    // 7 keeps a margin without pretending the 4th/5th colours are far apart
    for (const [kind, m] of Object.entries(CVD)) {
      for (let i = 0; i < palette.length; i++)
        for (let j = i + 1; j < palette.length; j++) {
          const d = deltaE(simulate(palette[i]!, m), simulate(palette[j]!, m))
          assert.ok(d >= 7, `${kind}: ${palette[i]} vs ${palette[j]} dE=${d.toFixed(1)}`)
        }
      // the first two (the ones most charts use) are clearly apart
      assert.ok(deltaE(simulate(palette[0]!, m), simulate(palette[1]!, m)) >= 15, `${kind}: first pair`)
    }
  })

  test(`heatmap (${theme}): token-only ramp, every cell label is AA (>= 4.5:1) on its fill or its chip`, () => {
    const hp = heatmapPalette({ read: (n) => tok[n] || '' })
    assert.equal(hp.high, tok['--chart-1'])
    assert.equal(hp.low, tok['--surface-3'])
    for (let i = 0; i <= 20; i++) {
      const cell = heatCell(hp, i / 20)
      assert.match(cell.fill, /^#[0-9a-f]{6}$/)
      const behind = cell.chip || cell.fill
      assert.ok(contrastRatio(cell.text, behind) >= 4.5, `t=${i / 20}: ${cell.text} on ${behind}`)
      if (cell.chip) assert.equal(cell.chip, tok['--surface'], 'the chip is the surface token')
    }
    // the ends of the ramp carry the label directly (no chip)
    assert.equal(heatCell(hp, 0).chip, null)
    assert.equal(heatCell(hp, 1).chip, null)
    // a design system's --chart-1 drives the ramp
    assert.equal(heatmapPalette({ read: (n) => ({ ...tok, '--chart-1': '#003366' })[n] || '' }).high, '#003366')
  })
}
