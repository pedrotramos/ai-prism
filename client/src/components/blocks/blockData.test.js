// Pure data rules behind the inline artifact blocks (document teaser, chart
// palette and "view data" table). Expected values are written by hand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { documentTeaser, chartToTable, seriesPalette } from './blockData.js'

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

const CHART = {
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
const read = (vars) => (name) => vars[name] || ''

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
