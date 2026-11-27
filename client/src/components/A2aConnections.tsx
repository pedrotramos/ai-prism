import { useEffect, useState } from 'react'
import * as Icon from './Icons.tsx'
import { useT } from '../lib/i18n.tsx'
import { getJSON, postJSON } from '../api.ts'
import { authorizeProvider, disconnectProvider } from '../lib/a2a.ts'
import type { A2aAgent, A2aProvider } from '../lib/a2a.ts'

// "Minhas conexões" section for A2A agents (rendered inside McpConnectionsTab): this user's sign-in per outside
// provider (connect / disconnect) and the state of each registered agent for THIS user. Nothing here holds a
// credential: the server keeps the tokens sealed and answers with connection state only.
type Translate = (key: string, vars?: Record<string, unknown>) => string

const STATUS_CLS: Record<string, string> = {
  connected: 'text-[var(--success)] border-[color-mix(in_srgb,var(--success)_50%,transparent)]',
  auth_required: 'text-[var(--warning)] border-[color-mix(in_srgb,var(--warning)_50%,transparent)]',
  no_access: 'text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_60%,transparent)]',
  unavailable: 'text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_60%,transparent)]',
  invalid_card: 'text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_60%,transparent)]',
  unknown: 'text-[var(--faint)] border-[var(--border)]',
}

const secondaryBtn = 'rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-label px-3 min-h-8 disabled:opacity-50'
const primaryBtn = 'rounded-lg bg-[var(--accent-strong)] hover:brightness-110 text-[var(--on-accent)] text-label font-semibold px-3 min-h-8 disabled:opacity-50'

