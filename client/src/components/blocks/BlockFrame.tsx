import type { ReactNode, Ref } from 'react'

// One frame for every inline data block (chart, table, image): a title and an
// optional subtitle on the left, an optional control on the right, the body,
// and an optional footer under a hairline. It carries the block's data
// attributes so the e2e and the PNG export find it. No overflow clipping: a
// chart tooltip may reach past the card edge.
interface BlockFrameProps {
  block: string
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  frameRef?: Ref<HTMLDivElement>
  attrs?: Record<string, string | undefined>
  className?: string
}

export default function BlockFrame({ block, title, subtitle, actions, footer, children, frameRef, attrs, className = '' }: BlockFrameProps) {
  const hasHead = !!(title || subtitle || actions)
  return (
    <div ref={frameRef} data-block={block} {...attrs} className={`rounded-card border border-border bg-raised my-3 ${className}`}>
      {hasHead && (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 pt-3.5 pb-1">
          <div className="min-w-0 flex-1 basis-40">
            {title && <div data-block-title className="text-body font-semibold text-fg">{title}</div>}
            {subtitle && <div data-block-subtitle className="text-label text-muted mt-0.5">{subtitle}</div>}
          </div>
          {actions}
        </div>
      )}
      {children}
      {footer && <div data-block-footer className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 border-t border-border-soft text-label text-muted">{footer}</div>}
    </div>
  )
}
