import { useCallback, useEffect, useRef, useState } from 'react'
import * as Icon from '../components/Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import { userFacingError } from '../lib/errors.js'
import { ErrorDetails } from './ErrorBoundary.jsx'

// Small, corner-anchored toast stack. Errors are informative, not blocking: a
// toast never sits on the composer and never needs a click to go away. Each
// toast auto-dismisses, but the timer pauses while the pointer or keyboard
// focus is on it (so "Details" can be read), and screen readers hear it: info
// toasts are role="status" (polite), errors role="alert".

const DISMISS_MS = { info: 6000, error: 8000 }

export function useToasts() {
  const t = useT()
  const [toasts, setToasts] = useState([])
  const dismissToast = useCallback((id) => setToasts((prev) => prev.filter((x) => x.id !== id)), [])
  // pushToast(text) or pushToast({ message, detail, tone: 'info' | 'error' })
  const pushToast = useCallback((input) => {
    if (!input) return
    const toast = typeof input === 'string' ? { message: input, tone: 'info' } : { tone: 'info', ...input }
    if (!toast.message) return
    setToasts((prev) => [...prev, { ...toast, id: `${Date.now()}-${Math.random()}` }])
  }, [])
  // a failure from the backend or the network, mapped to friendly copy with
  // the raw text kept behind "Details"; aborts stay silent
  const notifyError = useCallback(
    (err) => {
      const e = userFacingError(t, err)
      if (e.kind === 'aborted') return
      pushToast({ ...e, tone: 'error' })
    },
    [t, pushToast]
  )
  return { toasts, pushToast, notifyError, dismissToast }
}

function Toast({ toast, onDismiss }) {
  const t = useT()
  const remaining = useRef(DISMISS_MS[toast.tone] || DISMISS_MS.info)
  const started = useRef(0)
  const timer = useRef(null)
  const hovered = useRef(false)
  const focused = useRef(false)

  const resume = () => {
    if (timer.current || hovered.current || focused.current) return
    started.current = Date.now()
    timer.current = setTimeout(() => onDismiss(toast.id), remaining.current)
  }
  const pause = () => {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = null
    remaining.current = Math.max(1500, remaining.current - (Date.now() - started.current))
  }
  useEffect(() => {
    resume()
    return () => clearTimeout(timer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const error = toast.tone === 'error'
  return (
    <div
      role={error ? 'alert' : 'status'}
      onMouseEnter={() => ((hovered.current = true), pause())}
      onMouseLeave={() => ((hovered.current = false), resume())}
      onFocus={() => ((focused.current = true), pause())}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return
        focused.current = false
        resume()
      }}
      className="pointer-events-auto flex items-start gap-2 rounded-card bg-[var(--surface-3)] border border-[var(--border)] px-3.5 py-3 text-body shadow-overlay animate-slide-in-right"
    >
      {error ? (
        <Icon.AlertTriangle size={16} className="shrink-0 mt-0.5 text-[var(--danger)]" aria-hidden />
      ) : (
        <Icon.Check size={16} className="shrink-0 mt-0.5 text-[var(--muted)]" aria-hidden />
      )}
      <div className="flex-1 min-w-0 break-words text-[var(--text)]">
        {toast.message}
        <ErrorDetails detail={toast.detail} className="mt-1" />
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 -m-1 p-1.5 rounded-control text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition duration-fast"
        aria-label={t('common.dismiss')}
        title={t('common.dismiss')}
      >
        <Icon.Close size={14} />
      </button>
    </div>
  )
}

/** Always mounted, so assistive tech registers the region before a toast arrives. */
export default function Toasts({ toasts, onDismiss }) {
  const t = useT()
  return (
    <section
      aria-label={t('shell.notifications')}
      className="fixed top-4 right-4 z-toast flex flex-col gap-2 w-[min(22rem,calc(100vw-2rem))] pointer-events-none"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </section>
  )
}
