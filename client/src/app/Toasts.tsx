import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusEvent } from 'react'
import * as Icon from '../components/Icons.tsx'
import { useT } from '../lib/i18n.tsx'
import { userFacingError } from '../lib/errors.ts'
import { pt, en, es } from '../lib/locales/index.ts'
import { ErrorDetails } from './ErrorBoundary.tsx'

// A small ink pill at the bottom centre (the mockup's toast), with an optional
// action. Errors are informative, not blocking: a toast never needs a click to
// go away. Each
// toast auto-dismisses, but the timer pauses while the pointer or keyboard
// focus is on it (so "Details" can be read), and screen readers hear it: the
// two live regions (status for info, alert for errors) are always mounted, so a
// toast inserted into them is announced.

type ToastTone = 'info' | 'error'

interface ToastInput {
  message: string
  detail?: string
  tone?: ToastTone
  /** a single follow-up the user can take from the toast (e.g. Undo); taking it dismisses the toast */
  action?: { label: string; onClick: () => void }
}

interface ToastItem extends ToastInput {
  id: string
  tone: ToastTone
}

const DISMISS_MS: Record<ToastTone, number> = { info: 6000, error: 8000 }

// every string the UI catalogs can produce: a caller that passes one of these
// (e.g. t('docStudio.saveError')) already has human copy; anything else that
// reaches a toast is a raw backend message and goes behind Details
const CATALOG_TEXT = new Set([pt, en, es].flatMap((c) => Object.values(c)))
const isCatalogText = (s: string): boolean => CATALOG_TEXT.has(s)

export function useToasts() {
  const t = useT()
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const dismissToast = useCallback((id: string) => setToasts((prev) => prev.filter((x) => x.id !== id)), [])
  // pushToast(text) or pushToast({ message, detail, tone: 'info' | 'error' })
  const pushToast = useCallback((input: string | ToastInput) => {
    if (!input) return
    const toast: ToastInput & { tone: ToastTone } = typeof input === 'string' ? { message: input, tone: 'info' } : { tone: 'info', ...input }
    if (!toast.message) return
    setToasts((prev) => [...prev, { ...toast, id: `${Date.now()}-${Math.random()}` }])
  }, [])
  // a failure from the backend or the network, mapped to friendly copy with
  // the raw text kept behind "Details"; aborts stay silent
  const notifyError = useCallback(
    (err: unknown) => {
      const e = userFacingError(t, err, isCatalogText)
      if (e.kind === 'aborted') return
      pushToast({ ...e, tone: 'error' })
    },
    [t, pushToast]
  )
  return { toasts, pushToast, notifyError, dismissToast }
}

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const t = useT()
  const remaining = useRef(DISMISS_MS[toast.tone] || DISMISS_MS.info)
  const started = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    return () => {
      clearTimeout(timer.current ?? undefined)
      timer.current = null // StrictMode re-runs the effect: let resume() start again
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const error = toast.tone === 'error'
  return (
    <div
      onMouseEnter={() => ((hovered.current = true), pause())}
      onMouseLeave={() => ((hovered.current = false), resume())}
      onFocus={() => ((focused.current = true), pause())}
      onBlur={(e: FocusEvent<HTMLDivElement>) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        focused.current = false
        resume()
      }}
      className="pointer-events-auto flex items-start gap-3 rounded-card bg-action text-on-action px-3.5 py-2.5 text-body shadow-overlay animate-fade-in motion-reduce:animate-none"
    >
      {error ? (
        <Icon.AlertTriangle size={16} className="shrink-0 mt-0.5 text-on-action" aria-hidden />
      ) : (
        <Icon.Check size={16} className="shrink-0 mt-0.5 text-on-action" aria-hidden />
      )}
      {/* the raw error text keeps readable colours on the ink */}
      <div className="flex-1 min-w-0 break-words text-on-action [&_details]:text-on-action [&_pre]:text-on-action">
        {toast.message}
        <ErrorDetails detail={toast.detail} className="mt-1" />
      </div>
      {toast.action && (
        <button
          type="button"
          onClick={() => (toast.action!.onClick(), onDismiss(toast.id))}
          className="shrink-0 min-h-6 rounded-badge font-semibold underline underline-offset-[3px] hover:opacity-80 transition duration-fast"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 -m-1 p-1.5 rounded-control opacity-70 hover:opacity-100 hover:bg-[color-mix(in_srgb,var(--on-action)_14%,transparent)] transition duration-fast"
        aria-label={t('common.dismiss')}
        title={t('common.dismiss')}
      >
        <Icon.Close size={14} />
      </button>
    </div>
  )
}

/** Always mounted, so assistive tech registers both live regions before a toast arrives. */
export default function Toasts({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  const t = useT()
  const list = (tone: ToastTone) => toasts.filter((x) => (x.tone === 'error') === (tone === 'error')).map((toast) => <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />)
  return (
    <section
      aria-label={t('shell.notifications')}
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-toast flex flex-col items-stretch gap-2 w-[min(35rem,calc(100vw-2rem))] pointer-events-none"
    >
      <div role="alert" className="flex flex-col gap-2 empty:hidden">
        {list('error')}
      </div>
      <div role="status" aria-live="polite" className="flex flex-col gap-2 empty:hidden">
        {list('info')}
      </div>
    </section>
  )
}

export type ToastsState = ReturnType<typeof useToasts>
