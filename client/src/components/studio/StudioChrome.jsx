import { useEffect, useId, useRef, useState } from 'react'
import * as Icon from '../Icons.jsx'
import { useT } from '../../lib/i18n.tsx'
import { useModalDialog } from '../../lib/useModalDialog.ts'
import { createSaveQueue } from './saveQueue.js'

// Shared chrome of the three studios: the header icon button (named, ≥ 32 px,
// 40 px on phones), the close/back control, the save-status indicator, the
// confirmation dialog for destructive actions, and the small hooks they need
// (phone layout, browser Back closes the studio, autosave status).

const MOBILE_QUERY = '(max-width: 767px)'

/** true below the md breakpoint, where every studio is a full-screen dialog. */
export function useIsMobile() {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(MOBILE_QUERY).matches
  const [mobile, setMobile] = useState(get)
  useEffect(() => {
    const mq = window.matchMedia?.(MOBILE_QUERY)
    if (!mq) return undefined
    const on = () => setMobile(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return mobile
}

/** prefers-reduced-motion, for motion driven from JS (smooth scrolling). */
export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// On phones the studio is a full screen: the system/browser Back gesture must
// leave it (Jakob's law) instead of leaving the app. While open we push one
// history entry carrying the same URL; Back pops it and we call `onBack`, which
// may refuse (unsaved work → it raises its own confirmation) by returning false,
// in which case the entry is pushed again so the next Back is caught too.
export function useHistoryBack(active, onBack) {
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
  const [state, setState] = useState({ status: 'idle', error: null })
  const queue = useRef(null)
  if (!queue.current) queue.current = createSaveQueue(setState)
  const retryRef = useRef(null)
  useEffect(() => {
    queue.current.setRetry(() => retryRef.current?.())
  }, [])
  const q = queue.current
  return { ...state, run: q.run, retry: q.retry, reset: q.reset, retryRef }
}

export function SaveStatus({ status, error, onRetry, dirty = false }) {
  const t = useT()
  let body = null
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
export function StudioIconButton({ label, onClick, disabled, children, tone = 'default', className = '', pressed, ...rest }) {
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
export function StudioCloseButton({ mobile, onClick }) {
  const t = useT()
  return (
    <StudioIconButton label={mobile ? t('studio.back') : t('studio.close')} onClick={onClick} className="-ml-1.5" data-studio-close>
      {mobile ? <Icon.ChevronLeft size={20} aria-hidden /> : <Icon.Close size={20} aria-hidden />}
    </StudioIconButton>
  )
}

/**
 * Confirmation for an action that throws work away for good. alertdialog,
 * focus starts on the safe choice, Tab stays inside, Esc cancels, focus returns
 * to the opener. actions: [{ id, label, tone: 'primary'|'danger'|'default', onClick, busy }]
 */
export function StudioConfirmDialog({ title, body, actions, onCancel }) {
  const ref = useRef(null)
  const titleId = useId()
  const bodyId = useId()
  useModalDialog(ref, { onClose: onCancel, initialFocus: (el) => el.querySelector('[data-confirm-default]') })
  return (
    <div className="fixed inset-0 z-dialog grid place-items-center bg-scrim motion-safe:animate-fade-in" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        className="w-[min(92vw,26rem)] rounded-card border border-border bg-surface shadow-modal p-5"
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
                  ? 'bg-accent-strong text-on-accent hover:brightness-110 disabled:bg-disabled disabled:text-disabled-text'
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
export function useStudioDialog(ref, active) {
  useEffect(() => {
    const el = ref.current
    if (!active || !el) return undefined
    const opener = document.activeElement
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true })
    const onKey = (e) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return
      if (el.querySelector('[role="alertdialog"], [role="dialog"][aria-modal="true"]')) return
      const list = [...el.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]):not([hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')].filter(
        (n) => n.getClientRects().length > 0,
      )
      if (!list.length) return
      const head = list[0]
      const tail = list[list.length - 1]
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
export function StudioSnackbar({ message, actionLabel, onAction, onDismiss }) {
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
