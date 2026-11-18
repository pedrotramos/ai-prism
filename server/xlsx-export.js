// Renders a sanitized `spreadsheet` spec (see sanitizeSpreadsheet in blocks.js)
// into a real .xlsx buffer. ExcelJS writes the data/formulas/formatting/styles
// rock-solid, but it does NOT emit native Excel charts (no addChart in v4). So
// when a sheet declares charts we post-process the .xlsx zip (it's OOXML) and
// inject the chart/drawing parts by hand, wired to the actual cell ranges — the
// result is a genuine, editable, live-linked Excel chart, not a picture.
//
// A sheet is an ordered list of BLOCKS (title/note/section/table/spacer) so one
// tab can stack several tables under labelled bands — matching the reference
// (a "Resumo" tab with RESUMO GERAL + DESPESAS POR CATEGORIA + RECEITAS...).
//
// FORMULAS ARE REFERENCED BY NAME, NEVER BY ABSOLUTE A1. The model has no way
// to know which grid row a table lands on (titles/notes/sections/spacers shift
// everything), so hand-authored "=B14-C14" was chronically off-by-a-row and
// produced silently-wrong numbers. Instead the model writes position-free
// tokens — [@Coluna] (same-row sibling), [#nome] (a named cell), [Aba!Coluna]
// (a whole data column) — and THIS module resolves them to the exact A1 refs
// after it knows where every block actually landed. See resolveFormulaTokens.
//
// Cell colouring is driven by a fixed role→style legend (input/key/formula/
// link) resolved from the selected design system — never painted cell-by-cell
// by the model, exactly like the deck theme tokens. Numbers are model/user-
// authored (SPREADSHEET_POLICY governs honesty); this only lays out + resolves.
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { resolveDeckTheme, blend, contrastOn } from '../shared/deckTheme.js'
import { resolveFormula, colKey } from '../shared/sheetModel.js'

// #RRGGBB → FFRRGGBB (Excel argb). Falls back to a neutral if malformed.
function argb(hex, fallback = 'FF000000') {
  if (typeof hex !== 'string') return fallback
  const h = hex.replace('#', '')
  return /^[0-9a-fA-F]{6}$/.test(h) ? 'FF' + h.toUpperCase() : fallback
}

// Derive the whole spreadsheet color system from the selected design system
// (same template that themes the decks), so a workbook "wears" the brand:
// title/section bands from primary/secondary, table header from accent, and
// the input/key/formula legend as soft tints of the brand colors. No template
// → sensible navy/blue defaults. Cell colouring is ALWAYS role-driven and
// resolved here — never painted cell-by-cell by the model (mirrors deck tokens).
function resolveSheetTheme(template) {
  const th = resolveDeckTheme(template)
  const chartHex = [th.accent, th.secondary, th.primary, '#FF6A00', '#7C6FF0', '#98A2B3']
  return {
    titleFill: argb(th.primary),
    titleFont: argb(th.onPrimary),
    sectionFill: argb(blend(th.secondary, th.primary, 0.15)),
    sectionFont: argb(contrastOn(blend(th.secondary, th.primary, 0.15))),
    headerFill: argb(th.accent),
    headerFont: argb(th.onAccent),
    // legend tints: soft washes of brand colors over white so text stays dark
    roleStyles: {
      input: { fill: argb(blend(th.secondary, '#FFFFFF', 0.82)), fontColor: 'FF1A1A1A' },
      key: { fill: argb(blend(th.accent, '#FFFFFF', 0.82)), fontColor: 'FF1A1A1A' },
      formula: { fill: argb(blend(th.primary, '#FFFFFF', 0.9)), fontColor: 'FF1A1A1A' },
      link: { fill: null, fontColor: argb(th.accent) },
      normal: { fill: null, fontColor: 'FF1A1A1A' },
    },
    // human-readable meaning of each role, for the auto Instructions sheet
    roleMeaning: {
      input: 'Célula de ENTRADA — digite seus dados aqui.',
      key: 'Campo-chave / premissa — preencha; os cálculos dependem dele.',
      formula: 'Célula CALCULADA — não edite; recalcula automaticamente.',
      link: 'Referência a outra aba.',
    },
    // hex (no '#') for the OOXML chart series fills, matching the preview
    chartColors: chartHex.map((h) => argb(h).slice(2)),
    // heatmap colour scale (a native conditional format, not a chart): a soft
    // wash of the brand accent up to the accent itself, like the role tints
    heatLow: argb(blend(th.accent, '#FFFFFF', 0.9)),
    heatHigh: argb(th.accent),
  }
}

