import { useMemo } from 'react'
import { gridColumns, readSlideRoot } from './slideDesign.ts'
import type { GridSettings } from './SlideDesignPanel.tsx'

// Editor-only column guide drawn ABOVE the slide frame (app chrome, not slide
// content): it never enters the slide's HTML, so it is neither saved nor exported.
// The columns sit inside the slide's own left/right margins.
export default function SlideGridOverlay({ html, grid, stageW = 1280, stageH = 720 }: { html: string; grid: GridSettings; stageW?: number; stageH?: number }) {
  const cols = useMemo(() => gridColumns(stageW, readSlideRoot(html).margins, grid.columns, grid.gutter), [html, grid.columns, grid.gutter, stageW])
  if (!grid.on) return null
  return (
    <svg data-slide-grid viewBox={`0 0 ${stageW} ${stageH}`} preserveAspectRatio="none" aria-hidden className="pointer-events-none absolute inset-0 h-full w-full rounded-card">
      {cols.map((c) => (
        <rect key={c.x} x={c.x} y={0} width={c.w} height={stageH} className="fill-[var(--accent)] opacity-20" />
      ))}
    </svg>
  )
}
