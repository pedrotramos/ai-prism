import { useState } from 'react'
import * as Icon from './Icons.tsx'
import { useT } from '../lib/i18n.tsx'
import { authorizeProvider } from '../lib/a2a.ts'
import type { AuthDescriptor } from '../lib/a2a.ts'

// The card a tool call shows when it needs the user's own authorization (server/userAuth.ts): an A2A agent that signs
// in with an outside provider (the popup runs the authorization-code + PKCE login), or an MCP service that is not
// connected for the user (its public sign-in page opens in a new tab). Once authorized, `onAuthorized` re-runs the
// answer (regenerate); without it the card tells the user to ask again. It never shows or holds a token.
interface AuthRequiredCardProps {
  auth: AuthDescriptor
  /** re-runs the turn; absent when this message can no longer be regenerated */
  onAuthorized?: (() => void) | null
  /** false while the turn still streams: the action waits for the saved message */
  ready?: boolean
}

type Phase = 'idle' | 'waiting' | 'done' | 'failed'

export default function AuthRequiredCard({ auth, onAuthorized, ready = true }: AuthRequiredCardProps) {
  const t = useT()
  const [phase, setPhase] = useState<Phase>('idle')
  const [problem, setProblem] = useState('')
  const provider = auth.providerName || auth.provider || ''
  const isMcp = auth.kind === 'mcp'
  const btn = 'tap-target inline-flex items-center gap-1.5 rounded-control px-3 text-label font-semibold transition duration-fast disabled:opacity-50'

  const finish = () => {
    setPhase('done')
    if (onAuthorized) onAuthorized()
  }

  const authorize = async () => {
    setPhase('waiting')
    setProblem('')
    const out = await authorizeProvider(auth.provider as string)
    if (out.ok) return finish()
    setPhase('failed')
    if (out.blocked) setProblem(t('a2a.auth.popupBlocked'))
    else if (out.closed) setProblem(t('a2a.auth.closed'))
    else setProblem(t('a2a.auth.failed', { reason: t(`a2a.oauth.reason.${out.reason}`) === `a2a.oauth.reason.${out.reason}` ? t('a2a.oauth.reason.internal') : t(`a2a.oauth.reason.${out.reason}`) }))
  }

  const openLogin = () => {
    if (auth.loginUrl) window.open(auth.loginUrl, '_blank', 'noopener')
  }

  return (
    <div data-auth-required={auth.kind} role="group" aria-label={t('a2a.auth.title')} className="mb-2 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-control border border-border bg-warning-soft px-3 py-2.5">
      <span className="mt-0.5 shrink-0 text-warning" aria-hidden>
        <Icon.Lock size={16} />
      </span>
      <div className="flex-1 min-w-48">
        <p className="text-body font-semibold text-fg">{t('a2a.auth.title')}</p>
        <p className="text-label text-muted mt-0.5">{isMcp ? t('a2a.auth.bodyMcp', { name: auth.name }) : t('a2a.auth.bodyA2a', { name: auth.name, provider: provider || '—' })}</p>
        <p className="text-caption text-faint mt-0.5">{t(`a2a.auth.reason.${auth.reason}`)}</p>
        {phase === 'waiting' && (
          <p role="status" className="text-caption text-faint mt-1">
            {t('a2a.auth.waiting')}
          </p>
        )}
        {phase === 'done' && (
          <p role="status" className="text-caption text-success mt-1">
            {onAuthorized ? t('a2a.auth.connected') : t('a2a.auth.connectedAsk')}
          </p>
        )}
        {phase === 'failed' && problem && (
          <p role="alert" className="text-caption text-danger mt-1">
            {problem}
          </p>
        )}
      </div>
      {phase !== 'done' && (
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {isMcp ? (
            <>
              {auth.loginUrl && (
                <button type="button" onClick={openLogin} className={`${btn} bg-accent-strong text-on-accent hover:brightness-110`}>
                  <Icon.Link size={14} /> {t('a2a.auth.openLogin')}
                </button>
              )}
              <button type="button" onClick={finish} disabled={!ready} className={`${btn} bg-surface border border-border text-fg hover:bg-surface-3`}>
                <Icon.Regenerate size={14} /> {t('a2a.auth.retry')}
              </button>
            </>
          ) : (
            <button type="button" onClick={authorize} disabled={!ready || phase === 'waiting' || !auth.provider} className={`${btn} bg-accent-strong text-on-accent hover:brightness-110`}>
              <Icon.Shield size={14} /> {t(auth.reason === 'missing' ? 'a2a.auth.authorize' : 'a2a.auth.reauthorize', { provider: provider || '—' })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
