import { useEffect, useState } from 'react'
import * as Icon from './Icons.tsx'
import { useT } from '../lib/i18n.tsx'
import { getJSON, postJSON, putJSON } from '../api.ts'
import type { A2aAdminProvider, A2aAgent } from '../lib/a2a.ts'

// Admin: the org catalog of A2A agents (register by card URL or Databricks App name, check again, offer or hide,
// remove) and the provider configuration the server loaded (errors and the redirect URI to register at the IdP).
// Registering and checking never send the admin's credential: the server reads only what the host serves anonymously.
type Translate = (key: string, vars?: Record<string, unknown>) => string

const secondaryBtn = 'rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-label px-3 min-h-8 disabled:opacity-50'
const input = 'w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-body focus:border-[var(--accent)] placeholder:text-[var(--faint)]'

const CHECK_CLS: Record<string, string> = {
  ok: 'text-[var(--success)] border-[color-mix(in_srgb,var(--success)_50%,transparent)]',
  card_requires_auth: 'text-[var(--warning)] border-[color-mix(in_srgb,var(--warning)_50%,transparent)]',
  invalid_card: 'text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_60%,transparent)]',
  unavailable: 'text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_60%,transparent)]',
  unknown: 'text-[var(--faint)] border-[var(--border)]',
}

