// Deterministic parsing of spreadsheets/CSVs into chart-ready structures.
// Chart *data* always comes from here, never from the model — this keeps
// numbers trustworthy (the LLM only narrates/selects among real candidates).
import * as XLSX from 'xlsx'
import { histogramBins, toChartNumber } from '../shared/chartValue.js'

const MAX_ROWS_SCANNED = 5000
const MAX_CATEGORIES = 20

function ext(name) {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function inferType(values) {
  const sample = values.filter((v) => v !== null && v !== undefined && v !== '').slice(0, 200)
  if (!sample.length) return 'empty'
  const numeric = sample.filter((v) => typeof v === 'number' || (!isNaN(v) && v !== '')).length
  if (numeric / sample.length > 0.8) return 'numeric'
  const dates = sample.filter((v) => v instanceof Date || !isNaN(Date.parse(v))).length
  if (dates / sample.length > 0.8) return 'date'
  return 'categorical'
}

function summarizeColumn(name, values) {
  const type = inferType(values)
  const col = { name, type }
  // distinctCount is computed for every type, not just categorical — it's
  // what lets a numeric-looking column (year, month, a region code) be
  // recognized as a grouping dimension instead of a continuous metric below.
  col.distinctCount = new Set(values.filter((v) => v !== null && v !== undefined && v !== '')).size
  if (type === 'numeric') {
    const nums = values.map(Number).filter((n) => !isNaN(n))
    col.stats = {
      count: nums.length,
      min: nums.length ? Math.min(...nums) : null,
      max: nums.length ? Math.max(...nums) : null,
      sum: nums.reduce((a, b) => a + b, 0),
      avg: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
    }
  }
  return col
}

// SQL/spreadsheet column names are rarely presentable as-is ("numero_pedidos",
// "ticket_medio") — chart titles need natural-language phrases instead. A
// small dictionary of exact, known metric names (from this app's own demo
// datasets) gives a perfect phrase for the common cases; anything else falls
// back to a generic underscore-to-space + accent-restoration pass so a raw
// identifier is never dumped straight into a title.
const KNOWN_METRIC_PHRASES = {
  regiao: 'região',
  estado: 'estado',
  receita_total: 'receita total',
  receita_total_reais: 'receita total',
  numero_pedidos: 'número de pedidos',
  quantidade_pedidos: 'número de pedidos',
  numero_clientes_unicos: 'número de clientes únicos',
  ticket_medio: 'ticket médio',
  nota_media_avaliacao: 'nota média de avaliação',
  nota_media: 'nota média',
}
const WORD_ACCENTS = {
  numero: 'número',
  numeros: 'números',
  regiao: 'região',
  regioes: 'regiões',
  medio: 'médio',
  media: 'média',
  avaliacao: 'avaliação',
  avaliacoes: 'avaliações',
  unicos: 'únicos',
  unico: 'único',
  unica: 'única',
  unicas: 'únicas',
  preco: 'preço',
  precos: 'preços',
  pais: 'país',
  mes: 'mês',
  meses: 'meses',
}

function humanize(raw) {
  const key = String(raw).toLowerCase().trim()
  const known = KNOWN_METRIC_PHRASES[key]
  const phrase = known || key.split(/[_\s]+/).filter(Boolean).map((w) => WORD_ACCENTS[w] || w).join(' ')
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

// SQL aggregations routinely GROUP BY a column that's numeric-typed but is
// really a dimension (year, month, a region/category id) — not a continuous
// metric. inferType alone can't tell them apart, so this name heuristic
// backstops it: if it looks like a time unit, prefer treating it as one.
const TIME_LIKE_NAME_RE = /^(ano|year|m[eê]s|month|dia|day|data|date|trimestre|quarter|semana|week|semestre)/i

// Builds up to a handful of real, aggregated chart candidates from a sheet's
// (or a Genie query's) rows — an array of objects keyed by column name.
// A "dimension" is anything usable as a chart's x-axis/category: text
// columns, date columns, and low-cardinality numeric columns (year, month,
// a region code) that are clearly a grouping key, not a measure, because
// they repeat across rows. Dimension x measure -> bar/pie; a time-like or
// date dimension x measure -> line, sorted chronologically.
function buildChartCandidates(sheetName, headers, rows, columns) {
  const candidates = []
  const isRepeatingDimension = (c) =>
    c.distinctCount != null && c.distinctCount >= 2 && c.distinctCount <= MAX_CATEGORIES && c.distinctCount < rows.length

  const timeCols = columns
    .filter((c) => c.type === 'date' || (c.type === 'numeric' && TIME_LIKE_NAME_RE.test(c.name) && isRepeatingDimension(c)))
    .map((c) => c.name)
  const categoricalCols = columns
    .filter((c) => !timeCols.includes(c.name) && (c.type === 'categorical' || (c.type === 'numeric' && isRepeatingDimension(c))))
    .map((c) => c.name)
  const measureCols = columns
    .filter((c) => c.type === 'numeric' && !timeCols.includes(c.name) && !categoricalCols.includes(c.name))
    .map((c) => c.name)

  const aggregateBy = (keyCol, valueCol) => {
    const agg = new Map()
    for (const r of rows) {
      const key = String(r[keyCol] ?? '—').trim() || '—'
      const val = Number(r[valueCol])
      if (isNaN(val)) continue
      agg.set(key, (agg.get(key) || 0) + val)
    }
    return [...agg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_CATEGORIES)
      .map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 }))
  }

  for (const keyCol of categoricalCols.slice(0, 2)) {
    for (const valueCol of measureCols.slice(0, 5)) {
      const data = aggregateBy(keyCol, valueCol)
      if (data.length < 2) continue
      const id = `c${candidates.length + 1}`
      candidates.push({
        id,
        chartType: 'bar',
        title: `${humanize(valueCol)} por ${humanize(keyCol)}`,
        series: [{ name: valueCol, data }],
      })
      if (data.length <= 8) {
        candidates.push({
          id: `c${candidates.length + 1}`,
          chartType: 'pie',
          title: `Distribuição de ${humanize(valueCol)} por ${humanize(keyCol)}`,
          series: [{ name: valueCol, data }],
        })
      }
    }
  }

  for (const timeCol of timeCols.slice(0, 1)) {
    for (const valueCol of measureCols.slice(0, 5)) {
      const data = aggregateBy(timeCol, valueCol).sort((a, b) => (a.label > b.label ? 1 : -1))
      if (data.length < 2) continue
      candidates.push({
        id: `c${candidates.length + 1}`,
        chartType: 'line',
        title: `${humanize(valueCol)} ao longo do tempo`,
        series: [{ name: valueCol, data }],
      })
    }
  }

  const all = [...candidates.slice(0, 15), ...buildAnalysisCandidates(rows, { timeCols, categoricalCols, measureCols })]
  all.forEach((c, i) => (c.id = `c${i + 1}`))
  return all
}

