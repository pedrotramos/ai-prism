import { useT } from '../lib/i18n.tsx'

// "Temporary" marker of a temporary chat (W3-6): a closed padlock and the word.
// Used in the sidebar row and the chat header. The text is the accessible name
// (the padlock is decorative); `compact` keeps only the padlock on a phone-width
// header and leaves the word to screen readers there.
interface TemporaryBadgeProps {
  compact?: boolean
  className?: string
}

export default function TemporaryBadge({ compact = false, className = '' }: TemporaryBadgeProps) {
  const t = useT()
  return (
    <span
      data-temporary-badge=""
      title={t('sidebar.temporaryHint')}
      className={`inline-flex items-center gap-1 shrink-0 text-caption font-medium text-[var(--muted)] ${className}`}
    >
      <svg
        aria-hidden="true"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      <span className={compact ? 'sr-only sm:not-sr-only' : ''}>{t('sidebar.temporary')}</span>
    </span>
  )
}
