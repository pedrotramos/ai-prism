import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

// A segmented control for the views of one block (the chart's kinds and its
// table). It is a tab list: one tab is in the tab order, Left/Right/Home/End
// move between tabs and select, and the panel it controls is named by the
// selected tab. Reads as buttons on a sunk track, the selected one raised.
export interface SwitchOption {
  id: string
  label: ReactNode
  icon?: ReactNode
}

interface BlockSwitchProps {
  label: string
  options: SwitchOption[]
  value: string
  onChange: (id: string) => void
  panelId: string
  idPrefix: string
}

export const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`

export default function BlockSwitch({ label, options, value, onChange, panelId, idPrefix }: BlockSwitchProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const move = (e: KeyboardEvent, i: number) => {
    const last = options.length - 1
    const next = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1) : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1
    if (next < 0) return
    e.preventDefault()
    const id = options[next]!.id
    onChange(id)
    refs.current[id]?.focus()
  }
  return (
    <div role="tablist" aria-label={label} data-block-switch className="inline-flex max-w-full overflow-x-auto p-0.5 gap-0.5 rounded-control bg-surface-3 border border-border-soft">
      {options.map((o, i) => {
        const on = o.id === value
        return (
          <button
            key={o.id}
            ref={(el) => {
              refs.current[o.id] = el
            }}
            type="button"
            role="tab"
            id={tabId(idPrefix, o.id)}
            aria-selected={on}
            aria-controls={panelId}
            tabIndex={on ? 0 : -1}
            data-view={o.id}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => move(e, i)}
            className={`tap-target inline-flex items-center gap-1.5 whitespace-nowrap rounded-badge px-2.5 text-label transition-colors duration-fast ${
              on ? 'bg-raised text-fg font-medium shadow-raised' : 'text-muted hover:text-fg'
            }`}
          >
            {o.icon}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