// Richer analysis kinds (W2-9), appended AFTER the original bar/pie/line
// candidates so their ids never shift. Same data-honesty rule: every number is
// computed here from the real rows, the model only picks and narrates.
//   pivot + heatmap  two dimensions x the first measure (sum), one series per
//                    column key, rows aligned; a missing combination is null
//   histogram        distribution of a measure (shared Sturges binning)
//   scatter          two measures as x/y, grouped by the first dimension
const MAX_PIVOT_ROWS = 20
const MAX_PIVOT_COLS = 12
const MAX_SCATTER_POINTS = 500
const MAX_SCATTER_GROUPS = 6
const MIN_HISTOGRAM_VALUES = 10
const MAX_ANALYSIS_CANDIDATES = 10

const keyOf = (v) => String(v ?? '—').trim() || '—'
const round2 = (n) => Math.round(n * 100) / 100

function pivotSeries(rows, rowCol, colCol, valueCol, chronological) {
  const cells = new Map() // row -> col -> sum
  const rowTotals = new Map()
  const colTotals = new Map()
  for (const r of rows) {
    const val = toChartNumber(r[valueCol])
    if (val == null) continue
    const rk = keyOf(r[rowCol])
    const ck = keyOf(r[colCol])
    if (!cells.has(rk)) cells.set(rk, new Map())
    const row = cells.get(rk)
    row.set(ck, (row.get(ck) || 0) + val)
    rowTotals.set(rk, (rowTotals.get(rk) || 0) + val)
    colTotals.set(ck, (colTotals.get(ck) || 0) + val)
  }
  // biggest rows/columns first (ties by label, so the order is total); a time
  // dimension as columns keeps its chronological order instead
  const byTotal = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] > b[0] ? 1 : -1)).map(([k]) => k)
  const rowKeys = byTotal(rowTotals).slice(0, MAX_PIVOT_ROWS)
  let colKeys = byTotal(colTotals).slice(0, MAX_PIVOT_COLS)
  if (chronological) colKeys = colKeys.sort((a, b) => (a > b ? 1 : a < b ? -1 : 0))
  return colKeys.map((ck) => ({
    name: ck,
    data: rowKeys.map((rk) => {
      const v = cells.get(rk)?.get(ck)
      return { label: rk, value: v == null ? null : round2(v) }
    }),
  }))
}

