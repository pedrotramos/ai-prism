import type { ComponentType } from 'react'
import * as Icon from '../Icons.jsx'

// A highlight from the model: summary, anomaly or opportunity. The kind is
// carried by a drawn icon in its semantic token colour (not an emoji, not the
// brand red), on the same card surface as every other block.
const TrendUp = ({ size = 16, className }: { size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="m3 17 6-6 4 4 8-8" />
    <path d="M15 7h6v6" />
  </svg>
)

const KIND: Record<string, { Glyph: ComponentType<{ size?: number; className?: string }>; tone: string }> = {
  summary: { Glyph: Icon.Sparkle, tone: 'text-info' },
  anomaly: { Glyph: Icon.AlertTriangle, tone: 'text-warning' },
  opportunity: { Glyph: TrendUp, tone: 'text-success' },
}

export default function InsightCard({ block }: { block: { kind?: string; title?: string; body?: string } }) {
  const { Glyph, tone } = (block.kind ? KIND[block.kind] : undefined) || KIND.summary!
  return (
    <div data-block="insight" className="rounded-card border border-border bg-surface-2 p-4 my-3">
      <div className="flex items-center gap-2 text-body font-semibold">
        <span aria-hidden className={`shrink-0 ${tone}`}>
          <Glyph size={16} />
        </span>
        <span>{block.title}</span>
      </div>
      <p className="text-body text-muted mt-1.5 leading-relaxed">{block.body}</p>
    </div>
  )
}
