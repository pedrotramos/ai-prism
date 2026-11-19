import { useEffect, useState } from 'react'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import { getJSON } from '../api.js'
import { Switch, SaveStatus } from './SettingsControls.jsx'
import { chainRowState, overallState, activeRowIndex, forbiddenLast24h, verifySummary } from '../lib/webSearchStatus.js'

// Web search group of the admin Tools tab (W2-11b): the policy switch plus the
// resolved chain from GET /api/admin/web-search/status, one row per entry with
// its state for the signed-in admin, a Verify action (one real search per
// entry, result counts only) and the 24 h permission-denial count. Only the
// documented fields are rendered: never a key value, a query or result text.

const STATE_TONE = {
  up: 'text-[var(--success)]',
  unknown: 'text-[var(--muted)]',
  forbidden: 'text-[var(--danger)]',
  no_tool: 'text-[var(--danger)]',
  no_key: 'text-[var(--danger)]',
  quota: 'text-[var(--warning)]',
  unavailable: 'text-[var(--danger)]',
}

const MCP_KINDS = new Set(['managed-mcp', 'external-mcp'])
const KEYED_KINDS = new Set(['brave', 'tavily'])
const text = (v) => (typeof v === 'string' ? v : '')

export default function WebSearchAdminCard({ open, on, onToggle, saveState }) {
  const t = useT()
  const [status, setStatus] = useState(null)
  const [loadError, setLoadError] = useState(false)
  const [verify, setVerify] = useState({ state: 'idle' }) // idle | running | done | limited | failed

  useEffect(() => {
    if (!open) return undefined
    let live = true
    getJSON('/api/admin/web-search/status')
      .then((s) => live && (setStatus(s), setLoadError(false)))
      .catch(() => live && setLoadError(true))
    return () => {
      live = false
    }
  }, [open])

  const runVerify = async () => {
    setVerify({ state: 'running' })
    try {
      const r = await fetch('/api/admin/web-search/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (r.status === 429) {
        const s = Number.parseInt(r.headers.get('Retry-After') || '', 10)
        setVerify({ state: 'limited', seconds: Number.isFinite(s) && s > 0 ? s : 10 })
        return
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const s = await r.json()
      setStatus(s)
      setLoadError(false)
      setVerify({ state: 'done', ...verifySummary(s) })
    } catch {
      setVerify({ state: 'failed' })
    }
  }

  const nameId = 'tool-group-web-search'
  const overall = overallState(status, on)
  const chain = Array.isArray(status?.chain) ? status.chain : []
  const active = on ? activeRowIndex(chain) : -1

  return (
    <li
      className={`rounded-card border p-3 transition duration-fast ${
        on ? 'border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[var(--accent-soft)]' : 'border-[var(--border)]'
      }`}
    >
      <section aria-labelledby={nameId} data-testid="web-search-card">
        <div className="flex items-center gap-3">
          <Icon.Globe2 size={18} className="shrink-0 text-[var(--accent)]" aria-hidden />
          <span className="min-w-0 flex-1">
            <span id={nameId} className="block text-body font-semibold">
              {t('toolsAdmin.webSearch.name')}
            </span>
            <span id={`${nameId}-desc`} className="block text-label text-[var(--muted)] mt-0.5">
              {t('toolsAdmin.webSearch.desc')}
            </span>
          </span>
          {saveState && <SaveStatus state={saveState === 'error' ? 'idle' : saveState} />}
          <Switch checked={on} onChange={onToggle} labelledBy={nameId} describedBy={`${nameId}-desc`} />
        </div>

        <div className="mt-3 space-y-2 pl-[30px]">
          {loadError && !status && (
            <p role="alert" className="text-label text-[var(--danger)]">
              {t('toolsAdmin.webSearch.statusFailed')}
            </p>
          )}
          {overall && (
            <p className="text-label">
              <span className="text-[var(--muted)]">{t('toolsAdmin.webSearch.overallLabel')}: </span>
              <span data-testid="web-search-overall" className="font-semibold">
                {t(`toolsAdmin.webSearch.overall.${overall}`)}
              </span>
            </p>
          )}

          {chain.length > 0 && (
            <>
              <h4 className="text-caption uppercase tracking-wide text-[var(--muted)]">{t('toolsAdmin.webSearch.chainTitle')}</h4>
              <ol className="space-y-1.5">
                {chain.map((row, i) => {
                  const st = chainRowState(row)
                  const isActive = i === active
                  const kind = text(row.kind)
                  const count = Number.isFinite(row.resultCount) ? row.resultCount : null
                  return (
                    <li
                      key={`${kind}-${i}`}
                      data-chain-row
                      data-kind={kind}
                      data-state={st}
                      data-active={isActive ? 'true' : 'false'}
                      className="rounded-control border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-label"
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="tabular-nums text-[var(--muted)]">{i + 1}.</span>
                        <span className="font-semibold">{t(`toolsAdmin.webSearch.kind.${kind}`)}</span>
                        {isActive && (
                          <span className="rounded-pill bg-[var(--accent-soft)] px-1.5 text-caption font-semibold text-[var(--accent-text)]">
                            {t('toolsAdmin.webSearch.active')}
                          </span>
                        )}
                        <span className={`ml-auto font-semibold ${STATE_TONE[st]}`}>{t(`toolsAdmin.webSearch.state.${st}`)}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-caption text-[var(--muted)]">
                        {MCP_KINDS.has(kind) && text(row.service) && (
                          <span>
                            {t('toolsAdmin.webSearch.service')}: <code className="font-mono">{text(row.service)}</code>
                          </span>
                        )}
                        {MCP_KINDS.has(kind) && text(row.tool) && (
                          <span>
                            {t('toolsAdmin.webSearch.tool')}: <code className="font-mono">{text(row.tool)}</code>
                          </span>
                        )}
                        {KEYED_KINDS.has(kind) && (
                          <span>{row.keyPresent ? t('toolsAdmin.webSearch.keyConfigured') : t('toolsAdmin.webSearch.keyMissing')}</span>
                        )}
                        {count != null && (
                          <span className="tabular-nums">
                            {count === 1 ? t('toolsAdmin.webSearch.resultOne') : t('toolsAdmin.webSearch.results', { n: count })}
                          </span>
                        )}
                        {Number.isFinite(row.lastMs) && (
                          <span className="tabular-nums">{t('toolsAdmin.webSearch.ms', { ms: Math.round(row.lastMs) })}</span>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </>
          )}

          {status && (
            <p className="text-label">
              <span className="text-[var(--muted)]">{t('toolsAdmin.webSearch.forbidden24h')}: </span>
              <span data-testid="web-search-forbidden-24h" className="font-semibold tabular-nums">
                {forbiddenLast24h(status)}
              </span>
            </p>
          )}

          {chain.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={runVerify}
                disabled={verify.state === 'running'}
                aria-describedby={`${nameId}-verify-hint`}
                className="tap-target inline-flex items-center gap-1 rounded-control border border-[var(--border)] bg-[var(--surface)] px-2.5 min-h-8 text-label font-semibold hover:bg-[var(--surface-2)] disabled:opacity-60"
              >
                <Icon.Check size={13} aria-hidden /> {verify.state === 'running' ? t('toolsAdmin.webSearch.verifying') : t('toolsAdmin.webSearch.verify')}
              </button>
              <span id={`${nameId}-verify-hint`} className="text-caption text-[var(--muted)]">
                {t('toolsAdmin.webSearch.verifyHint')}
              </span>
            </div>
          )}
          <div role="status" aria-live="polite" className="text-label">
            {verify.state === 'done' && t('toolsAdmin.webSearch.verified', { answered: verify.answered, total: verify.total })}
          </div>
          {(verify.state === 'limited' || verify.state === 'failed') && (
            <p role="alert" className="text-label text-[var(--danger)]">
              {verify.state === 'limited'
                ? t('toolsAdmin.webSearch.rateLimited', { s: verify.seconds })
                : t('toolsAdmin.webSearch.verifyFailed')}
            </p>
          )}
        </div>
      </section>
    </li>
  )
}
