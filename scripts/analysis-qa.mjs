#!/usr/bin/env node
// Analysis QA (W2-9) — the golden net for pivot / heatmap / scatter / histogram.
//
//   node scripts/analysis-qa.mjs            # check against the golden
//   node scripts/analysis-qa.mjs --update   # rewrite the golden (review the diff!)
//
// 1. analyzeSpreadsheet over scripts/fixtures/analysis-sales.golden.csv, and
//    over the same rows written as .xlsx: same candidates either way, every
//    new kind present, ids candidate_1..N, identical across runs, and equal to
//    scripts/fixtures/analysis-candidates.golden.json (titles, metadata and a
//    per-series point count + checksum, so a silent change of a number trips).
// 2. Every candidate resolves as a chart block by ref (Mode 1) AND the same
//    series given inline (Mode 2) round-trips unchanged; a histogram given raw
//    values is binned exactly like the candidate.
// 3. The chart renderers carry no raw colour literal (token palette only) and
//    the repo ships no geodata.
// 4. A workbook with the new native kinds (scatter, histogram, heatmap) renders
//    via renderXlsx, re-opens with ExcelJS, and its injected chart parts are
//    well-formed, of the right OOXML type and point at real cells; the heatmap
//    is a colour-scale conditional format over the value cells.
// Headless and CI-fast.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { analyzeSpreadsheet, chartCandidatesFromRows } from '../server/analysis.ts'
import { extractPrismBlocks, sanitizeSpreadsheet } from '../server/blocks.ts'
import { renderXlsx } from '../server/xlsx-export.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CSV_PATH = join(HERE, 'fixtures', 'analysis-sales.golden.csv')
const GOLDEN_PATH = join(HERE, 'fixtures', 'analysis-candidates.golden.json')
const NEW_KINDS = ['pivot', 'heatmap', 'scatter', 'histogram']
const UPDATE = process.argv.includes('--update')

let failures = 0
const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  failures++
}
const ok = (msg) => console.log(`ok  : ${msg}`)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const round = (n) => Math.round(n * 1000) / 1000
function summarize(c) {
  const meta = {}
  for (const k of ['xLabel', 'yLabel', 'rowLabel', 'colLabel', 'valueLabel']) if (c[k]) meta[k] = c[k]
  return {
    id: c.id,
    chartType: c.chartType,
    title: c.title,
    ...meta,
    series: c.series.map((s) => ({
      name: s.name,
      points: s.data.length,
      checksum: round(s.data.reduce((a, d) => a + (c.chartType === 'scatter' ? d.x * 2 + d.y : d.value ?? 0), 0)),
      labels: c.chartType === 'scatter' ? undefined : s.data.map((d) => d.label),
    })),
  }
}

// ---- 1. candidates --------------------------------------------------------
function candidates() {
  const csv = readFileSync(CSV_PATH)
  const a = analyzeSpreadsheet('vendas.csv', csv).chartCandidates
  const b = analyzeSpreadsheet('vendas.csv', csv).chartCandidates
  if (same(a, b)) ok(`determinístico: ${a.length} candidatos idênticos em duas execuções`)
  else fail('analyzeSpreadsheet não é determinístico')

  a.forEach((c, i) => c.id !== `candidate_${i + 1}` && fail(`id fora de ordem: ${c.id} na posição ${i + 1}`))
  if (new Set(a.map((c) => c.id)).size === a.length) ok('ids únicos e sequenciais candidate_1..N')

  for (const k of NEW_KINDS) {
    const n = a.filter((c) => c.chartType === k).length
    if (n) ok(`${k}: ${n} candidato(s)`)
    else fail(`nenhum candidato ${k}`)
  }
  if (a.every((c) => c.chartType !== 'map')) ok('nenhum candidato geográfico')
  else fail('candidato de mapa emitido')

  // the same rows as a real .xlsx: same analysis
  const rows = XLSX.utils.sheet_to_json(XLSX.read(csv.toString('utf8'), { type: 'string', raw: true }).Sheets.Sheet1, { defval: null, raw: true })
  const typed = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : v])))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(typed), 'Vendas')
  const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const x = analyzeSpreadsheet('vendas.xlsx', xlsxBuf).chartCandidates
  if (same(x.map(summarize), a.map(summarize))) ok('.xlsx e .csv com as mesmas linhas geram os mesmos candidatos')
  else fail('.xlsx e .csv divergem')

  // Genie path: same kinds, local ids
  const g = chartCandidatesFromRows('Genie One', typed)
  if (NEW_KINDS.every((k) => g.some((c) => c.chartType === k)) && g.every((c, i) => c.id === `c${i + 1}`)) ok('chartCandidatesFromRows: novos tipos com ids locais c1..N')
  else fail('chartCandidatesFromRows sem os novos tipos ou ids fora de ordem')

  const summary = a.map(summarize)
  if (UPDATE || !existsSync(GOLDEN_PATH)) {
    writeFileSync(GOLDEN_PATH, JSON.stringify(summary, null, 2) + '\n')
    ok(`golden ${UPDATE ? 'reescrito' : 'criado'}: ${GOLDEN_PATH}`)
  } else {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'))
    if (same(golden, summary)) ok('candidatos iguais ao golden')
    else {
      for (let i = 0; i < Math.max(golden.length, summary.length); i++)
        if (!same(golden[i], summary[i])) fail(`golden difere em ${golden[i]?.id || summary[i]?.id}: ${JSON.stringify(summary[i])?.slice(0, 200)}`)
    }
  }
  return a
}

