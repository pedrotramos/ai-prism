import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import CostBadge from './CostBadge.jsx'
import PromptImageStrip from './PromptImageStrip.jsx'
import { usePromptImages } from '../hooks/usePromptImages.js'
import { getJSON, postJSON, patchJSON } from '../api.js'
import { resolveDeckTheme, blend, contrastOn } from '../../../shared/deckTheme.js'
import { materializeWorkbook, colLetter } from '../lib/sheetEval.js'
import { SUBMIT_CHORD } from '../lib/platform.js'

// Full-screen studio for a generated spreadsheet — the tabular sibling of
// DeckStudio. It is READ-ONLY on purpose: the grid faithfully previews the
// exported .xlsx (row-number gutter + column letters, computed cell values, a
// formula bar) but the user never types into cells. All changes go through the
// AI panel (POST /api/spreadsheets/:id/tweak); to edit by hand, export the .xlsx
// and open it in Excel. This keeps the model's formula/role invariants intact —
// a hand-typed "=B14-C14" would reintroduce exactly the off-by-row bug the
// by-name token engine was built to remove.
//
// The grid mirrors server/xlsx-export.js layout so what you see == what you
// export; cell VALUES are computed by client/src/lib/sheetEval.js (the preview
// evaluator), so a formula cell shows its result (e.g. Saldo = 3.500) and its
// formula text appears in the formula bar when selected.

const INK = '#1A1A1A'
function roleFills(th) {
  return {
    input: { bg: blend(th.secondary, '#FFFFFF', 0.82), fg: INK },
    key: { bg: blend(th.accent, '#FFFFFF', 0.82), fg: INK },
    formula: { bg: blend(th.primary, '#FFFFFF', 0.9), fg: INK },
    link: { bg: null, fg: th.accent },
    normal: { bg: null, fg: INK },
  }
}
const NUM_FORMATS = ['currency', 'usd', 'eur', 'percent', 'percent0', 'integer', 'number']

function cellParts(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { value: raw.v, role: raw.role, format: raw.format, name: raw.name }
  return { value: raw, role: undefined, format: undefined, name: undefined }
}

function fmtNumber(value, format) {
  if (value == null || value === '') return ''
  const n = Number(value)
  const isNum = typeof value === 'number' || (!isNaN(n) && value !== '')
  if (isNum) {
    if (format === 'currency') return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    if (format === 'usd') return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    if (format === 'eur') return '€ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    if (format === 'percent') return (n * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%'
    if (format === 'percent0') return Math.round(n * 100) + '%'
    if (format === 'integer') return Math.round(n).toLocaleString('pt-BR')
    if (format === 'number') return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  return String(value)
}

// compact number for the stats footer (thousands sep, up to 2 decimals)
function fmtStat(n) {
  if (!isFinite(n)) return '—'
  return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 })
}

function Stat({ label, value }) {
  return (
    <span><span className="text-[var(--faint)]">{label}:</span> <span className="font-semibold text-[var(--text)]">{value}</span></span>
  )
}

// ---- charts (values read from the computed model) --------------------------

function chartData(sheet, chart, computed, sheetName) {
  const table = sheet.blocks?.[chart.tableBlock]
  if (!table || table.kind !== 'table') return null
  const cat = chart.categoryColumn
  const vals = chart.valueColumns || []
  const cols = table.columns || []
  // find the table's data rows in the materialized grid by scanning addresses
  const data = (table.rows || []).map((row, ri) => {
    const arr = Array.isArray(row) ? row : []
    const point = { __cat: fmtNumber(cellParts(arr[cat]).value, cols[cat]?.format) }
    for (const v of vals) {
      const p = cellParts(arr[v])
      let num
      if (typeof p.value === 'string' && p.value[0] === '=') num = 0 // resolved below if needed
      else num = Number(p.value)
      point[cols[v]?.header || `col${v}`] = isNaN(num) ? 0 : num
    }
    return point
  })
  const hasNumbers = data.some((d) => vals.some((v) => d[cols[v]?.header || `col${v}`]))
  return hasNumbers ? { data, series: vals.map((v) => cols[v]?.header || `col${v}`) } : null
}

