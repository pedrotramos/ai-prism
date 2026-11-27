// Deterministic parsing of spreadsheets/CSVs into chart-ready structures.
// Chart *data* always comes from here, never from the model — this keeps
// numbers trustworthy (the LLM only narrates/selects among real candidates).
import * as XLSX from 'xlsx'
import { histogramBins, toChartNumber } from '../shared/chartValue.js'
import { matchGeo } from './geo.ts'

// `any`: untyped JSON from the LLM / spreadsheet cells; shapes are validated at runtime.
type Json = any

const MAX_ROWS_SCANNED = 5000
const MAX_CATEGORIES = 20

function ext(name: Json) {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function inferType(values: Json) {
  const sample = values.filter((v: Json) => v !== null && v !== undefined && v !== '').slice(0, 200)
  if (!sample.length) return 'empty'
  const numeric = sample.filter((v: Json) => typeof v === 'number' || (!isNaN(v) && v !== '')).length
  if (numeric / sample.length > 0.8) return 'numeric'
  const dates = sample.filter((v: Json) => v instanceof Date || !isNaN(Date.parse(v))).length
  if (dates / sample.length > 0.8) return 'date'
  return 'categorical'
}

function summarizeColumn(name: Json, values: Json) {
  const type = inferType(values)
  const col: Json = { name, type }
  // distinctCount is computed for every type, not just categorical — it's
  // what lets a numeric-looking column (year, month, a region code) be
  // recognized as a grouping dimension instead of a continuous metric below.
  col.distinctCount = new Set(values.filter((v: Json) => v !== null && v !== undefined && v !== '')).size
  if (type === 'numeric') {
    const nums = values.map(Number).filter((n: Json) => !isNaN(n))
    col.stats = {
      count: nums.length,
      min: nums.length ? Math.min(...nums) : null,
      max: nums.length ? Math.max(...nums) : null,
      sum: nums.reduce((a: Json, b: Json) => a + b, 0),
      avg: nums.length ? nums.reduce((a: Json, b: Json) => a + b, 0) / nums.length : null,
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
const KNOWN_METRIC_PHRASES: Record<string, string> = {
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
const WORD_ACCENTS: Record<string, string> = {
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

function humanize(raw: Json) {
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
function buildChartCandidates(sheetName: Json, headers: Json, rows: Json, columns: Json) {
  const candidates = []
  const isRepeatingDimension = (c: Json) =>
    c.distinctCount != null && c.distinctCount >= 2 && c.distinctCount <= MAX_CATEGORIES && c.distinctCount < rows.length

  const timeCols = columns
    .filter((c: Json) => c.type === 'date' || (c.type === 'numeric' && TIME_LIKE_NAME_RE.test(c.name) && isRepeatingDimension(c)))
    .map((c: Json) => c.name)
  const categoricalCols = columns
    .filter((c: Json) => !timeCols.includes(c.name) && (c.type === 'categorical' || (c.type === 'numeric' && isRepeatingDimension(c))))
    .map((c: Json) => c.name)
  const measureCols = columns
    .filter((c: Json) => c.type === 'numeric' && !timeCols.includes(c.name) && !categoricalCols.includes(c.name))
    .map((c: Json) => c.name)

  const aggregateBy = (keyCol: Json, valueCol: Json) => {
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
      const id: string = `c${candidates.length + 1}`
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
const MAX_ANALYSIS_CANDIDATES = 14
// donut: up to 6 slices, or 5 + "Outros" when the dimension has more
const MAX_DONUT_SLICES = 6
const OTHERS_LABEL = 'Outros'
const OTHERS_ALT_LABEL = 'Demais'
// a measure whose parts do not add up to a whole (an average, a rate, a price):
// no share-of-total chart, and a map of it averages the rows of a region
const NON_ADDITIVE_RE = /(m[eé]di[ao]|\bavg\b|average|\bmean\b|ticket|pre[cç]o|price|taxa|\brate\b|margem|margin|%|percent|\bpct\b|ratio|\bnota\b|score|[ií]ndice|index)/i

const keyOf = (v: Json) => String(v ?? '—').trim() || '—'
const round2 = (n: Json) => Math.round(n * 100) / 100

function pivotSeries(rows: Json, rowCol: Json, colCol: Json, valueCol: Json, chronological: Json) {
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
  const byTotal = (m: Json) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] > b[0] ? 1 : -1)).map(([k]) => k)
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

function scatterSeries(rows: Json, xCol: Json, yCol: Json, groupCol: Json) {
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

// One value per dimension key: the sum for an additive measure, the mean for
// a non-additive one. `cap` limits the keys kept (biggest first); a key without
// any number is left out, never counted as 0.
function aggregateRows(rows: Json, keyCol: Json, valueCol: Json, { mean = false, cap = Infinity } = {}) {
  const agg = new Map<string, { sum: number; n: number }>()
  for (const r of rows) {
    const v = toChartNumber(r[valueCol])
    if (v == null) continue
    const k = keyOf(r[keyCol])
    const a = agg.get(k) ?? { sum: 0, n: 0 }
    a.sum += v
    a.n++
    agg.set(k, a)
  }
  return [...agg.entries()]
    .map(([label, a]) => ({ label, value: round2(mean ? a.sum / a.n : a.sum) }))
    .sort((a, b) => b.value - a.value || (a.label > b.label ? 1 : -1))
    .slice(0, cap)
}

// The slices of a donut: the biggest 5 and the rest as one "Outros" slice (named
// "Demais" when the data already has a category called "Outros").
function donutSlices(data: { label: string; value: number }[]) {
  const pos = data.filter((d) => d.value > 0)
  if (pos.length <= MAX_DONUT_SLICES) return pos
  const head = pos.slice(0, MAX_DONUT_SLICES - 1)
  const rest = round2(pos.slice(MAX_DONUT_SLICES - 1).reduce((a, d) => a + d.value, 0))
  const taken = pos.some((d) => d.label.toLowerCase() === OTHERS_LABEL.toLowerCase())
  return [...head, { label: taken ? OTHERS_ALT_LABEL : OTHERS_LABEL, value: rest }]
}

function buildAnalysisCandidates(rows: Json, { timeCols, categoricalCols, measureCols }: Json) {
  const out: Json[] = []
  const push = (c: Json) => out.push({ id: `c${out.length + 1}`, ...c })
  const valueCol = measureCols[0]

  // pivot/heatmap over the first two dimension pairs (time goes to the columns)
  const dims = [...categoricalCols.slice(0, 2).map((name: Json) => ({ name, time: false })), ...timeCols.slice(0, 1).map((name: Json) => ({ name, time: true }))]
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
    const nums = rows.map((r: Json) => toChartNumber(r[col])).filter((n: Json) => n != null)
    if (nums.length < MIN_HISTOGRAM_VALUES || new Set(nums).size < 5) continue
    const data = histogramBins(nums).map(({ label, value }) => ({ label, value }))
    push({ chartType: 'histogram', title: `Distribuição de ${humanize(col)}`, valueLabel: col, series: [{ name: col, data }] })
  }

  const groupCol = categoricalCols.find((c: Json) => {
    const n = new Set(rows.map((r: Json) => keyOf(r[c]))).size
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

  // donut: the share of each part of a whole (an additive measure, 2+ positive parts)
  for (const keyCol of categoricalCols.slice(0, 2)) {
    const col = measureCols.find((c: Json) => !NON_ADDITIVE_RE.test(c))
    if (!col) break
    const slices = donutSlices(aggregateRows(rows, keyCol, col))
    if (slices.length < 2) continue
    push({ chartType: 'donut', title: `Participação de ${humanize(col)} por ${humanize(keyCol)}`, valueLabel: col, series: [{ name: col, data: slices }] })
    break
  }

  // map: a dimension whose values name the regions of a geo set (countries, states, ...)
  let maps = 0
  for (const keyCol of categoricalCols) {
    if (maps >= 2) break
    const labels = [...new Set<string>(rows.map((r: Json) => keyOf(r[keyCol])))]
    const match = matchGeo(labels)
    if (!match) continue
    for (const col of measureCols.slice(0, 1)) {
      const data = aggregateRows(rows, keyCol, col, { mean: NON_ADDITIVE_RE.test(col) })
      if (data.length < 3) continue
      push({ chartType: 'map', geo: match.set.id, title: `${humanize(col)} por ${humanize(keyCol)} (mapa)`, valueLabel: col, series: [{ name: col, data }] })
      maps++
    }
  }

  return out.slice(0, MAX_ANALYSIS_CANDIDATES)
}

function sheetToRows(ws: Json) {
  const rows = XLSX.utils.sheet_to_json<Json>(ws, { defval: null, raw: true })
  return rows.slice(0, MAX_ROWS_SCANNED)
}

function analyzeWorkbook(wb: Json) {
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

export function analyzeSpreadsheet(filename: Json, buffer: Json) {
  const e = ext(filename)
  const wb =
    e === 'csv'
      ? XLSX.read(buffer.toString('utf-8'), { type: 'string', raw: true })
      : XLSX.read(buffer, { type: 'buffer' })
  return analyzeWorkbook(wb)
}

export function isSpreadsheet(filename: Json) {
  return ['xlsx', 'xls', 'csv'].includes(ext(filename))
}

// Same deterministic candidate-building heuristic as analyzeSpreadsheet, but
// for tabular data that didn't come from an uploaded file — e.g. rows a
// Genie Space query returned mid-conversation. `rows` is an array of plain
// objects keyed by column name; ids are local (`c1`, `c2`, ...) and must be
// re-numbered by the caller into the shared `candidate_N` namespace.
export function chartCandidatesFromRows(sourceLabel: Json, rows: Json) {
  if (!rows?.length) return []
  const headers = Object.keys(rows[0])
  const columns = headers.map((h) => summarizeColumn(h, rows.map((r: Json) => r[h])))
  return buildChartCandidates(sourceLabel, headers, rows, columns)
}

// Compact, LLM-facing description of chart candidates: enough to pick/narrate,
// never the raw data points a model could copy verbatim into hallucinated text.
export function describeCandidates(candidates: Json) {
  return candidates.map(describeCandidate).join('\n')
}

function describeCandidate(c: Json) {
  const head = `- ${c.id} (${c.chartType}): "${c.title}" — `
  if (c.chartType === 'scatter') {
    const n = c.series.reduce((a: Json, s: Json) => a + s.data.length, 0)
    return head + `${n} pontos (x=${c.xLabel}, y=${c.yLabel}), grupos: ${c.series.map((s: Json) => s.name).join(', ')}`
  }
  if (c.chartType === 'pivot' || c.chartType === 'heatmap') {
    const rows = c.series[0]?.data.length ?? 0
    return head + `${rows} linhas × ${c.series.length} colunas (${c.rowLabel} × ${c.colLabel}, soma de ${c.valueLabel})`
  }
  if (c.chartType === 'histogram') {
    return head + `${c.series[0]?.data.length ?? 0} faixas de ${c.valueLabel}`
  }
  if (c.chartType === 'map') {
    return head + `${c.series[0]?.data.length ?? 0} regiões (conjunto ${c.geo}), medida: ${c.valueLabel}`
  }
  return (
    head +
    `${c.series[0]?.data.length ?? 0} categorias, ` +
    `top: ${c.series[0]?.data.slice(0, 3).map((d: Json) => `${d.label}=${d.value}`).join(', ')}`
  )
}
