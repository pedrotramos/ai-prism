import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as Icon from '../Icons.tsx'
import { useT } from '../../lib/i18n.tsx'
import { useModalDialog } from '../../lib/useModalDialog.ts'
import { createSaveQueue } from './saveQueue.ts'
import type { SaveQueue, SaveState } from './saveQueue.ts'

// Shared chrome of the three studios: the header icon button (named, ≥ 32 px,
// 40 px on phones), the close/back control, the save-status indicator, the
// confirmation dialog for destructive actions, and the small hooks they need
// (phone layout, browser Back closes the studio, autosave status).

const MOBILE_QUERY = '(max-width: 767px)'
// at or below this the sidebar collapses and the docked panel becomes an overlay
// (design.md §4.2, `--bp-overlay`); at ≤ 767 it is a full-screen dialog instead
const OVERLAY_QUERY = '(max-width: 1100px)'

function useMediaQuery(query: string) {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches
  const [match, setMatch] = useState(get)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return undefined
    const on = () => setMatch(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}

/** true below the md breakpoint, where every studio is a full-screen dialog. */
export function useIsMobile() {
  return useMediaQuery(MOBILE_QUERY)
}

/** true at ≤ 1100 px, where the docked panel floats over the chat as an overlay. */
export function useIsOverlay() {
  return useMediaQuery(OVERLAY_QUERY)
}

/**
 * Root classes of a docked studio panel (the width contract of design.md §4.2):
 * `--panel-w` is min(46vw, 760px) with a 420 px floor; above 1100 px the panel
 * sits beside the chat, from 768 to 1100 px it floats over it from the right,
 * and below 768 px it is a full screen. `focus` lets the panel take the width.
 */
export function studioPanelClass(focus = false): string {
  const base = 'fixed inset-0 z-studio flex flex-col bg-surface motion-safe:animate-fade-in [--panel-w:min(46vw,760px)]'
  // 768–1100 px: overlay from the right edge
  const overlay = 'md:inset-y-0 md:left-auto md:right-0 md:w-[max(420px,var(--panel-w))] md:max-w-full md:border-l md:border-border md:shadow-modal'
  // > 1100 px: docked sibling of the chat column
  const docked = 'ov:static ov:inset-auto ov:z-auto ov:h-full ov:shadow-none'
  const width = focus ? 'md:left-0 md:w-auto ov:flex-1 ov:min-w-0' : 'ov:shrink-0'
  return `${base} ${overlay} ${docked} ${width}`
}

/** prefers-reduced-motion, for motion driven from JS (smooth scrolling). */
export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// On phones the studio is a full screen: the system/browser Back gesture must
// leave it (Jakob's law) instead of leaving the app. While open we push one
// history entry carrying the same URL; Back pops it and we call `onBack`, which
// may refuse (unsaved work → it raises its own confirmation) by returning false,
// in which case the entry is pushed again so the next Back is caught too.
export function useHistoryBack(active: boolean | undefined, onBack?: () => unknown): void {
  const onBackRef = useRef(onBack)
  onBackRef.current = onBack
  useEffect(() => {
    if (!active) return undefined
    const marker = `studio-${Math.random().toString(36).slice(2)}`
    window.history.pushState({ ...(window.history.state || {}), prismStudio: marker }, '', window.location.href)
    let popped = false
    const onPop = () => {
      if (window.history.state?.prismStudio === marker) return
      const ok = onBackRef.current?.() !== false
      if (ok) popped = true
      else window.history.pushState({ ...(window.history.state || {}), prismStudio: marker }, '', window.location.href)
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // closed from the UI: drop our entry so Back is not a dead step
      if (!popped && window.history.state?.prismStudio === marker) window.history.back()
    }
  }, [active])
}

// Autosave status the user can trust (Flow + Peak-End): "Saving…" while a write
// is in flight, "Saved" once it landed (stays visible, not a 1 s flash), and on
// failure "Couldn't save" with Retry. Errors never vanish into a toast. Writes
// are serialized and Retry writes the current state — see saveQueue.js.
// The studio assigns `save.retryRef.current` on every render to a function that
// writes the CURRENT state (it may close over fresh state); Retry calls it.
export function useSaveStatus() {
  const [state, setState] = useState<SaveState>({ status: 'idle', error: null })
  const queue = useRef<SaveQueue | null>(null)
  if (!queue.current) queue.current = createSaveQueue(setState)
  const retryRef = useRef<(() => unknown) | null>(null)
  useEffect(() => {
    queue.current!.setRetry(() => retryRef.current?.())
  }, [])
  const q = queue.current!
  return { ...state, run: q.run, retry: q.retry, reset: q.reset, retryRef }
}

interface SaveStatusProps {
  status: SaveState['status']
  error?: string | null
  onRetry?: () => void
  dirty?: boolean
}

export function SaveStatus({ status, error, onRetry, dirty = false }: SaveStatusProps) {
  const t = useT()
  let body: ReactNode = null
  if (status === 'saving') {
    body = (
      <>
        <span className="inline-block w-3 h-3 rounded-pill border-2 border-current border-t-transparent motion-safe:animate-spin" aria-hidden />
        {t('studio.save.saving')}
      </>
    )
  } else if (status === 'error') {
    body = (
      <>
        <Icon.AlertTriangle size={13} className="text-danger shrink-0" aria-hidden />
        <span className="text-danger" title={error || undefined}>{t('studio.save.error')}</span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="min-h-8 rounded-control px-2 font-semibold text-fg underline underline-offset-2 hover:bg-surface-3">
            {t('studio.save.retry')}
          </button>
        )}
      </>
    )
  } else if (dirty) {
    body = <span>{t('studio.save.unsaved')}</span>
  } else if (status === 'saved') {
    body = (
      <>
        <Icon.Check size={13} className="text-success shrink-0" aria-hidden />
        {t('studio.save.saved')}
      </>
    )
  }
  return (
    <span role="status" data-save-status={dirty && status !== 'saving' && status !== 'error' ? 'dirty' : status} className="inline-flex items-center gap-1.5 text-caption text-muted whitespace-nowrap min-w-0">
      {body}
    </span>
  )
}

