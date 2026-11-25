import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import * as Icon from './Icons.tsx'
import { useT, useI18n } from '../lib/i18n.tsx'
import { fmtNumber, fmtStat } from '../lib/sheetFormat.ts'
import { INSTRUCTIONS_SHEET_NAME } from '../../../shared/sheetInstructions.js'
import { notifyUsageChanged } from './CostMeter.tsx'
import { usePromptImages } from '../hooks/usePromptImages.ts'
import { getJSON, postJSON, patchJSON } from '../api.ts'
import { resolveDeckTheme, blend, contrastOn } from '../../../shared/deckTheme.js'
import type { DeckTemplate, DeckTheme } from '../../../shared/deckTheme.js'
import type { MaterializedSheet, SheetSpec, WorkbookSpec } from '../../../shared/sheetModel.js'
import { materializeWorkbook, colLetter } from '../lib/sheetEval.ts'
import ChartBlock from './blocks/ChartBlock.tsx'
import StudioAIPanel from './studio/StudioAIPanel.tsx'
import StudioExportMenu from './studio/StudioExportMenu.tsx'
import { sheetChartToBlock, chartValueResolver } from './studio/sheetChart.ts'
import { SaveStatus, StudioHeader, StudioIconButton, studioPanelClass, useHistoryBack, useIsMobile, useIsOverlay, useSaveStatus, useStudioDialog } from './studio/StudioChrome.tsx'

// useT()/useI18n() come from i18n.jsx (untyped JS), which infers a one-argument `t`.
type Translate = (key: string, vars?: Record<string, unknown>) => string

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
//
// Layout (design.md §2.7): a panel docked beside the chat above 1100 px, a modal
// overlay from the right at ≤ 1100 px and a full screen on phones. Header, the
// formula bar, the grid with AI quick actions that appear over the current
// selection, the selection stats, the sheet tabs with the cell-colour legend,
// and the shared AI ask bar. No versions, comments or editable cells (Q12-A).

// The sheet "paper" previews the exported .xlsx, so it keeps the workbook's own
// colours in both app themes (white sheet, near-black ink — what Excel shows).
// These two are DATA, like the DS-derived role fills; the app chrome around
// the grid (gutter, column letters, panels) uses theme tokens.
/* data: sheet paper and ink are the printed cell colours, not UI chrome */
const PAPER = '#FFFFFF'
const INK = '#1A1A1A'
/* data:end */
const GRID_LINE = blend(INK, PAPER, 0.9)
const NOTE_INK = blend(INK, PAPER, 0.4)
interface Fill {
  bg: string | null
  fg: string
}

// selection range in grid coords (ar/ac = the active cell)
interface Sel {
  r1: number
  c1: number
  r2: number
  c2: number
  ar: number
  ac: number
  ncols?: number
}

type Evaluated = ReturnType<typeof materializeWorkbook>

interface SheetDto extends SheetSpec {
  charts?: Array<Record<string, unknown>>
}

interface SpreadsheetDto extends WorkbookSpec {
  title?: string
  instructions?: string
  sheets?: SheetDto[]
}

interface TweakCost {
  usage: Record<string, number>
  model: string
}

interface TweakPreview {
  before: SpreadsheetDto | null
  label: string
}

interface SpreadsheetStudioProps {
  open?: boolean
  spreadsheetId?: number | string | null
  onClose?: () => void
  pushToast?: (message: string) => void
  models?: Array<{ id: string; in?: number; out?: number }>
  model?: string
  /** moves the chat into a project and opens its members; the button shows only when this is passed */
  onShare?: () => void
}

function roleFills(th: DeckTheme): Record<string, Fill> {
  return {
    input: { bg: blend(th.secondary, PAPER, 0.82), fg: INK },
    key: { bg: blend(th.accent, PAPER, 0.82), fg: INK },
    formula: { bg: blend(th.primary, PAPER, 0.9), fg: INK },
    link: { bg: null, fg: th.accent },
    normal: { bg: null, fg: INK },
  }
}
const NUM_FORMATS = ['currency', 'usd', 'eur', 'percent', 'percent0', 'integer', 'number']

function cellParts(raw: unknown) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as { v?: unknown; role?: string; format?: string; name?: string }
    return { value: o.v, role: o.role, format: o.format, name: o.name }
  }
  return { value: raw, role: undefined, format: undefined, name: undefined }
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span><span className="text-[var(--faint)]">{label}:</span> <span className="font-semibold text-[var(--text)]">{value}</span></span>
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
interface GridViewProps {
  mat: MaterializedSheet
  computed: Evaluated['computed']
  sheetName: string
  fills: Record<string, Fill>
  th: DeckTheme
  sel: Sel | null
  setSel: Dispatch<SetStateAction<Sel | null>>
  /** Esc in the grid: returns true when it dismissed something (so the studio stays open) */
  onEscape?: () => boolean
}

