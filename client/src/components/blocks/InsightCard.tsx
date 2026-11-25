import type { ComponentType } from 'react'
import * as Icon from '../Icons.tsx'

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
  summary: { Glyph: Icon.Sparkle, tone: 'text-info bg-info-soft' },
  anomaly: { Glyph: Icon.AlertTriangle, tone: 'text-warning bg-warning-soft' },
  opportunity: { Glyph: TrendUp, tone: 'text-success bg-success-soft' },
}

export default function InsightCard({ block }: { block: { kind?: string; title?: string; body?: string } }) {
  const { Glyph, tone } = (block.kind ? KIND[block.kind] : undefined) || KIND.summary!
  return (
    <div data-block="insight" data-insight-kind={block.kind || 'summary'} className="flex items-start gap-3 rounded-card border border-border bg-raised px-4 py-3 my-3">
      <span aria-hidden className={`grid place-items-center shrink-0 w-8 h-8 rounded-control ${tone}`}>
        <Glyph size={16} />
      </span>
      <div className="min-w-0">
        <div className="text-body font-semibold text-fg">{block.title}</div>
        <p className="text-body text-muted mt-0.5 leading-relaxed">{block.body}</p>
      </div>
    </div>
  )
}
