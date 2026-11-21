import type { ReactNode } from 'react'

// The one icon button of the message UI. `label` is mandatory: it is the
// accessible name (aria-label) and the tooltip, so an icon-only control can
// never ship unnamed. `.tap-target` (message.css) sizes it >= 32 px with a
// mouse and >= 44 px on touch.
interface ActionButtonProps {
  label: string
  onClick?: () => void
  disabled?: boolean
  pressed?: boolean
  className?: string
  children?: ReactNode
}

export default function ActionButton({ label, onClick, disabled, pressed, className = '', children }: ActionButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      className={`tap-target inline-flex items-center justify-center rounded-control text-faint hover:bg-surface-3 hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent transition-colors duration-fast ${className}`}
    >
      {children}
    </button>
  )
}