function GridView({ mat, computed, sheetName, fills, th, sel, setSel, onEscape }: GridViewProps) {
  const { locale } = useI18n()
  const { maxCols, maxRow, bands } = mat
  const bandByRow = new Map(bands.map((b) => [b.row, b]))
  const secBg = blend(th.secondary, th.primary, 0.15)

  const wrapRef = useRef<HTMLDivElement>(null)
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
  const inSel = (r: number, c: number) => sel && r >= Math.min(sel.r1, sel.r2) && r <= Math.max(sel.r1, sel.r2) && c >= Math.min(sel.c1, sel.c2) && c <= Math.max(sel.c1, sel.c2)
  const isActive = (r: number, c: number) => sel && sel.ar === r && sel.ac === c
  // which OUTER edges of the selection rectangle a given in-range cell touches —
  // used to paint one continuous accent border around the whole range (not just
  // a background tint on the active cell, which read as "only A1 is selected")
  const selEdges = (r: number, c: number) => {
    if (!sel) return null
    const r1 = Math.min(sel.r1, sel.r2), r2 = Math.max(sel.r1, sel.r2)
    const c1 = Math.min(sel.c1, sel.c2), c2 = Math.max(sel.c1, sel.c2)
    return { top: r === r1, bottom: r === r2, left: c === c1, right: c === c2 }
  }
  const isRange = sel && (Math.min(sel.r1, sel.r2) !== Math.max(sel.r1, sel.r2) || Math.min(sel.c1, sel.c2) !== Math.max(sel.c1, sel.c2))

  // set active cell (and collapse selection unless extending)
  const pick = (r: number, c: number, { extend = false }: { extend?: boolean } = {}) => {
    setSel((prev) => {
      if (extend && prev) return { ...prev, r2: r, c2: c, ar: prev.ar, ac: prev.ac, ncols: totalCols }
      return { r1: r, c1: c, r2: r, c2: c, ar: r, ac: c, ncols: totalCols }
    })
  }
  const selectRow = (r: number, extend: boolean) => setSel((prev) => extend && prev ? { ...prev, r2: r, c1: 0, c2: totalCols - 1 } : { r1: r, c1: 0, r2: r, c2: totalCols - 1, ar: r, ac: 0, ncols: totalCols })
  const selectCol = (c: number, extend: boolean) => setSel((prev) => extend && prev ? { ...prev, c2: c, r1: 1, r2: totalRows } : { r1: 1, c1: c, r2: totalRows, c2: c, ar: 1, ac: c, ncols: totalCols })

  // Cmd/Ctrl+arrow: jump to the far edge of the contiguous data block in a
  // direction (Excel behaviour, simplified: go to last non-empty then edge).
  const nonEmpty = (r: number, c: number) => {
    if (r < 1 || c < 0 || c >= maxCols) return false
    const cell = mat.cells.get(`${colLetter(c)}${r}`)
    if (!cell) return false
    const v = cell.value
    return v != null && v !== '' && !cell.header
  }
  // any content (incl. headers) in a cell — used to decide Excel-style text
  // overflow: a left-aligned text cell spills into the empty cells to its right
  // and clips as soon as a neighbour has content
  const cellHasAnything = (r: number, c: number) => {
    if (c < 0 || c >= maxCols) return false
    const cell = mat.cells.get(`${colLetter(c)}${r}`)
    return !!cell && cell.value != null && cell.value !== ''
  }
  // how many empty columns follow (r,c) — the text may overflow across them
  const emptyRunRight = (r: number, c: number) => {
    let n = 0
    for (let cc = c + 1; cc < totalCols && !cellHasAnything(r, cc); cc++) n++
    return n
  }
  const jump = (r: number, c: number, dr: number, dc: number): [number, number] => {
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

  // where a keyboard user lands when nothing is selected yet: the first row
  // with data cells (bands such as the title are skipped), column A
  const firstDataCell = (): [number, number] => {
    for (let r = 1; r <= maxRow; r++) {
      if (bandByRow.has(r)) continue
      for (let c = 0; c < maxCols; c++) if (mat.cells.has(`${colLetter(c)}${r}`)) return [r, c]
    }
    return [1, 0]
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // dismiss the selection actions first; the event is consumed so the studio stays open
      if (onEscape?.()) e.preventDefault()
      return
    }
    const dirs: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    const d = dirs[e.key]
    if (!d) return
    e.preventDefault()
    if (!sel) {
      // the first arrow selects a cell (like a click), it does not move yet
      const [r, c] = firstDataCell()
      pick(r, c)
      wrapRef.current?.querySelector(`[data-rc="${r}-${c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      return
    }
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

  const cellStyle = (r: number, c: number, base: React.CSSProperties): React.CSSProperties => {
    const active = isActive(r, c)
    const within = inSel(r, c)
    // build box-shadow layers: a tint fill for every in-range cell + accent
    // segments on whichever outer edges of the range this cell sits on, so the
    // whole selection carries one crisp rectangle (Excel/Sheets-style)
    const shadows = []
    if (within && !active) shadows.push(`inset 0 0 0 9999px ${th.accent}1f`)
    if (isRange && within) {
      const e = selEdges(r, c)! // `within` implies a selection
      const w = 2
      if (e.top) shadows.push(`inset 0 ${w}px 0 ${th.accent}`)
      if (e.bottom) shadows.push(`inset 0 -${w}px 0 ${th.accent}`)
      if (e.left) shadows.push(`inset ${w}px 0 0 ${th.accent}`)
      if (e.right) shadows.push(`inset -${w}px 0 0 ${th.accent}`)
    }
    return {
      ...base,
      width: COL_W, height: ROW_H, borderColor: GRID_LINE,
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
        className="sticky left-0 z-raised flex items-center justify-center text-caption text-faint bg-surface-2 border-r border-b border-border select-none shrink-0 cursor-pointer hover:bg-surface-3"
        /* data */ style={{ width: GUTTER_W, height: ROW_H }}>
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
          : { background: PAPER, color: NOTE_INK }
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
            className="border-r border-b shrink-0"
            /* data */ style={cellStyle(r, c, painted ? { background: bandStyle.background } : { background: PAPER })} />
        )
      }
      // text overlay, anchored at the first data column, overflowing rightward
      rowCells.push(
        <div key={`bt${r}`} aria-hidden
          className={`absolute flex items-center px-2 text-label whitespace-nowrap pointer-events-none ${isTitle || isSection ? 'font-bold' : 'italic'}`}
          /* data */ style={{ left: GUTTER_W, height: ROW_H, color: bandStyle.color, fontSize: isTitle ? 13 : 12 }}>
          {band.text}
        </div>
      )
    } else {
      for (let c = 0; c < totalCols; c++) {
        const addr = `${colLetter(c)}${r}`
        const cell = c < maxCols ? mat.cells.get(addr) : null
        const common = {
          'data-rc': `${r}-${c}`,
          onMouseDown: (e: React.MouseEvent) => pick(r, c, { extend: e.shiftKey }),
          onMouseEnter: () => dragging.current && pick(r, c, { extend: true }),
        }
        if (!cell) {
          rowCells.push(<div key={addr} {...common} className="border-r border-b shrink-0" /* data */ style={cellStyle(r, c, { background: PAPER })} />)
          continue
        }
        if (cell.header) {
          rowCells.push(
            <div key={addr} {...common} className="flex items-center px-2 text-label font-semibold truncate border-r border-b shrink-0"
              /* data */ style={cellStyle(r, c, { background: th.accent, color: th.onAccent })}>
              {cell.value as React.ReactNode}
            </div>
          )
          continue
        }
        const raw = cell.value
        const isFormula = typeof raw === 'string' && raw[0] === '='
        let role = cell.role
        if (!role && isFormula) role = 'formula'
        const style = fills[role as string] || fills.normal!
        const display = isFormula ? fmtNumber(computed(sheetName, addr), cell.format, locale) : fmtNumber(raw, cell.format, locale)
        const numRight = NUM_FORMATS.includes(cell.format as string)
        // Excel-style overflow: a LEFT-aligned text value (not a number, which
        // stays right-aligned) that overruns its cell spills into the empty
        // cells to its right. The painted cell stays clipped + individually
        // selectable; a pointer-through overlay (added after the row loop, like
        // band text) carries the full text across the empty run.
        const overflow = !numRight && !style.bg && display ? emptyRunRight(r, c) : 0
        if (overflow) overlays.push({ r, c, text: display, span: overflow + 1, color: style.fg || INK })
        rowCells.push(
          <div key={addr} {...common}
            className={`flex items-center px-2 text-label truncate border-r border-b cursor-cell shrink-0 ${numRight ? 'justify-end' : ''}`}
            /* data */ style={cellStyle(r, c, { background: style.bg || PAPER, color: style.fg || INK })}>
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
          className="absolute flex items-center px-2 text-label whitespace-nowrap overflow-hidden pointer-events-none"
          /* data */ style={{ left: GUTTER_W + o.c * COL_W, width: COL_W * o.span, height: ROW_H, color: o.color }}>
          {o.text}
        </div>
      )
    }
    // rows are position:relative so band text and overflow overlays anchor
    rows.push(<div key={`r${r}`} className={`flex ${band || overlays.length ? 'relative' : ''}`}>{rowCells}</div>)
  }

  const colHeader = [
    <div key="corner" className="sticky left-0 z-sticky bg-surface-3 border-r border-b border-border shrink-0" /* data */ style={{ width: GUTTER_W, height: ROW_H }} />,
  ]
  for (let c = 0; c < totalCols; c++) {
    colHeader.push(
      <div key={`ch${c}`} onMouseDown={(e) => selectCol(c, e.shiftKey)}
        className="flex items-center justify-center text-caption font-medium text-muted bg-surface-3 border-r border-b border-border select-none shrink-0 cursor-pointer hover:bg-surface-2"
        /* data */ style={{ width: COL_W, height: ROW_H }}>
        {colLetter(c)}
      </div>
    )
  }

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      role="region"
      aria-label={sheetName}
      data-ds-paper
      onKeyDown={onKeyDown}
      onMouseDown={() => { dragging.current = true }}
      onMouseUp={() => { dragging.current = false }}
      onMouseLeave={() => { dragging.current = false }}
      className="h-full w-full overflow-auto select-none"
      /* data */ style={{ background: PAPER }}
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
type SelectionStats =
  | { kind: 'number'; sum: number; avg: number; min: number; max: number; count: number }
  | { kind: 'date'; min: string; max: string; count: number }
  | { kind: 'text'; count: number }

function selectionStats(mat: MaterializedSheet, computed: Evaluated['computed'], sheetName: string, sel: Sel | null): SelectionStats | null {
  if (!sel) return null
  const r1 = Math.min(sel.r1, sel.r2), r2 = Math.max(sel.r1, sel.r2)
  const c1 = Math.min(sel.c1, sel.c2), c2 = Math.max(sel.c1, sel.c2)
  if (r1 === r2 && c1 === c2) return null // single cell: no stats

  const nums: number[] = []          // numeric values (non-date)
  const dates: number[] = []         // parsed date timestamps
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
        const t = Date.parse(v as string)
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
    const fmt = (t: number) => new Date(t).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
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
function TweakOverlay({ instruction, scope }: { instruction: string; scope?: string }) {
  const t = useT() as Translate
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
          <span className="text-body font-semibold text-[var(--text)]">{t('sheetStudio.editingWithAI')}</span>
          <span className="ml-auto text-caption text-[var(--faint)]">
            {scope === 'workbook' ? t('sheetStudio.scopeWholeWorkbook') : t('sheetStudio.scopeSheet', { name: scope })}
          </span>
        </div>
        <div className="rounded-xl bg-[var(--surface)] border border-[var(--border)] px-3 py-2 text-label text-[var(--muted)] italic mb-3 max-h-24 overflow-auto">
          “{instruction}”
        </div>
        <div className="flex items-center gap-2 text-label text-[var(--muted)]">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
          {t(TWEAK_STEP_KEYS[step]!)}
        </div>
      </div>
    </div>
  )
}

export default function SpreadsheetStudio({ open, spreadsheetId, onClose, pushToast, models, model, onShare }: SpreadsheetStudioProps) {
  const t = useT() as Translate
  const { locale } = useI18n()
  const [spec, setSpec] = useState<SpreadsheetDto | null>(null)
  const [template, setTemplate] = useState<DeckTemplate | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadTick, setLoadTick] = useState(0)
  const [active, setActive] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [tweak, setTweak] = useState('')
  const [tweakWhole, setTweakWhole] = useState(false)
  const [tweaking, setTweaking] = useState(false)
  const [saving, setSaving] = useState(false) // persisting an accepted preview
  const tweakImages = usePromptImages()
  const [lastInstruction, setLastInstruction] = useState('')
  const [lastWhole, setLastWhole] = useState(false) // whether the running edit targets the whole workbook
  // accepting an AI edit is the one write here: its status stays visible
  const save = useSaveStatus()
  const live = useRef<{ spec: SpreadsheetDto | null; tweakPreview: TweakPreview | null }>({ spec: null, tweakPreview: null })
  const mobile = useIsMobile()
  const overlay = useIsOverlay() // ≤ 1100 px: the panel floats over the chat as a modal layer
  const rootRef = useRef<HTMLDivElement>(null)
  const askRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [tweakCost, setTweakCost] = useState<TweakCost | null>(null) // { usage, model } of the last AI edit
  // Pending AI edit shown in the grid with Accept/Discard. null = none. The edit
  // is NOT persisted until accepted (server ran it in preview mode), so closing
  // or discarding leaves the saved workbook untouched.
  const [tweakPreview, setTweakPreview] = useState<TweakPreview | null>(null) // null | { before, label }
  // selection is a range { r1,c1,r2,c2, ar,ac } in grid coords (ar/ac = active
  // cell). null = nothing selected. Reset when the sheet changes.
  const [sel, setSel] = useState<Sel | null>(null)
  const [showCharts, setShowCharts] = useState(false)
  // Esc hides the selection actions without clearing the selection; a new selection shows them again
  const [quickOff, setQuickOff] = useState(false)
  const gridBoxRef = useRef<HTMLDivElement>(null)
  const quickRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || !spreadsheetId) return
    setLoading(true)
    setLoadError(null)
    setActive(0)
    setSel(null)
    setTweakPreview(null)
    save.reset()
    Promise.all([getJSON<{ spreadsheet: SpreadsheetDto }>(`/api/spreadsheets/${spreadsheetId}`), getJSON<{ template?: DeckTemplate | null }>('/api/deck-templates/selected')])
      .then(([s, t]) => {
        setSpec(s.spreadsheet)
        setTemplate(t.template || null)
      })
      .catch((e: Error) => setLoadError(e.message || t('sheetStudio.loadError')))
      .finally(() => setLoading(false))
  }, [open, spreadsheetId, loadTick]) // eslint-disable-line react-hooks/exhaustive-deps

  const th = useMemo(() => resolveDeckTheme(template), [template])
  const fills = useMemo(() => roleFills(th), [th])

  // build the evaluated model whenever the spec changes
  const wbModel = useMemo(() => (spec ? materializeWorkbook(spec) : null), [spec])

  // Esc closes the charts panel first; then the studio, but only where it is a
  // modal overlay (the docked panel is not) — unless a field or menu had it
  // first (they stop it), or an AI edit is running
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || tweaking) return
      if (showCharts) return setShowCharts(false)
      if (overlay) onClose?.()
    }
    if (open) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, tweaking, showCharts, overlay])
  // on phones and at ≤ 1100 px the studio covers the app: a modal dialog with its own Tab loop
  useStudioDialog(rootRef, open && overlay, { inertBackground: true })
  useHistoryBack(open && mobile, () => {
    onClose?.()
    return true
  })

  useEffect(() => { setSel(null) }, [active])
  useEffect(() => { setQuickOff(false) }, [sel])

  // Anchor the selection actions to the selected range: just above it (below
  // when there is no room), centred on it and kept inside the grid box. Placed
  // imperatively from the cells' own rects, so it follows scroll and resize.
  useLayoutEffect(() => {
    const box = gridBoxRef.current
    const bar = quickRef.current
    if (!box || !bar || !sel) return undefined
    const place = () => {
      const cell = (r: number, c: number) => box.querySelector(`[data-rc="${r}-${c}"]`)
      const a = cell(Math.min(sel.r1, sel.r2), Math.min(sel.c1, sel.c2))
      const z = cell(Math.max(sel.r1, sel.r2), Math.max(sel.c1, sel.c2))
      if (!a || !z) return
      const B = box.getBoundingClientRect()
      const A = a.getBoundingClientRect()
      const Z = z.getBoundingClientRect()
      const w = bar.offsetWidth
      const h = bar.offsetHeight
      const gap = 8
      const edge = 4
      const minTop = ROW_H + edge // below the column letters
      const maxTop = Math.max(minTop, B.height - h - edge)
      // above the range by default, so the cells a user extends the selection into
      // (down and right) stay clickable; below it only when there is no room above
      let top = A.top - B.top - gap - h
      if (top < minTop) top = Z.bottom - B.top + gap
      top = Math.min(Math.max(top, minTop), maxTop)
      const mid = (A.left + Z.right) / 2 - B.left
      const left = Math.min(Math.max(mid - w / 2, edge), Math.max(edge, B.width - w - edge))
      bar.style.left = `${Math.round(left)}px`
      bar.style.top = `${Math.round(top)}px`
      bar.style.visibility = 'visible'
    }
    place()
    const scroller = box.querySelector('[data-ds-paper]')
    scroller?.addEventListener('scroll', place, { passive: true })
    const ro = new ResizeObserver(place)
    ro.observe(box)
    return () => {
      scroller?.removeEventListener('scroll', place)
      ro.disconnect()
    }
  })

  live.current = { spec, tweakPreview }
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
        barContent = wbModel!.formulaA1(sheetName!, activeAddr) || (cell.value as string)
      } else if (cell.value != null) {
        barContent = String(cell.value)
      }
    }
  }
  const stats = sel && mat ? selectionStats(mat, wbModel!.computed, sheetName!, sel) : null

  const exportXlsx = async () => {
    setExporting(true)
    try {
      const res = await fetch(`/api/spreadsheets/${spreadsheetId}/export`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(spec!.title || 'planilha').replace(/[^\w-]+/g, '_').slice(0, 60)}.xlsx`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      pushToast?.((e as Error).message || t('sheetStudio.exportError'))
    } finally {
      setExporting(false)
    }
  }

  // Run the AI edit in PREVIEW mode: the server returns the revised workbook
  // WITHOUT saving it. We show it in the grid and offer Accept/Discard — the
  // change only reaches the database once the user accepts (acceptTweak).
  // `override` is a quick action's prompt (always the current sheet); the ask bar sends what was typed.
  const runTweak = async (override?: string) => {
    const instruction = (override ?? tweak).trim()
    if (!instruction || tweaking || saving) return
    const whole = override === undefined && tweakWhole
    setLastInstruction(instruction)
    setLastWhole(whole)
    setTweaking(true)
    try {
      const body: Record<string, unknown> = { instruction, model, preview: true }
      if (!whole) body.sheetIndex = active
      // spreadsheets only use images as VISUAL REFERENCE (no insertion), so send
      // the raster vision copy — the model can't consume SVG directly.
      if (tweakImages.images.length) body.images = tweakImages.images.map((im) => ({ dataUrl: im.visionUrl }))
      const r = await postJSON<{ spreadsheet?: SpreadsheetDto; usage?: Record<string, number>; model: string }>(`/api/spreadsheets/${spreadsheetId}/tweak`, body)
      if (r.spreadsheet) {
        setTweakPreview({ before: spec, label: instruction })
        setSpec(r.spreadsheet)
        if (override === undefined) setTweak('')
        tweakImages.clear()
        setSel(null)
        if (r.usage) setTweakCost({ usage: r.usage, model: r.model })
        notifyUsageChanged() // the AI edit is on the taxímetro now
      }
    } catch (err) {
      const e = err as Error & { code?: string; limit?: number } // postJSON attaches code/limit
      // the server names the limit by code: show the localized copy, not its pt-BR fallback
      pushToast?.(e.code === 'spreadsheet_too_many_images' ? t('sheetStudio.tooManyImages', { limit: e.limit ?? 4 }) : e.message || t('sheetStudio.tweakError'))
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
    // the PATCH revalidates and saves; a failure keeps the preview (and its
    // Accept) on screen and shows "Couldn't save · Retry" — never a lost edit
    await save.run(writeAccepted)
    setSaving(false)
  }

  // Discard the pending edit → restore the pre-edit workbook (nothing was saved).
  // A failed Accept of it is moot: the error clears, so Retry cannot write it.
  const discardTweak = () => {
    if (!tweakPreview || saving) return
    setSpec(tweakPreview.before)
    setTweakPreview(null)
    setTweakCost(null)
    setSel(null)
    save.reset()
  }

  // The one write: reads the live workbook when it runs (queued, or re-run by
  // Retry), and writes nothing once the preview is gone.
  async function writeAccepted() {
    const { spec: cur, tweakPreview: pending } = live.current
    if (!pending || !cur) return true
    const body: Record<string, unknown> = { title: cur.title, sheets: cur.sheets }
    if (cur.instructions) body.instructions = cur.instructions
    const r = await patchJSON<{ spreadsheet?: SpreadsheetDto }>(`/api/spreadsheets/${spreadsheetId}`, body)
    if (r.spreadsheet) setSpec(r.spreadsheet)
    setTweakPreview(null)
    return true
  }
  // studio/StudioChrome is still JS: its retryRef infers `null`, so widen it here
  ;(save.retryRef as { current: (() => Promise<boolean>) | null }).current = () => (live.current.tweakPreview ? writeAccepted() : Promise.resolve(true))

  const chartValues = wbModel && sheetName ? chartValueResolver(wbModel, sheetName) : undefined
  const charts = (sheet?.charts || []).map((c) => sheetChartToBlock(sheet, c, chartValues)).filter(Boolean) as NonNullable<ReturnType<typeof sheetChartToBlock>>[]

  // the AI quick actions over the current selection (design.md §2.7): prompt
  // templates that name the selected range. They never invent an endpoint; the
  // result lands in the same Accept / Discard preview as a typed instruction.
  const range = barRef
  const multiCell = !!sel && (sel.r1 !== sel.r2 || sel.c1 !== sel.c2)
  // does the selection hold a formula cell? (Explain formula only makes sense then)
  let selHasFormula = false
  if (sel && mat) {
    const r1 = Math.min(sel.r1, sel.r2), r2 = Math.min(Math.max(sel.r1, sel.r2), mat.maxRow)
    const c1 = Math.min(sel.c1, sel.c2), c2 = Math.min(Math.max(sel.c1, sel.c2), mat.maxCols - 1)
    for (let r = r1; r <= r2 && !selHasFormula; r++) {
      for (let c = c1; c <= c2; c++) {
        const v = mat.cells.get(`${colLetter(c)}${r}`)?.value
        if (typeof v === 'string' && v[0] === '=') { selHasFormula = true; break }
      }
    }
  }
  const quickAction = (id: 'ask' | 'variance' | 'chart' | 'explain') => {
    if (id === 'ask') {
      setTweakWhole(false)
      setTweak((cur) => cur || t('sheetStudio.quick.askPrefill', { range }))
      requestAnimationFrame(() => askRef.current?.querySelector('textarea')?.focus())
      return
    }
    setTweakWhole(false)
    const key = { variance: 'variancePrompt', chart: 'chartPrompt', explain: 'explainPrompt' }[id]
    void runTweak(t(`sheetStudio.quick.${key}`, { range }))
  }
  const showQuick = !!sel && !!mat && !tweakPreview && !tweaking && !saving && !quickOff
  const focusGrid = () => rootRef.current?.querySelector<HTMLElement>('[data-ds-paper]')?.focus()
  // Esc dismisses the selection actions and puts focus back on the grid; false when there was nothing to dismiss
  const dismissQuick = () => {
    if (!showQuick) return false
    setQuickOff(true)
    focusGrid()
    return true
  }

  // roving tabindex for the sheet tabs: ←/→/Home/End move and activate
  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (tweaking) return
    let n = -1
    if (e.key === 'ArrowRight') n = (active + 1) % sheets.length
    else if (e.key === 'ArrowLeft') n = (active - 1 + sheets.length) % sheets.length
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = sheets.length - 1
    if (n < 0) return
    e.preventDefault()
    setActive(n)
    document.getElementById(`${titleId}-tab-${n}`)?.focus()
  }

  const headerSubtitle = sheets.length ? t(sheets.length === 1 ? 'sheetStudio.header.kindOne' : 'sheetStudio.header.kindMany', { n: sheets.length }) : t('sheetStudio.header.kind')
  // a <section> (region) when docked; a modal dialog when the panel overlays the chat or covers the app
  const Root = (overlay ? 'div' : 'section') as 'div'
  const legend = [
    { id: 'input', label: t('sheetStudio.legend.input'), bg: fills.input!.bg },
    { id: 'formula', label: t('sheetStudio.legend.formula'), bg: fills.formula!.bg },
    { id: 'key', label: t('sheetStudio.legend.key'), bg: fills.key!.bg },
  ]

  return (
    <Root
      ref={rootRef}
      data-studio="sheet"
      role={overlay ? 'dialog' : undefined}
      aria-modal={overlay ? 'true' : undefined}
      aria-labelledby={titleId}
      tabIndex={-1}
      className={studioPanelClass()}
    >
      {/* header: close · kind icon · name + "Spreadsheet · N sheets" · save status · share · export */}
      <StudioHeader
        mobile={mobile}
        onClose={onClose}
        icon={<Icon.SpreadsheetFile size={17} />}
        subtitle={headerSubtitle}
        title={
          <h2 id={titleId} className="font-semibold text-title leading-snug min-w-0 truncate">
            {spec?.title || t('sheetStudio.title')}
          </h2>
        }
        actions={
          <>
            <SaveStatus status={save.status} error={save.error} onRetry={save.retry} />
            {onShare && (
              <StudioIconButton
                label={t('sheetStudio.share')}
                onClick={onShare}
                disabled={!spec}
                className="grid-flow-col auto-cols-max gap-1.5 border border-border px-2.5 text-label font-semibold"
              >
                <Icon.Users size={15} aria-hidden /> <span className="max-md:hidden">{t('sheetStudio.share')}</span>
              </StudioIconButton>
            )}
          </>
        }
        primary={
          <StudioExportMenu
            busy={exporting}
            disabled={!spec}
            options={[{ id: 'xlsx', label: t('sheetStudio.export.xlsx'), description: t('sheetStudio.export.xlsxBody'), onSelect: exportXlsx }]}
          />
        }
      />

      {loading && <div role="status" className="flex-1 grid place-items-center text-body text-muted">{t('sheetStudio.loading')}</div>}
      {loadError && !loading && (
        <div className="flex-1 grid place-items-center">
          <div role="alert" className="text-center">
            <div className="text-body text-muted mb-3">{loadError}</div>
            <button type="button" onClick={() => setLoadTick((n) => n + 1)} className="min-h-9 rounded-control bg-action text-on-action hover:opacity-90 font-semibold text-body px-4">
              {t('sheetStudio.retry')}
            </button>
          </div>
        </div>
      )}

      {spec && !loading && (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* formula bar: name box · fx · the resolved formula of the active cell */}
          <div role="group" aria-label={t('sheetStudio.formulaBar')} className="shrink-0 flex items-stretch h-10 border-b border-border bg-raised text-label">
            <span className="inline-flex items-center justify-center w-16 shrink-0 border-r border-border font-mono text-caption text-muted" aria-label={t('sheetStudio.nameBox')}>
              {barRef || '—'}
            </span>
            <span className="inline-flex items-center px-3 shrink-0 border-r border-border text-faint italic" aria-hidden>fx</span>
            <div className={`flex-1 min-w-0 flex items-center px-3 truncate ${barContent.startsWith('=') ? 'font-mono' : ''} text-fg`}>
              {barContent || <span className="text-faint truncate">{t('sheetStudio.selectCellHint')}</span>}
            </div>
            {charts.length > 0 && (
              <button
                type="button"
                onClick={() => setShowCharts((v) => !v)}
                aria-pressed={showCharts}
                className={`shrink-0 self-center mr-2 min-h-8 max-md:min-h-11 text-caption font-semibold px-2.5 rounded-control border transition-colors duration-fast ${showCharts ? 'bg-accent-soft text-accent-text border-transparent' : 'border-border text-muted hover:text-fg hover:bg-surface-3'}`}
              >
                {charts.length === 1 ? t('sheetStudio.chartCountOne', { n: 1 }) : t('sheetStudio.chartCountMany', { n: charts.length })}
              </button>
            )}
          </div>

          {/* the grid fills all remaining space */}
          <div ref={gridBoxRef} className="flex-1 min-h-0 relative">
            {sheet && mat && <GridView mat={mat} computed={wbModel!.computed} sheetName={sheetName!} fills={fills} th={th} sel={sel} setSel={setSel} onEscape={dismissQuick} />}

            {/* AI quick actions: anchored to the selected range (see the layout effect above) */}
            {showQuick && (
              <div
                ref={quickRef}
                role="toolbar"
                aria-label={t('sheetStudio.quick.label')}
                data-quick-actions
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && dismissQuick()) e.preventDefault()
                }}
                className="invisible absolute left-0 top-0 z-raised w-max max-w-[calc(100%-8px)] flex flex-wrap items-center justify-center gap-1 rounded-card border border-border bg-raised shadow-overlay p-1 motion-safe:animate-fade-in"
              >
                <button type="button" onClick={() => quickAction('ask')} className="min-h-8 max-md:min-h-11 inline-flex items-center gap-1.5 rounded-control px-2.5 text-label font-semibold text-accent-text hover:bg-accent-soft">
                  <Icon.Sparkle size={13} aria-hidden /> {t('sheetStudio.quick.ask')}
                </button>
                <button type="button" onClick={() => quickAction('variance')} className="min-h-8 max-md:min-h-11 inline-flex items-center gap-1.5 rounded-control px-2.5 text-label font-medium text-muted hover:text-fg hover:bg-sunk">
                  <Icon.Plus size={13} aria-hidden /> {t('sheetStudio.quick.variance')}
                </button>
                {multiCell && (
                  <button type="button" onClick={() => quickAction('chart')} className="min-h-8 max-md:min-h-11 rounded-control px-2.5 text-label font-medium text-muted hover:text-fg hover:bg-sunk">
                    {t('sheetStudio.quick.chart')}
                  </button>
                )}
                {selHasFormula && (
                  <button type="button" onClick={() => quickAction('explain')} className="min-h-8 max-md:min-h-11 rounded-control px-2.5 text-label font-medium text-muted hover:text-fg hover:bg-sunk">
                    {t('sheetStudio.quick.explain')}
                  </button>
                )}
              </div>
            )}

            {/* charts panel (toggled): the chat's ChartBlock, so every exported kind previews */}
            {showCharts && charts.length > 0 && (
              <section
                aria-label={t('sheetStudio.charts')}
                className="absolute inset-2 md:inset-auto md:right-3 md:top-3 md:bottom-3 md:w-[400px] md:max-w-[80%] z-sticky overflow-auto rounded-card border border-border bg-surface-2 p-3 shadow-overlay"
              >
                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-label font-semibold text-muted">{t('sheetStudio.charts')}</h2>
                  <StudioIconButton label={t('studio.close')} onClick={() => setShowCharts(false)}>
                    <Icon.Close size={14} aria-hidden />
                  </StudioIconButton>
                </div>
                {charts.map((b, i) => (
                  <ChartBlock key={`${sheetName}-${i}`} block={b} />
                ))}
              </section>
            )}

            {/* AI-editing overlay: rich feedback while a tweak runs */}
            {tweaking && <TweakOverlay instruction={lastInstruction} scope={lastWhole ? 'workbook' : sheetName} />}
          </div>

          {/* stats footer over the selected range (Excel/Sheets-style) —
              números: Soma/Média/Mín/Máx/Contagem; datas: Mín/Máx/Contagem;
              texto/misto: só Contagem */}
          <div className="shrink-0 h-8 flex items-center gap-4 px-3 border-t border-border bg-sunk text-caption text-muted overflow-hidden whitespace-nowrap" aria-live="polite">
            {stats ? (
              <>
                {stats.kind === 'number' && (
                  <>
                    <Stat label={t('sheetStudio.stat.sum')} value={fmtStat(stats.sum, locale)} />
                    <Stat label={t('sheetStudio.stat.avg')} value={fmtStat(stats.avg, locale)} />
                    <Stat label={t('sheetStudio.stat.min')} value={fmtStat(stats.min, locale)} />
                    <Stat label={t('sheetStudio.stat.max')} value={fmtStat(stats.max, locale)} />
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
              <span className="text-faint truncate">{t('sheetStudio.statsHint')}</span>
            )}
          </div>

          {/* sheet tabs, and the legend of the cell colours (what the fills mean) */}
          <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-t border-border bg-surface">
            <div role="tablist" aria-label={t('sheetStudio.sheets')} onKeyDown={onTabKey} className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {sheets.map((s, i) => (
                <button
                  key={i}
                  id={`${titleId}-tab-${i}`}
                  type="button"
                  role="tab"
                  aria-selected={i === active}
                  tabIndex={i === active ? 0 : -1}
                  disabled={tweaking}
                  onClick={() => setActive(i)}
                  className={`min-h-8 max-md:min-h-11 px-3 rounded-control border text-label transition-colors duration-fast disabled:text-disabled-text ${i === active ? 'bg-raised text-fg font-medium border-border shadow-raised' : 'border-transparent text-muted hover:text-fg'}`}
                >
                  {s.name}
                </button>
              ))}
            </div>
            <ul aria-label={t('sheetStudio.legend.label')} className="shrink-0 flex items-center gap-3 text-caption text-muted max-sm:hidden">
              {legend.map((l) => (
                <li key={l.id} className="inline-flex items-center gap-1.5">
                  <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" className="shrink-0 text-faint">
                    <rect x="0.5" y="0.5" width="9" height="9" rx="2" fill={l.bg || 'none'} stroke="currentColor" strokeOpacity="0.4" />
                  </svg>
                  {l.label}
                </li>
              ))}
            </ul>
          </div>

          {/* the shared AI ask bar: this sheet or the whole workbook, with a reversible preview */}
          <div ref={askRef} className="shrink-0 border-t border-border bg-surface px-3 py-3 flex flex-col gap-2 max-h-[45vh] overflow-y-auto">
            <StudioAIPanel
              compact
              hint={t('sheetStudio.aiIntro')}
              value={tweak}
              onChange={setTweak}
              onSubmit={() => runTweak()}
              placeholder={t('sheetStudio.describeChange')}
              busy={tweaking}
              // studio/StudioAIPanel is still JS: images/scope/preview/cost infer as `null` from their defaults
              images={tweakImages as never}
              scope={({
                label: t('sheetStudio.applyTo'),
                value: tweakWhole ? 'workbook' : 'sheet',
                onChange: (id: string) => setTweakWhole(id === 'workbook'),
                options: [
                  { id: 'sheet', label: t('sheetStudio.sheetTab', { name: sheet?.name }), title: t('sheetStudio.onlySheet', { name: sheet?.name }) },
                  { id: 'workbook', label: t('sheetStudio.workbook') },
                ],
              }) as never}
              preview={
                (tweakPreview
                  ? { label: tweakPreview.label, hint: t('sheetStudio.tweak.reviewHint'), onAccept: acceptTweak, onDiscard: discardTweak, saving }
                  : null) as null
              }
              cost={tweakCost as null}
              models={models}
            />
            {/* the note describes the downloaded file: the export always appends this sheet, named as below in every language */}
            <p className="text-caption text-faint">
              {t('sheetStudio.footerNotePre')}
              <span className="font-medium">{INSTRUCTIONS_SHEET_NAME}</span>
              {t('sheetStudio.footerNotePost')}
            </p>
          </div>
        </div>
      )}
    </Root>
  )
}
