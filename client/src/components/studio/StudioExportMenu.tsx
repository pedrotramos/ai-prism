import { useEffect, useId, useRef, useState } from 'react'
import * as Icon from '../Icons.tsx'
import { useT } from '../../lib/i18n.tsx'

// The one export control of the three studios: a filled "Export" button that
// opens a menu of formats (deck: universal vs brand fonts; spreadsheet: XLSX;
// document: DOCX / Markdown / PDF). Menu-button pattern: aria-haspopup,
// aria-expanded, role=menu/menuitem, ↑/↓/Home/End move, Enter/Space pick,
// Esc or Tab closes and focus returns to the trigger.
//
// options: [{ id, label, description?, badge?, onSelect }]
interface StudioExportOption {
  id: string
  label: string
  description?: string
  badge?: string
  onSelect: () => void
}

interface StudioExportMenuProps {
  options: StudioExportOption[]
  busy?: boolean
  disabled?: boolean
}

export default function StudioExportMenu({ options, busy = false, disabled = false }: StudioExportMenuProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return undefined
    itemRefs.current[0]?.focus()
    const onDown = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return
      if (!(e.target as Element).closest?.(`[data-export-menu="${menuId}"]`)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, menuId])

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = itemRefs.current.filter(Boolean) as HTMLButtonElement[]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const move = (n: number) => {
      e.preventDefault()
      items[(n + items.length) % items.length]?.focus()
    }
    if (e.key === 'ArrowDown') move(i + 1)
    else if (e.key === 'ArrowUp') move(i - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(items.length - 1)
    else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'Tab') close(false)
  }

  const pick = (o: StudioExportOption) => {
    close()
    o.onSelect()
  }

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
        disabled={disabled || busy}
        data-studio-export
        className="min-h-9 max-md:min-h-11 max-md:min-w-11 flex items-center justify-center gap-1.5 rounded-control bg-action text-on-action hover:opacity-90 font-semibold text-body px-3 transition-colors duration-fast disabled:bg-disabled disabled:text-disabled-text"
      >
        <Icon.Download size={15} aria-hidden />
        <span className="max-sm:sr-only">{busy ? t('studio.export.busy') : t('studio.export.label')}</span>
        {!busy && <Icon.ChevronDown size={13} className="-mr-0.5 opacity-80" aria-hidden />}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t('studio.export.menu')}
          data-export-menu={menuId}
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full mt-1.5 z-popover w-72 max-w-[calc(100vw-1.5rem)] rounded-card border border-border bg-raised shadow-overlay p-1.5 motion-safe:animate-fade-in"
        >
          {options.map((o, i) => (
            <button
              key={o.id}
              ref={(el) => (itemRefs.current[i] = el)}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => pick(o)}
              className="w-full min-h-9 text-left rounded-control px-3 py-2 hover:bg-surface-3 focus-visible:bg-surface-3 transition-colors duration-fast"
            >
              <span className="flex items-center gap-1.5 text-body font-semibold text-fg">
                {o.label}
                {o.badge && <span className="text-caption font-bold uppercase text-accent-text bg-accent-soft rounded-badge px-1">{o.badge}</span>}
              </span>
              {o.description && <span className="block text-caption text-muted mt-0.5">{o.description}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