// Named number-format presets → Excel numFmt codes. Currency/number/percent
// carry a red-negative variant (matches the reference's -R$ 500,00 in red).
const NUM_FORMATS = {
  text: '@',
  number: '#,##0.00;[Red]-#,##0.00',
  integer: '#,##0;[Red]-#,##0',
  currency: '"R$"\\ #,##0.00;[Red]-"R$"\\ #,##0.00',
  usd: '"$"#,##0.00;[Red]-"$"#,##0.00',
  eur: '"€"\\ #,##0.00;[Red]-"€"\\ #,##0.00',
  percent: '0.0%;[Red]-0.0%',
  percent0: '0%;[Red]-0%',
  date: 'yyyy-mm-dd',
  datetime: 'yyyy-mm-dd hh:mm',
}

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// 0-based column index → spreadsheet column letters (0→A, 26→AA).
function colLetter(idx) {
  let s = ''
  let n = idx
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

function fmtCode(fmt) {
  if (!fmt) return null
  if (NUM_FORMATS[fmt]) return NUM_FORMATS[fmt]
  if (/[#0%@]/.test(fmt) || /[ymdhs]/.test(fmt)) return fmt // raw Excel code
  return null
}

function isFormula(v) {
  return typeof v === 'string' && v.length > 1 && v[0] === '='
}

function isDateFmt(fmt) {
  const code = fmtCode(fmt) || ''
  return /[ymd]/i.test(code) && !/[#0]/.test(code)
}

// A row cell is a scalar, a "=formula" string, or {v, role, format, name} override.
function cellParts(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { value: raw.v, role: raw.role, format: raw.format, name: raw.name }
  }
  return { value: raw, role: undefined, format: undefined, name: undefined }
}

const norm = (s) => String(s ?? '').trim().toLowerCase()
const qSheet = (name) => `'${String(name).replace(/'/g, "''")}'`

// Formula token resolution lives in ../shared/sheetModel.js (resolveFormula) so
// the server export and the client preview NEVER diverge on where a cell lands
// or how a token resolves — a past divergence shifted exported formulas a row.

// ---- workbook build -------------------------------------------------------

function buildWorkbook(spec, theme) {
  const ROLE_STYLES = theme.roleStyles
  const wb = new ExcelJS.Workbook()
  wb.creator = 'AI Prism'
  wb.created = new Date(0) // deterministic — never Date.now(), keeps output stable

  const built = []
  // cross-workbook resolution maps, filled during layout, consumed after
  const columnIndex = new Map() // `${sheet}\0${colName}` → {letter, sheetName}
  const namedCells = new Map() // name → {sheetName, letter, row}
  const deferred = [] // formula cells to resolve once all positions are known
  // aggregate facts for the auto Instructions sheet
  const rolesUsed = new Set()
  let hasFormula = false
  let hasDropdown = false
  const sheetSummaries = []

  for (const sheet of spec.sheets) {
    // a frozen pane MUST have a non-zero split — {row:0,col:0} would emit
    // <pane state="frozen"/> with no split, which Excel flags as corrupt and
    // "repairs" (the reported sheet2 View repair). Only freeze when there's a
    // real split; otherwise no view at all.
    const fx = sheet.freeze?.col || 0
    const fy = sheet.freeze?.row || 0
    const ws = wb.addWorksheet(sheet.name, {
      views: fx > 0 || fy > 0 ? [{ state: 'frozen', xSplit: fx, ySplit: fy }] : undefined,
    })

    // width of the widest table, so title/section bands merge across it
    const tableBlocks = (sheet.blocks || []).filter((b) => b.kind === 'table')
    const maxCols = Math.max(1, ...tableBlocks.map((t) => (t.columns || []).length))

    const tableGeom = {} // per-table geometry (for chart range resolution)
    const colWidths = {}
    const noteW = (c, len) => (colWidths[c] = Math.max(colWidths[c] || 0, len))

    // first title/section on the sheet → its purpose line in the instructions
    let purpose = ''

    let r = 1
    const blocks = sheet.blocks || []
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi]

      if (block.kind === 'spacer') {
        r += 1
        continue
      }

      if (block.kind === 'title') {
        const cell = ws.getCell(r, 1)
        cell.value = block.text
        cell.font = { bold: true, size: 15, color: { argb: theme.titleFont } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.titleFill } }
        cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
        ws.getRow(r).height = 26
        if (maxCols > 1) ws.mergeCells(r, 1, r, maxCols)
        if (!purpose) purpose = block.text
        r += 1
        continue
      }

      if (block.kind === 'note') {
        const cell = ws.getCell(r, 1)
        cell.value = block.text
        cell.font = { italic: true, size: 10, color: { argb: 'FF666666' } }
        if (maxCols > 1) ws.mergeCells(r, 1, r, maxCols)
        r += 1
        continue
      }

      if (block.kind === 'section') {
        const cell = ws.getCell(r, 1)
        cell.value = block.text
        cell.font = { bold: true, size: 11, color: { argb: theme.sectionFont } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.sectionFill } }
        cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
        ws.getRow(r).height = 20
        if (maxCols > 1) ws.mergeCells(r, 1, r, maxCols)
        r += 1
        continue
      }

      if (block.kind === 'table') {
        const columns = block.columns || []
        const colCount = columns.length

        // A table with no non-empty header is a label/value panel (the
        // reference's "RESUMO GERAL") — emit NO header row.
        const hasHeader = block.headerless !== true && columns.some((col) => String(col.header || '').trim())

        // name → column letter for [@Col] (same-row) resolution in THIS table,
        // and register whole-column ranges for [Aba!Col] resolution anywhere.
        const colByName = new Map()
        for (let c = 0; c < colCount; c++) {
          const letter = colLetter(c)
          const names = [columns[c]?.header, columns[c]?.key].filter((n) => String(n || '').trim())
          for (const nm of names) {
            colByName.set(norm(nm), letter)
            columnIndex.set(colKey(sheet.name, nm), { letter, sheetName: sheet.name })
          }
        }

        // header row (only when there's a real header)
        const headerRow = hasHeader ? r : 0
        if (hasHeader) {
          for (let c = 0; c < colCount; c++) {
            const cell = ws.getCell(r, c + 1)
            cell.value = columns[c].header ?? ''
            cell.font = { bold: true, color: { argb: theme.headerFont } }
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.headerFill } }
            cell.alignment = { vertical: 'middle', horizontal: 'left' }
            noteW(c, String(columns[c].header || '').length + 3)
          }
          r += 1
        }

        // data rows
        const dataStart = r
        const rows = block.rows || []
        for (const row of rows) {
          const arr = Array.isArray(row) ? row : columns.map((col) => row?.[col.key])
          for (let c = 0; c < colCount; c++) {
            const { value, role: cellRole, format: cellFmt, name } = cellParts(arr[c])
            if (value === undefined || value === null || value === '') {
              // still register a name on an empty (input) cell if given
              if (name) namedCells.set(norm(name), { sheetName: sheet.name, letter: colLetter(c), row: r })
              continue
            }
            const cell = ws.getCell(r, c + 1)
            const colFmt = columns[c]?.format
            const fmt = fmtCode(cellFmt || colFmt)

            if (isFormula(value)) {
              hasFormula = true
              // defer: resolve tokens once every table position is known
              deferred.push({ cell, formula: value.slice(1), sheetName: sheet.name, colByName, row: r })
              noteW(c, 16)
            } else if (isDateFmt(cellFmt || colFmt) && typeof value === 'string') {
              const d = new Date(value)
              cell.value = isNaN(d.getTime()) ? value : d
              noteW(c, String(value).length + 2)
            } else {
              cell.value = value
              noteW(c, String(value).length + 2)
            }
            if (fmt) cell.numFmt = fmt

            // role: explicit per-cell, else per-column, else inferred (formula→formula)
            let role = cellRole || columns[c]?.role
            if (!role && isFormula(value)) role = 'formula'
            if (role && role !== 'normal') rolesUsed.add(role)
            const style = ROLE_STYLES[role] || ROLE_STYLES.normal
            if (style.fill) {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.fill } }
            }
            cell.font = { color: { argb: style.fontColor } }
            cell.border = { bottom: { style: 'hair', color: { argb: 'FFE0E0E0' } } }

            if (name) namedCells.set(norm(name), { sheetName: sheet.name, letter: colLetter(c), row: r })
          }
          r += 1
        }
        const rowCount = rows.length

        // dropdowns (data validation) per column
        for (let c = 0; c < colCount; c++) {
          const opts = columns[c]?.dropdown
          if (!Array.isArray(opts) || !opts.length || !rowCount) continue
          hasDropdown = true
          const list = '"' + opts.map((o) => String(o).replace(/"/g, '')).join(',').slice(0, 250) + '"'
          for (let rr = dataStart; rr < dataStart + rowCount; rr++) {
            ws.getCell(rr, c + 1).dataValidation = {
              type: 'list',
              allowBlank: true,
              formulae: [list],
              showErrorMessage: false,
            }
          }
        }

        tableGeom[bi] = { headerRow, dataStart, rowCount, colCount }
        // NO auto-spacer: the model counts blocks contiguously when it writes
        // any literal A1 refs, so an invisible gap here shifts those refs by a
        // row (the reported wrong-formula bug). For visual breathing room the
        // model must emit an explicit {kind:"spacer"} — which it does.
        continue
      }
    }

    // apply widths
    for (const c of Object.keys(colWidths)) {
      ws.getColumn(Number(c) + 1).width = Math.min(48, Math.max(10, colWidths[c]))
    }

    sheetSummaries.push({ name: sheet.name, purpose: sheet.purpose || purpose || '' })
    built.push({ name: sheet.name, ws, tableGeom, maxCols, charts: sheet.charts || [] })
  }

  // resolve every deferred formula now that all positions are known — via the
  // SHARED resolver so server export and client preview never diverge
  for (const d of deferred) {
    d.cell.value = { formula: resolveFormula(d.formula, d, columnIndex, namedCells) }
  }

  return { wb, built, meta: { rolesUsed, hasFormula, hasDropdown, sheetSummaries } }
}

