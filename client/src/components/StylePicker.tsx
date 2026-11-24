import { useEffect, useId, useRef, useState } from 'react'
import * as Icon from './Icons.tsx'
import { useT } from '../lib/i18n.tsx'
import type { TFn } from '../lib/tFn.ts'

// The composer's response-style picker (W1-3). It picks one of the six
// personas the Settings page also offers and writes it as the chat's
// `system_prompt` (the parent persists it on the open session). Text typed in
// Settings that matches no persona shows as "Custom"; "Personal instructions"
// opens Settings. Popover: Escape and an outside click close it, focus returns
// to the trigger, arrow keys move between options.
const PERSONAS = ['default', 'concise', 'executive', 'engineer', 'analyst', 'teacher'] as const

interface StylePickerProps {
  /** The chat's current system prompt. */
  value: string
  onChange: (prompt: string) => void
  onOpenSettings?: () => void
  disabled?: boolean
}

export default function StylePicker({ value, onChange, onOpenSettings, disabled }: StylePickerProps) {
  const t: TFn = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  const options = PERSONAS.map((id) => ({
    id,
    name: t(`settings.persona.${id}.name`),
    desc: t(`composer.style.${id}.desc`),
    prompt: id === 'default' ? '' : t(`settings.persona.${id}.prompt`),
  }))
  const active = options.find((o) => o.prompt === (value || ''))
  const label = active ? active.name : t('composer.style.custom')

  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }

  // keyboard focus moved outside: close, so one popover is open at a time
  const onFocusOut = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null
    if (open && next && !ref.current?.contains(next)) close(false)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    requestAnimationFrame(() => (panelRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') || panelRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus())
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const onPanelKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = [...panelRef.current!.querySelectorAll<HTMLElement>('[data-style-item]')]
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    items[e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length : i) - 1]!.focus()
  }

  return (
    <div className="relative shrink-0" ref={ref} onBlur={onFocusOut}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t('composer.style.trigger', { name: label })}
        title={t('composer.style.heading')}
        className="flex items-center gap-1.5 min-h-9 min-w-9 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 justify-center rounded-control hover:bg-sunk px-2 py-1 text-label font-medium text-fg transition duration-fast disabled:text-disabled-text"
      >
        <Icon.Wand size={15} className="shrink-0 text-muted" />
        <span className="hidden [@container(min-width:600px)]:inline truncate max-w-28">{label}</span>
        <Icon.ChevronDown size={14} className="hidden [@container(min-width:600px)]:block text-muted shrink-0" />
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          aria-label={t('composer.style.heading')}
          onKeyDown={onPanelKey}
          className="fixed left-2 right-2 bottom-28 md:absolute md:left-auto md:right-0 md:bottom-full md:mb-2 md:w-72 z-dropdown max-h-[min(70vh,32rem)] overflow-y-auto rounded-card border border-border bg-raised shadow-overlay p-1.5 animate-fade-in"
        >
          <div className="px-3 pt-1.5 pb-1 text-caption font-semibold text-muted">{t('composer.style.heading')}</div>
          {options.map((o) => {
            const selected = active?.id === o.id
            return (
              <button
                type="button"
                key={o.id}
                role="menuitemradio"
                aria-checked={selected}
                data-style-item
                onClick={() => {
                  onChange(o.prompt)
                  close()
                }}
                className={`w-full text-left rounded-control px-3 py-2 flex items-start gap-2 transition duration-fast ${selected ? 'bg-sunk' : 'hover:bg-sunk'}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-medium text-fg">{o.name}</span>
                  <span className="block text-label text-muted">{o.desc}</span>
                </span>
                {selected && <Icon.Check size={16} className="text-accent mt-0.5 shrink-0" />}
              </button>
            )
          })}
          {onOpenSettings && (
            <button
              type="button"
              role="menuitem"
              data-style-item
              onClick={() => {
                close(false)
                onOpenSettings()
              }}
              className="mt-1 w-full text-left rounded-control border-t border-border px-3 py-2.5 flex items-center gap-2 text-body font-medium text-fg hover:bg-sunk transition duration-fast"
            >
              <Icon.Pencil size={15} className="text-muted" />
              {t('composer.style.personal')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
