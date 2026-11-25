import { useEffect, useState } from 'react'
import * as Icon from './Icons.tsx'
import { useT } from '../lib/i18n.tsx'
import { getJSON } from '../api.ts'
import { Switch, SaveStatus } from './SettingsControls.tsx'
import { chainRowState, overallState, activeRowIndex, forbiddenLast24h } from '../lib/webSearchStatus.ts'

// useT()/useI18n() come from i18n.jsx (untyped JS), which infers a one-argument `t`.
type Translate = (key: string, vars?: Record<string, unknown>) => string

// Web search group of the admin Tools tab (W2-11b): the policy switch plus the
// resolved chain from GET /api/admin/web-search/status, one row per entry with
// its state for the signed-in admin, a Verify button per row (one real search
// against THAT entry, result count only; never a fan-out across the chain) and
// the 24 h permission-denial count. Only the
// documented fields are rendered: never a key value, a query or result text.

const STATE_TONE: Record<string, string> = {
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
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

interface ChainRow {
  kind?: string
  keyPresent?: boolean
  state?: string
  code?: string
  service?: string
  tool?: string
  resultCount?: number
  lastMs?: number
}

interface WebSearchStatus {
  enabled?: boolean
  chain?: ChainRow[] | null
  offReason?: string
  mode?: string
  last24h?: { byCode?: Record<string, unknown> }
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

// state: idle | running | done | limited | stale | failed
interface VerifyState {
  state: string
  entry?: number
  kind?: string
  seconds?: number
  row?: ChainRow | null
}

interface WebSearchAdminCardProps {
  open: boolean
  on: boolean
  onToggle: (next: boolean) => void
  saveState?: SaveState | null
}

export default function WebSearchAdminCard({ open, on, onToggle, saveState }: WebSearchAdminCardProps) {
  const t = useT() as Translate
  const [status, setStatus] = useState<WebSearchStatus | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [verify, setVerify] = useState<VerifyState>({ state: 'idle' })

  useEffect(() => {
    if (!open) return undefined
    let live = true
    getJSON<WebSearchStatus>('/api/admin/web-search/status')
      .then((s) => live && (setStatus(s), setLoadError(false)))
      .catch(() => live && setLoadError(true))
    return () => {
      live = false
    }
  }, [open])

  const runVerify = async (entry: number, kind: string) => {
    setVerify({ state: 'running', entry, kind })
    try {
      const r = await fetch('/api/admin/web-search/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry, kind }),
      })
      if (r.status === 429) {
        const s = Number.parseInt(r.headers.get('Retry-After') || '', 10)
        setVerify({ state: 'limited', entry, kind, seconds: Number.isFinite(s) && s > 0 ? s : 10 })
        return
      }
      if (r.status === 400) {
        setVerify({ state: 'stale', entry, kind })
        return
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const s: WebSearchStatus = await r.json()
      setStatus(s)
      setLoadError(false)
      setVerify({ state: 'done', entry, kind, row: s?.chain?.[entry] || null })
    } catch {
      setVerify({ state: 'failed', entry, kind })
    }
  }

  const verifyMessage = () => {
    if (verify.state !== 'done') return ''
    const name = t(`toolsAdmin.webSearch.kind.${text(verify.kind)}`)
    const row = verify.row
    const st = chainRowState(row)
    const count = row?.resultCount != null && Number.isFinite(row.resultCount) ? row.resultCount : null
    const result =
      st === 'up' && count != null
        ? count === 1
          ? t('toolsAdmin.webSearch.resultOne')
          : t('toolsAdmin.webSearch.results', { n: count })
        : t(`toolsAdmin.webSearch.state.${st}`)
    return t('toolsAdmin.webSearch.verifiedRow', { name, result })
  }

  const nameId = 'tool-group-web-search'
  const overall = overallState(status, on)
  const chain: ChainRow[] = Array.isArray(status?.chain) ? status.chain : []
  const active = on ? activeRowIndex(chain) : -1

  return (
    <li className="px-4 py-3">
      <section aria-labelledby={nameId} data-testid="web-search-card">
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1">
            <span id={nameId} className="block text-body font-medium">
              {t('toolsAdmin.webSearch.name')}
            </span>
            <span id={`${nameId}-desc`} className="block text-label text-[var(--muted)] mt-0.5">
              {t('toolsAdmin.webSearch.desc')}
            </span>
          </span>
          {saveState && <SaveStatus state={saveState === 'error' ? 'idle' : saveState} />}
          <Switch checked={on} onChange={onToggle} labelledBy={nameId} describedBy={`${nameId}-desc`} />
        </div>

        <div className="mt-3 space-y-2">
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
                  const count = row.resultCount != null && Number.isFinite(row.resultCount) ? row.resultCount : null
                  return (
                    <li
                      key={`${kind}-${i}`}
                      data-chain-row
                      data-kind={kind}
                      data-state={st}
                      data-active={isActive ? 'true' : 'false'}
                      className="flex items-center gap-2 rounded-control border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-label"
                    >
                      <div className="min-w-0 flex-1">
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
                          {row.lastMs != null && Number.isFinite(row.lastMs) && <span className="tabular-nums">{t('toolsAdmin.webSearch.ms', { ms: Math.round(row.lastMs) })}</span>}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => runVerify(i, kind)}
                        disabled={verify.state === 'running'}
                        aria-label={`${t('toolsAdmin.webSearch.verify')} ${t(`toolsAdmin.webSearch.kind.${kind}`)}`}
                        aria-describedby={`${nameId}-verify-hint`}
                        className="tap-target shrink-0 inline-flex items-center gap-1 rounded-control border border-[var(--border)] bg-[var(--surface-2)] px-2 min-h-7 text-caption font-semibold hover:bg-[var(--surface-3)] disabled:opacity-60"
                      >
                        <Icon.Check size={12} />
                        {verify.state === 'running' && verify.entry === i ? t('toolsAdmin.webSearch.verifying') : t('toolsAdmin.webSearch.verify')}
                      </button>
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
            <p id={`${nameId}-verify-hint`} className="text-caption text-[var(--muted)]">
              {t('toolsAdmin.webSearch.verifyHint')}
            </p>
          )}
          <div role="status" aria-live="polite" className="text-label">
            {verifyMessage()}
          </div>
          {(verify.state === 'limited' || verify.state === 'stale' || verify.state === 'failed') && (
            <p role="alert" className="text-label text-[var(--danger)]">
              {verify.state === 'limited'
                ? t('toolsAdmin.webSearch.rateLimited', { s: verify.seconds })
                : verify.state === 'stale'
                  ? t('toolsAdmin.webSearch.staleEntry')
                  : t('toolsAdmin.webSearch.verifyFailed')}
            </p>
          )}
        </div>
      </section>
    </li>
  )
}
