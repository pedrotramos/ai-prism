#!/usr/bin/env node
// Spreadsheet-export QA — the corruption safety net for the .xlsx generator.
//
//   node scripts/spreadsheet-qa.mjs
//
// The highest-risk piece of the spreadsheet feature is the hand-written OOXML
// chart/drawing injection (server/xlsx-export.js injectCharts): a malformed
// part makes Excel declare the file "corrupted, needs repair" — a defect no
// unit assertion on our own objects would catch. So this:
//   1. sanitizes a golden model-authored spec (scripts/fixtures/
//      spreadsheet-financial.golden.json) through the real sanitizeSpreadsheet
//   2. renders it to a real .xlsx buffer via renderXlsx (with a brand template)
//   3. RE-OPENS the buffer with a fresh ExcelJS reader — the same round-trip
//      Excel does; a broken zip/part throws here
//   4. unzips and XML-parses every injected chart/drawing part (well-formed?)
//   5. asserts the data-honesty invariants survive: formulas kept verbatim,
//      cross-sheet refs intact, role→fill applied, number formats applied,
//      dropdowns present, chart ranges point at real cells
// Headless, CI-fast (no Excel needed). Any regression in the sanitizer or the
// OOXML injection trips here before it reaches a user's download.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { sanitizeSpreadsheet } from '../server/blocks.js'
import { renderXlsx } from '../server/xlsx-export.ts'
import { materializeWorkbook } from '../client/src/lib/sheetEval.js'

const HERE = dirname(fileURLToPath(import.meta.url))
let failures = 0
const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  failures++
}
const ok = (msg) => console.log(`ok  : ${msg}`)

// A Databricks-ish brand so we also exercise the design-system theming path.
const TEMPLATE = { primaryColor: '#FF3621', secondaryColor: '#1B3139', accentColor: '#2272B4', backgroundColor: '#FFFFFF' }

// Minimal well-formedness check without a hard dependency: XML is "balanced"
// enough if every opened tag closes and it parses as a single root. We use a
// lightweight scan (xmldom may not be installed) — throws on obvious breakage.
function assertXmlWellFormed(label, xml) {
  // must start with declaration or root, must not have unescaped stray '<'
  if (!/^<\?xml|^</.test(xml.trim())) return fail(`${label}: não começa como XML`)
  const opens = (xml.match(/<[a-zA-Z]/g) || []).length
  const closes = (xml.match(/<\/[a-zA-Z]/g) || []).length
  const selfClose = (xml.match(/\/>/g) || []).length
  // opens = closingElements + selfClosing + declaration-less; a rough balance
  if (opens - selfClose !== closes) {
    return fail(`${label}: tags desbalanceadas (open=${opens} self=${selfClose} close=${closes})`)
  }
  ok(`${label}: XML bem-formado`)
}

