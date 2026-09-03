import { useEffect, useState } from 'react'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import { getJSON, postJSON, del } from '../api.js'

const STATUS = {
  connected: { labelKey: 'mcp.status.connected', cls: 'text-[var(--accent)] border-[var(--accent)]/40' },
  needs_login: { labelKey: 'mcp.status.needsLogin', cls: 'text-amber-400 border-amber-400/40' },
  unavailable: { labelKey: 'mcp.status.unavailable', cls: 'text-red-400 border-red-400/40' },
  unknown: { labelKey: 'mcp.status.unknown', cls: 'text-[var(--faint)] border-[var(--border)]' },
}

// A friendly title from the service's fully-qualified name: the last segment
// (the service name) prettified — e.g. `system.ai.web_search` → "Web Search".
// Discovery leads with name + description; the three-part name is shown small
// and muted, not as the headline.
const prettyName = (fq) =>
  (String(fq).split('.').pop() || String(fq))
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())

// Settings tab: browse the workspace's external MCP catalog and connect once.
// Connecting = adopt + probe auth (one-time OAuth consent via the managed
// proxy, opened in a new tab when required). Adopted connections then appear as
// on/off toggles in the tool picker (default on). No credential is stored here
// — the bearer is always the user's own forwarded token.
export default function McpConnectionsTab({ open }) {
  const t = useT()
  const [connections, setConnections] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(null) // connectionName currently working
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)

  const load = async (q = '') => {
    try {
      const r = await getJSON(`/api/mcp/connections${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      setConnections(r.connections || [])
      setError('')
    } catch (e) {
      setError(e.message)
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

  const patch = (name, fields) =>
    setConnections((list) => list.map((c) => (c.connectionName === name ? { ...c, ...fields } : c)))

  const connect = async (c) => {
    setBusy(c.connectionName)
    try {
      const r = await postJSON(`/api/mcp/connections/${encodeURIComponent(c.connectionName)}`, {
        comment: c.comment,
      })
      patch(c.connectionName, { adopted: true, status: r.status })
      // if the proxy needs one-time consent, send the user through the login flow
      if (r.status === 'needs_login' && r.loginUrl) window.open(r.loginUrl, '_blank', 'noopener')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const verify = async (c) => {
    setBusy(c.connectionName)
    try {
      const r = await postJSON(`/api/mcp/connections/${encodeURIComponent(c.connectionName)}/probe`, {})
      patch(c.connectionName, { status: r.status })
      if (r.status === 'needs_login' && r.loginUrl) window.open(r.loginUrl, '_blank', 'noopener')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const forget = async (c) => {
    setBusy(c.connectionName)
    try {
      await del(`/api/mcp/connections/${encodeURIComponent(c.connectionName)}`)
      patch(c.connectionName, { adopted: false, status: 'unknown' })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  if (connections === null) {
    return <div className="text-sm text-[var(--muted)]">{t('mcp.loading')}</div>
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold flex items-center gap-2">
          <Icon.Plug size={16} /> {t('settings.tab.mcp')}
        </h3>
        <p className="text-xs text-[var(--muted)] mt-0.5">
          {t('mcp.subtitle')}
        </p>
      </div>

      {/* semantic search over name + description */}
      <div className="relative">
        <Icon.Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('mcp.searchPlaceholder')}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] pl-8 pr-3 py-1.5 text-sm outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
        />
        {searching && (
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-[var(--faint)]">
            {t('mcp.searching')}
          </span>
        )}
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      {connections.length === 0 && (
        <div className="text-sm text-[var(--muted)]">
          {query.trim()
            ? t('mcp.noMatch', { query: query.trim() })
            : t('mcp.empty')}
        </div>
      )}

      <div className="space-y-2">
        {connections.map((c) => {
          const st = STATUS[c.status] || STATUS.unknown
          const working = busy === c.connectionName
          return (
            <div key={c.connectionName} className="rounded-xl border border-[var(--border)] p-3">
              <div className="flex items-center gap-3">
                <Icon.McpExternal size={16} className="shrink-0 text-[var(--muted)]" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{prettyName(c.connectionName)}</div>
                  {c.comment && (
                    <div className="text-xs text-[var(--muted)] truncate">{c.comment}</div>
                  )}
                  {/* three-part name: de-emphasized (small, muted, monospace) */}
                  <div className="text-[10px] text-[var(--faint)] font-mono truncate mt-0.5">
                    {c.connectionName}
                  </div>
                </div>
                {c.adopted && (
                  <span className={`text-[10px] border rounded px-1.5 py-0.5 shrink-0 ${st.cls}`}>
                    {t(st.labelKey)}
                  </span>
                )}
              </div>

              <div className="mt-2.5 flex items-center gap-2 justify-end">
                {working && <span className="text-[11px] text-[var(--faint)]">{t('mcp.verifying')}</span>}
                {!c.adopted ? (
                  <button
                    onClick={() => connect(c)}
                    disabled={working}
                    className="rounded-lg bg-[var(--accent)] hover:brightness-110 text-white text-xs font-semibold px-3 py-1.5 disabled:opacity-50"
                  >
                    {t('mcp.connect')}
                  </button>
                ) : (
                  <>
                    {c.status === 'needs_login' && (
                      <button
                        onClick={() => verify(c)}
                        disabled={working}
                        className="rounded-lg bg-amber-500 hover:brightness-110 text-white text-xs font-semibold px-3 py-1.5 disabled:opacity-50"
                      >
                        {t('mcp.login')}
                      </button>
                    )}
                    <button
                      onClick={() => verify(c)}
                      disabled={working}
                      className="rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-xs px-3 py-1.5 disabled:opacity-50"
                    >
                      {t('mcp.verify')}
                    </button>
                    <button
                      onClick={() => forget(c)}
                      disabled={working}
                      className="rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--muted)] text-xs px-3 py-1.5 disabled:opacity-50"
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
