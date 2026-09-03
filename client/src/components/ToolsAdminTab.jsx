import { useEffect, useState } from 'react'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import { getJSON, putJSON } from '../api.js'

// Admin tab: turn whole tool GROUPS on/off for the org. A group set to off is
// hidden from every user's tool picker AND blocked server-side (resolveToolDefs).
// A missing policy row means enabled (default-on), so a fresh org has everything
// available and the admin only records exceptions. Mirrors ModelsAdminTab's shape.
const GROUPS = [
  { key: 'python', icon: (p) => <Icon.Terminal {...p} />, nameKey: 'toolsAdmin.python.name', descKey: 'toolsAdmin.python.desc' },
  { key: 'genie-one', icon: (p) => <Icon.GenieOne {...p} />, nameKey: 'toolsAdmin.genieOne.name', descKey: 'toolsAdmin.genieOne.desc' },
  { key: 'image-gen', icon: (p) => <Icon.Image {...p} />, nameKey: 'toolsAdmin.imageGen.name', descKey: 'toolsAdmin.imageGen.desc' },
  // Busca na internet, nesse primeiro momento, é via MCP externo (grupo abaixo),
  // não como tool nativa habilitável/desabilitável. Card mantido comentado:
  // { key: 'web-search', icon: (p) => <Icon.Globe2 {...p} />, nameKey: 'toolsAdmin.webSearch.name', descKey: 'toolsAdmin.webSearch.desc' },
  { key: 'genie', icon: (p) => <Icon.GenieSpaces {...p} />, nameKey: 'toolsAdmin.genie.name', descKey: 'toolsAdmin.genie.desc' },
  { key: 'uc', icon: (p) => <Icon.UcFunctions {...p} />, nameKey: 'toolsAdmin.uc.name', descKey: 'toolsAdmin.uc.desc' },
  { key: 'vector-search', icon: (p) => <Icon.VectorSearch {...p} />, nameKey: 'toolsAdmin.vectorSearch.name', descKey: 'toolsAdmin.vectorSearch.desc' },
  { key: 'mcp-external', icon: (p) => <Icon.McpExternal {...p} />, nameKey: 'toolsAdmin.mcp.name', descKey: 'toolsAdmin.mcp.desc' },
]

export default function ToolsAdminTab({ open }) {
  const t = useT()
  const [policy, setPolicy] = useState(null)
  const [error, setError] = useState('')
  const [savingKey, setSavingKey] = useState(null)

  const load = async () => {
    try {
      const r = await getJSON('/api/tool-policy')
      setPolicy(r.policy || {})
      setError('')
    } catch (e) {
      setError(e.message)
      setPolicy({})
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // a missing key means enabled (default-on)
  const isOn = (key) => policy?.[key] !== false

  const toggle = async (key) => {
    const next = !isOn(key)
    setSavingKey(key)
    // optimistic
    setPolicy((p) => ({ ...(p || {}), [key]: next }))
    try {
      await putJSON(`/api/admin/tool-policy/${encodeURIComponent(key)}`, { enabled: next })
      setError('')
    } catch (e) {
      setError(e.message)
      setPolicy((p) => ({ ...(p || {}), [key]: !next })) // revert
    } finally {
      setSavingKey(null)
    }
  }

  if (policy === null) {
    return <div className="text-sm text-[var(--muted)]">{t('common.loading')}</div>
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold flex items-center gap-2">
          <Icon.Toolbox size={16} /> {t('toolsAdmin.title')}
        </h3>
        <p className="text-xs text-[var(--muted)] mt-0.5">{t('toolsAdmin.subtitle')}</p>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="space-y-2">
        {GROUPS.map((g) => {
          const on = isOn(g.key)
          return (
            <div
              key={g.key}
              className={`flex items-center gap-3 rounded-xl border p-3 transition ${
                on ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)]/30' : 'border-[var(--border)]'
              }`}
            >
              <g.icon size={18} className="shrink-0 text-[var(--accent)]" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{t(g.nameKey)}</span>
                <span className="block text-xs text-[var(--faint)] mt-0.5">{t(g.descKey)}</span>
              </span>
              {savingKey === g.key && <span className="text-[11px] text-[var(--faint)]">{t('common.saving')}</span>}
              <button
                onClick={() => toggle(g.key)}
                className={`relative w-10 h-6 rounded-full transition shrink-0 ${
                  on ? 'bg-[var(--accent)]' : 'bg-[var(--surface-3)]'
                }`}
                aria-label={on ? t('toolsAdmin.disable') : t('toolsAdmin.enable')}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                    on ? 'translate-x-4' : ''
                  }`}
                />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