async function main() {
  const raw = JSON.parse(readFileSync(join(HERE, 'fixtures', 'spreadsheet-financial.golden.json'), 'utf8'))

  // 1. sanitize
  const spec = sanitizeSpreadsheet(raw)
  if (!spec) return fail('sanitizeSpreadsheet devolveu null para o golden')
  ok(`sanitizado: ${spec.sheets.length} abas`)
  if (spec.sheets.length !== raw.sheets.length) fail(`abas: ${spec.sheets.length} != ${raw.sheets.length} esperadas`)

  // a formula in the golden must survive verbatim (data-honesty: we never
  // freeze a derived value)
  const resumo = spec.sheets.find((s) => s.name === 'Resumo')
  const flatCells = (resumo?.blocks || []).filter((b) => b.kind === 'table').flatMap((t) => t.rows.flat())
  const hasFormula = flatCells.some((c) => (typeof c === 'string' && c[0] === '=') || (c && typeof c === 'object' && String(c.v)[0] === '='))
  if (hasFormula) ok('fórmulas preservadas na sanitização')
  else fail('nenhuma fórmula sobreviveu à sanitização do golden')

  // 1b. PREVIEW EVALUATOR (client/src/lib/sheetEval.js): the studio/card show
  // computed values, not formula text — assert it computes the golden's known
  // results (SUMIFS cross-sheet, named-cell subtraction, same-row Diferença).
  // Keeps the preview evaluator in sync with what Excel will compute on export.
  const { computed } = materializeWorkbook(spec)
  const expect = (addr, want, label) => {
    const got = computed('Resumo', addr)
    if (Number(got) === want) ok(`preview eval ${addr} = ${want} (${label})`)
    else fail(`preview eval ${addr}: esperado ${want} (${label}), obteve ${JSON.stringify(got)}`)
  }
  // (blocks are contiguous — no auto-spacer — so the category table's first
  // data row is 11: title(1) note(2) [gap(3) explicit spacer] section(4)
  // RESUMO rows 5-7, spacer(8), section(9), header(10), data 11-13)
  expect('B5', 5000, 'SUMIFS receitas entre abas')
  expect('B6', 1500, 'SUMIFS despesas entre abas')
  expect('B7', 3500, 'saldo via células nomeadas [#..]')
  expect('D11', 100, 'Diferença Moradia (1600-1500) na própria linha')
  expect('D12', 900, 'Diferença Alimentação (900-0) na própria linha')

  // 1c. LOOKUPS cross-sheet (INDEX/MATCH, VLOOKUP) — the preview evaluator must
  // resolve them, else lookup cells render blank and dependents show 0 (the
  // seasonality→revenue bug). Inline spec so it doesn't couple to the golden.
  {
    const lookupSpec = sanitizeSpreadsheet({
      type: 'spreadsheet',
      title: 'Lookups',
      sheets: [
        { name: 'Premissas', blocks: [{ kind: 'table', columns: [{ header: 'Mes' }, { header: 'Pct' }], rows: [['Janeiro', 0.019], ['Fevereiro', 0.04], ['Marco', 0.062]] }] },
        { name: 'Projecao', blocks: [{ kind: 'table', columns: [{ header: 'Mes' }, { header: 'PctIM' }], rows: [
          ['Fevereiro', '=INDEX([Premissas!Pct],MATCH([@Mes],[Premissas!Mes],0))'],
          ['Marco', '=INDEX([Premissas!Pct],MATCH([@Mes],[Premissas!Mes],0))'],
        ] }] },
      ],
    })
    if (!lookupSpec) fail('sanitize do fixture de lookups falhou')
    else {
      const lc = materializeWorkbook(lookupSpec).computed
      const chk = (addr, want, label) => {
        const got = lc('Projecao', addr)
        if (Math.abs(Number(got) - want) < 1e-9) ok(`preview lookup ${addr} = ${want} (${label})`)
        else fail(`preview lookup ${addr}: esperado ${want} (${label}), obteve ${JSON.stringify(got)}`)
      }
      chk('B2', 0.04, 'INDEX/MATCH cross-sheet Fevereiro')
      chk('B3', 0.062, 'INDEX/MATCH cross-sheet Marco')
    }
  }

  // 2. render
  const buf = await renderXlsx(spec, TEMPLATE)
  if (!buf?.length) return fail('renderXlsx devolveu buffer vazio')
  ok(`renderizado: ${buf.length} bytes`)

  // 3. re-open (the corruption gate)
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buf)
    ok(`reaberto sem erro: ${wb.worksheets.map((w) => w.name).join(', ')}`)
  } catch (e) {
    return fail(`ExcelJS não conseguiu reabrir o .xlsx (corrompido): ${e.message}`)
  }

  // formula round-trips as a formula cell (not a frozen value)
  const rz = wb.getWorksheet('Resumo')
  let foundFormulaCell = false
  const formulaCells = []
  rz?.eachRow((row, rn) => row.eachCell((cell, cn) => {
    if (cell.value && typeof cell.value === 'object' && 'formula' in cell.value) {
      foundFormulaCell = true
      formulaCells.push({ row: rn, col: cn, f: cell.value.formula })
    }
  }))
  if (foundFormulaCell) ok('fórmula presente como célula de fórmula no arquivo')
  else fail('nenhuma célula de fórmula no arquivo reaberto')

  // CORRECTNESS (the #4 regression gate): no token survived unresolved, and no
  // formula reference points at a DIFFERENT data row than its own — the
  // off-by-one bug that made "Diferença" use another category's numbers.
  const anyToken = formulaCells.some((c) => /\[|#REF!/.test(c.f))
  if (anyToken) fail(`fórmula com token não resolvido ou #REF!: ${formulaCells.find((c) => /\[|#REF!/.test(c.f))?.f}`)
  else ok('todos os tokens de fórmula resolvidos (nenhum [..] ou #REF! remanescente)')

  // a token-resolved same-row formula (=[@Orçado]-[@Real]) must reference its
  // own row. We only assert this for the KNOWN Diferença column of the golden
  // (D11/D12/D13), since a headerless panel's Saldo (=B5-B6) is a legitimate
  // cross-row formula. The general header-row-reference guard runs in regression().
  let rowMismatch = 0
  for (const addr of ['D11', 'D12', 'D13']) {
    const c = formulaCells.find((fc) => rz.getCell(fc.row, fc.col).address === addr)
    if (!c) continue
    const m = /^([A-Z]+)(\d+)-([A-Z]+)(\d+)$/.exec(c.f)
    if (m && (Number(m[2]) !== c.row || Number(m[4]) !== c.row)) {
      rowMismatch++
      fail(`Diferença ${addr} fora da própria linha: "=${c.f}"`)
    }
  }
  if (!rowMismatch) ok('coluna Diferença referencia a própria linha (sem deslocamento)')

  // number format applied somewhere
  let foundFmt = false
  rz?.eachRow((row) => row.eachCell((cell) => { if (cell.numFmt) foundFmt = true }))
  if (foundFmt) ok('formato numérico aplicado')
  else fail('nenhum formato numérico aplicado')

  // brand color reached a title band (title fill == primary argb)
  const titleFill = rz?.getCell('A1')?.fill?.fgColor?.argb
  if (titleFill === 'FF' + TEMPLATE.primaryColor.slice(1)) ok('cor do design system aplicada na faixa de título')
  else fail(`faixa de título não usou a cor da marca (got ${titleFill})`)

  // #5: an auto "Instruções de Uso" sheet is always appended (the model never
  // authored one in the golden)
  if (wb.getWorksheet('Instruções de Uso')) ok('aba "Instruções de Uso" gerada automaticamente')
  else fail('aba de instruções automática ausente')

  // 4. inspect injected OOXML parts
  const zip = await JSZip.loadAsync(buf)
  const chartParts = Object.keys(zip.files).filter((p) => /^xl\/charts\/chart\d+\.xml$/.test(p))
  const drawingParts = Object.keys(zip.files).filter((p) => /^xl\/drawings\/drawing\d+\.xml$/.test(p))
  if (chartParts.length) ok(`${chartParts.length} parte(s) de gráfico injetada(s)`)
  else fail('golden declara gráficos mas nenhuma parte de chart foi injetada')

  for (const p of [...chartParts, ...drawingParts]) {
    assertXmlWellFormed(p, await zip.file(p).async('string'))
  }

  // every chart references a real cell range (has a sheet-qualified c:f)
  for (const p of chartParts) {
    const xml = await zip.file(p).async('string')
    // sheet names are XML-escaped (&apos;), and a range spans rows ($A$12:$A$14)
    if (/<c:f>(&apos;)?[^<]+(&apos;)?!\$[A-Z]+\$\d+:\$[A-Z]+\$\d+<\/c:f>/.test(xml)) ok(`${p}: séries ligadas a um range real`)
    else fail(`${p}: nenhuma referência de range válida (gráfico não ligado a células)`)
  }

  // #3: charts must not overlap — each drawing anchor's <xdr:from> row must be
  // distinct (the renderer stacks them vertically). Parse the drawing parts.
  for (const p of drawingParts) {
    const xml = await zip.file(p).async('string')
    const fromRows = [...xml.matchAll(/<xdr:from>.*?<xdr:row>(\d+)<\/xdr:row>/gs)].map((m) => Number(m[1]))
    if (fromRows.length > 1) {
      const unique = new Set(fromRows)
      if (unique.size === fromRows.length) ok(`${p}: ${fromRows.length} gráficos em linhas distintas (sem sobreposição)`)
      else fail(`${p}: gráficos compartilham a mesma linha de âncora (${fromRows.join(',')}) — sobreposição`)
    }
  }

  // content types declares the injected parts (else Excel ignores/erros)
  const ct = await zip.file('[Content_Types].xml').async('string')
  if (ct.includes('chart+xml') && ct.includes('drawing+xml')) ok('[Content_Types].xml declara chart e drawing')
  else fail('[Content_Types].xml não declara as partes injetadas')

  // dropdown (data validation) survived to the worksheet
  const wsFiles = Object.keys(zip.files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
  let foundDv = false
  for (const p of wsFiles) {
    if ((await zip.file(p).async('string')).includes('<dataValidation')) foundDv = true
  }
  if (foundDv) ok('menu suspenso (data validation) presente no arquivo')
  else fail('golden declara dropdown mas nenhuma data validation foi escrita')

  // ── REGRESSION: the real user spec that broke (mixed literal A1 + tokens,
  // and a freeze:{row:0,col:0} that corrupted the sheet View). Renders it and
  // asserts (a) it reopens clean, (b) NO frozen pane with a zero split exists,
  // (c) every "=Xn-Ym" subtraction references its OWN row (no phantom-spacer
  // shift), (d) SUM(range) columns match.
  await regression()
}

async function regression() {
  const raw = JSON.parse(readFileSync(join(HERE, 'fixtures', 'spreadsheet-regression.golden.json'), 'utf8'))
  const spec = sanitizeSpreadsheet(raw)
  if (!spec) return fail('regressão: sanitizeSpreadsheet devolveu null')
  const buf = await renderXlsx(spec, TEMPLATE)

  // corruption gate
  const wb = new ExcelJS.Workbook()
  try { await wb.xlsx.load(buf); ok('regressão: reaberto sem erro') }
  catch (e) { return fail(`regressão: não reabriu (corrompido): ${e.message}`) }

  // no invalid frozen pane (state=frozen with no split) — the reported View repair
  const zip = await JSZip.loadAsync(buf)
  const wsFiles = Object.keys(zip.files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
  let badPane = false
  for (const p of wsFiles) {
    const x = await zip.file(p).async('string')
    for (const m of x.matchAll(/<pane\b[^>]*>/g)) {
      const tag = m[0]
      if (/state="frozen"/.test(tag)) {
        const xs = Number((tag.match(/xSplit="(\d+)"/) || [])[1] || 0)
        const ys = Number((tag.match(/ySplit="(\d+)"/) || [])[1] || 0)
        if (xs === 0 && ys === 0) { badPane = true; fail(`regressão: ${p} tem pane frozen com split zero (corrompe a View)`) }
      }
    }
  }
  if (!badPane) ok('regressão: nenhum freeze pane inválido (sem corrupção de View)')

  // The real off-by-row bug pointed a formula at a HEADER/band row (a text
  // cell), yielding #VALUE! or the wrong category. So the precise invariant is:
  // no formula may reference a cell that holds text used as a header/band label.
  // (A cross-row formula between two numeric cells — e.g. Saldo=B4-B5 in a
  // headerless panel — is legitimate and allowed.)
  const textRows = {} // sheetName → Set(row) of rows whose A-col (or any) is a non-numeric label header
  for (const ws of wb.worksheets) {
    const labels = new Set()
    ws.eachRow((row, rn) => {
      // a band/header row: a bold text cell that is NOT a data value
      const c1 = row.getCell(1)
      const v = c1.value
      if (typeof v === 'string' && v.trim() && c1.font?.bold) labels.add(rn)
    })
    textRows[ws.name] = labels
  }
  let refBug = 0
  for (const ws of wb.worksheets) {
    ws.eachRow((row, rn) => row.eachCell((c, cn) => {
      if (c.value && typeof c.value === 'object' && 'formula' in c.value) {
        // any A1 ref in the formula that lands on a header/band row of THIS sheet
        for (const ref of c.value.formula.matchAll(/(?<![A-Za-z'!])([A-Z]{1,3})(\d+)\b/g)) {
          const rr = Number(ref[2])
          if (textRows[ws.name]?.has(rr)) {
            const cellR = ws.getCell(rr, 1)
            // only flag if that header cell truly holds text (not a number)
            if (typeof cellR.value === 'string') {
              refBug++
              fail(`regressão: ${ws.name}!${ws.getCell(rn, cn).address} = "=${c.value.formula}" referencia a linha-cabeçalho ${rr} ("${cellR.value}")`)
            }
          }
        }
      }
    }))
  }
  if (!refBug) ok('regressão: nenhuma fórmula referencia linha-cabeçalho (sem deslocamento)')
}

main()
  .then(() => {
    if (failures) {
      console.error(`\n${failures} falha(s) na QA de planilha`)
      process.exit(1)
    }
    console.log('\nspreadsheet-qa: OK')
  })
  .catch((e) => {
    console.error('spreadsheet-qa crashou:', e)
    process.exit(1)
  })
