// A small spreadsheet evaluator for the PREVIEW (card + studio). The exported
// .xlsx keeps live formula cells that Excel computes; here we reproduce enough
// of that so a preview cell can show its COMPUTED VALUE (e.g. Saldo = 3.500)
// while the formula bar shows the resolved A1 formula (=B5-B6).
//
// Layout + formula-token resolution come from ../../../shared/sheetModel.js —
// the SAME module the server exporter uses — so the gutter row/col a cell shows
// and the A1 a token resolves to are IDENTICAL to the exported file. This file
// adds only the value evaluator on top of that shared model.
//
// The evaluator is deliberately partial: it handles the functions the generator
// emits (SUM, SUMIF, SUMIFS, COUNTIF, COUNTIFS, AVERAGE, IF, ROUND, MIN, MAX,
// ABS) plus arithmetic/comparisons. Anything it can't evaluate returns '' — a
// blank preview, never a wrong number (Excel still computes it on export).
import { materializeWorkbook as buildModel, resolveFormula, colLetter, colIndex, norm, isFormula } from '../../../shared/sheetModel.js'
import type { ColumnIndex, FormulaContext, MaterializedSheet, MaterializedWorkbook, NamedCells, WorkbookSpec } from '../../../shared/sheetModel.js'

type Scalar = string | number | boolean | null | undefined
// A range value is a FLAT column-major array carrying non-enumerable 2D metadata.
interface Range extends Array<Val> { __grid?: Val[][]; __rows?: number; __cols?: number } // metadata is absent on the empty ranges
type Val = Scalar | Range
type Tok = { t: 'str' | 'ref' | 'func' | 'op'; v: string } | { t: 'num'; v: number }

interface EvaluatedWorkbook {
  sheets: Record<string, MaterializedSheet>
  computed: (sheetName: string, addr: string) => unknown
  formulaA1: (sheetName: string, addr: string) => string | null
}

export { colLetter }

// legacy shim kept for the evaluator below (resolveFormula signature matches)
function resolveTokens(formula: string, ctx: FormulaContext, columnIndex: ColumnIndex, namedCells: NamedCells): string {
  return resolveFormula(formula, ctx, columnIndex, namedCells)
}

// ---- expression evaluator --------------------------------------------------

// Tokenizer for a resolved A1 formula (no leading '=').
function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'
  // word chars in a name/ref: Unicode letters (accents!), digits, _ $ . — used
  // for both function/cell tokens and UNQUOTED sheet names (Transações!…). A
  // past bug used [A-Za-z], so "ç"/"õ" split the token and cross-sheet SUMIFS
  // returned 0 in the preview (Excel parsed it fine). \p{L} fixes that.
  const isWord = (c: string | null | undefined): boolean => c != null && /[\p{L}0-9_$.]/u.test(c)
  const isAlpha = (c: string | null | undefined): boolean => c != null && /[\p{L}_]/u.test(c)
  while (i < src.length) {
    const c = src[i]!
    if (c === ' ') { i++; continue }
    if (c === '"') {
      let s = ''; i++
      while (i < src.length && src[i] !== '"') { s += src[i]; i++ }
      i++ // closing quote
      toks.push({ t: 'str', v: s })
      continue
    }
    if (c === "'") { // quoted sheet name → part of a ref; collect until matching '
      let s = "'"; i++
      while (i < src.length && src[i] !== "'") { s += src[i]; i++ }
      s += "'"; i++
      // followed by !ref
      let rest = ''
      while (i < src.length && /[\p{L}0-9_!$:.]/u.test(src[i]!)) { rest += src[i]; i++ }
      toks.push({ t: 'ref', v: s + rest })
      continue
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let n = ''
      while (i < src.length && /[0-9.]/.test(src[i]!)) { n += src[i]; i++ }
      toks.push({ t: 'num', v: parseFloat(n) })
      continue
    }
    if (isAlpha(c) || c === '$') {
      let w = ''
      while (i < src.length && (isWord(src[i]) || src[i] === ':')) { w += src[i]; i++ }
      // an UNQUOTED sheet-qualified ref: word immediately followed by "!" —
      // consume the "!" and the ref/range that follows (Transações!$E:$E)
      if (src[i] === '!') {
        w += '!'; i++
        while (i < src.length && /[\p{L}0-9_$:.]/u.test(src[i]!)) { w += src[i]; i++ }
        toks.push({ t: 'ref', v: w })
        continue
      }
      // function name if immediately followed by '('
      if (src[i] === '(') toks.push({ t: 'func', v: w.toUpperCase() })
      else toks.push({ t: 'ref', v: w })
      continue
    }
    // multi-char operators
    const two = src.slice(i, i + 2)
    if (two === '<>' || two === '>=' || two === '<=') { toks.push({ t: 'op', v: two }); i += 2; continue }
    if ('+-*/^()=,<>&'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue }
    i++ // skip unknown
  }
  return toks
}