function scatterSeries(rows, xCol, yCol, groupCol) {
  const points = []
  for (const r of rows) {
    const x = toChartNumber(r[xCol])
    const y = toChartNumber(r[yCol])
    if (x == null || y == null) continue
    points.push({ group: groupCol ? keyOf(r[groupCol]) : yCol, x, y })
  }
  // deterministic down-sampling: an even stride over the row order
  const stride = Math.max(1, Math.ceil(points.length / MAX_SCATTER_POINTS))
  const kept = points.filter((_, i) => i % stride === 0).slice(0, MAX_SCATTER_POINTS)
  const groups = new Map()
  for (const p of kept) {
    if (!groups.has(p.group)) groups.set(p.group, [])
    groups.get(p.group).push({ label: '', x: p.x, y: p.y })
  }
  return [...groups.entries()].map(([name, data]) => ({ name, data }))
}

function buildAnalysisCandidates(rows, { timeCols, categoricalCols, measureCols }) {
  const out = []
  const push = (c) => out.push({ id: `c${out.length + 1}`, ...c })
  const valueCol = measureCols[0]

  // pivot/heatmap over the first two dimension pairs (time goes to the columns)
  const dims = [...categoricalCols.slice(0, 2).map((name) => ({ name, time: false })), ...timeCols.slice(0, 1).map((name) => ({ name, time: true }))]
  const pairs = []
  for (let i = 0; i < dims.length; i++) for (let j = i + 1; j < dims.length; j++) pairs.push([dims[i], dims[j]])
  if (valueCol) {
    for (const [a, b] of pairs.slice(0, 2)) {
      const [rowDim, colDim] = a.time ? [b, a] : [a, b]
      const series = pivotSeries(rows, rowDim.name, colDim.name, valueCol, colDim.time)
      if (series.length < 2 || (series[0]?.data.length ?? 0) < 2) continue
      const meta = { rowLabel: rowDim.name, colLabel: colDim.name, valueLabel: valueCol, series }
      push({ chartType: 'pivot', title: `${humanize(valueCol)} por ${humanize(rowDim.name)} e ${humanize(colDim.name)}`, ...meta })
      push({ chartType: 'heatmap', title: `Mapa de calor: ${humanize(valueCol)} por ${humanize(rowDim.name)} e ${humanize(colDim.name)}`, ...meta })
    }
  }

  for (const col of measureCols.slice(0, 2)) {
    const nums = rows.map((r) => toChartNumber(r[col])).filter((n) => n != null)
    if (nums.length < MIN_HISTOGRAM_VALUES || new Set(nums).size < 5) continue
    const data = histogramBins(nums).map(({ label, value }) => ({ label, value }))
    push({ chartType: 'histogram', title: `Distribuição de ${humanize(col)}`, valueLabel: col, series: [{ name: col, data }] })
  }

  const groupCol = categoricalCols.find((c) => {
    const n = new Set(rows.map((r) => keyOf(r[c]))).size
    return n >= 2 && n <= MAX_SCATTER_GROUPS
  })
  const measurePairs = []
  const m = measureCols.slice(0, 3)
  for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) measurePairs.push([m[i], m[j]])
  for (const [xCol, yCol] of measurePairs.slice(0, 2)) {
    const series = scatterSeries(rows, xCol, yCol, groupCol)
    const count = series.reduce((a, s) => a + s.data.length, 0)
    if (count < 5) continue
    push({ chartType: 'scatter', title: `${humanize(yCol)} vs ${humanize(xCol)}`, xLabel: xCol, yLabel: yCol, series })
  }

  return out.slice(0, MAX_ANALYSIS_CANDIDATES)
}

