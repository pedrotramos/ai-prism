// Pure data rules behind the inline artifact blocks. Kept free of React so
// node --test can pin them (blockData.test.js).
import { contrastRatio, heatColor, readableOn } from '../../../../shared/chartValue.js'

const TEASER_MAX = 140

function cleanInline(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // bold
    .replace(/(\*|_)(.+?)\1/g, '$2') // italics
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '') // list marker
    .replace(/^\s*>\s?/, '') // blockquote
}

/**
 * A one-line teaser for a document card: the first prose paragraph, with
 * headings, tables, fenced code and rules skipped and inline marks removed,
 * so the card never shows raw markdown syntax ("| Region | Q2 |…").
 */
export function documentTeaser(markdown, max = TEASER_MAX) {
  const lines = String(markdown || '').split('\n')
  const para = []
  let inFence = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence
      if (para.length) break
      continue
    }
    if (inFence) continue
    const skip =
      !line ||
      /^#{1,6}\s/.test(line) ||
      /^\|/.test(line) ||
      /^(-{3,}|\*{3,}|_{3,})$/.test(line) ||
      /^:?-{2,}:?(\s*\|\s*:?-{2,}:?)*\|?$/.test(line)
    if (skip) {
      if (para.length) break
      continue
    }
    para.push(cleanInline(line))
  }
  const text = para.join(' ').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd() + '…'
}

/** The rows behind a chart as a `table` block, for the "View data" toggle. */
export function chartToTable(block, labelHeader) {
  const series = block?.series || []
  if (block?.chartType === 'scatter') {
    return {
      type: 'table',
      title: null,
      columns: [labelHeader, block.xLabel || 'x', block.yLabel || 'y'],
      rows: series.flatMap((s) => (s.data || []).map((p) => [String(p.label || s.name || ''), String(p.x), String(p.y)])),
    }
  }
  const labels = series[0]?.data?.map((d) => d.label) || []
  return {
    type: 'table',
    title: null,
    columns: [labelHeader, ...series.map((s, i) => s.name || `Series ${i + 1}`)],
    rows: labels.map((label, i) => [
      String(label),
      ...series.map((s) => {
        const v = s.data?.[i]?.value
        return v == null ? null : String(v)
      }),
    ]),
  }
}

// Categorical order: a design system may define --chart-1…--chart-6; the app
// falls back to its semantic tokens, which already meet 3:1 on every surface.
const CATEGORICAL = [
  ['--chart-1', '--info'],
  ['--chart-2', '--success'],
  ['--chart-3', '--warning'],
  ['--chart-4', '--accent'],
  ['--chart-5', '--muted'],
]
const NEUTRAL = ['--chart-neutral', '--faint']
// kinds whose two series read as "prior vs current"; scatter groups, pivot
// columns and pie slices are categories, not a comparison
const COMPARISON_KINDS = new Set(['bar', 'line', 'area'])

/**
 * Series colours for a chart, resolved to concrete values through `read`
 * (getComputedStyle(...).getPropertyValue), so the PNG export, which cannot
 * see CSS variables, paints the same colours. Two series on a bar/line/area
 * chart are a comparison: the first (prior period) is neutral, the second
 * (current) primary; the brand red never marks a prior period as "bad".
 */
export function seriesPalette({ chartType, count, read }) {
  const pick = (names) => {
    for (const n of names) {
      const v = (read(n) || '').trim()
      if (v) return v
    }
    return 'currentColor'
  }
  if (COMPARISON_KINDS.has(chartType) && count === 2) return [pick(NEUTRAL), pick(CATEGORICAL[0])]
  const out = []
  for (let i = 0; i < count; i++) out.push(pick(CATEGORICAL[i % CATEGORICAL.length]))
  return out
}

// Heatmap ramp: from a quiet surface token to the primary chart token, mixed
// in JS from the resolved values so the PNG export paints the same fills. The
// label on each cell is whichever text token reads better; in the mid-ramp
// band where neither reaches AA (4.5:1) the label sits on an opaque --surface
// chip instead (both pinned by the tests for both app themes).
const HEAT_HIGH = ['--chart-1', '--info']
const HEAT_LOW = ['--chart-heat-low', '--surface-3']
const HEAT_TEXT = [['--text'], ['--bg']]
const HEAT_CHIP = ['--surface']
const AA = 4.5

export function heatmapPalette({ read }) {
  const pick = (names) => {
    for (const n of names) {
      const v = (read(n) || '').trim()
      if (v) return v
    }
    return ''
  }
  return { low: pick(HEAT_LOW), high: pick(HEAT_HIGH), text: HEAT_TEXT.map(pick).filter(Boolean), chip: pick(HEAT_CHIP) }
}

/**
 * Fill and label colours of a heatmap cell at position t in [0, 1]. `chip` is
 * set when the label needs a surface chip behind it to stay AA.
 */
export function heatCell(palette, t) {
  const fill = heatColor(palette.low, palette.high, t)
  const text = readableOn(fill, palette.text)
  if (contrastRatio(text, fill) >= AA || !palette.chip) return { fill, text, chip: null }
  return { fill, text: readableOn(palette.chip, palette.text), chip: palette.chip }
}