// ---- auto "Instruções de Uso" sheet ----------------------------------------

// Every generated workbook ends with a guaranteed instructions tab: the color
// legend (only for roles actually used), how the file behaves, and a map of the
// sheets. Built by the renderer — never left to the model — so the guidance is
// always present and always matches the real color system. Skipped only if the
// spec already carries an instructions-like sheet (model authored its own).
function buildInstructionsSheet(wb, theme, meta, extraLines) {
  // pick a free name (ExcelJS throws on a duplicate) — the model shouldn't have
  // authored an instructions tab, but dedupe defensively
  let name = 'Instruções de Uso'
  if (wb.getWorksheet(name)) {
    let n = 2
    while (wb.getWorksheet(`${name} ${n}`)) n++
    name = `${name} ${n}`
  }
  const ws = wb.addWorksheet(name)
  ws.getColumn(1).width = 30
  ws.getColumn(2).width = 82
  let r = 1

  const title = (text) => {
    const cell = ws.getCell(r, 1)
    cell.value = text
    cell.font = { bold: true, size: 15, color: { argb: theme.titleFont } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.titleFill } }
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
    ws.getRow(r).height = 26
    ws.mergeCells(r, 1, r, 2)
    r += 1
  }
  const section = (text) => {
    const cell = ws.getCell(r, 1)
    cell.value = text
    cell.font = { bold: true, size: 11, color: { argb: theme.sectionFont } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: theme.sectionFill } }
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
    ws.getRow(r).height = 20
    ws.mergeCells(r, 1, r, 2)
    r += 1
  }
  const note = (text) => {
    const cell = ws.getCell(r, 1)
    cell.value = text
    cell.font = { italic: true, size: 10, color: { argb: 'FF666666' } }
    cell.alignment = { wrapText: true, vertical: 'top' }
    ws.mergeCells(r, 1, r, 2)
    r += 1
  }
  const legendRow = (role, text) => {
    const swatch = ws.getCell(r, 1)
    const style = theme.roleStyles[role] || theme.roleStyles.normal
    if (style.fill) {
      swatch.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.fill } }
      swatch.value = 'exemplo'
      swatch.font = { color: { argb: style.fontColor }, italic: true }
    } else {
      // link has no fill — show its accent text color instead
      swatch.value = 'exemplo'
      swatch.font = { color: { argb: style.fontColor }, bold: true }
    }
    swatch.alignment = { vertical: 'middle', horizontal: 'center' }
    swatch.border = { outline: { style: 'thin', color: { argb: 'FFCCCCCC' } } }
    const desc = ws.getCell(r, 2)
    desc.value = text
    desc.font = { size: 11, color: { argb: 'FF1A1A1A' } }
    desc.alignment = { vertical: 'middle', wrapText: true }
    r += 1
  }
  const kv = (a, b) => {
    ws.getCell(r, 1).value = a
    ws.getCell(r, 1).font = { bold: true, size: 11, color: { argb: 'FF1A1A1A' } }
    ws.getCell(r, 1).alignment = { vertical: 'top' }
    ws.getCell(r, 2).value = b
    ws.getCell(r, 2).font = { size: 11, color: { argb: 'FF333333' } }
    ws.getCell(r, 2).alignment = { vertical: 'top', wrapText: true }
    r += 1
  }

  title('Instruções de Uso')
  note('Como esta planilha funciona e onde você deve digitar. Preencha apenas as células destacadas — os totais e cálculos se atualizam sozinhos.')
  r += 1

  const roleOrder = ['input', 'key', 'formula', 'link']
  const shown = roleOrder.filter((role) => meta.rolesUsed.has(role))
  if (shown.length) {
    section('Legenda de cores')
    for (const role of shown) legendRow(role, theme.roleMeaning[role])
    r += 1
  }

  section('Como usar')
  const steps = []
  if (meta.rolesUsed.has('input') || meta.rolesUsed.has('key')) {
    steps.push('Digite seus dados apenas nas células destacadas (entrada / campo-chave). As demais são calculadas.')
  }
  if (meta.hasFormula) {
    steps.push('As células calculadas contêm fórmulas — não as edite manualmente; elas recalculam quando você muda uma entrada.')
  }
  if (meta.hasDropdown) {
    steps.push('Alguns campos têm menu suspenso (uma seta ao selecionar a célula) — escolha uma das opções da lista para manter os cálculos corretos.')
  }
  steps.push('Você pode adicionar novas linhas às tabelas de lançamento — as fórmulas que somam colunas inteiras já consideram as linhas novas.')
  steps.push('Abra este arquivo no Excel ou no Google Sheets; os formatos de moeda, porcentagem e as cores são preservados.')
  for (let i = 0; i < steps.length; i++) kv(`${i + 1}.`, steps[i])
  r += 1

  for (const line of extraLines || []) note(line)
  if (extraLines?.length) r += 1

  if (meta.sheetSummaries.length) {
    section('Abas desta planilha')
    for (const s of meta.sheetSummaries) kv(s.name, s.purpose || '—')
  }

  return ws
}