function SheetChart({ sheet, chart, colors, computed, sheetName }) {
  const cd = chartData(sheet, chart, computed, sheetName)
  if (!cd) return null
  const { data, series } = cd
  const common = { data, margin: { top: 8, right: 12, left: 0, bottom: 4 } }
  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="#00000010" vertical={false} />
      <XAxis dataKey="__cat" tick={{ fontSize: 11, fill: '#666' }} />
      <YAxis tick={{ fontSize: 11, fill: '#666' }} width={48} />
      <Tooltip />
      {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
    </>
  )
  return (
    <div className="mt-3 rounded-lg border border-[var(--border)] bg-white p-3">
      {chart.title && <div className="text-xs font-semibold text-[#555] mb-1">{chart.title}</div>}
      <div style={{ width: '100%', height: 220 }}>
        <ResponsiveContainer>
          {chart.kind === 'pie' ? (
            <PieChart>
              <Tooltip />
              <Pie data={data} dataKey={series[0]} nameKey="__cat" cx="50%" cy="50%" outerRadius={80} label>
                {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
              </Pie>
            </PieChart>
          ) : chart.kind === 'line' ? (
            <LineChart {...common}>{axes}{series.map((s, i) => <Line key={s} type="monotone" dataKey={s} stroke={colors[i % colors.length]} strokeWidth={2} dot={false} />)}</LineChart>
          ) : chart.kind === 'area' ? (
            <AreaChart {...common}>{axes}{series.map((s, i) => <Area key={s} type="monotone" dataKey={s} stroke={colors[i % colors.length]} fill={colors[i % colors.length]} fillOpacity={0.25} />)}</AreaChart>
          ) : (
            <BarChart {...common}>{axes}{series.map((s, i) => <Bar key={s} dataKey={s} fill={colors[i % colors.length]} radius={[3, 3, 0, 0]} />)}</BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ---- the spreadsheet grid (read-only, with gutter + computed values) -------

const GUTTER_W = 40
const COL_W = 132
const ROW_H = 26

// A spreadsheet-like grid that FILLS the viewport and behaves like Excel:
// click/drag to select a range, click a row number / column letter to select a
// whole row/column, and navigate with the keyboard (arrows move; Shift+arrow
// extends; Cmd/Ctrl+arrow jumps to the data edge). Selection is reported up via
// onSelectionChange({r1,c1,r2,c2,active}) so the studio shows the formula bar +
// a stats footer (Sum/Avg/Min/Max/Count) over the highlighted numeric cells.
function GridView({ mat, computed, sheetName, fills, th, sel, setSel }) {
  const { maxCols, maxRow, bands } = mat
  const bandByRow = new Map(bands.map((b) => [b.row, b]))
  const secBg = blend(th.secondary, th.primary, 0.15)

  const wrapRef = useRef(null)
  const [fit, setFit] = useState({ rows: 0, cols: 0 })
  const dragging = useRef(false)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => {
      setFit({
        rows: Math.floor((el.clientHeight - ROW_H) / ROW_H),
        cols: Math.floor((el.clientWidth - GUTTER_W) / COL_W),
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const totalRows = Math.max(maxRow + 2, fit.rows || 0)
  const totalCols = Math.max(maxCols, fit.cols || 0)

  // selection normalized bounds
  const inSel = (r, c) => sel && r >= Math.min(sel.r1, sel.r2) && r <= Math.max(sel.r1, sel.r2) && c >= Math.min(sel.c1, sel.c2) && c <= Math.max(sel.c1, sel.c2)
  const isActive = (r, c) => sel && sel.ar === r && sel.ac === c
  // which OUTER edges of the selection rectangle a given in-range cell touches —
  // used to paint one continuous accent border around the whole range (not just
  // a background tint on the active cell, which read as "only A1 is selected")
  const selEdges = (r, c) => {
    if (!sel) return null
    const r1 = Math.min(sel.r1, sel.r2), r2 = Math.max(sel.r1, sel.r2)
    const c1 = Math.min(sel.c1, sel.c2), c2 = Math.max(sel.c1, sel.c2)
    return { top: r === r1, bottom: r === r2, left: c === c1, right: c === c2 }
  }
  const isRange = sel && (Math.min(sel.r1, sel.r2) !== Math.max(sel.r1, sel.r2) || Math.min(sel.c1, sel.c2) !== Math.max(sel.c1, sel.c2))

  // set active cell (and collapse selection unless extending)
  const pick = (r, c, { extend = false } = {}) => {
    setSel((prev) => {
      if (extend && prev) return { ...prev, r2: r, c2: c, ar: prev.ar, ac: prev.ac, ncols: totalCols }
      return { r1: r, c1: c, r2: r, c2: c, ar: r, ac: c, ncols: totalCols }
    })
  }
  const selectRow = (r, extend) => setSel((prev) => extend && prev ? { ...prev, r2: r, c1: 0, c2: totalCols - 1 } : { r1: r, c1: 0, r2: r, c2: totalCols - 1, ar: r, ac: 0, ncols: totalCols })
  const selectCol = (c, extend) => setSel((prev) => extend && prev ? { ...prev, c2: c, r1: 1, r2: totalRows } : { r1: 1, c1: c, r2: totalRows, c2: c, ar: 1, ac: c, ncols: totalCols })

  // Cmd/Ctrl+arrow: jump to the far edge of the contiguous data block in a
  // direction (Excel behaviour, simplified: go to last non-empty then edge).
  const nonEmpty = (r, c) => {
    if (r < 1 || c < 0 || c >= maxCols) return false
    const cell = mat.cells.get(`${colLetter(c)}${r}`)
    if (!cell) return false
    const v = cell.value
    return v != null && v !== '' && !cell.header
  }
  // any content (incl. headers) in a cell — used to decide Excel-style text
  // overflow: a left-aligned text cell spills into the empty cells to its right
  // and clips as soon as a neighbour has content
  const cellHasAnything = (r, c) => {
    if (c < 0 || c >= maxCols) return false
    const cell = mat.cells.get(`${colLetter(c)}${r}`)
    return !!cell && cell.value != null && cell.value !== ''
  }
  // how many empty columns follow (r,c) — the text may overflow across them
  const emptyRunRight = (r, c) => {
    let n = 0
    for (let cc = c + 1; cc < totalCols && !cellHasAnything(r, cc); cc++) n++
    return n
  }
  const jump = (r, c, dr, dc) => {
    let nr = r, nc = c
    // step once, then keep going while the next cell matches current emptiness
    const startFilled = nonEmpty(r, c)
    while (true) {
      const tr = nr + dr, tc = nc + dc
      if (tr < 1 || tr > totalRows || tc < 0 || tc >= totalCols) break
      const filled = nonEmpty(tr, tc)
      nr = tr; nc = tc
      if (startFilled ? !nonEmpty(nr + dr, nc + dc) : filled) {
        if (startFilled && !filled) { nr -= dr; nc -= dc }
        break
      }
    }
    return [nr, nc]
  }

  const onKeyDown = (e) => {
    if (!sel) return
    const dirs = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    const d = dirs[e.key]
    if (!d) return
    e.preventDefault()
    const jumpMod = e.metaKey || e.ctrlKey
    // Shift extends the MOVING edge of the range (r2/c2) from where it is, so
    // repeated Shift+Arrow keeps growing the selection; without Shift we move
    // the active cell itself. (The past bug stepped from the anchor every time,
    // so Shift+Arrow could only ever reach anchor±1.)
    let [r, c] = e.shiftKey ? [sel.r2, sel.c2] : [sel.ar, sel.ac]
    if (jumpMod) { [r, c] = jump(r, c, d[0], d[1]) }
    else { r = Math.min(Math.max(1, r + d[0]), totalRows); c = Math.min(Math.max(0, c + d[1]), totalCols - 1) }
    pick(r, c, { extend: e.shiftKey })
    // keep the moving edge visible
    const el = wrapRef.current?.querySelector(`[data-rc="${r}-${c}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const cellStyle = (r, c, base) => {
    const active = isActive(r, c)
    const within = inSel(r, c)
    // build box-shadow layers: a tint fill for every in-range cell + accent
    // segments on whichever outer edges of the range this cell sits on, so the
    // whole selection carries one crisp rectangle (Excel/Sheets-style)
    const shadows = []
    if (within && !active) shadows.push(`inset 0 0 0 9999px ${th.accent}1f`)
    if (isRange && within) {
      const e = selEdges(r, c)
      const w = 2
      if (e.top) shadows.push(`inset 0 ${w}px 0 ${th.accent}`)
      if (e.bottom) shadows.push(`inset 0 -${w}px 0 ${th.accent}`)
      if (e.left) shadows.push(`inset ${w}px 0 0 ${th.accent}`)
      if (e.right) shadows.push(`inset -${w}px 0 0 ${th.accent}`)
    }
    return {
      ...base,
      width: COL_W, height: ROW_H,
      // the active cell keeps its solid outline; a single-cell selection has no
      // range border. zIndex lifts the active/edge cells above neighbour borders
      outline: active ? `2px solid ${th.accent}` : 'none',
      outlineOffset: -2,
      position: 'relative',
      zIndex: active || (isRange && within) ? 1 : undefined,
      boxShadow: shadows.length ? shadows.join(', ') : 'none',
    }
  }

  const rows = []
  for (let r = 1; r <= totalRows; r++) {
    const band = bandByRow.get(r)
    const rowCells = []
    // text-overflow overlays for this row (Excel-style spill into empty cells);
    // collected while painting value cells, rendered on top afterwards
    const overlays = []
    rowCells.push(
      <div key={`g${r}`} onMouseDown={(e) => selectRow(r, e.shiftKey)}
        className="sticky left-0 z-10 flex items-center justify-center text-[10px] text-[#8a8a8a] bg-[#f5f5f5] border-r border-b border-[#e0e0e0] select-none shrink-0 cursor-pointer hover:bg-[#ececec]"
        style={{ width: GUTTER_W, height: ROW_H }}>
        {r}
      </div>
    )
    if (band) {
      const isTitle = band.kind === 'title'
      const isSection = band.kind === 'section'
      const bandStyle = isTitle
        ? { background: th.primary, color: th.onPrimary }
        : isSection
          ? { background: secBg, color: contrastOn(secBg) }
          : { background: '#fff', color: '#666' }
      // Excel-style overflow: DON'T merge. Paint the band across its data
      // columns as individually-selectable cells, then lay the text ON TOP as
      // an overlay that overflows past column A (pointer-events:none so clicks
      // fall through to the painted cells beneath). Notes (white bg) overflow
      // like Excel too; title/section carry the band fill on every column.
      for (let c = 0; c < totalCols; c++) {
        const painted = c < maxCols && band.kind !== 'note'
        rowCells.push(
          <div key={`${colLetter(c)}${r}`} data-rc={`${r}-${c}`}
            onMouseDown={(e) => pick(r, c, { extend: e.shiftKey })}
            onMouseEnter={() => dragging.current && pick(r, c, { extend: true })}
            className="border-r border-b border-[#e0e0e0] shrink-0"
            style={cellStyle(r, c, painted ? { background: bandStyle.background } : { background: '#fff' })} />
        )
      }
      // text overlay, anchored at the first data column, overflowing rightward
      rowCells.push(
        <div key={`bt${r}`} aria-hidden
          className={`absolute flex items-center px-2 text-xs whitespace-nowrap pointer-events-none ${isTitle || isSection ? 'font-bold' : 'italic'}`}
          style={{ left: GUTTER_W, height: ROW_H, color: bandStyle.color, fontSize: isTitle ? 13 : 12 }}>
          {band.text}
        </div>
      )
    } else {
      for (let c = 0; c < totalCols; c++) {
        const addr = `${colLetter(c)}${r}`
        const cell = c < maxCols ? mat.cells.get(addr) : null
        const common = {
          'data-rc': `${r}-${c}`,
          onMouseDown: (e) => pick(r, c, { extend: e.shiftKey }),
          onMouseEnter: () => dragging.current && pick(r, c, { extend: true }),
        }
        if (!cell) {
          rowCells.push(<div key={addr} {...common} className="border-r border-b border-[#eee] bg-white shrink-0" style={cellStyle(r, c, {})} />)
          continue
        }
        if (cell.header) {
          rowCells.push(
            <div key={addr} {...common} className="flex items-center px-2 text-xs font-semibold truncate border-r border-b border-[#e0e0e0] shrink-0"
              style={cellStyle(r, c, { background: th.accent, color: th.onAccent })}>
              {cell.value}
            </div>
          )
          continue
        }
        const raw = cell.value
        const isFormula = typeof raw === 'string' && raw[0] === '='
        let role = cell.role
        if (!role && isFormula) role = 'formula'
        const style = fills[role] || fills.normal
        const display = isFormula ? fmtNumber(computed(sheetName, addr), cell.format) : fmtNumber(raw, cell.format)
        const numRight = NUM_FORMATS.includes(cell.format)
        // Excel-style overflow: a LEFT-aligned text value (not a number, which
        // stays right-aligned) that overruns its cell spills into the empty
        // cells to its right. The painted cell stays clipped + individually
        // selectable; a pointer-through overlay (added after the row loop, like
        // band text) carries the full text across the empty run.
        const overflow = !numRight && !style.bg && display ? emptyRunRight(r, c) : 0
        if (overflow) overlays.push({ r, c, text: display, span: overflow + 1, color: style.fg || INK })
        rowCells.push(
          <div key={addr} {...common}
            className={`flex items-center px-2 text-xs truncate border-r border-b border-[#eee] cursor-cell shrink-0 ${numRight ? 'justify-end' : ''}`}
            style={cellStyle(r, c, { background: style.bg || '#fff', color: style.fg || INK })}>
            {overflow ? '' : display}
          </div>
        )
      }
    }
    // text-overflow overlays: anchored at the source cell, spilling rightward
    // across the empty run, pointer-events:none so clicks reach the cells below
    for (const o of overlays) {
      rowCells.push(
        <div key={`ov${o.r}-${o.c}`} aria-hidden
          className="absolute flex items-center px-2 text-xs whitespace-nowrap overflow-hidden pointer-events-none"
          style={{ left: GUTTER_W + o.c * COL_W, width: COL_W * o.span, height: ROW_H, color: o.color }}>
          {o.text}
        </div>
      )
    }
    // rows are position:relative so band text and overflow overlays anchor
    rows.push(<div key={`r${r}`} className={`flex ${band || overlays.length ? 'relative' : ''}`}>{rowCells}</div>)
  }

  const colHeader = [
    <div key="corner" className="sticky left-0 z-20 bg-[#ececec] border-r border-b border-[#d5d5d5] shrink-0" style={{ width: GUTTER_W, height: ROW_H }} />,
  ]
  for (let c = 0; c < totalCols; c++) {
    colHeader.push(
      <div key={`ch${c}`} onMouseDown={(e) => selectCol(c, e.shiftKey)}
        className="flex items-center justify-center text-[10px] font-medium text-[#7a7a7a] bg-[#ececec] border-r border-b border-[#d5d5d5] select-none shrink-0 cursor-pointer hover:bg-[#e0e0e0]"
        style={{ width: COL_W, height: ROW_H }}>
        {colLetter(c)}
      </div>
    )
  }

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={() => { dragging.current = true }}
      onMouseUp={() => { dragging.current = false }}
      onMouseLeave={() => { dragging.current = false }}
      className="h-full w-full overflow-auto bg-white outline-none select-none"
    >
      <div className="inline-block min-w-full">
        <div className="flex sticky top-0 z-20">{colHeader}</div>
        {rows}
      </div>
    </div>
  )
}

// Stats over the current selection's numeric cells (Sum/Avg/Min/Max/Count),
// shown in the studio footer like Excel/Sheets (Image #33).
function selectionStats(mat, computed, sheetName, sel) {
  if (!sel) return null
  const r1 = Math.min(sel.r1, sel.r2), r2 = Math.max(sel.r1, sel.r2)
  const c1 = Math.min(sel.c1, sel.c2), c2 = Math.max(sel.c1, sel.c2)
  if (r1 === r2 && c1 === c2) return null // single cell: no stats

  const nums = []          // numeric values (non-date)
  const dates = []         // parsed date timestamps
  let count = 0            // total non-empty cells (any type)
  let anyDate = false, anyNum = false, anyText = false

  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const addr = `${colLetter(c)}${r}`
      const cell = mat.cells.get(addr)
      if (!cell || cell.header) continue
      const v = typeof cell.value === 'string' && cell.value[0] === '=' ? computed(sheetName, addr) : cell.value
      if (v === '' || v == null) continue
      count++
      const isDateFmt = cell.format === 'date' || cell.format === 'datetime'
      if (isDateFmt) {
        const t = Date.parse(v)
        if (!isNaN(t)) { dates.push(t); anyDate = true; continue }
      }
      const n = Number(v)
      if (!isNaN(n) && v !== true && v !== false) { nums.push(n); anyNum = true }
      else anyText = true
    }
  }
  if (!count) return null

  // choose the stat set by the dominant content type of the selection
  if (anyNum && !anyDate) {
    const sum = nums.reduce((a, b) => a + b, 0)
    return { kind: 'number', sum, avg: sum / nums.length, min: Math.min(...nums), max: Math.max(...nums), count }
  }
  if (anyDate && !anyNum) {
    // Date.parse("2024-01-05") is UTC midnight; format in UTC too, else a
    // negative-offset locale (e.g. -03:00 BR) shifts it to the previous day.
    const fmt = (t) => new Date(t).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
    return { kind: 'date', min: fmt(Math.min(...dates)), max: fmt(Math.max(...dates)), count }
  }
  // mixed, or pure text → just a count (Excel behaviour for text selections)
  return { kind: 'text', count }
}

// Rich feedback while an AI tweak runs: a soft overlay on the grid with a
// spinner, the user's own instruction echoed back, and rotating step messages
// (the request is one synchronous call, so these are indicative, not literal
// progress — but they make the wait legible instead of a bare "Aplicando…").
const TWEAK_STEP_KEYS = [
  'sheetStudio.step.reading',
  'sheetStudio.step.applying',
  'sheetStudio.step.rewriting',
  'sheetStudio.step.validating',
  'sheetStudio.step.almost',
]
function TweakOverlay({ instruction, scope }) {
  const t = useT()
  const [step, setStep] = useState(0)
  useEffect(() => {
    setStep(0)
    const id = setInterval(() => setStep((s) => Math.min(s + 1, TWEAK_STEP_KEYS.length - 1)), 1400)
    return () => clearInterval(id)
  }, [instruction])
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-[var(--bg)]/70 backdrop-blur-[2px] animate-fade-in">
      <div className="w-[min(420px,86%)] rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-5 shadow-2xl">
        <div className="flex items-center gap-2.5 mb-3">
          <span className="inline-block w-4 h-4 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
          <span className="text-sm font-semibold text-[var(--text)]">{t('sheetStudio.editingWithAI')}</span>
          <span className="ml-auto text-[11px] text-[var(--faint)]">
            {scope === 'workbook' ? t('sheetStudio.scopeWholeWorkbook') : t('sheetStudio.scopeSheet', { name: scope })}
          </span>
        </div>
        <div className="rounded-xl bg-[var(--surface)] border border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)] italic mb-3 max-h-24 overflow-auto">
          “{instruction}”
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
          {t(TWEAK_STEP_KEYS[step])}
        </div>
      </div>
    </div>
  )
}

export default function SpreadsheetStudio({ open, spreadsheetId, onClose, pushToast, models, model }) {
  const t = useT()
  const [spec, setSpec] = useState(null)
  const [template, setTemplate] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [loadTick, setLoadTick] = useState(0)
  const [active, setActive] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [tweak, setTweak] = useState('')
  const [tweakWhole, setTweakWhole] = useState(false)
  const [tweaking, setTweaking] = useState(false)
  const [saving, setSaving] = useState(false) // persisting an accepted preview
  const tweakImages = usePromptImages()
  const tweakImageInput = useRef(null)
  const [lastInstruction, setLastInstruction] = useState('')
  const [flash, setFlash] = useState(false) // brief success flash after a tweak
  const [tweakCost, setTweakCost] = useState(null) // { usage, model } of the last AI edit
  // Pending AI edit shown in the grid with Accept/Discard. null = none. The edit
  // is NOT persisted until accepted (server ran it in preview mode), so closing
  // or discarding leaves the saved workbook untouched.
  const [tweakPreview, setTweakPreview] = useState(null) // null | { before, label }
  // selection is a range { r1,c1,r2,c2, ar,ac } in grid coords (ar/ac = active
  // cell). null = nothing selected. Reset when the sheet changes.
  const [sel, setSel] = useState(null)
  const [showCharts, setShowCharts] = useState(false)

  useEffect(() => {
    if (!open || !spreadsheetId) return
    setLoading(true)
    setLoadError(null)
    setActive(0)
    setSel(null)
    setTweakPreview(null)
    Promise.all([getJSON(`/api/spreadsheets/${spreadsheetId}`), getJSON('/api/deck-templates/selected')])
      .then(([s, t]) => {
        setSpec(s.spreadsheet)
        setTemplate(t.template || null)
      })
      .catch((e) => setLoadError(e.message || t('sheetStudio.loadError')))
      .finally(() => setLoading(false))
  }, [open, spreadsheetId, loadTick])

  const th = useMemo(() => resolveDeckTheme(template), [template])
  const fills = useMemo(() => roleFills(th), [th])
  const chartColors = useMemo(() => [th.accent, th.secondary, th.primary, '#FF6A00', '#7C6FF0', '#98A2B3'], [th])

  // build the evaluated model whenever the spec changes
  const wbModel = useMemo(() => (spec ? materializeWorkbook(spec) : null), [spec])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !tweaking) onClose?.() }
    if (open) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, tweaking])

  useEffect(() => { setSel(null) }, [active])

  if (!open) return null

  const sheets = spec?.sheets || []
  const sheet = sheets[Math.min(active, sheets.length - 1)] || null
  const sheetName = sheet?.name
  const mat = wbModel && sheetName ? wbModel.sheets[sheetName] : null

  // formula-bar content for the ACTIVE cell — the RESOLVED A1 formula
  // (=B5-B6, =SUMIFS('Aba'!$E:$E,…)), the exact text the exported .xlsx carries.
  // The name box shows a single ref (A1) or a range (A1:C4).
  let barRef = ''
  let barContent = ''
  if (sel && mat) {
    const activeAddr = `${colLetter(sel.ac)}${sel.ar}`
    const r1 = Math.min(sel.r1, sel.r2), r2 = Math.max(sel.r1, sel.r2)
    const c1 = Math.min(sel.c1, sel.c2), c2 = Math.max(sel.c1, sel.c2)
    barRef = (r1 === r2 && c1 === c2) ? activeAddr : `${colLetter(c1)}${r1}:${colLetter(c2)}${r2}`
    const cell = mat.cells.get(activeAddr)
    if (cell) {
      if (typeof cell.value === 'string' && cell.value[0] === '=') {
        barContent = wbModel.formulaA1(sheetName, activeAddr) || cell.value
      } else if (cell.value != null) {
        barContent = String(cell.value)
      }
    }
  }
  const stats = sel && mat ? selectionStats(mat, wbModel.computed, sheetName, sel) : null

  const exportXlsx = async () => {
    setExporting(true)
    try {
      const res = await fetch(`/api/spreadsheets/${spreadsheetId}/export`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(spec.title || 'planilha').replace(/[^\w-]+/g, '_').slice(0, 60)}.xlsx`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      pushToast?.(e.message || t('sheetStudio.exportError'))
    } finally {
      setExporting(false)
    }
  }

  // Run the AI edit in PREVIEW mode: the server returns the revised workbook
  // WITHOUT saving it. We show it in the grid and offer Accept/Discard — the
  // change only reaches the database once the user accepts (acceptTweak).
  const runTweak = async () => {
    const instruction = tweak.trim()
    if (!instruction || tweaking || saving) return
    setLastInstruction(instruction)
    setTweaking(true)
    try {
      const body = { instruction, model, preview: true }
      if (!tweakWhole) body.sheetIndex = active
      // spreadsheets only use images as VISUAL REFERENCE (no insertion), so send
      // the raster vision copy — the model can't consume SVG directly.
      if (tweakImages.images.length) body.images = tweakImages.images.map((im) => ({ dataUrl: im.visionUrl }))
      const r = await postJSON(`/api/spreadsheets/${spreadsheetId}/tweak`, body)
      if (r.spreadsheet) {
        setTweakPreview({ before: spec, label: instruction })
        setSpec(r.spreadsheet)
        setTweak('')
        tweakImages.clear()
        setSel(null)
        if (r.usage) setTweakCost({ usage: r.usage, model: r.model })
      }
    } catch (e) {
      pushToast?.(e.message || t('sheetStudio.tweakError'))
    } finally {
      setTweaking(false)
    }
  }

  // Accept the pending edit → persist it (PATCH revalidates + saves). Kept as a
  // separate step so an AI change is never written to the workbook the user
  // didn't confirm — and, once confirmed, it IS saved (never silently lost).
  const acceptTweak = async () => {
    if (!tweakPreview || tweaking || saving) return
    setSaving(true)
    try {
      const body = { title: spec.title, sheets: spec.sheets }
      if (spec.instructions) body.instructions = spec.instructions
      const r = await patchJSON(`/api/spreadsheets/${spreadsheetId}`, body)
      if (r.spreadsheet) setSpec(r.spreadsheet)
      setTweakPreview(null)
      setFlash(true)
      setTimeout(() => setFlash(false), 1400)
    } catch (e) {
      pushToast?.(e.message || t('sheetStudio.saveError'))
    } finally {
      setSaving(false)
    }
  }

  // Discard the pending edit → restore the pre-edit workbook (nothing was saved).
  const discardTweak = () => {
    if (!tweakPreview || saving) return
    setSpec(tweakPreview.before)
    setTweakPreview(null)
    setTweakCost(null)
    setSel(null)
  }

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-[var(--bg)] animate-fade-in">
      {/* toolbar */}
      <header className="shrink-0 h-14 flex items-center gap-3 px-4 border-b border-[var(--border)]">
        <button onClick={onClose} className="p-2 -ml-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]" title={t('sheetStudio.close')}>
          <Icon.Close size={20} />
        </button>
        <Icon.SpreadsheetFile size={18} className="text-[var(--accent)]" />
        <span className="font-semibold text-sm truncate max-w-md">{spec?.title || t('sheetStudio.title')}</span>
        <button
          onClick={exportXlsx}
          disabled={!spec || exporting}
          className="ml-auto flex items-center gap-1.5 rounded-xl bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white font-semibold text-sm px-3.5 py-2 transition"
        >
          <Icon.Download size={15} /> {exporting ? t('sheetStudio.exporting') : t('sheetStudio.exportXlsx')}
        </button>
      </header>

      {loading && <div className="flex-1 grid place-items-center text-sm text-[var(--muted)]">{t('sheetStudio.loading')}</div>}
      {loadError && !loading && (
        <div className="flex-1 grid place-items-center">
          <div className="text-center">
            <div className="text-sm text-[var(--muted)] mb-3">{loadError}</div>
            <button onClick={() => setLoadTick((n) => n + 1)} className="rounded-xl bg-[var(--accent)] text-white text-sm px-4 py-2">{t('sheetStudio.retry')}</button>
          </div>
        </div>
      )}

      {spec && !loading && (
        <div className="flex-1 min-h-0 flex flex-col md:flex-row">
          {/* main preview area */}
          <div className="flex-1 min-w-0 flex flex-col relative">
            {/* formula bar */}
            <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface-2)]">
              <span className="inline-flex items-center justify-center min-w-[44px] h-6 px-2 rounded bg-[var(--surface)] border border-[var(--border)] text-[11px] font-mono text-[var(--muted)]">
                {barRef || '—'}
              </span>
              <span className="text-[var(--faint)] text-xs italic mr-1">fx</span>
              <div className={`flex-1 truncate text-xs ${barContent.startsWith('=') ? 'font-mono' : ''} text-[var(--text)]`}>
                {barContent || <span className="text-[var(--faint)]">{t('sheetStudio.selectCellHint')}</span>}
              </div>
              {sheet?.charts?.length > 0 && (
                <button
                  onClick={() => setShowCharts((v) => !v)}
                  className={`shrink-0 text-[11px] px-2 py-1 rounded-lg border transition ${showCharts ? 'bg-[var(--accent)] text-white border-transparent' : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]'}`}
                >
                  {sheet.charts.length === 1 ? t('sheetStudio.chartCountOne', { n: sheet.charts.length }) : t('sheetStudio.chartCountMany', { n: sheet.charts.length })}
                </button>
              )}
            </div>

            {/* sheet tabs */}
            <div className="shrink-0 flex flex-wrap items-center gap-1 px-3 py-2 border-b border-[var(--border)]">
              {sheets.map((s, i) => (
                <button
                  key={i}
                  disabled={tweaking}
                  onClick={() => setActive(i)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition disabled:opacity-50 ${i === active ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--text)]'}`}
                >
                  {s.name}
                </button>
              ))}
            </div>

            {/* the grid fills all remaining space */}
            <div className="flex-1 min-h-0 relative">
              {sheet && mat && (
                <GridView
                  mat={mat}
                  computed={wbModel.computed}
                  sheetName={sheetName}
                  fills={fills}
                  th={th}
                  sel={sel}
                  setSel={setSel}
                />
              )}

              {/* charts overlay panel (toggled) */}
              {showCharts && sheet?.charts?.length > 0 && (
                <div className="absolute right-3 top-3 bottom-3 w-[380px] max-w-[46%] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 shadow-2xl">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-[var(--muted)]">{t('sheetStudio.charts')}</span>
                    <button onClick={() => setShowCharts(false)} className="p-1 rounded text-[var(--faint)] hover:text-[var(--text)]"><Icon.Close size={14} /></button>
                  </div>
                  {sheet.charts.map((c, i) => <SheetChart key={i} sheet={sheet} chart={c} colors={chartColors} computed={wbModel.computed} sheetName={sheetName} />)}
                </div>
              )}

              {/* AI-editing overlay: rich feedback while a tweak runs */}
              {tweaking && <TweakOverlay instruction={lastInstruction} scope={tweakWhole ? 'workbook' : sheetName} />}
            </div>

            {/* stats footer over the selected range (Excel/Sheets-style) —
                números: Soma/Média/Mín/Máx/Contagem; datas: Mín/Máx/Contagem;
                texto/misto: só Contagem */}
            <div className="shrink-0 h-8 flex items-center gap-4 px-3 border-t border-[var(--border)] bg-[var(--surface-2)] text-[11px] text-[var(--muted)]">
              {stats ? (
                <>
                  {stats.kind === 'number' && (
                    <>
                      <Stat label={t('sheetStudio.stat.sum')} value={fmtStat(stats.sum)} />
                      <Stat label={t('sheetStudio.stat.avg')} value={fmtStat(stats.avg)} />
                      <Stat label={t('sheetStudio.stat.min')} value={fmtStat(stats.min)} />
                      <Stat label={t('sheetStudio.stat.max')} value={fmtStat(stats.max)} />
                    </>
                  )}
                  {stats.kind === 'date' && (
                    <>
                      <Stat label={t('sheetStudio.stat.min')} value={stats.min} />
                      <Stat label={t('sheetStudio.stat.max')} value={stats.max} />
                    </>
                  )}
                  <Stat label={t('sheetStudio.stat.count')} value={stats.count} />
                </>
              ) : (
                <span className="text-[var(--faint)]">{t('sheetStudio.statsHint')}</span>
              )}
            </div>
          </div>

          {/* AI tweak sidebar */}
          <aside className="shrink-0 md:w-[340px] border-t md:border-t-0 md:border-l border-[var(--border)] p-4 flex flex-col gap-3 bg-[var(--surface-2)]">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Icon.Sparkle size={16} className="text-[var(--accent)]" /> {t('sheetStudio.editWithAI')}
            </div>
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              {t('sheetStudio.aiIntro')}
            </p>

            {tweakPreview ? (
              /* pending AI edit: review it live in the grid, then confirm to save */
              <div className="rounded-xl border border-[var(--accent)]/40 bg-[var(--accent-soft)] p-3 flex flex-col gap-2">
                <div className="text-xs text-[var(--text)]">
                  {t('sheetStudio.tweak.previewLabel', { label: tweakPreview.label })}
                </div>
                <p className="text-[11px] text-[var(--muted)] leading-relaxed">{t('sheetStudio.tweak.reviewHint')}</p>
                {tweakCost && (
                  <CostBadge usage={tweakCost.usage} model={tweakCost.model} models={models} className="text-[11px]" />
                )}
                <div className="flex gap-2 mt-0.5">
                  <button
                    onClick={discardTweak}
                    disabled={saving}
                    className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-3)] text-[var(--muted)] text-xs font-medium py-1.5 disabled:opacity-50"
                  >
                    {t('sheetStudio.tweak.discard')}
                  </button>
                  <button
                    onClick={acceptTweak}
                    disabled={saving}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] hover:brightness-110 text-white text-xs font-semibold py-1.5 disabled:opacity-50"
                  >
                    {saving
                      ? <span className="inline-block w-3 h-3 rounded-full border-2 border-white/70 border-t-transparent animate-spin" />
                      : <Icon.Check size={13} />}
                    {t('sheetStudio.tweak.accept')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* scope: a clean segmented control (replaces the cramped checkbox) */}
                <div>
                  <div className="text-[11px] font-medium text-[var(--muted)] mb-1.5">{t('sheetStudio.applyTo')}</div>
                  <div className="flex rounded-xl bg-[var(--surface)] border border-[var(--border)] p-0.5 text-xs">
                    <button
                      onClick={() => setTweakWhole(false)}
                      disabled={tweaking}
                      className={`flex-1 truncate rounded-lg px-2.5 py-1.5 font-medium transition disabled:opacity-50 ${!tweakWhole ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}
                      title={t('sheetStudio.onlySheet', { name: sheet?.name })}
                    >
                      {t('sheetStudio.sheetTab', { name: sheet?.name })}
                    </button>
                    <button
                      onClick={() => setTweakWhole(true)}
                      disabled={tweaking}
                      className={`flex-1 rounded-lg px-2.5 py-1.5 font-medium transition disabled:opacity-50 ${tweakWhole ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)] hover:text-[var(--text)]'}`}
                    >
                      {t('sheetStudio.workbook')}
                    </button>
                  </div>
                </div>

                <PromptImageStrip images={tweakImages.images} onRemove={tweakImages.removeAt} />
                <div className="relative">
                  <textarea
                    value={tweak}
                    onChange={(e) => setTweak(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runTweak() }}
                    onPaste={tweakImages.onPaste}
                    placeholder={t('sheetStudio.describeChange')}
                    rows={4}
                    disabled={tweaking}
                    className="w-full resize-none rounded-xl bg-[var(--surface)] border border-[var(--border)] px-3 py-2 pr-9 text-sm outline-none focus:border-[var(--accent)] disabled:opacity-60"
                  />
                  <button
                    onClick={() => tweakImageInput.current?.click()}
                    disabled={tweaking}
                    className="absolute top-2 right-2 p-1 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-50 transition"
                    title={t('sheetStudio.attachImage')}
                  >
                    <Icon.Paperclip size={16} />
                  </button>
                  <input
                    ref={tweakImageInput}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => { tweakImages.addFiles(e.target.files); e.target.value = '' }}
                  />
                </div>
                <button
                  onClick={runTweak}
                  disabled={(!tweak.trim() && !tweakImages.images.length) || tweaking}
                  className="flex items-center justify-center gap-2 rounded-xl bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white font-semibold text-sm py-2.5 transition"
                >
                  {tweaking ? (
                    <><span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-white/70 border-t-transparent animate-spin" /> {t('sheetStudio.applying')}</>
                  ) : (
                    <><Icon.Send size={14} /> {t('sheetStudio.apply')} <span className="opacity-60 text-[11px] font-normal">{SUBMIT_CHORD}</span></>
                  )}
                </button>
              </>
            )}

            {flash && !tweaking && (
              <div className="flex items-center gap-1.5 text-xs text-[var(--accent)] animate-fade-in">
                <Icon.Check size={14} /> {t('sheetStudio.updated')}
                {tweakCost && (
                  <CostBadge usage={tweakCost.usage} model={tweakCost.model} models={models} className="text-[11px]" />
                )}
              </div>
            )}

            <div className="text-[11px] text-[var(--faint)] mt-auto leading-relaxed">
              {t('sheetStudio.footerNotePre')}<span className="font-medium">{t('sheetStudio.footerNoteTab')}</span>{t('sheetStudio.footerNotePost')}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
