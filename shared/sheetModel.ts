// Shared spreadsheet layout + formula-resolution model, imported by BOTH the
// server exporter (server/xlsx-export.js) and the client preview/studio
// (client/src/lib/sheetEval.js, SpreadsheetStudio.jsx). Keeping this in one
// place is the whole point: the row/column a cell lands on, and the way a
// formula token resolves to a real A1 reference, MUST be identical on both
// sides — a past divergence (a phantom auto-spacer on one side only) shifted
// exported formulas by a row and produced silently-wrong numbers.
//
// KEY INVARIANT — NO AUTO-SPACER: blocks are laid out contiguously (only
// explicit `spacer` blocks add gaps). So the grid row a model counts for a
// block equals the row it renders at. This is what makes even a literal A1
// reference the model writes (=B10-C10) land on the right cells.
//
// Formulas may reference cells two ways, both resolved here to real A1:
//   • position-free TOKENS the generator prefers (immune to any miscount):
//       [@Coluna]      same-row cell of that column, in the formula's table
//       [Aba!Coluna]   the whole data column of a sheet  → 'Aba'!$E:$E
//       [Coluna]       whole data column of the current sheet
//       [#nome]        the single cell tagged "name":"nome" (any sheet)
//   • literal A1 (=B10-C10) — left as-is; correct now that layout is contiguous.
// An unresolvable token becomes #REF! (a VISIBLE error, never a wrong number).

/** A table column of the workbook spec. */
export interface SheetColumn {
  header?: string
  key?: string
  role?: string
  format?: string
}

/**
 * A block of a sheet: `spacer`, `title`/`note`/`section` bands, or a `table`.
 * Other kinds are ignored by the layout.
 */
export interface SheetBlock {
  kind: string
  text?: string
  columns?: SheetColumn[]
  /** each row is an array (by column position) or an object keyed by column `key` */
  rows?: unknown[]
  headerless?: boolean
}

export interface SheetSpec {
  name: string
  blocks?: SheetBlock[]
}

export interface WorkbookSpec {
  sheets?: SheetSpec[]
}

/** A cell written as an object instead of a bare value. */
export interface CellObject {
  v?: unknown
  role?: string
  format?: string
  name?: string
}

export interface CellParts {
  value: unknown
  role: string | undefined
  format: string | undefined
  name: string | undefined
}

/** A positioned cell of the materialized model, keyed by its A1 address. */
export interface ModelCell {
  value: unknown
  header?: true
  role?: string
  format?: string
  name?: string
  /** header/key (normalized) → column letter of the cell's table */
  colByName?: Map<string, string>
  row?: number
}

export interface Band {
  row: number
  kind: string
  text: string | undefined
  span: number
}

export interface TableGeom {
  headerRow: number
  dataStart: number
  rowCount: number
  colCount: number
  colByName: Map<string, string>
}

export interface MaterializedSheet {
  cells: Map<string, ModelCell>
  maxCols: number
  maxRow: number
  bands: Band[]
  /** block index → table geometry */
  tableGeom: Record<number, TableGeom>
}

/** colKey(sheet, column) → where that column lives. */
export type ColumnIndex = Map<string, { letter: string; sheetName: string }>
/** norm(name) → the single named cell. */
export type NamedCells = Map<string, { sheetName: string; letter: string; row: number }>

export interface MaterializedWorkbook {
  sheets: Record<string, MaterializedSheet>
  columnIndex: ColumnIndex
  namedCells: NamedCells
  defaultSheet: string | undefined
}

/** Where a formula is being resolved: its sheet, its table's columns, its row. */
export interface FormulaContext {
  sheetName?: string
  colByName?: Map<string, string>
  row?: number
}

export const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase()

// 0-based column index → letters (0→A, 26→AA).
export function colLetter(idx: number): string {
  let s = ''
  let n = idx
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}
// letters → 0-based index (A→0).
export function colIndex(letters: string): number {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

// key for the cross-sheet column lookup — a separator that can't occur in a
// sheet/column name (written as an escape, so this file stays plain text).
export const colKey = (sheetName: unknown, colName: unknown): string => `${norm(sheetName)}\u0000${norm(colName)}`

export const isFormula = (v: unknown): v is string => typeof v === 'string' && v.length > 1 && v[0] === '='

export function cellParts(raw: unknown): CellParts {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const cell = raw as CellObject
    return { value: cell.v, role: cell.role, format: cell.format, name: cell.name }
  }
  return { value: raw, role: undefined, format: undefined, name: undefined }
}

const qSheet = (name: unknown): string => `'${String(name).replace(/'/g, "''")}'`

// Walk a workbook spec into a positioned model: every cell keyed by A1 address,
// plus per-table geometry, the color bands, and the cross-sheet column/named-
// cell indexes formulas resolve against. NO auto-spacer (see header).
export function materializeWorkbook(spec: WorkbookSpec | null | undefined): MaterializedWorkbook {
  const columnIndex: ColumnIndex = new Map() // colKey(sheet,col) → { letter, sheetName }
  const namedCells: NamedCells = new Map() // norm(name) → { sheetName, letter, row }
  const sheets: Record<string, MaterializedSheet> = {}
  for (const sheet of spec?.sheets || []) {
    sheets[sheet.name] = materializeSheet(sheet, columnIndex, namedCells)
  }
  return { sheets, columnIndex, namedCells, defaultSheet: spec?.sheets?.[0]?.name }
}

