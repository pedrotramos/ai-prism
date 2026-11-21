// One anatomy for every generated artifact in the chat (deck, spreadsheet,
// document): icon, title, meta, one primary action, an optional secondary
// action, then an optional body (slide previews, a teaser). The layout follows
// the card's own width through a container query (message.css), not the
// viewport, so the narrow chat column beside an open studio moves the actions
// under the title instead of squeezing the title to one character per line.
import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface CardAction {
  icon?: ReactNode
  label: ReactNode
  onClick?: () => void
  disabled?: boolean
  title?: string
  'aria-busy'?: boolean
}

interface CardButtonProps extends CardAction, Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CardAction | 'children' | 'className' | 'type'> {
  primary?: boolean
}

interface ArtifactCardProps {
  kind: string
  icon?: ReactNode
  title?: string
  meta?: ReactNode
  primary?: CardAction | null
  secondary?: CardAction | null
  error?: string
  children?: ReactNode
}

export function CardButton({ primary = false, icon, label, onClick, disabled, title, ...rest }: CardButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`tap-target inline-flex items-center justify-center gap-2 rounded-control px-3 text-label font-semibold whitespace-nowrap transition duration-fast disabled:bg-disabled disabled:text-disabled-text disabled:border-transparent disabled:cursor-not-allowed ${
        primary
          ? 'bg-accent-strong text-on-accent hover:brightness-110'
          : 'bg-surface border border-border text-fg hover:bg-surface-3'
      }`}
      {...rest}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

export default function ArtifactCard({ kind, icon, title, meta, primary, secondary, error, children }: ArtifactCardProps) {
  return (
    <div data-artifact-card={kind} className="artifact-card my-3 rounded-card border border-border bg-surface-2 p-3">
      <div className="artifact-card__head">
        <div className="artifact-card__icon grid place-items-center w-10 h-10 rounded-control bg-surface border border-border text-accent" aria-hidden>
          {icon}
        </div>
        <div className="artifact-card__text">
          <div data-card-title className="truncate text-body font-semibold text-fg" title={title}>
            {title}
          </div>
          {meta && (
            <div data-card-meta className="truncate text-caption text-faint">
              {meta}
            </div>
          )}
        </div>
        {(primary || secondary) && (
          <div className="artifact-card__actions">
            {primary && <CardButton primary data-card-primary {...primary} />}
            {secondary && <CardButton {...secondary} />}
          </div>
        )}
      </div>
      {children && (
        <div data-card-body className="mt-3">
          {children}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-caption text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
