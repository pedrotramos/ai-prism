import { useId, useRef } from 'react'
import * as Icon from '../Icons.tsx'
import { useT } from '../../lib/i18n.tsx'
import { useModalDialog } from '../../lib/useModalDialog.ts'
import { describeFailure } from './projectsLogic.js'

// Small pieces shared by the Projects screens. Tokens only (no raw colors), 44 px
// targets on touch, a visible name for every control.

export const inputCls =
  'w-full min-h-10 rounded-control border border-[var(--border)] bg-[var(--surface)] px-3 text-body text-[var(--text)] placeholder:text-[var(--muted)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-60 [@media(hover:none)]:min-h-11'
export const selectCls = inputCls.replace('w-full ', 'w-auto ')
export const primaryBtn =
  'inline-flex items-center justify-center gap-1.5 min-h-10 px-4 rounded-control bg-[var(--accent-strong)] text-[var(--on-accent)] text-label font-semibold hover:brightness-110 transition duration-fast disabled:opacity-50 disabled:pointer-events-none [@media(hover:none)]:min-h-11'
export const ghostBtn =
  'inline-flex items-center justify-center gap-1.5 min-h-10 px-3 rounded-control border border-[var(--border)] bg-[var(--surface)] text-label font-semibold text-[var(--text)] hover:bg-[var(--surface-2)] transition duration-fast disabled:opacity-50 disabled:pointer-events-none [@media(hover:none)]:min-h-11'
export const dangerBtn =
  'inline-flex items-center justify-center gap-1.5 min-h-10 px-4 rounded-control border border-[var(--danger)] bg-[var(--surface)] text-[var(--danger)] text-label font-semibold hover:brightness-110 transition duration-fast disabled:opacity-50 disabled:pointer-events-none [@media(hover:none)]:min-h-11'
export const iconBtn =
  'shrink-0 grid place-items-center w-9 h-9 [@media(hover:none)]:w-11 [@media(hover:none)]:h-11 rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)] transition-colors duration-fast disabled:opacity-50'

/** A named region of the project page (one landmark per concern, so a screen reader can jump). */
export function Section({ title, hint, action, children }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 md:p-5 space-y-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <h2 id={id} className="text-body font-semibold text-[var(--text)]">
            {title}
          </h2>
          {hint && <p className="text-label text-[var(--muted)]">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** The role as text (never color alone). */
export function RoleBadge({ role }) {
  const t = useT()
  if (!role) return null
  return (
    <span className="inline-flex items-center rounded-badge bg-[var(--surface-3)] px-2 py-0.5 text-caption font-semibold text-[var(--muted)]">
      {t(`projects.role.${role}`)}
    </span>
  )
}

/**
 * A failure in words: what happened and the next step (Peak-End: the user ends
 * on what to do, not on a code). `retry` adds a Retry button when trying again is useful.
 */
export function FailureNotice({ error, ctx, onRetry, onDismiss }) {
  const t = useT()
  if (!error) return null
  const { key, next } = describeFailure({ status: error.status ?? 500, code: error.code }, ctx)
  return (
    <div role="alert" className="flex items-start gap-2 rounded-control border border-[var(--border)] bg-[var(--danger-soft)] px-3 py-2.5">
      <Icon.AlertTriangle size={16} className="shrink-0 mt-0.5 text-[var(--danger)]" />
      <p className="min-w-0 flex-1 text-body text-[var(--text)]">
        <span className="font-semibold">{t(key)}</span> {t(next)}
      </p>
      {onRetry && (
        <button type="button" onClick={onRetry} className={ghostBtn}>
          {t('projects.retry')}
        </button>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} className={iconBtn} aria-label={t('common.close')} title={t('common.close')}>
          <Icon.Close size={14} />
        </button>
      )}
    </div>
  )
}

/** Confirmation dialog: asks once, names the consequence, Cancel is the first focus. */
export function ConfirmDialog({ title, body, confirmLabel, busy, error, onConfirm, onCancel }) {
  const t = useT()
  const ref = useRef(null)
  const titleId = useId()
  const bodyId = useId()
  useModalDialog(ref, { onClose: busy ? undefined : onCancel, initialFocus: (el) => el.querySelector('[data-cancel]') })
  return (
    <div className="fixed inset-0 z-modal grid place-items-center bg-scrim p-4">
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} className="w-full max-w-md rounded-card bg-[var(--surface)] border border-[var(--border)] p-5 shadow-modal space-y-3">
        <h2 id={titleId} className="text-body font-semibold text-[var(--text)]">
          {title}
        </h2>
        <p id={bodyId} className="text-body text-[var(--muted)]">
          {body}
        </p>
        <FailureNotice error={error} ctx="delete" />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" data-cancel onClick={onCancel} disabled={busy} className={ghostBtn}>
            {t('common.cancel')}
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={dangerBtn}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
