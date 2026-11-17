import { Component } from 'react'
import * as Icon from '../components/Icons.jsx'
import { useT } from '../lib/i18n.jsx'

// A render error anywhere in React unmounts the whole tree: one malformed
// stored message (e.g. `attachments` holding objects instead of strings) used
// to blank the entire app with no way back. Boundaries contain the damage:
// - variant "app": around the whole shell — a full-page card with Reload;
// - variant "message": around each message (and the list) — an inline card,
//   the rest of the conversation keeps working;
// - variant "block": around one block inside a message (for Message.jsx).
// `resetKey`: when it changes the boundary tries to render its children again
// (e.g. the conversation changed, or the message was reloaded).

function AppCrash({ error }) {
  const t = useT()
  return (
    <div role="alert" className="h-full grid place-items-center p-6 bg-[var(--bg)] text-[var(--text)]">
      <div className="max-w-md w-full rounded-card border border-[var(--border)] bg-[var(--surface)] p-6 space-y-3 shadow-overlay">
        <div className="flex items-center gap-2 text-title font-semibold">
          <Icon.AlertTriangle size={18} className="text-[var(--danger)] shrink-0" />
          {t('shell.crashTitle')}
        </div>
        <p className="text-body text-[var(--muted)]">{t('shell.crashBody')}</p>
        <ErrorDetails detail={error?.message} />
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 min-h-11 px-4 rounded-control bg-accent-strong text-on-accent text-body font-semibold hover:brightness-110 transition duration-fast"
        >
          <Icon.Regenerate size={15} /> {t('shell.reload')}
        </button>
      </div>
    </div>
  )
}

function InlineCrash({ error, variant }) {
  const t = useT()
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-card border border-[var(--border)] bg-[var(--danger-soft)] px-3.5 py-3 text-body ${variant === 'block' ? 'my-2' : ''}`}
    >
      <Icon.AlertTriangle size={16} className="shrink-0 mt-0.5 text-[var(--danger)]" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-[var(--text)]">{t('shell.messageCrash')}</p>
        <ErrorDetails detail={error?.message} />
      </div>
    </div>
  )
}

/** The raw text behind a "Details" disclosure (shared by every error surface). */
export function ErrorDetails({ detail, className = '' }) {
  const t = useT()
  if (!detail) return null
  return (
    <details className={`text-label text-[var(--muted)] ${className}`}>
      <summary className="cursor-pointer select-none w-fit rounded-badge hover:text-[var(--text)]">{t('appError.details')}</summary>
      <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-caption text-[var(--muted)] max-h-40 overflow-auto">{detail}</pre>
    </details>
  )
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, key: props.resetKey }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  static getDerivedStateFromProps(props, state) {
    // a new resetKey clears the error so the children get another chance
    if (props.resetKey !== state.key) return { error: null, key: props.resetKey }
    return null
  }

  componentDidCatch(error, info) {
    // keep the stack in the console for whoever opens devtools; the UI shows
    // the friendly card
    console.error('[ErrorBoundary]', this.props.variant || 'app', error, info?.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const variant = this.props.variant || 'app'
    return variant === 'app' ? <AppCrash error={error} /> : <InlineCrash error={error} variant={variant} />
  }
}