// ---- 2. chart blocks ------------------------------------------------------
function blocks(cands) {
  const fence = (o) => '```prism-block\n' + JSON.stringify(o) + '\n```'
  for (const c of cands.filter((x) => NEW_KINDS.includes(x.chartType))) {
    const [byRef] = extractPrismBlocks(fence({ type: 'chart', ref: c.id }), cands).blocks
    if (!byRef || byRef.chartType !== c.chartType || !same(byRef.series, c.series)) fail(`${c.id} (${c.chartType}): Modo 1 não resolve`)
    const { id: _id, ...inline } = c
    const [byInline] = extractPrismBlocks(fence({ type: 'chart', ...inline }), []).blocks
    if (!byInline || !same(byInline.series, c.series)) fail(`${c.id} (${c.chartType}): Modo 2 não faz round-trip`)
    for (const k of ['xLabel', 'yLabel', 'rowLabel', 'colLabel', 'valueLabel'])
      if (c[k] && (byRef?.[k] !== c[k] || byInline?.[k] !== c[k])) fail(`${c.id}: ${k} perdido`)
  }
  ok('Modo 1 (ref) e Modo 2 (em linha) resolvem para todos os candidatos novos')

  const hist = cands.find((c) => c.chartType === 'histogram')
  const csvRows = readFileSync(CSV_PATH, 'utf8').trim().split('\n')
  const header = csvRows[0].split(',')
  const col = header.indexOf(hist.valueLabel)
  const values = csvRows.slice(1).map((l) => Number(l.split(',')[col]))
  const [raw] = extractPrismBlocks(fence({ type: 'chart', chartType: 'histogram', series: [{ name: hist.series[0].name, values }] }), []).blocks
  if (raw && same(raw.series, hist.series)) ok('histograma com valores brutos em linha = faixas do candidato')
  else fail('histograma em linha diverge do candidato')
}

