import * as Icon from '../components/Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import { friendlyError } from '../lib/errors.js'
import { ErrorDetails } from './ErrorBoundary.jsx'

// Shown in the chat column instead of Welcome when a conversation could not be
// opened: `error` absent = the id points at nothing (deleted, mistyped, or not
// the user's: the server scopes reads by owner, so those look the same);
// `error` present = the load failed and can be retried. Either way the user
// gets a way forward, never a silent empty chat.
export default function NotFound({ error, onRetry, onHistory, onNewChat }) {
  const t = useT()
  const failed = error ? friendlyError(t, error) : null
  return (
    <div className="h-full grid place-items-center px-4 py-section animate-fade-in">
      <div role={failed ? 'alert' : undefined} className="max-w-md w-full text-center space-y-3">
        <div className="mx-auto w-12 h-12 rounded-pill grid place-items-center bg-[var(--surface-2)] text-[var(--muted)]">
          {failed ? <Icon.AlertTriangle size={22} className="text-[var(--danger)]" /> : <Icon.Search size={22} />}
        </div>
        <h1 className="text-heading font-semibold text-[var(--text)]">{failed ? t('shell.loadFailedTitle') : t('shell.notFoundTitle')}</h1>
        <p className="text-body text-[var(--muted)]">{failed ? failed.message : t('shell.notFoundBody')}</p>
        {failed && <ErrorDetails detail={failed.detail} className="text-left mx-auto w-fit max-w-full" />}
        <div className="flex flex-wrap justify-center gap-in-group pt-2">
          {failed && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-2 min-h-11 px-4 rounded-control bg-accent-strong text-on-accent text-body font-semibold hover:brightness-110 transition duration-fast"
            >
              <Icon.Regenerate size={15} /> {t('chat.retry')}
            </button>
          )}
          <button
            type="button"
            onClick={onHistory}
            className={`inline-flex items-center gap-2 min-h-11 px-4 rounded-control text-body font-semibold transition duration-fast ${
              failed ? 'border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--text)]' : 'bg-accent-strong text-on-accent hover:brightness-110'
            }`}
          >
            <Icon.History size={15} /> {t('shell.backToHistory')}
          </button>
          <button
            type="button"
            onClick={onNewChat}
            className="inline-flex items-center gap-2 min-h-11 px-4 rounded-control border border-[var(--border)] hover:bg-[var(--surface-2)] text-body font-semibold text-[var(--text)] transition duration-fast"
          >
            <Icon.Plus size={15} /> {t('shell.newChat')}
          </button>
        </div>
      </div>
    </div>
  )
}
