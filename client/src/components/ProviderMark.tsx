import { MARK_PATHS, markFor } from '../lib/providerMarks.ts'
import type { ProviderMarkId } from '../lib/providerMarks.ts'

interface BaseProps {
  size?: number
  className?: string
  /** Accessible name (the provider name). Without it the mark is decorative (aria-hidden). */
  title?: string
}

function Glyph({ id, size = 16, className, title }: BaseProps & { id: ProviderMarkId }) {
  const paths = Object.hasOwn(MARK_PATHS, id) ? MARK_PATHS[id] : []
  const a11y = title ? { role: 'img' as const, 'aria-label': title } : { 'aria-hidden': true as const }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" className={className} {...a11y}>
      {title ? <title>{title}</title> : null}
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

/** The provider's mark in `currentColor`; an unknown model gets a neutral 50% dot (always aria-hidden). */
export function ProviderMark({ model, size = 16, className, title }: BaseProps & { model: { provider?: string | null; id?: string | null } | null }) {
  const id = markFor(model)
  if (id) return <Glyph id={id} size={size} className={className} title={title} />
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <circle cx="12" cy="12" r="4" fill="currentColor" opacity="0.5" />
    </svg>
  )
}

/** The MCP mark, for MCP connections in the tools picker and in settings. */
export function McpMark(p: BaseProps) {
  return <Glyph id="mcp" {...p} />
}