export default function A2aAgentsAdminTab({ open }: { open: boolean }) {
  const t = useT() as Translate
  const [agents, setAgents] = useState<A2aAgent[] | null>(null)
  const [providers, setProviders] = useState<A2aAdminProvider[]>([])
  const [disabledReason, setDisabledReason] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [cardUrl, setCardUrl] = useState('')
  const [appName, setAppName] = useState('')
  const [registering, setRegistering] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const errText = (e: unknown) => {
    const err = e as { code?: string; message?: string } | null
    const key = `a2a.admin.err.${err?.code}`
    return err?.code && t(key) !== key ? t(key) : err?.message || String(e)
  }

  const load = async () => {
    try {
      const [a, p] = await Promise.all([getJSON<{ agents?: A2aAgent[] }>('/api/a2a/agents'), getJSON<{ providers?: A2aAdminProvider[]; disabledReason?: string | null }>('/api/admin/a2a/providers')])
      setAgents(a.agents || [])
      setProviders(p.providers || [])
      setDisabledReason(p.disabledReason || null)
      setError('')
    } catch (e) {
      setError(errText(e))
      setAgents([])
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const replace = (agent: A2aAgent) => setAgents((list) => (list || []).map((x) => (x.id === agent.id ? { ...x, ...agent } : x)))

  const register = async () => {
    if (!cardUrl.trim() && !appName.trim()) return setError(t('a2a.admin.err.bad_request'))
    setRegistering(true)
    setError('')
    try {
      await postJSON('/api/a2a/agents', { cardUrl: cardUrl.trim(), appName: appName.trim() })
      setCardUrl('')
      setAppName('')
      await load()
    } catch (e) {
      setError(errText(e))
    } finally {
      setRegistering(false)
    }
  }

  const verify = async (a: A2aAgent) => {
    setBusy(a.id)
    try {
      const r = await postJSON<{ agent: A2aAgent }>(`/api/a2a/agents/${encodeURIComponent(a.id)}/verify`, {})
      replace(r.agent)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(null)
    }
  }

  const toggle = async (a: A2aAgent) => {
    setBusy(a.id)
    try {
      const r = await putJSON<{ agent: A2aAgent }>(`/api/a2a/agents/${encodeURIComponent(a.id)}/enabled`, { enabled: !a.enabled })
      replace(r.agent)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (a: A2aAgent) => {
    if (!window.confirm(t('a2a.admin.confirmRemove', { name: a.displayName }))) return
    setBusy(a.id)
    try {
      const r = await fetch(`/api/a2a/agents/${encodeURIComponent(a.id)}`, { method: 'DELETE' })
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { code: ((await r.json().catch(() => ({}))) as { code?: string }).code })
      setAgents((list) => (list || []).filter((x) => x.id !== a.id))
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(null)
    }
  }

  if (agents === null) return <div className="text-body text-[var(--muted)]">{t('a2a.admin.loading')}</div>

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-title font-semibold flex items-center gap-2">
          <Icon.Plug size={16} /> {t('a2a.admin.title')}
        </h3>
        <p className="text-label text-[var(--muted)] mt-0.5">{t('a2a.admin.subtitle')}</p>
      </div>

      <form
        className="rounded-xl border border-[var(--border)] p-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          register()
        }}
      >
        <label className="block">
          <span className="text-label text-[var(--muted)]">{t('a2a.admin.cardUrl')}</span>
          <input value={cardUrl} onChange={(e) => setCardUrl(e.target.value)} type="url" placeholder={t('a2a.admin.cardUrlPlaceholder')} className={`${input} mt-1`} />
        </label>
        <label className="block">
          <span className="text-label text-[var(--muted)]">{t('a2a.admin.appName')}</span>
          <input value={appName} onChange={(e) => setAppName(e.target.value)} placeholder={t('a2a.admin.appNamePlaceholder')} className={`${input} mt-1`} />
        </label>
        <div className="flex justify-end">
          <button type="submit" disabled={registering} className="rounded-lg bg-[var(--accent-strong)] hover:brightness-110 text-[var(--on-accent)] text-label font-semibold px-3 min-h-8 disabled:opacity-50">
            {registering ? t('a2a.admin.registering') : t('a2a.admin.register')}
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className="text-label text-[var(--danger)]">
          {error}
        </p>
      )}

      {!agents.length && <div className="text-body text-[var(--muted)]">{t('a2a.admin.empty')}</div>}

      <div className="space-y-2">
        {agents.map((a) => {
          const working = busy === a.id
          const check = a.configStatus && CHECK_CLS[a.configStatus] ? a.configStatus : 'unknown'
          return (
            <div key={a.id} className="rounded-xl border border-[var(--border)] p-3">
              <div className="flex items-center gap-3">
                <Icon.Plug size={16} className="shrink-0 text-[var(--muted)]" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-body truncate">{a.displayName}</div>
                  <div className="text-caption text-[var(--faint)] font-mono truncate">{a.cardUrl}</div>
                </div>
                <span className={`text-caption border rounded px-1.5 py-0.5 shrink-0 ${CHECK_CLS[check]}`}>{t(`a2a.status.${check}`)}</span>
              </div>
              {a.card.description && <p className="text-label text-[var(--muted)] mt-1.5">{a.card.description}</p>}
              <p className="text-caption text-[var(--faint)] mt-1.5">
                {t('a2a.admin.strategy')}: {a.authStrategy === 'oauth2-user' ? t('a2a.mine.via.oauth2-user', { provider: a.authProviderName || a.authProvider || '' }) : t(`a2a.mine.via.${a.authStrategy}`)} · {a.cardPublic ? t('a2a.admin.cardPublic') : t('a2a.admin.cardPrivate')}
              </p>
              {a.card.skills.length > 0 && (
                <p className="text-caption text-[var(--faint)] mt-1 truncate">
                  {t('a2a.admin.skills')}: {a.card.skills.map((s) => s.name).join(', ')}
                </p>
              )}
              {a.configError && <p className="text-caption text-[var(--danger)] mt-1.5 break-words">{a.configError}</p>}
              <div className="mt-2.5 flex flex-wrap items-center gap-2 justify-end">
                <button role="switch" aria-checked={a.enabled} aria-label={t('a2a.admin.enabledLabel', { name: a.displayName })} onClick={() => toggle(a)} disabled={working} className={secondaryBtn}>
                  {a.enabled ? t('a2a.admin.on') : t('a2a.admin.off')}
                </button>
                <button onClick={() => verify(a)} disabled={working} className={secondaryBtn}>
                  {t('a2a.admin.verify')}
                </button>
                <button onClick={() => remove(a)} disabled={working} className={`${secondaryBtn} text-[var(--danger)]`}>
                  {t('a2a.admin.remove')}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="space-y-2 border-t border-[var(--border)] pt-4">
        <h4 className="text-label font-semibold text-[var(--muted)]">{t('a2a.admin.providers')}</h4>
        {(!providers.length || disabledReason) && <p className="text-label text-[var(--faint)]">{providers.length ? t('a2a.mine.disabled') : t('a2a.admin.noProviders')}</p>}
        {providers.map((p) => (
          <div key={p.id} className="rounded-xl border border-[var(--border)] p-3 space-y-1">
            <div className="font-medium text-body">{p.name}</div>
            {p.error ? (
              <p className="text-caption text-[var(--danger)] break-words">{t('a2a.admin.providerError', { error: p.error })}</p>
            ) : (
              <>
                <p className="text-caption text-[var(--faint)] break-all">
                  {t('a2a.admin.redirectUri')}: <span className="font-mono">{p.redirectUri}</span>
                </p>
                <p className="text-caption text-[var(--faint)] break-words">
                  {t('a2a.admin.scopes')}: {p.scopes.join(' ') || '—'}
                </p>
                <p className="text-caption text-[var(--faint)] break-words">
                  {t('a2a.admin.hosts')}: <span className="font-mono">{p.hostPatterns.map((h) => h.pattern).join(', ') || '—'}</span>
                </p>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
