import { useEffect, useState } from 'react'
import * as Icon from './Icons.tsx'
import { useT } from '../lib/i18n.tsx'
import { getJSON, postJSON, del } from '../api.ts'
import { mcpTitle } from '../lib/mcp.ts'

// useT()/useI18n() come from i18n.jsx (untyped JS), which infers a one-argument `t`.
type Translate = (key: string, vars?: Record<string, unknown>) => string

type StatusEntry = { labelKey: string; cls: string }
const STATUS: Record<string, StatusEntry> & { unknown: StatusEntry } = {
  connected: { labelKey: 'mcp.status.connected', cls: 'text-[var(--success)] border-[color-mix(in_srgb,var(--success)_50%,transparent)]' },
  needs_login: { labelKey: 'mcp.status.needsLogin', cls: 'text-[var(--warning)] border-[color-mix(in_srgb,var(--warning)_50%,transparent)]' },
  unavailable: { labelKey: 'mcp.status.unavailable', cls: 'text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_60%,transparent)]' },
  forbidden: { labelKey: 'mcp.status.forbidden', cls: 'text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_60%,transparent)]' },
  unknown: { labelKey: 'mcp.status.unknown', cls: 'text-[var(--faint)] border-[var(--border)]' },
}

// Settings tab: browse the workspace's external MCP catalog and connect once.
// Connecting = adopt + probe auth (one-time OAuth consent via the managed
// proxy, opened in a new tab when required). Adopted connections then appear as
// on/off toggles in the tool picker (default on). No credential is stored here
// — the bearer is always the user's own forwarded token.
interface McpConnection {
  connectionName: string
  comment?: string | null
  adopted?: boolean
  status?: string
  [key: string]: unknown
}

interface McpConnectionsTabProps {
  open: boolean
}

interface McpActionResult {
  status?: string
  loginUrl?: string
}

export default function McpConnectionsTab({ open }: McpConnectionsTabProps) {
  const t = useT() as Translate
  const [connections, setConnections] = useState<McpConnection[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null) // connectionName currently working
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)

  const load = async (q = '') => {
    try {
      const r = await getJSON<{ connections?: McpConnection[] }>(`/api/mcp/connections${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      setConnections(r.connections || [])
      setError('')
    } catch (e) {
      setError((e as Error).message)
      setConnections([])
    }
  }

  // single loader: runs on open and whenever the query changes. Semantic search
  // over name + description, debounced so we don't embed on every keystroke; an
  // empty query returns the full catalog (no debounce needed for that first
  // paint, but the small delay is imperceptible and keeps one code path).
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    setSearching(!!q)
    const t = setTimeout(async () => {
      await load(q)
      setSearching(false)
    }, q ? 350 : 0)
    return () => clearTimeout(t)
  }, [query, open]) // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (name: string, fields: Partial<McpConnection>) =>
    setConnections((list) => (list as McpConnection[]).map((c) => (c.connectionName === name ? { ...c, ...fields } : c)))

  const connect = async (c: McpConnection) => {
    setBusy(c.connectionName)
    try {
      const r = await postJSON<McpActionResult>(`/api/mcp/connections/${encodeURIComponent(c.connectionName)}`, {
        comment: c.comment,
      })
      patch(c.connectionName, { adopted: true, status: r.status })
      // if the proxy needs one-time consent, send the user through the login flow
      if (r.status === 'needs_login' && r.loginUrl) window.open(r.loginUrl, '_blank', 'noopener')
    } catch (e) {
      setError((e as Error).message === 'mcp_hidden_by_admin' ? t('mcp.err.hidden') : (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const verify = async (c: McpConnection) => {
    setBusy(c.connectionName)
    try {
      const r = await postJSON<McpActionResult>(`/api/mcp/connections/${encodeURIComponent(c.connectionName)}/probe`, {})
      patch(c.connectionName, { status: r.status })
      if (r.status === 'needs_login' && r.loginUrl) window.open(r.loginUrl, '_blank', 'noopener')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const forget = async (c: McpConnection) => {
    setBusy(c.connectionName)
    try {
      await del(`/api/mcp/connections/${encodeURIComponent(c.connectionName)}`)
      patch(c.connectionName, { adopted: false, status: 'unknown' })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (connections === null) {
    return <div className="text-body text-[var(--muted)]">{t('mcp.loading')}</div>
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-title font-semibold flex items-center gap-2">
          <Icon.Plug size={16} /> {t('settings.tab.mcp')}
        </h3>
        <p className="text-label text-[var(--muted)] mt-0.5">
          {t('mcp.subtitle')}
        </p>
      </div>

      {/* semantic search over name + description */}
      <div className="relative">
        <Icon.Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          type="search"
          placeholder={t('mcp.searchPlaceholder')}
          aria-label={t('mcp.searchPlaceholder')}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] pl-8 pr-3 py-1.5 text-body focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
        />
        {searching && (
          <span role="status" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-caption text-[var(--faint)]">
            {t('mcp.searching')}
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="text-label text-[var(--danger)]">
          {error}
        </p>
      )}

      {connections.length === 0 && (
        <div className="text-body text-[var(--muted)]">
          {query.trim()
            ? t('mcp.noMatch', { query: query.trim() })
            : t('mcp.empty')}
        </div>
      )}

      <div className="space-y-2">
        {connections.map((c) => {
          const st = STATUS[c.status as string] || STATUS.unknown
          const working = busy === c.connectionName
          return (
            <div key={c.connectionName} className="rounded-xl border border-[var(--border)] p-3">
              <div className="flex items-center gap-3">
                <Icon.McpExternal size={16} className="shrink-0 text-[var(--muted)]" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-body truncate">{mcpTitle(c)}</div>
                  {c.comment && (
                    <div className="text-label text-[var(--muted)] truncate">{c.comment}</div>
                  )}
                  {/* three-part name: de-emphasized (small, muted, monospace) */}
                  <div className="text-caption text-[var(--faint)] font-mono truncate mt-0.5">
                    {c.connectionName}
                  </div>
                </div>
                {c.adopted && (
                  <span className={`text-caption border rounded px-1.5 py-0.5 shrink-0 ${st.cls}`}>
                    {t(st.labelKey)}
                  </span>
                )}
              </div>

              <div className="mt-2.5 flex items-center gap-2 justify-end">
                {working && (
                  <span role="status" className="text-caption text-[var(--faint)]">
                    {t('mcp.verifying')}
                  </span>
                )}
                {!c.adopted ? (
                  <button
                    onClick={() => connect(c)}
                    disabled={working}
                    className="rounded-lg bg-[var(--accent-strong)] hover:brightness-110 text-[var(--on-accent)] text-label font-semibold px-3 min-h-8 disabled:opacity-50"
                  >
                    {t('mcp.connect')}
                  </button>
                ) : (
                  <>
                    {c.status === 'needs_login' && (
                      <button
                        onClick={() => verify(c)}
                        disabled={working}
                        className="rounded-lg border border-[color-mix(in_srgb,var(--warning)_60%,transparent)] text-[var(--warning)] hover:bg-[var(--warning-soft)] text-label font-semibold px-3 min-h-8 disabled:opacity-50"
                      >
                        {t('mcp.login')}
                      </button>
                    )}
                    <button
                      onClick={() => verify(c)}
                      disabled={working}
                      className="rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-label px-3 min-h-8 disabled:opacity-50"
                    >
                      {t('mcp.verify')}
                    </button>
                    <button
                      onClick={() => forget(c)}
                      disabled={working}
                      className="rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--muted)] text-label px-3 min-h-8 disabled:opacity-50"
                    >
                      {t('mcp.forget')}
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