function materializeSheet(sheet: SheetSpec, columnIndex: ColumnIndex, namedCells: NamedCells): MaterializedSheet {
  const cells = new Map<string, ModelCell>()
  const tableBlocks = (sheet.blocks || []).filter((b) => b.kind === 'table')
  const maxCols = Math.max(1, ...tableBlocks.map((t) => (t.columns || []).length))
  const tableGeom: Record<number, TableGeom> = {} // blockIndex → { headerRow, dataStart, rowCount, colCount, colByName }
  const bands: Band[] = [] // { row, kind, text, span }
  let maxRow = 0
  let r = 1
  const blocks = sheet.blocks || []

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi]!
    if (block.kind === 'spacer') { r += 1; continue }
    if (block.kind === 'title' || block.kind === 'note' || block.kind === 'section') {
      bands.push({ row: r, kind: block.kind, text: block.text, span: maxCols })
      maxRow = Math.max(maxRow, r)
      r += 1
      continue
    }
    if (block.kind === 'table') {
      const columns = block.columns || []
      const colCount = columns.length
      const hasHeader = block.headerless !== true && columns.some((c) => String(c.header || '').trim())

      const colByName = new Map<string, string>()
      for (let c = 0; c < colCount; c++) {
        const letter = colLetter(c)
        for (const nm of [columns[c]?.header, columns[c]?.key].filter((n) => String(n || '').trim())) {
          colByName.set(norm(nm), letter)
          columnIndex.set(colKey(sheet.name, nm), { letter, sheetName: sheet.name })
        }
      }

      const headerRow = hasHeader ? r : 0
      if (hasHeader) {
        for (let c = 0; c < colCount; c++) cells.set(`${colLetter(c)}${r}`, { value: columns[c]!.header ?? '', header: true })
        maxRow = Math.max(maxRow, r)
        r += 1
      }

      const dataStart = r
      for (const row of block.rows || []) {
        const arr = Array.isArray(row) ? row : columns.map((col) => (row as Record<string, unknown> | null | undefined)?.[col.key as string])
        for (let c = 0; c < colCount; c++) {
          const { value, role, format, name } = cellParts(arr[c])
          const addr = `${colLetter(c)}${r}`
          cells.set(addr, { value, role: role || columns[c]?.role, format: format || columns[c]?.format, name, colByName, row: r })
          if (name) namedCells.set(norm(name), { sheetName: sheet.name, letter: colLetter(c), row: r })
        }
        maxRow = Math.max(maxRow, r)
        r += 1
      }
      tableGeom[bi] = { headerRow, dataStart, rowCount: (block.rows || []).length, colCount, colByName }
      // NO auto-spacer — the model's own row math depends on contiguous blocks.
    }
  }
  return { cells, maxCols, maxRow, bands, tableGeom }
}

// Resolve a "=..." formula's bracket tokens to real A1 references. Same-row and
// named refs are RELATIVE (B10, 'Aba'!B5) and whole-column refs ABSOLUTE
// ('Aba'!$E:$E) — matching idiomatic Excel and what the user sees in the bar.
// `ctx` = { sheetName, colByName, row }. Literal A1 already in the formula is
// left untouched (it's correct once layout is contiguous).
export function resolveFormula(
  formula: string,
  ctx: FormulaContext,
  columnIndex: ColumnIndex,
  namedCells: NamedCells,
): string {
  return formula.replace(/\[([^\]]+)\]/g, (_: string, inner: string) => {
    const token = inner.trim()
    // same-row sibling column → relative ref (B10)
    if (token[0] === '@') {
      const letter = ctx.colByName?.get(norm(token.slice(1)))
      return letter ? `${letter}${ctx.row}` : '#REF!'
    }
    // named single cell → relative, sheet-qualified if cross-sheet
    if (token[0] === '#') {
      const nc = namedCells.get(norm(token.slice(1)))
      if (!nc) return '#REF!'
      const ref = `${nc.letter}${nc.row}`
      return norm(nc.sheetName) === norm(ctx.sheetName) ? ref : `${qSheet(nc.sheetName)}!${ref}`
    }
    // whole data column, optionally sheet-qualified → absolute column range
    let sheetName = ctx.sheetName
    let colName = token
    const bang = token.indexOf('!')
    if (bang >= 0) { sheetName = token.slice(0, bang).trim(); colName = token.slice(bang + 1).trim() }
    const col = columnIndex.get(colKey(sheetName, colName))
    if (!col) return '#REF!'
    const range = `$${col.letter}:$${col.letter}`
    return norm(col.sheetName) === norm(ctx.sheetName) ? range : `${qSheet(col.sheetName)}!${range}`
  })
}
