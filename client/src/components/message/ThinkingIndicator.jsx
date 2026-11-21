import { useEffect, useRef, useState } from 'react'
import { useT } from '../../lib/i18n.tsx'

// Shown while the assistant streams but nothing else signals progress (see
// showThinkingRow in logic.js): on the first round the model reads context
// and decides whether to call a tool; between rounds it decides what to do
// with a result. One stable label ("Thinking…", or the artifact being built)
// plus an honest elapsed-seconds counter once the wait passes 3 s. The model's
// live reasoning lives in ReasoningTrace, never here.
function useElapsedSeconds() {
  const [now, setNow] = useState(() => Date.now())
  const startRef = useRef(Date.now())
  useEffect(() => {
    startRef.current = Date.now()
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return Math.floor((now - startRef.current) / 1000)
}

export default function ThinkingIndicator({ buildingKey }) {
  const t = useT()
  const secs = useElapsedSeconds()
  const label = buildingKey ? t(buildingKey) : t('message.thinking')
  return (
    <span className="inline-flex items-center gap-2 text-muted text-body min-w-0">
      <span className="inline-flex gap-1 shrink-0" aria-hidden>
        <span className="w-1.5 h-1.5 rounded-pill bg-accent animate-pulse" />
        <span className="w-1.5 h-1.5 rounded-pill bg-accent animate-pulse [animation-delay:150ms]" />
        <span className="w-1.5 h-1.5 rounded-pill bg-accent animate-pulse [animation-delay:300ms]" />
      </span>
      <span className="truncate">{label}</span>
      {secs >= 3 && <span className="text-faint tabular-nums shrink-0">{secs}s</span>}
    </span>
  )
}