/** A named icon-only button for studio toolbars: ≥ 32 px, 40 px on phones. */
interface StudioIconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className' | 'onClick' | 'disabled'> {
  label: string
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  disabled?: boolean
  children?: ReactNode
  tone?: 'default' | 'danger'
  className?: string
  pressed?: boolean
  // the studios pass data-* flags (e.g. data-studio-close)
  [dataAttr: `data-${string}`]: string | boolean | undefined
}

export function StudioIconButton({ label, onClick, disabled, children, tone = 'default', className = '', pressed, ...rest }: StudioIconButtonProps) {
  const toneCls =
    tone === 'danger'
      ? 'text-muted hover:text-danger hover:bg-danger-soft focus-visible:text-danger'
      : 'text-muted hover:text-fg hover:bg-surface-3'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={`shrink-0 min-w-8 min-h-8 max-md:min-w-11 max-md:min-h-11 grid place-items-center rounded-control transition-colors duration-fast disabled:text-disabled-text disabled:hover:bg-transparent ${toneCls} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

/** Close on desktop, Back (←) on phones where the studio is a full screen. */
export function StudioCloseButton({ mobile, onClick }: { mobile?: boolean; onClick?: React.MouseEventHandler<HTMLButtonElement> }) {
  const t = useT()
  return (
    <StudioIconButton label={mobile ? t('studio.back') : t('studio.close')} onClick={onClick} className="-ml-1.5" data-studio-close>
      {mobile ? <Icon.ChevronLeft size={20} aria-hidden /> : <Icon.Close size={20} aria-hidden />}
    </StudioIconButton>
  )
}

/**
 * The panel header of every studio (design.md §2.7): close · kind icon · name
 * with a "kind · count" line under it · undo/redo (only where the studio keeps
 * a history) · the studio's own actions · the primary export. `title` is the
 * studio's name control (an input, so it can be renamed in place). Undo/redo
 * render only when a handler is given; no version pill, share or presence.
 */
interface StudioHeaderProps {
  mobile?: boolean
  onClose?: React.MouseEventHandler<HTMLButtonElement>
  icon: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  undo?: { onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean } | null
  /** actions between undo/redo and the export (edit, present, expand…) */
  actions?: ReactNode
  /** the primary export control */
  primary?: ReactNode
}

export function StudioHeader({ mobile, onClose, icon, title, subtitle, undo = null, actions, primary }: StudioHeaderProps) {
  const t = useT()
  return (
    <header className="shrink-0 min-h-14 flex items-center gap-1.5 md:gap-2 px-2 md:px-3 py-1.5 border-b border-border bg-raised">
      <StudioCloseButton mobile={mobile} onClick={onClose} />
      <span className="shrink-0 grid place-items-center w-8 h-8 rounded-control bg-accent-soft text-accent-text max-sm:hidden" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1 flex flex-col justify-center">
        {title}
        {subtitle && <span data-studio-subtitle className="text-caption text-muted truncate">{subtitle}</span>}
      </div>
      <div className="ml-auto flex items-center gap-1 shrink-0">
        {undo && (
          <>
            <StudioIconButton label={t('studio.undo')} onClick={undo.onUndo} disabled={!undo.canUndo} data-studio-undo>
              <Icon.Undo size={16} aria-hidden />
            </StudioIconButton>
            <StudioIconButton label={t('studio.redo')} onClick={undo.onRedo} disabled={!undo.canRedo} data-studio-redo>
              <Icon.Redo size={16} aria-hidden />
            </StudioIconButton>
            <span role="separator" aria-orientation="vertical" className="w-px h-5 bg-border mx-1 shrink-0 max-sm:hidden" />
          </>
        )}
        {actions}
        {primary}
      </div>
    </header>
  )
}

/**
 * Confirmation for an action that throws work away for good. alertdialog,
 * focus starts on the safe choice, Tab stays inside, Esc cancels, focus returns
 * to the opener. actions: [{ id, label, tone: 'primary'|'danger'|'default', onClick, busy }]
 */
interface StudioConfirmAction {
  id: string
  label: ReactNode
  tone?: 'primary' | 'danger' | 'default'
  onClick: React.MouseEventHandler<HTMLButtonElement>
  busy?: boolean
  default?: boolean
}

interface StudioConfirmDialogProps {
  title: ReactNode
  body: ReactNode
  actions: StudioConfirmAction[]
  onCancel: () => void
}

export function StudioConfirmDialog({ title, body, actions, onCancel }: StudioConfirmDialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const bodyId = useId()
  useModalDialog(ref, { onClose: onCancel, initialFocus: (el) => el.querySelector<HTMLElement>('[data-confirm-default]') })
  return (
    <div className="fixed inset-0 z-dialog grid place-items-center bg-scrim motion-safe:animate-fade-in" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        className="w-[min(92vw,26rem)] rounded-card border border-border bg-raised shadow-modal p-5"
      >
        <h2 id={titleId} className="text-title font-semibold text-fg">{title}</h2>
        <p id={bodyId} className="text-body text-muted mt-1.5">{body}</p>
        <div className="flex flex-wrap items-center justify-end gap-2 mt-4">
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={a.onClick}
              disabled={a.busy}
              data-confirm-default={a.default ? '' : undefined}
              className={`min-h-9 max-md:min-h-11 inline-flex items-center gap-1.5 rounded-control font-semibold text-label px-3 transition-colors duration-fast ${
                a.tone === 'primary'
                  ? 'bg-action text-on-action hover:opacity-90 disabled:bg-disabled disabled:text-disabled-text'
                  : a.tone === 'danger'
                    ? 'border border-border text-danger hover:bg-danger-soft'
                    : 'border border-border text-muted hover:bg-surface-3'
              }`}
            >
              {a.busy && <span className="w-3 h-3 rounded-pill border-2 border-current border-t-transparent motion-safe:animate-spin" aria-hidden />}
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * The full-screen dialog behaviour for a studio that covers the app (spreadsheet
 * and document always; the deck on phones): initial focus, Tab trap, focus
 * return. Escape is NOT handled here: each studio decides what Esc means (leave
 * edit mode first, then close).
 */
export function useStudioDialog(ref: React.RefObject<HTMLElement | null>, active: boolean | undefined): void {
  useEffect(() => {
    const el = ref.current
    if (!active || !el) return undefined
    const opener = document.activeElement
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return
      if (el.querySelector('[role="alertdialog"], [role="dialog"][aria-modal="true"]')) return
      const list = [...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]):not([hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')].filter(
        (n) => n.getClientRects().length > 0,
      )
      if (!list.length) return
      const head = list[0]!
      const tail = list[list.length - 1]!
      if (e.shiftKey && (document.activeElement === head || document.activeElement === el)) {
        e.preventDefault()
        tail.focus()
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault()
        head.focus()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('keydown', onKey)
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** Bottom snackbar with an action (Undo). role=status so it is announced. */
interface StudioSnackbarProps {
  message: ReactNode
  actionLabel?: ReactNode
  onAction?: () => void
  onDismiss?: () => void
}

export function StudioSnackbar({ message, actionLabel, onAction, onDismiss }: StudioSnackbarProps) {
  const t = useT()
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-popover flex justify-center px-3">
      <div role="status" data-studio-snackbar className="pointer-events-auto flex items-center gap-2 rounded-card border border-border bg-surface-3 shadow-overlay pl-4 pr-1.5 py-1.5 text-body text-fg motion-safe:animate-fade-in">
        <span className="min-w-0">{message}</span>
        {onAction && (
          <button type="button" onClick={onAction} className="min-h-8 rounded-control px-3 font-semibold text-accent-text hover:bg-surface-2">
            {actionLabel}
          </button>
        )}
        {onDismiss && (
          <StudioIconButton label={t('studio.dismiss')} onClick={onDismiss}>
            <Icon.Close size={14} aria-hidden />
          </StudioIconButton>
        )}
      </div>
    </div>
  )
}