// ---- 3. tokens only, no geodata -----------------------------------------
function tokensAndGeo() {
  const files = ['client/src/components/blocks/ChartBlock.jsx', 'client/src/components/blocks/PivotBlock.jsx']
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8').replace(/\/\/.*$/gm, '')
    const hex = src.match(/#[0-9a-fA-F]{3,8}\b/g) || []
    const rgb = src.match(/\brgba?\(\s*\d/g) || []
    if (hex.length || rgb.length) fail(`${f}: cor literal ${[...hex, ...rgb].join(', ')}`)
    else ok(`${f}: só tokens (nenhum hex/rgb literal)`)
  }
  if (existsSync(join(ROOT, 'client/public/geo'))) fail('client/public/geo existe (geodata fora do escopo)')
  else ok('nenhum geodata no repositório')
}

// ---- 4. xlsx --------------------------------------------------------------
// same rough well-formedness check as spreadsheet-qa (no XML parser dependency)
function wellFormed(label, xml) {
  if (!/^<\?xml|^</.test(xml.trim())) return fail(`${label}: não começa como XML`)
  const opens = (xml.match(/<[a-zA-Z]/g) || []).length
  const closes = (xml.match(/<\/[a-zA-Z]/g) || []).length
  const selfClose = (xml.match(/\/>/g) || []).length
  if (opens - selfClose !== closes) return fail(`${label}: tags desbalanceadas`)
  ok(`${label}: XML bem-formado`)
}

async function xlsx(cands) {
  const pivot = cands.find((c) => c.chartType === 'pivot')
  const hist = cands.find((c) => c.chartType === 'histogram')
  const scatter = cands.find((c) => c.chartType === 'scatter')
  const pts = scatter.series.flatMap((s) => s.data)
  const spec = sanitizeSpreadsheet({
    title: 'Análise',
    sheets: [
      {
        name: 'Pivot',
        blocks: [
          {
            kind: 'table',
            columns: [{ header: pivot.rowLabel }, ...pivot.series.map((s) => ({ header: s.name, format: 'number' }))],
            rows: pivot.series[0].data.map((d, r) => [d.label, ...pivot.series.map((s) => s.data[r].value)]),
          },
        ],
        charts: [{ kind: 'heatmap', title: pivot.title, tableBlock: 0, categoryColumn: 0, valueColumns: pivot.series.map((_, i) => i + 1) }],
      },
      {
        name: 'Distribuição',
        blocks: [{ kind: 'table', columns: [{ header: 'Faixa' }, { header: 'Contagem' }], rows: hist.series[0].data.map((d) => [d.label, d.value]) }],
        charts: [{ kind: 'histogram', title: hist.title, tableBlock: 0, categoryColumn: 0, valueColumns: [1] }],
      },
      {
        name: 'Dispersão',
        blocks: [{ kind: 'table', columns: [{ header: scatter.xLabel }, { header: scatter.yLabel }], rows: pts.map((p) => [p.x, p.y]) }],
        charts: [{ kind: 'scatter', title: scatter.title, tableBlock: 0, categoryColumn: 0, valueColumns: [1] }],
      },
    ],
  })
  if (!spec) return fail('sanitizeSpreadsheet devolveu null')
  const kinds = spec.sheets.map((s) => s.charts?.[0]?.kind)
  if (same(kinds, ['heatmap', 'histogram', 'scatter'])) ok('sanitizeSpreadsheet mantém heatmap/histogram/scatter')
  else fail(`tipos de gráfico após sanitize: ${kinds}`)

  const buf = await renderXlsx(spec, { primaryColor: '#1B3139', secondaryColor: '#2272B4', accentColor: '#FF3621', backgroundColor: '#FFFFFF' })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  ok(`reabre com ExcelJS: ${wb.worksheets.length} abas`)

  const zip = await JSZip.loadAsync(buf)
  const chartFiles = Object.keys(zip.files).filter((f) => /^xl\/charts\/chart\d+\.xml$/.test(f)).sort()
  if (chartFiles.length === 2) ok('2 partes de gráfico injetadas (histograma + dispersão; o heatmap é formatação condicional)')
  else fail(`esperadas 2 partes de gráfico, há ${chartFiles.length}`)
  const rawXmls = await Promise.all(chartFiles.map((f) => zip.file(f).async('string')))
  rawXmls.forEach((x, i) => wellFormed(chartFiles[i], x))
  // formulas are XML-escaped ('Sheet' → &apos;Sheet&apos;); match on the decoded text
  const xmls = rawXmls.map((x) => x.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
  const histXml = xmls.find((x) => x.includes('<c:barChart>'))
  if (histXml && histXml.includes('<c:gapWidth val="0"/>')) ok('histograma: barras contíguas (gapWidth 0)')
  else fail('histograma sem barChart/gapWidth 0')
  if (histXml && histXml.includes(`'Distribuição'!$A$`) && histXml.includes(`'Distribuição'!$B$`)) ok('histograma ligado às células da tabela de faixas')
  else fail('histograma não referencia as células da tabela')
  const scXml = xmls.find((x) => x.includes('<c:scatterChart>'))
  if (scXml && /<c:xVal><c:numRef><c:f>'Dispersão'!\$A\$\d+:\$A\$\d+<\/c:f>/.test(scXml) && /<c:yVal><c:numRef><c:f>'Dispersão'!\$B\$/.test(scXml))
    ok('dispersão: scatterChart com xVal/yVal nas colunas reais')
  else fail('dispersão sem scatterChart/xVal/yVal corretos')
  if (scXml && (scXml.match(/<c:valAx>/g) || []).length === 2) ok('dispersão: dois eixos de valor')
  else fail('dispersão sem dois valAx')

  const sheetFiles = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
  const sheetXmls = await Promise.all(sheetFiles.map((f) => zip.file(f).async('string')))
  const heat = sheetXmls.find((x) => x.includes('<colorScale>'))
  const lastRow = 1 + pivot.series[0].data.length
  const lastCol = String.fromCharCode(65 + pivot.series.length)
  if (heat && new RegExp(`sqref="B\\d+:B${lastRow}[^"]*${lastCol}\\d+:${lastCol}${lastRow}"`).test(heat)) ok(`heatmap: escala de cor sobre B..${lastCol} até a linha ${lastRow}`)
  else fail('heatmap sem colorScale sobre as células de valor')
}

async function main() {
  const cands = candidates()
  blocks(cands)
  tokensAndGeo()
  await xlsx(cands)
  if (failures) {
    console.error(`\nanalysis-qa: ${failures} falha(s)`)
    process.exit(1)
  }
  console.log('\nanalysis-qa: OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