function sheetToRows(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true })
  return rows.slice(0, MAX_ROWS_SCANNED)
}

function analyzeWorkbook(wb) {
  const sheets = []
  const chartCandidates = []
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    const rows = sheetToRows(ws)
    if (!rows.length) {
      sheets.push({ name, headers: [], rowCount: 0, columns: [] })
      continue
    }
    const headers = Object.keys(rows[0])
    const columns = headers.map((h) => summarizeColumn(h, rows.map((r) => r[h])))
    sheets.push({ name, headers, rowCount: rows.length, columns })
    for (const cand of buildChartCandidates(name, headers, rows, columns)) {
      chartCandidates.push(cand)
    }
  }
  // re-number ids globally so refs are unambiguous across sheets
  chartCandidates.forEach((c, i) => (c.id = `candidate_${i + 1}`))
  return { sheets, chartCandidates }
}

export function analyzeSpreadsheet(filename, buffer) {
  const e = ext(filename)
  const wb =
    e === 'csv'
      ? XLSX.read(buffer.toString('utf-8'), { type: 'string', raw: true })
      : XLSX.read(buffer, { type: 'buffer' })
  return analyzeWorkbook(wb)
}

export function isSpreadsheet(filename) {
  return ['xlsx', 'xls', 'csv'].includes(ext(filename))
}

// Same deterministic candidate-building heuristic as analyzeSpreadsheet, but
// for tabular data that didn't come from an uploaded file — e.g. rows a
// Genie Space query returned mid-conversation. `rows` is an array of plain
// objects keyed by column name; ids are local (`c1`, `c2`, ...) and must be
// re-numbered by the caller into the shared `candidate_N` namespace.
export function chartCandidatesFromRows(sourceLabel, rows) {
  if (!rows?.length) return []
  const headers = Object.keys(rows[0])
  const columns = headers.map((h) => summarizeColumn(h, rows.map((r) => r[h])))
  return buildChartCandidates(sourceLabel, headers, rows, columns)
}

// Compact, LLM-facing description of chart candidates: enough to pick/narrate,
// never the raw data points a model could copy verbatim into hallucinated text.
export function describeCandidates(candidates) {
  return candidates.map(describeCandidate).join('\n')
}

function describeCandidate(c) {
  const head = `- ${c.id} (${c.chartType}): "${c.title}" — `
  if (c.chartType === 'scatter') {
    const n = c.series.reduce((a, s) => a + s.data.length, 0)
    return head + `${n} pontos (x=${c.xLabel}, y=${c.yLabel}), grupos: ${c.series.map((s) => s.name).join(', ')}`
  }
  if (c.chartType === 'pivot' || c.chartType === 'heatmap') {
    const rows = c.series[0]?.data.length ?? 0
    return head + `${rows} linhas × ${c.series.length} colunas (${c.rowLabel} × ${c.colLabel}, soma de ${c.valueLabel})`
  }
  if (c.chartType === 'histogram') {
    return head + `${c.series[0]?.data.length ?? 0} faixas de ${c.valueLabel}`
  }
  return (
    head +
    `${c.series[0]?.data.length ?? 0} categorias, ` +
    `top: ${c.series[0]?.data.slice(0, 3).map((d) => `${d.label}=${d.value}`).join(', ')}`
  )
}