function makeEvaluator(model: MaterializedWorkbook): { cellRaw: (addr: string) => Val } {
  const memo = new Map<string, Val>()
  const inProgress = new Set<string>()

  // raw value of a single cell address like "B5" or "'Aba'!B5"
  function cellRaw(addr: string): Val {
    let sheetName: string = model.defaultSheet!
    let a = addr.replace(/\$/g, '')
    const bang = a.indexOf('!')
    if (bang >= 0) { sheetName = a.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'"); a = a.slice(bang + 1) }
    const sheet = model.sheets[sheetName]
    if (!sheet) return ''
    const cell = sheet.cells.get(a)
    if (!cell) return 0
    const v = cell.value
    if (v == null || v === '') return 0
    if (isFormula(v)) {
      const key = `${sheetName}!${a}`
      if (memo.has(key)) return memo.get(key)
      if (inProgress.has(key)) return 0 // cycle guard
      inProgress.add(key)
      const resolved = resolveTokens(v.slice(1), { sheetName, colByName: cell.colByName, row: cell.row }, model.columnIndex, model.namedCells)
      let out: Val
      try { out = evalExpr(tokenize(resolved)) } catch { out = '' }
      inProgress.delete(key)
      memo.set(key, out)
      return out
    }
    return v as Scalar
  }

  // expand a range ref ("E:E", "B2:B10", "'Aba'!E:E") to a FLAT array of raw
  // values (column-major). Carries non-enumerable shape metadata (__grid rows,
  // __r1/__c1 origins, __sheet) so 2D lookups (INDEX/VLOOKUP/HLOOKUP/MATCH) can
  // reconstruct rows/columns without changing the flat contract SUM/etc. rely on.
  function rangeValues(ref: string): Range {
    let sheetName: string = model.defaultSheet!
    let a = ref.replace(/\$/g, '')
    const bang = a.indexOf('!')
    if (bang >= 0) { sheetName = a.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'"); a = a.slice(bang + 1) }
    const sheet = model.sheets[sheetName]
    if (!sheet) return []
    const [start, end] = a.split(':')
    const m1 = /^([A-Z]+)(\d+)?$/.exec(start!)
    const m2 = /^([A-Z]+)(\d+)?$/.exec(end || start!)
    if (!m1 || !m2) return []
    const c1 = colIndex(m1[1]!), c2 = colIndex(m2[1]!)
    const r1 = m1[2] ? Number(m1[2]) : 1
    const r2 = m2[2] ? Number(m2[2]) : sheet.maxRow
    const lo = { r: Math.min(r1, r2), c: Math.min(c1, c2) }
    const hi = { r: Math.max(r1, r2), c: Math.max(c1, c2) }
    const out: Range = []
    const grid: Val[][] = [] // grid[rowIdx][colIdx] — row-major, for 2D lookups
    for (let rr = lo.r; rr <= hi.r; rr++) {
      const row: Val[] = []
      for (let c = lo.c; c <= hi.c; c++) row.push(cellRaw(`'${sheetName}'!${colLetter(c)}${rr}`))
      grid.push(row)
    }
    // flat array is column-major (what SUM/AVERAGE/SUMIFS already expect)
    for (let c = lo.c; c <= hi.c; c++) {
      for (let rr = lo.r; rr <= hi.r; rr++) out.push(cellRaw(`'${sheetName}'!${colLetter(c)}${rr}`))
    }
    Object.defineProperties(out, {
      __grid: { value: grid, enumerable: false },
      __rows: { value: hi.r - lo.r + 1, enumerable: false },
      __cols: { value: hi.c - lo.c + 1, enumerable: false },
    })
    return out
  }

  const num = (v: Val): number => (typeof v === 'number' ? v : (v !== '' && !isNaN(Number(v)) ? Number(v) : 0))

  // Excel-ish criterion match: number equality, or "op number", or text equality
  function matches(cellVal: Val, criterion: Val): boolean {
    const crit = typeof criterion === 'string' ? criterion.trim() : criterion
    if (typeof crit === 'string') {
      const m = /^(>=|<=|<>|>|<|=)(.*)$/.exec(crit)
      if (m) {
        const rhs = m[2]!.trim()
        const rn = Number(rhs)
        const cn = Number(cellVal)
        if (!isNaN(rn) && !isNaN(cn)) {
          switch (m[1]) {
            case '>': return cn > rn
            case '<': return cn < rn
            case '>=': return cn >= rn
            case '<=': return cn <= rn
            case '<>': return cn !== rn
            case '=': return cn === rn
          }
        }
        if (m[1] === '<>') return String(cellVal) !== rhs
        if (m[1] === '=') return String(cellVal) === rhs
      }
    }
    // plain equality (number or text, case-insensitive for text)
    if (typeof crit === 'number') return num(cellVal) === crit
    return norm(cellVal) === norm(crit)
  }

  function callFunc(name: string, args: Val[]): Val {
    switch (name) {
      case 'SUM': return args.flatMap((a) => (Array.isArray(a) ? a : [a])).reduce((s: number, v) => s + num(v), 0)
      case 'AVERAGE': {
        const vals = args.flatMap((a) => (Array.isArray(a) ? a : [a])).map(num)
        return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0
      }
      case 'MIN': return Math.min(...args.flatMap((a) => (Array.isArray(a) ? a : [a])).map(num))
      case 'MAX': return Math.max(...args.flatMap((a) => (Array.isArray(a) ? a : [a])).map(num))
      case 'ABS': return Math.abs(num(args[0]))
      case 'ROUND': { const f = Math.pow(10, num(args[1]) || 0); return Math.round(num(args[0]) * f) / f }
      case 'IF': return (args[0] === true || num(args[0]) !== 0 && args[0] !== false) ? args[1] : (args[2] ?? false)
      case 'SUMIF': {
        const range = Array.isArray(args[0]) ? args[0] : [args[0]]
        const crit = args[1]
        const sumRange = args[2] != null ? (Array.isArray(args[2]) ? args[2] : [args[2]]) : range
        let s = 0
        for (let k = 0; k < range.length; k++) if (matches(range[k], crit)) s += num(sumRange[k])
        return s
      }
      case 'COUNTIF': {
        const range = Array.isArray(args[0]) ? args[0] : [args[0]]
        let s = 0
        for (const v of range) if (matches(v, args[1])) s++
        return s
      }
      case 'SUMIFS': {
        const sumRange = Array.isArray(args[0]) ? args[0] : [args[0]]
        const pairs: [Val[], Val][] = []
        for (let k = 1; k + 1 < args.length; k += 2) pairs.push([(Array.isArray(args[k]) ? args[k] : [args[k]]) as Val[], args[k + 1]])
        let s = 0
        for (let idx = 0; idx < sumRange.length; idx++) {
          let all = true
          for (const [rng, crit] of pairs) if (!matches(rng[idx], crit)) { all = false; break }
          if (all) s += num(sumRange[idx])
        }
        return s
      }
      case 'COUNTIFS': {
        const pairs: [Val[], Val][] = []
        for (let k = 0; k + 1 < args.length; k += 2) pairs.push([(Array.isArray(args[k]) ? args[k] : [args[k]]) as Val[], args[k + 1]])
        const len = pairs[0]?.[0].length || 0
        let s = 0
        for (let idx = 0; idx < len; idx++) {
          let all = true
          for (const [rng, crit] of pairs) if (!matches(rng[idx], crit)) { all = false; break }
          if (all) s++
        }
        return s
      }
      // ---- lookups (LibreOffice/Excel/Sheets all support these; NOT dynamic-
      // array). The generator prefers INDEX/MATCH; add VLOOKUP/HLOOKUP too since
      // a model may emit them. Without these the preview left cross-sheet lookup
      // cells blank → dependent cells showed 0 (the bug), though the exported
      // .xlsx computed fine. Approximate-match args default to exact (false),
      // which is what these financial models use.
      case 'MATCH': {
        // MATCH(lookup, range, [type]) → 1-based position; type 0 = exact
        const lookup = args[0]
        const range = Array.isArray(args[1]) ? args[1] : [args[1]]
        const type = args[2] == null ? 1 : num(args[2])
        if (type === 0) {
          for (let i = 0; i < range.length; i++) if (matches(range[i], lookup)) return i + 1
          return ''
        }
        // type 1 (default): largest value ≤ lookup, assuming ascending
        let best: string | number = ''
        for (let i = 0; i < range.length; i++) {
          const v = num(range[i])
          if (v <= num(lookup)) best = i + 1
          else if (type === 1) break
        }
        return best
      }
      case 'INDEX': {
        // INDEX(range, rowNum, [colNum]) — 1-based; rowNum 0 with a single
        // column returns that column. Uses the 2D grid metadata.
        const range = args[0]
        const grid = Array.isArray(range) ? range.__grid : null
        if (!grid) return ''
        const rows = grid.length
        const cols = grid[0]?.length || 0
        const rn = num(args[1])
        const cn = args[2] != null ? num(args[2]) : (cols === 1 ? 1 : 0)
        // single row/column vectors let the other index be omitted
        if (rows === 1 && args[2] == null) { const v = grid[0]![rn - 1]; return v == null ? '' : v }
        if (cols === 1 && (args[2] == null || cn === 1)) { const row = grid[rn - 1]; return row ? (row[0] ?? '') : '' }
        const row = grid[rn - 1]
        if (!row) return ''
        const v = row[cn - 1]
        return v == null ? '' : v
      }
      case 'VLOOKUP': {
        // VLOOKUP(lookup, table, colIndex, [approx]) — colIndex 1-based within table
        const lookup = args[0]
        const table = args[1]
        const grid = Array.isArray(table) ? table.__grid : null
        if (!grid) return ''
        const colIdx = num(args[2])
        const approx = args[3] === true || (typeof args[3] === 'number' && args[3] !== 0)
        let hit = -1
        if (!approx) {
          for (let i = 0; i < grid.length; i++) if (matches(grid[i]![0], lookup)) { hit = i; break }
        } else {
          for (let i = 0; i < grid.length; i++) { if (num(grid[i]![0]) <= num(lookup)) hit = i; else break }
        }
        if (hit < 0) return ''
        const v = grid[hit]![colIdx - 1]
        return v == null ? '' : v
      }
      case 'HLOOKUP': {
        // HLOOKUP(lookup, table, rowIndex, [approx]) — rowIndex 1-based within table
        const lookup = args[0]
        const table = args[1]
        const grid = Array.isArray(table) ? table.__grid : null
        if (!grid || !grid.length) return ''
        const rowIdx = num(args[2])
        const approx = args[3] === true || (typeof args[3] === 'number' && args[3] !== 0)
        const header = grid[0]!
        let hit = -1
        if (!approx) {
          for (let j = 0; j < header.length; j++) if (matches(header[j], lookup)) { hit = j; break }
        } else {
          for (let j = 0; j < header.length; j++) { if (num(header[j]) <= num(lookup)) hit = j; else break }
        }
        if (hit < 0) return ''
        const row = grid[rowIdx - 1]
        return row ? (row[hit] ?? '') : ''
      }
      default: return ''
    }
  }

  // recursive-descent over the token array
  function evalExpr(toks: Tok[]): Val {
    let pos = 0
    const peek = () => toks[pos]
    const eat = () => toks[pos++]

    function parsePrimary(): Val {
      const tk = peek()
      if (!tk) return 0
      if (tk.t === 'num') { eat(); return tk.v }
      if (tk.t === 'str') { eat(); return tk.v }
      if (tk.t === 'op' && tk.v === '(') { eat(); const v = parseCompare(); if (peek()?.v === ')') eat(); return v }
      if (tk.t === 'op' && (tk.v === '-' || tk.v === '+')) { eat(); const v = parsePrimary(); return tk.v === '-' ? -num(v) : num(v) }
      if (tk.t === 'func') {
        eat(); if (peek()?.v === '(') eat()
        const args: Val[] = []
        if (peek()?.v !== ')') {
          args.push(parseCompare())
          while (peek()?.v === ',') { eat(); args.push(parseCompare()) }
        }
        if (peek()?.v === ')') eat()
        return callFunc(tk.v, args)
      }
      if (tk.t === 'ref') {
        eat()
        if (tk.v.includes('#REF!')) return ''
        if (/:/.test(tk.v)) return rangeValues(tk.v)
        return cellRaw(tk.v)
      }
      eat(); return 0
    }
    function parsePow(): Val { let l: Val = parsePrimary(); while (peek()?.v === '^') { eat(); l = Math.pow(num(l), num(parsePrimary())) } return l }
    function parseMul(): Val {
      let l: Val = parsePow()
      while (peek()?.v === '*' || peek()?.v === '/') { const op = eat()!.v; const r = parsePow(); l = op === '*' ? num(l) * num(r) : (num(r) === 0 ? '' : num(l) / num(r)) }
      return l
    }
    function parseAdd(): Val {
      let l: Val = parseMul()
      while (peek()?.v === '+' || peek()?.v === '-' || peek()?.v === '&') {
        const op = eat()!.v; const r = parseMul()
        l = op === '+' ? num(l) + num(r) : op === '-' ? num(l) - num(r) : String(l ?? '') + String(r ?? '')
      }
      return l
    }
    function parseCompare(): Val {
      const l = parseAdd()
      const tk = peek()
      if (tk && tk.t === 'op' && ['=', '<>', '>', '<', '>=', '<='].includes(tk.v)) {
        eat(); const r = parseAdd()
        switch (tk.v) {
          case '=': return num(l) === num(r) || String(l) === String(r)
          case '<>': return !(num(l) === num(r) || String(l) === String(r))
          case '>': return num(l) > num(r)
          case '<': return num(l) < num(r)
          case '>=': return num(l) >= num(r)
          case '<=': return num(l) <= num(r)
        }
      }
      return l
    }
    return parseCompare()
  }

  return { cellRaw }
}

// Public: build an evaluated model of a whole workbook spec. Returns per-sheet
// geometry + a computed(addr) accessor that gives a cell's displayable value.
export function materializeWorkbook(spec: WorkbookSpec | null | undefined): EvaluatedWorkbook {
  // geometry + indexes come from the SHARED model (identical to the export)
  const model = buildModel(spec)
  const { sheets } = model
  const evaluator = makeEvaluator(model)

  // value shown in a cell: computed number for a formula, raw otherwise
  function computed(sheetName: string, addr: string): unknown {
    const sheet = sheets[sheetName]
    const cell = sheet?.cells.get(addr)
    if (!cell) return ''
    if (isFormula(cell.value)) {
      model.defaultSheet = sheetName
      const v = evaluator.cellRaw(`'${sheetName}'!${addr}`)
      return v
    }
    return cell.value
  }

  // the RESOLVED A1 formula for the formula bar (=B5-B6, =SUMIFS('Aba'!$E:$E…)),
  // exactly what the exported .xlsx carries — tokens resolved, literals as-is.
  function formulaA1(sheetName: string, addr: string): string | null {
    const cell = sheets[sheetName]?.cells.get(addr)
    if (!cell || !isFormula(cell.value)) return null
    return '=' + resolveFormula(cell.value.slice(1), { sheetName, colByName: cell.colByName, row: cell.row }, model.columnIndex, model.namedCells)
  }

  return { sheets, computed, formulaA1 }
}
