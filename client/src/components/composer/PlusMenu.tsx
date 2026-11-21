import { useEffect, useId, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import * as Icon from '../Icons.tsx'
import { useT } from '../../lib/i18n.jsx'
import { nextIndex } from '../../lib/slashCommands.ts'

// The "+" button and its menu: everything that adds to a message (files,
// images, audio/video) and the way into the "/" commands, in at most 7 items
// split into labelled groups. It replaces the bare paperclip that only opened
// the native file dialog.
//
// Keyboard (WAI-ARIA menu button): Enter/Space/ArrowDown open it on the first
// item, ArrowUp on the last; arrows rove (wrapping), Home/End jump, Enter or
// Space picks, Esc closes and returns focus to the button, Tab closes.
// A pointer click outside closes it too.
//
interface PlusMenuItem {
  id: string
  label: string
  hint?: string
  icon?: string
  onSelect: () => void
}

interface PlusMenuGroup {
  id: string
  label: string
  items: PlusMenuItem[]
}

interface PlusMenuProps {
  groups: PlusMenuGroup[]
  buttonClassName?: string
}

// Icons.jsx is still JS: look glyphs up by name through this shape.
const GLYPHS = Icon as unknown as Record<string, ComponentType<{ size?: number; className?: string }> | undefined>

// `groups`: [{ id, label, items: [{ id, label, hint, icon, onSelect }] }]
export default function PlusMenu({ groups, buttonClassName }: PlusMenuProps) {
  const t = useT()
  const menuId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const flat = groups.flatMap((g) => g.items)

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus()
  }, [open, active])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const openAt = (i: number) => {
    setActive(i)
    setOpen(true)
  }
  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) btnRef.current?.focus()
  }
  const pick = (item: PlusMenuItem) => {
    close(false)
    item.onSelect()
  }

  const onButtonKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      openAt(e.key === 'ArrowUp' ? flat.length - 1 : 0)
    }
  }

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault()
      setActive((i) => nextIndex(i, flat.length, e.key))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  let n = -1
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t('composer.plusMenu')}
        title={t('composer.plusMenu')}
        onClick={() => (open ? close() : openAt(0))}
        onKeyDown={onButtonKey}
        className={buttonClassName}
      >
        <Icon.Plus size={20} className={`transition-transform duration-fast ${open ? 'rotate-45' : ''}`} />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={t('composer.plusMenu')}
          onKeyDown={onMenuKey}
          className="absolute bottom-full left-0 mb-2 w-72 max-w-[calc(100vw-2rem)] rounded-card border border-border bg-surface-2 shadow-overlay p-1 z-dropdown animate-fade-in"
        >
          {groups.map((g, gi) => (
            <div key={g.id} role="group" aria-label={g.label} className={gi > 0 ? 'mt-1 pt-1 border-t border-border-soft' : ''}>
              <div aria-hidden="true" className="px-3 pt-2 pb-1 text-caption font-medium uppercase tracking-wide text-faint">
                {g.label}
              </div>
              {g.items.map((item) => {
                const i = ++n
                const Glyph = (item.icon ? GLYPHS[item.icon] : undefined) || Icon.File
                return (
                  <button
                    key={item.id}
                    ref={(el) => {
                      itemRefs.current[i] = el
                    }}
                    type="button"
                    role="menuitem"
                    tabIndex={i === active ? 0 : -1}
                    onClick={() => pick(item)}
                    onMouseMove={() => i !== active && setActive(i)}
                    className="w-full flex items-start gap-3 min-h-11 md:min-h-9 px-3 py-2 rounded-control text-left hover:bg-surface-3 focus-visible:bg-surface-3 transition-colors duration-fast"
                  >
                    <Glyph size={16} className="mt-0.5 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-body text-fg">{item.label}</span>
                      {item.hint && <span className="block text-label text-muted">{item.hint}</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
