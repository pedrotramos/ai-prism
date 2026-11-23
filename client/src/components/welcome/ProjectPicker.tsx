import { useEffect, useId, useRef, useState } from 'react'
import * as Icon from '../Icons.tsx'
import { useT } from '../../lib/i18n.tsx'

type Translate = (key: string, vars?: Record<string, unknown>) => string

export interface PickerProject {
  id: number
  name: string
}

// Colour dot per project. The 8 `--project-N` tokens come with the sidebar; until
// they exist the dot falls back to a neutral tone instead of a hardcoded colour.
// Static class names so Tailwind sees them; no inline style needed.
const DOT_BG = [
  'bg-[var(--project-0,var(--muted))]',
  'bg-[var(--project-1,var(--muted))]',
  'bg-[var(--project-2,var(--muted))]',
  'bg-[var(--project-3,var(--muted))]',
  'bg-[var(--project-4,var(--muted))]',
  'bg-[var(--project-5,var(--muted))]',
  'bg-[var(--project-6,var(--muted))]',
  'bg-[var(--project-7,var(--muted))]',
] as const
const dotClass = (id: number) => DOT_BG[Math.abs(Math.trunc(id)) % 8]!

interface ProjectPickerProps {
  projects: PickerProject[]
  onStartInProject: (projectId: number | null) => void
}

// "No project" pill that opens a short list of projects to start the chat in.
// A popover: Escape and an outside click close it, focus returns to the
// trigger, arrow keys move between options, and the chosen option is announced
// with aria-pressed.
export default function ProjectPicker({ projects, onStartInProject }: ProjectPickerProps) {
  const t = useT() as Translate
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  const current = projects.find((p) => p.id === selected) || null
  // the selected project can disappear (deleted elsewhere): fall back to none
  useEffect(() => {
    if (selected != null && !current) setSelected(null)
  }, [selected, current])

  const close = (returnFocus = true) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const items = panelRef.current?.querySelectorAll<HTMLElement>('[data-project-item]')
    const on = panelRef.current?.querySelector<HTMLElement>('[data-project-item][aria-pressed="true"]')
    ;(on || items?.[0])?.focus()
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const choose = (id: number | null) => {
    setSelected(id)
    onStartInProject(id)
    close()
  }

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('[data-project-item]') || [])]
    if (!items.length) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length : i) - 1
    items[next]!.focus()
  }

  const row = (id: number | null, label: string, sub: string | null, dot: string | null) => {
    const on = id === (current ? current.id : null)
    return (
      <button
        key={id ?? 'none'}
        type="button"
        data-project-item
        aria-pressed={on}
        onClick={() => choose(id)}
        className={`w-full text-left rounded-control px-3 py-2 min-h-11 flex items-center gap-2.5 transition-colors duration-fast ${
          on ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-2)]'
        }`}
      >
        {dot ? (
          <span aria-hidden className={`w-2.5 h-2.5 rounded-pill shrink-0 ${dot}`} />
        ) : (
          <Icon.Folder size={14} aria-hidden className="shrink-0 text-[var(--muted)]" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-body truncate">{label}</span>
          {sub && <span className="block text-caption text-[var(--muted)] truncate">{sub}</span>}
        </span>
        {on && <Icon.Check size={16} aria-hidden className="shrink-0 text-[var(--text)]" />}
      </button>
    )
  }

  return (
    <div className="relative inline-block" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="home-project-picker"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t('welcome.project.trigger', { name: current ? current.name : t('welcome.project.none') })}
        className="inline-flex items-center gap-2 min-h-9 [@media(pointer:coarse)]:min-h-11 max-w-full rounded-pill border border-[var(--border)] bg-raised hover:bg-[var(--surface-2)] px-3 text-label font-medium transition-colors duration-fast"
      >
        {current ? (
          <span aria-hidden className={`w-2.5 h-2.5 rounded-pill shrink-0 ${dotClass(current.id)}`} />
        ) : (
          <Icon.Folder size={14} aria-hidden className="shrink-0 text-[var(--muted)]" />
        )}
        <span className="truncate">{current ? current.name : t('welcome.project.none')}</span>
        <Icon.ChevronDown size={14} aria-hidden className="shrink-0 text-[var(--muted)]" />
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={t('welcome.project.title')}
          onKeyDown={onKey}
          className="absolute left-0 top-full mt-2 z-dropdown w-[min(280px,calc(100vw-2rem))] max-h-72 overflow-y-auto rounded-card border border-[var(--border)] bg-raised shadow-overlay p-1.5"
        >
          <div className="px-3 pt-1.5 pb-1 text-caption font-semibold text-[var(--muted)]">{t('welcome.project.title')}</div>
          {row(null, t('welcome.project.none'), t('welcome.project.noneHint'), null)}
          {projects.map((p) => row(p.id, p.name, null, dotClass(p.id)))}
        </div>
      )}
    </div>
  )
}
