import { useEffect, useRef, useState } from 'react'
import * as Icon from '../Icons.tsx'
import { useT } from '../../lib/i18n.jsx'

// The model's native reasoning behind a native <details> disclosure. Open
// while the model is still reasoning (no answer prose yet) so the chain of
// thought is visible live; it collapses on its own once the answer streams,
// and stays collapsed on reload. A click by the user wins over the automatic
// state. <details> gives keyboard, screen-reader and find-in-page support for
// free.
interface ReasoningTraceProps {
  text?: string | null
  hasAnswer?: boolean
}

export default function ReasoningTrace({ text, hasAnswer }: ReasoningTraceProps) {
  const t = useT()
  const [manual, setManual] = useState<boolean | null>(null) // null = follow the automatic state
  const open = manual == null ? !hasAnswer : manual
  const bodyRef = useRef<HTMLDivElement>(null)
  // keep the newest reasoning in view while it streams and stays open
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [text, open])
  if (!text) return null
  return (
    <details
      open={open}
      onToggle={(e) => {
        if (e.currentTarget.open !== open) setManual(e.currentTarget.open)
      }}
      className="group/reasoning mb-2 rounded-control border border-border bg-surface-2 overflow-hidden"
    >
      <summary className="tap-target flex items-center gap-2 px-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-label text-muted hover:text-fg transition-colors duration-fast">
        <Icon.Sparkle size={13} className={hasAnswer ? 'shrink-0' : 'shrink-0 animate-pulse text-accent'} />
        <span className="font-medium">{hasAnswer ? t('reasoning.done') : t('reasoning.thinking')}</span>
        <Icon.ChevronDown size={14} className="ml-auto shrink-0 transition-transform duration-fast group-open/reasoning:rotate-180" />
      </summary>
      <div ref={bodyRef} className="px-3 pb-2 max-h-48 overflow-y-auto text-label text-muted whitespace-pre-wrap">
        {text}
      </div>
    </details>
  )
}