// ---- chart range resolution ----------------------------------------------

// Resolve a chart's declared table block + category/value columns into
// absolute, sheet-qualified A1 ranges against the grid we actually wrote. The
// model gives a block index + column indices, never raw ranges — so a chart
// can't point at cells that don't exist. Returns null if it can't be grounded.
function resolveChart(sheetBuilt, chart) {
  const geom = sheetBuilt.tableGeom[chart.tableBlock]
  if (!geom || !geom.rowCount) return null
  const { name } = sheetBuilt
  const { dataStart, rowCount, colCount, headerRow } = geom
  const first = dataStart
  const last = dataStart + rowCount - 1
  const sn = name.replace(/'/g, "''")
  const q = (col, r1, r2) => `'${sn}'!$${colLetter(col)}$${r1}:$${colLetter(col)}$${r2}`
  const headerCell = (col) => `'${sn}'!$${colLetter(col)}$${headerRow || dataStart}`

  const catCol = chart.categoryColumn
  if (catCol == null || catCol < 0 || catCol >= colCount) return null
  const valCols = (chart.valueColumns || []).filter((c) => c >= 0 && c < colCount && c !== catCol)
  if (!valCols.length) return null

  return {
    kind: chart.kind,
    title: chart.title || '',
    // heatmap: the value cells the colour scale covers (sheet-local refs)
    cells: valCols.map((col) => `${colLetter(col)}${first}:${colLetter(col)}${last}`).join(' '),
    cat: q(catCol, first, last),
    series: valCols.map((col) => ({ name: headerCell(col), val: q(col, first, last) })),
    categoryCount: rowCount,
  }
}

// ---- OOXML chart/drawing XML ----------------------------------------------

// Builds a <c:ser>. `marker` (line charts only) is injected in its schema-
// correct slot (after spPr, before cat/val) — OOXML CT_LineSer is order-strict
// and Excel offers "repair" if marker lands after val.
function serXml(s, idx, colors, marker = '') {
  const color = colors[idx % colors.length]
  const fill = `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr>`
  return (
    `<c:ser>` +
    `<c:idx val="${idx}"/><c:order val="${idx}"/>` +
    `<c:tx><c:strRef><c:f>${xmlEscape(s.name)}</c:f></c:strRef></c:tx>` +
    fill +
    marker +
    `<c:cat><c:strRef><c:f>${xmlEscape(s.catRef)}</c:f></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>${xmlEscape(s.val)}</c:f></c:numRef></c:val>` +
    `</c:ser>`
  )
}

function pieSerXml(s, colorCount, colors) {
  const pts = Array.from({ length: colorCount }, (_, i) => {
    const color = colors[i % colors.length]
    return `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr></c:dPt>`
  }).join('')
  return (
    `<c:ser>` +
    `<c:idx val="0"/><c:order val="0"/>` +
    `<c:tx><c:strRef><c:f>${xmlEscape(s.name)}</c:f></c:strRef></c:tx>` +
    pts +
    `<c:cat><c:strRef><c:f>${xmlEscape(s.catRef)}</c:f></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>${xmlEscape(s.val)}</c:f></c:numRef></c:val>` +
    `</c:ser>`
  )
}

// A scatter <c:ser>: markers only (no connecting line), x from the category
// column, y from the value column — CT_ScatterSer order: idx, order, tx, spPr,
// marker, xVal, yVal, smooth.
function scatterSerXml(s, idx, colors) {
  const color = colors[idx % colors.length]
  return (
    `<c:ser>` +
    `<c:idx val="${idx}"/><c:order val="${idx}"/>` +
    `<c:tx><c:strRef><c:f>${xmlEscape(s.name)}</c:f></c:strRef></c:tx>` +
    `<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr>` +
    `<c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr></c:marker>` +
    `<c:xVal><c:numRef><c:f>${xmlEscape(s.catRef)}</c:f></c:numRef></c:xVal>` +
    `<c:yVal><c:numRef><c:f>${xmlEscape(s.val)}</c:f></c:numRef></c:yVal>` +
    `<c:smooth val="0"/>` +
    `</c:ser>`
  )
}

const AX_CAT = 111111111
const AX_VAL = 222222222

function chartXml(resolved, colors) {
  const titleXml = resolved.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${xmlEscape(resolved.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : `<c:autoTitleDeleted val="1"/>`

  const series = resolved.series.map((s) => ({ ...s, catRef: resolved.cat }))

  const axes =
    `<c:catAx><c:axId val="${AX_CAT}"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="b"/><c:crossAx val="${AX_VAL}"/></c:catAx>` +
    `<c:valAx><c:axId val="${AX_VAL}"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="l"/><c:crossAx val="${AX_CAT}"/></c:valAx>`
  const axIds = `<c:axId val="${AX_CAT}"/><c:axId val="${AX_VAL}"/>`

  let plot
  if (resolved.kind === 'pie') {
    plot = `<c:pieChart><c:varyColors val="1"/>${pieSerXml(series[0], resolved.categoryCount, colors)}</c:pieChart>`
  } else if (resolved.kind === 'line') {
    plot =
      `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>` +
      series.map((s, i) => serXml(s, i, colors, '<c:marker><c:symbol val="none"/></c:marker>')).join('') +
      `<c:marker val="1"/>${axIds}</c:lineChart>` +
      axes
  } else if (resolved.kind === 'scatter') {
    // two value axes: x along the bottom, y on the left
    plot =
      `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>` +
      series.map((s, i) => scatterSerXml(s, i, colors)).join('') +
      `${axIds}</c:scatterChart>` +
      `<c:valAx><c:axId val="${AX_CAT}"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
      `<c:delete val="0"/><c:axPos val="b"/><c:crossAx val="${AX_VAL}"/></c:valAx>` +
      `<c:valAx><c:axId val="${AX_VAL}"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
      `<c:delete val="0"/><c:axPos val="l"/><c:crossAx val="${AX_CAT}"/></c:valAx>`
  } else if (resolved.kind === 'histogram') {
    // contiguous columns (no gap) over a table of bins
    plot =
      `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>` +
      series.map((s, i) => serXml(s, i, colors)).join('') +
      `<c:gapWidth val="0"/>${axIds}</c:barChart>` +
      axes
  } else if (resolved.kind === 'area') {
    plot =
      `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>` +
      series.map((s, i) => serXml(s, i, colors)).join('') +
      `${axIds}</c:areaChart>` +
      axes
  } else {
    // bar (default): clustered columns
    plot =
      `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>` +
      series.map((s, i) => serXml(s, i, colors)).join('') +
      `<c:gapWidth val="80"/>${axIds}</c:barChart>` +
      axes
  }

  const legend = resolved.kind === 'pie' || series.length > 1 ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>` : ''

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<c:chart>${titleXml}<c:plotArea><c:layout/>${plot}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `</c:chartSpace>`
  )
}

// Chart box: ~8 cols wide, ~15 rows tall. Anchors are computed by the renderer
// (renderXlsx), never taken from the model — charts used to overlap because the
// model guessed anchors. See the deterministic stacking there.
function drawingXml(anchors) {
  const frames = anchors
    .map((a, i) => {
      const fromCol = a.anchor.col
      const fromRow = a.anchor.row
      const toCol = fromCol + (a.anchor.w || 8)
      const toRow = fromRow + (a.anchor.h || 15)
      return (
        `<xdr:twoCellAnchor>` +
        `<xdr:from><xdr:col>${fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:to><xdr:col>${toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
        `<xdr:graphicFrame macro="">` +
        `<xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
        `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
        `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${a.rId}"/>` +
        `</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
      )
    })
    .join('')
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${frames}</xdr:wsDr>`
  )
}

// ---- zip post-processing ---------------------------------------------------

function nextRelId(relsXml) {
  let max = 0
  for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) max = Math.max(max, parseInt(m[1], 10))
  return max + 1
}

function decodeXmlName(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

// Map sheet display name → worksheet part path via workbook.xml +
// workbook.xml.rels, so we never guess the file numbering.
function sheetPathMap(workbookXml, workbookRels) {
  const relTarget = new Map()
  for (const m of workbookRels.matchAll(/<Relationship\s[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g)) {
    relTarget.set(m[1], m[2])
  }
  const byName = new Map()
  for (const m of workbookXml.matchAll(/<sheet\s[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g)) {
    const target = relTarget.get(m[2])
    if (target) byName.set(decodeXmlName(m[1]), 'xl/' + target.replace(/^\//, '').replace(/^xl\//, ''))
  }
  return byName
}

async function injectCharts(buffer, built, chartColors) {
  const withCharts = built.filter((s) => s.resolvedCharts?.length)
  if (!withCharts.length) return buffer

  const zip = await JSZip.loadAsync(buffer)
  let contentTypes = await zip.file('[Content_Types].xml').async('string')
  const workbookXml = await zip.file('xl/workbook.xml').async('string')
  const workbookRels = await zip.file('xl/_rels/workbook.xml.rels').async('string')
  const pathByName = sheetPathMap(workbookXml, workbookRels)

  let drawingSeq = 0
  let chartSeq = 0
  const ctOverrides = []

  for (const sheet of withCharts) {
    const wsPath = pathByName.get(sheet.name)
    if (!wsPath) continue
    const wsBase = wsPath.split('/').pop() // sheet1.xml

    drawingSeq++
    const drawingName = `drawing${drawingSeq}.xml`
    const drawingPath = `xl/drawings/${drawingName}`
    const drawingRelsPath = `xl/drawings/_rels/${drawingName}.rels`

    const drawingRelEntries = []
    const anchors = []
    for (const resolved of sheet.resolvedCharts) {
      chartSeq++
      const chartName = `chart${chartSeq}.xml`
      const chartPath = `xl/charts/${chartName}`
      zip.file(chartPath, chartXml(resolved, chartColors))
      ctOverrides.push(`<Override PartName="/${chartPath}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`)
      const rId = `rId${drawingRelEntries.length + 1}`
      drawingRelEntries.push(
        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/${chartName}"/>`
      )
      anchors.push({ ...resolved, rId })
    }

    zip.file(drawingPath, drawingXml(anchors))
    zip.file(
      drawingRelsPath,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRelEntries.join('')}</Relationships>`
    )
    ctOverrides.push(`<Override PartName="/${drawingPath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`)

    // worksheet rels: merge (may already exist for hyperlinks etc.)
    const wsRelsPath = `xl/worksheets/_rels/${wsBase}.rels`
    const existingRels = zip.file(wsRelsPath) ? await zip.file(wsRelsPath).async('string') : null
    let drawingRid
    if (existingRels) {
      drawingRid = `rId${nextRelId(existingRels)}`
      const rel = `<Relationship Id="${drawingRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/${drawingName}"/>`
      zip.file(wsRelsPath, existingRels.replace('</Relationships>', rel + '</Relationships>'))
    } else {
      drawingRid = 'rId1'
      zip.file(
        wsRelsPath,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="${drawingRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/${drawingName}"/>` +
          `</Relationships>`
      )
    }

    // worksheet xml: add <drawing r:id=.../> in correct schema position
    let wsXml = await zip.file(wsPath).async('string')
    const drawingEl = `<drawing r:id="${drawingRid}"/>`
    if (/<tableParts/.test(wsXml)) {
      wsXml = wsXml.replace(/<tableParts/, drawingEl + '<tableParts')
    } else if (/<\/worksheet>/.test(wsXml)) {
      wsXml = wsXml.replace('</worksheet>', drawingEl + '</worksheet>')
    }
    if (!/xmlns:r=/.test(wsXml.slice(0, 400))) {
      wsXml = wsXml.replace(/<worksheet\s/, '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ')
    }
    zip.file(wsPath, wsXml)
  }

  contentTypes = contentTypes.replace('</Types>', ctOverrides.join('') + '</Types>')
  zip.file('[Content_Types].xml', contentTypes)

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// ---- public API ------------------------------------------------------------

export async function renderXlsx(spec, template) {
  const theme = resolveSheetTheme(template)
  const { wb, built, meta } = buildWorkbook(spec, theme)

  // auto Instructions sheet — ALWAYS appended by us so the color legend + how-
  // to-fill guidance are guaranteed and always match the real color system (the
  // preview UI no longer shows a legend; this sheet is where it lives). The
  // model is told not to author its own; if one slipped through with the same
  // name, we dedupe so ExcelJS doesn't throw on a duplicate sheet name.
  const extra = Array.isArray(spec.instructions)
    ? spec.instructions.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim().slice(0, 300))
    : []
  buildInstructionsSheet(wb, theme, meta, extra)

  // resolve + lay out charts. Anchors are computed here (NOT from the model):
  // each sheet's charts stack vertically to the right of its widest table, so
  // they never overlap each other or the data (the reported "one on top of
  // another" bug). A chart box is 8 cols × 15 rows with a 3-row gap.
  for (const sheet of built) {
    const all = (sheet.charts || []).map((ch) => resolveChart(sheet, ch)).filter(Boolean)
    // a heatmap is a native 2-colour scale over the value cells, not a chart part
    for (const hm of all.filter((rc) => rc.kind === 'heatmap')) {
      sheet.ws.addConditionalFormatting({
        ref: hm.cells,
        rules: [{ type: 'colorScale', priority: 1, cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: theme.heatLow }, { argb: theme.heatHigh }] }],
      })
    }
    const resolved = all.filter((rc) => rc.kind !== 'heatmap')
    const anchorCol = (sheet.maxCols || 1) + 1
    resolved.forEach((rc, i) => {
      rc.anchor = { col: anchorCol, row: 1 + i * 18, w: 8, h: 15 }
    })
    sheet.resolvedCharts = resolved
  }

  const baseBuffer = await wb.xlsx.writeBuffer()
  const finalBuffer = await injectCharts(Buffer.from(baseBuffer), built, theme.chartColors)
  return Buffer.isBuffer(finalBuffer) ? finalBuffer : Buffer.from(finalBuffer)
}
