import * as Icon from '../Icons.jsx'
import { useT } from '../../lib/i18n.jsx'
import CopyButton from './CopyButton.jsx'

// A notice at the end of an answer that always carries its way forward:
// `error` (the answer failed or came back truncated) offers Retry; `stopped`
// (the turn ended early on a loop, round or time limit) offers Continue when
// the parent can continue the turn, and Retry. An optional `prompt` adds a
// "copy message" action so a failed prompt is never lost.
export default function NoticeCard({ kind, text, onRetry, onContinue, prompt }) {
  const t = useT()
  const isError = kind === 'error'
  const btn =
    'tap-target inline-flex items-center gap-1.5 rounded-control px-3 text-label font-semibold transition duration-fast'
  return (
    <div
      data-notice={kind}
      className={`mt-3 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-control border border-border px-3 py-2.5 ${
        isError ? 'bg-danger-soft' : 'bg-info-soft'
      }`}
    >
      <span className={`mt-0.5 shrink-0 ${isError ? 'text-danger' : 'text-info'}`} aria-hidden>
        {isError ? <Icon.AlertTriangle size={16} /> : <InfoIcon />}
      </span>
      <p className="flex-1 min-w-48 text-body text-fg">{text}</p>
      {(onRetry || onContinue || prompt) && (
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {onContinue && (
            <button type="button" onClick={onContinue} className={`${btn} bg-accent-strong text-on-accent hover:brightness-110`}>
              <Icon.Play size={14} /> {t('message.continue')}
            </button>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              // primary only when it is the one way forward from a failure; on an
              // informational stop the answer is usable, so Retry stays secondary
              className={`${btn} ${
                isError && !onContinue
                  ? 'bg-accent-strong text-on-accent hover:brightness-110'
                  : 'bg-surface border border-border text-fg hover:bg-surface-3'
              }`}
            >
              <Icon.Regenerate size={14} /> {t('message.retry')}
            </button>
          )}
          {prompt && <CopyButton text={prompt} label={t('message.copyPrompt')} />}
        </div>
      )}
    </div>
  )
}

const InfoIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
)