export default function A2aConnections({ open }: { open: boolean }) {
  const t = useT() as Translate
  const [agents, setAgents] = useState<A2aAgent[] | null>(null)
  const [providers, setProviders] = useState<A2aProvider[]>([])
  const [disabled, setDisabled] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [forceFor, setForceFor] = useState<string | null>(null) // provider whose revocation the IdP did not confirm

  const reasonText = (code: string) => (t(`a2a.oauth.reason.${code}`) === `a2a.oauth.reason.${code}` ? t('a2a.oauth.reason.internal') : t(`a2a.oauth.reason.${code}`))

  const load = async () => {
    try {
      const [a, p] = await Promise.all([getJSON<{ agents?: A2aAgent[] }>('/api/a2a/agents'), getJSON<{ providers?: A2aProvider[]; disabledReason?: string | null }>('/api/a2a/providers')])
      setAgents(a.agents || [])
      setProviders(p.providers || [])
      setDisabled(!!p.disabledReason)
      setError('')
    } catch (e) {
      setError((e as Error).message)
      setAgents([])
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async (p: A2aProvider) => {
    setBusy(`p:${p.id}`)
    setError('')
    const out = await authorizeProvider(p.id)
    if (!out.ok && !out.closed) setError(out.blocked ? t('a2a.auth.popupBlocked') : t('a2a.auth.failed', { reason: reasonText(out.reason) }))
    await load()
    setBusy(null)
  }

  const disconnect = async (p: A2aProvider, force = false) => {
    setBusy(`p:${p.id}`)
    setError('')
    const out = await disconnectProvider(p.id, force)
    if (out.ok) setForceFor(null)
    else {
      setForceFor(p.id)
      setError(t('a2a.mine.disconnectFailed', { provider: p.name }))
    }
    await load()
    setBusy(null)
  }

  const check = async (a: A2aAgent) => {
    setBusy(`a:${a.id}`)
    setError('')
    try {
      const r = await postJSON<{ status: string; error?: string }>(`/api/a2a/agents/${encodeURIComponent(a.id)}/check`, {})
      setAgents((list) => (list || []).map((x) => (x.id === a.id ? { ...x, status: r.status, lastError: r.error || '' } : x)))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (agents === null) return <div className="text-body text-[var(--muted)]">{t('a2a.mine.loading')}</div>
  // nothing registered and nothing to sign in to: the section stays out of the way
  if (!agents.length && !providers.length) return null

  return (
    <section aria-labelledby="a2a-mine-title" className="space-y-3 border-t border-[var(--border)] pt-5">
      <div>
        <h3 id="a2a-mine-title" className="text-title font-semibold flex items-center gap-2">
          <Icon.Shield size={16} /> {t('a2a.mine.title')}
        </h3>
        <p className="text-label text-[var(--muted)] mt-0.5">{t('a2a.mine.subtitle')}</p>
      </div>

      {error && (
        <p role="alert" className="text-label text-[var(--danger)]">
          {error}
        </p>
      )}

      {disabled && <p className="text-label text-[var(--warning)]">{t('a2a.mine.disabled')}</p>}

      <div className="space-y-2">
        <h4 className="text-label font-semibold text-[var(--muted)]">{t('a2a.mine.providers')}</h4>
        {!providers.length && <p className="text-label text-[var(--faint)]">{t('a2a.mine.noProviders')}</p>}
        {providers.map((p) => {
          const working = busy === `p:${p.id}`
          return (
            <div key={p.id} className="rounded-xl border border-[var(--border)] p-3 flex items-center gap-3">
              <Icon.Lock size={16} className="shrink-0 text-[var(--muted)]" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-body truncate">{p.name}</div>
                <div className="text-caption text-[var(--faint)]">
                  {p.connected ? t('a2a.mine.connected') : t('a2a.mine.notConnected')}
                  {p.connected && p.idpEmailVerified ? ` · ${t('a2a.mine.idpVerified')}` : ''}
                </div>
              </div>
              {working && (
                <span role="status" className="text-caption text-[var(--faint)]">
                  {t('a2a.mine.checking')}
                </span>
              )}
              {p.connected ? (
                <>
                  <button onClick={() => disconnect(p)} disabled={working} className={secondaryBtn}>
                    {t('a2a.mine.disconnect')}
                  </button>
                  {forceFor === p.id && (
                    <button onClick={() => disconnect(p, true)} disabled={working} className={`${secondaryBtn} text-[var(--danger)]`}>
                      {t('a2a.mine.disconnectForce')}
                    </button>
                  )}
                </>
              ) : (
                <button onClick={() => connect(p)} disabled={working || p.disabled} className={primaryBtn}>
                  {t('a2a.mine.connect')}
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="space-y-2">
        <h4 className="text-label font-semibold text-[var(--muted)]">{t('a2a.mine.agents')}</h4>
        {!agents.length && <p className="text-label text-[var(--faint)]">{t('a2a.mine.noAgents')}</p>}
        {agents.map((a) => {
          const working = busy === `a:${a.id}`
          const via = a.authStrategy === 'oauth2-user' ? t('a2a.mine.via.oauth2-user', { provider: a.authProviderName || a.authProvider || '' }) : t(`a2a.mine.via.${a.authStrategy}`)
          return (
            <div key={a.id} className="rounded-xl border border-[var(--border)] p-3">
              <div className="flex items-center gap-3">
                <Icon.Plug size={16} className="shrink-0 text-[var(--muted)]" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-body truncate">{a.displayName}</div>
                  <div className="text-label text-[var(--muted)] truncate">{a.card.description || t('a2a.mine.noDescription')}</div>
                  <div className="text-caption text-[var(--faint)] mt-0.5 truncate">{via}</div>
                </div>
                {!a.enabled && <span className="text-caption border border-[var(--border)] rounded px-1.5 py-0.5 shrink-0 text-[var(--faint)]">{t('a2a.mine.disabledByAdmin')}</span>}
                <span className={`text-caption border rounded px-1.5 py-0.5 shrink-0 ${STATUS_CLS[a.status] || STATUS_CLS.unknown}`}>{t(`a2a.status.${STATUS_CLS[a.status] ? a.status : 'unknown'}`)}</span>
              </div>
              {a.lastError && a.status !== 'connected' && <p className="text-caption text-[var(--danger)] mt-1.5 break-words">{a.lastError}</p>}
              <div className="mt-2.5 flex items-center gap-2 justify-end">
                {working && (
                  <span role="status" className="text-caption text-[var(--faint)]">
                    {t('a2a.mine.checking')}
                  </span>
                )}
                <button onClick={() => check(a)} disabled={working} className={secondaryBtn}>
                  {t('a2a.mine.check')}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
