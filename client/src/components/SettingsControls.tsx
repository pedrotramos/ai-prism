import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import * as Icon from './Icons.tsx'
import { useT } from '../lib/i18n.tsx'

// Shared controls of the Settings / admin tabs, so every tab states its
// semantics once: a switch is role=switch with aria-checked and a name, a
// label sits above its input with its error linked by aria-describedby,
// saving shows an explicit Saved / error state, and advanced options start
// collapsed behind a disclosure.

export const inputCls =
  'w-full rounded-control border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-body focus:border-[var(--accent)] placeholder:text-[var(--faint)] aria-[invalid=true]:border-[var(--danger)]'

/** On/off switch. Name it with `label` (aria-label) or `labelledBy`. */
interface SwitchProps {
  checked?: boolean
  onChange?: (next: boolean) => void
  label?: string
  labelledBy?: string
  describedBy?: string
  disabled?: boolean
}

export function Switch({ checked, onChange, label, labelledBy, describedBy, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-pill transition duration-fast disabled:opacity-50 ${
        checked ? 'bg-[var(--accent-strong)]' : 'bg-[var(--surface-3)] ring-1 ring-inset ring-[var(--border)]'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-5 w-5 rounded-pill bg-[var(--on-accent)] shadow-raised transition-transform duration-fast ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

/**
 * Label above the control. `children` is a render function receiving the
 * props to spread on the input: id, aria-invalid, aria-describedby.
 */
interface FieldInputProps {
  id: string
  'aria-invalid': true | undefined
  'aria-describedby': string | undefined
}

interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: (props: FieldInputProps) => ReactNode
  className?: string
}

export function Field({ label, hint, error, children, className = '' }: FieldProps) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errId = error ? `${id}-err` : undefined
  const describedBy = [errId, hintId].filter(Boolean).join(' ') || undefined
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-label font-medium text-[var(--muted)] mb-1">
        {label}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {error && (
        <p id={errId} className="mt-1 text-caption text-[var(--danger)] flex items-start gap-1">
          <Icon.AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden /> {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className="mt-1 text-caption text-[var(--faint)]">
          {hint}
        </p>
      )}
    </div>
  )
}

/**
 * Explicit save feedback. state: 'idle' | 'saving' | 'saved' | 'error'.
 * "Saved" fades after a few seconds; an error stays until the next save.
 */
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface SaveStatusProps {
  state: SaveState
  error?: ReactNode
  className?: string
}

export function SaveStatus({ state, error, className = '' }: SaveStatusProps) {
  const t = useT()
  const [shown, setShown] = useState<SaveState>(state)
  useEffect(() => {
    setShown(state)
    if (state !== 'saved') return undefined
    const timer = setTimeout(() => setShown('idle'), 4000)
    return () => clearTimeout(timer)
  }, [state])
  if (shown === 'error')
    return (
      <p role="alert" className={`text-caption text-[var(--danger)] flex items-start gap-1 ${className}`}>
        <Icon.AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden /> {error || t('settings.saveFailed')}
      </p>
    )
  return (
    <span role="status" className={`text-caption ${shown === 'saved' ? 'text-[var(--success)]' : 'text-[var(--faint)]'} ${className}`}>
      {shown === 'saving' && t('common.saving')}
      {shown === 'saved' && (
        <span className="inline-flex items-center gap-1">
          <Icon.Check size={12} aria-hidden /> {t('settings.saved')}
        </span>
      )}
    </span>
  )
}

/** Collapsed-by-default section ("Advanced"). */
interface DisclosureProps {
  title: ReactNode
  hint?: ReactNode
  defaultOpen?: boolean
  children?: ReactNode
}

export function Disclosure({ title, hint, defaultOpen = false, children }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div className="rounded-card border border-[var(--border)]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen((v) => !v)}
        className="w-full min-h-11 flex items-center gap-2 px-3 text-left text-body font-medium hover:bg-[var(--surface-2)] rounded-card transition duration-fast"
      >
        <Icon.ChevronRight size={14} aria-hidden className={`shrink-0 text-[var(--muted)] transition-transform duration-fast ${open ? 'rotate-90' : ''}`} />
        <span className="flex-1">{title}</span>
        {hint && !open && <span className="text-caption text-[var(--faint)]">{hint}</span>}
      </button>
      {open && (
        <div id={`${id}-panel`} className="px-3 pb-3 pt-1">
          {children}
        </div>
      )}
    </div>
  )
}
