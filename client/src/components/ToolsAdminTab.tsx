import { useEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import * as Icon from './Icons.tsx'
import { useT } from '../lib/i18n.tsx'
import { getJSON, putJSON } from '../api.ts'
import { Switch, SaveStatus } from './SettingsControls.tsx'
import WebSearchAdminCard from './WebSearchAdminCard.tsx'
import MemoryAdminCard from './MemoryAdminCard.tsx'

// Admin tab: turn whole tool GROUPS on/off for the org. A group set to off is
// hidden from every user's tool picker AND blocked server-side (resolveToolDefs).
// A missing policy row means enabled (default-on), so a fresh org has everything
// available and the admin only records exceptions. Mirrors ModelsAdminTab's shape.
type IconComponent = ComponentType<{ size?: number; className?: string }>
type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type ToolGroup =
  | { key: string; card: 'web-search' | 'memory'; icon?: undefined; nameKey?: undefined; descKey?: undefined }
  | { key: string; card?: undefined; icon: IconComponent; nameKey: string; descKey: string }

const GROUPS: ToolGroup[] = [
  { key: 'python', icon: (p: { size?: number; className?: string }) => <Icon.Terminal {...p} />, nameKey: 'toolsAdmin.python.name', descKey: 'toolsAdmin.python.desc' },
  { key: 'genie-one', icon: (p: { size?: number; className?: string }) => <Icon.GenieOne {...p} />, nameKey: 'toolsAdmin.genieOne.name', descKey: 'toolsAdmin.genieOne.desc' },
  { key: 'image-gen', icon: (p: { size?: number; className?: string }) => <Icon.Image {...p} />, nameKey: 'toolsAdmin.imageGen.name', descKey: 'toolsAdmin.imageGen.desc' },
  // 'web-search' is rendered by WebSearchAdminCard (policy switch + chain rows, W2-11b)
  { key: 'web-search', card: 'web-search' },
  // 'memory' is rendered by MemoryAdminCard (org-wide switch for cross-conversation memory, W3-3)
  { key: 'memory', card: 'memory' },
  { key: 'genie', icon: (p: { size?: number; className?: string }) => <Icon.GenieSpaces {...p} />, nameKey: 'toolsAdmin.genie.name', descKey: 'toolsAdmin.genie.desc' },
  { key: 'uc', icon: (p: { size?: number; className?: string }) => <Icon.UcFunctions {...p} />, nameKey: 'toolsAdmin.uc.name', descKey: 'toolsAdmin.uc.desc' },
  { key: 'vector-search', icon: (p: { size?: number; className?: string }) => <Icon.VectorSearch {...p} />, nameKey: 'toolsAdmin.vectorSearch.name', descKey: 'toolsAdmin.vectorSearch.desc' },
  { key: 'mcp-external', icon: (p: { size?: number; className?: string }) => <Icon.McpExternal {...p} />, nameKey: 'toolsAdmin.mcp.name', descKey: 'toolsAdmin.mcp.desc' },
]

interface ToolsAdminTabProps {
  open: boolean
  onManageMcpCatalog?: () => void
}

export default function ToolsAdminTab({ open, onManageMcpCatalog }: ToolsAdminTabProps) {
  const t = useT()
  const [policy, setPolicy] = useState<Record<string, boolean> | null>(null)
  const [error, setError] = useState('')
  // explicit saving / saved / error per row, keyed by tool group: a save on one row never
  // clears or re-enables another row that is still pending
  const [status, setStatus] = useState<Record<string, SaveState>>({})
  const pending = useRef(new Set<string>()) // synchronous guard: one in-flight PUT per key
  const setRow = (key: string, state: SaveState) => setStatus((s) => ({ ...s, [key]: state }))

  const load = async () => {
    try {
      const r = await getJSON<{ policy?: Record<string, boolean> }>('/api/tool-policy')
      setPolicy(r.policy || {})
      setError('')
    } catch (e) {
      setError((e as Error).message)
      setPolicy({})
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // a missing key means enabled (default-on)
  const isOn = (key: string) => policy?.[key] !== false

  const toggle = async (key: string) => {
    if (pending.current.has(key)) return
    pending.current.add(key)
    const next = !isOn(key)
    setRow(key, 'saving')
    // optimistic
    setPolicy((p) => ({ ...(p || {}), [key]: next }))
    let failed: Error | null = null
    try {
      await putJSON(`/api/admin/tool-policy/${encodeURIComponent(key)}`, { enabled: next })
    } catch (e) {
      failed = e as Error
    }
    // reconcile this row with what the server persisted, whatever the PUT said
    let persisted = failed ? !next : next
    try {
      const r = await getJSON<{ policy?: Record<string, boolean> }>('/api/tool-policy')
      persisted = r.policy?.[key] !== false
    } catch {
      // keep the PUT's own outcome
    }
    pending.current.delete(key)
    setPolicy((p) => ({ ...(p || {}), [key]: persisted }))
    if (failed) setError(failed.message)
    else setError('')
    setRow(key, failed ? 'error' : 'saved')
  }

  if (policy === null) {
    return <div className="text-body text-[var(--muted)]">{t('common.loading')}</div>
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-title font-semibold flex items-center gap-2">
          <Icon.Toolbox size={16} /> {t('toolsAdmin.title')}
        </h3>
        <p className="text-label text-[var(--muted)] mt-0.5">{t('toolsAdmin.subtitle')}</p>
      </div>

      {error && (
        <p role="alert" className="text-label text-[var(--danger)]">
          {error}
        </p>
      )}

      <ul className="space-y-2">
        {GROUPS.map((g) => {
          const on = isOn(g.key)
          if (g.card === 'memory')
            return <MemoryAdminCard key={g.key} on={on} onToggle={() => toggle(g.key)} saveState={status[g.key] || null} />
          if (g.card)
            return (
              <WebSearchAdminCard
                key={g.key}
                open={open}
                on={on}
                onToggle={() => toggle(g.key)}
                saveState={status[g.key] || null}
              />
            )
          const nameId = `tool-group-${g.key}`
          return (
            <li
              key={g.key}
              className={`flex items-center gap-3 rounded-card border p-3 transition duration-fast ${
                on ? 'border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[var(--accent-soft)]' : 'border-[var(--border)]'
              }`}
            >
              <g.icon size={18} className="shrink-0 text-[var(--accent)]" />
              <span className="min-w-0 flex-1">
                <span id={nameId} className="block text-body font-semibold">
                  {t(g.nameKey)}
                </span>
                <span id={`${nameId}-desc`} className="block text-label text-[var(--muted)] mt-0.5">
                  {t(g.descKey)}
                </span>
                {g.key === 'mcp-external' && onManageMcpCatalog && (
                  <button
                    type="button"
                    onClick={onManageMcpCatalog}
                    className="mt-1 inline-flex items-center gap-0.5 min-h-6 text-label font-semibold text-[var(--accent-text)] hover:underline"
                  >
                    {t('mcpAdmin.manageCatalog')} <Icon.ChevronRight size={12} />
                  </button>
                )}
              </span>
              {status[g.key] && <SaveStatus state={status[g.key] === 'error' ? 'idle' : (status[g.key] as SaveState)} />}
              <Switch
                checked={on}
                onChange={() => toggle(g.key)}
                labelledBy={nameId}
                describedBy={`${nameId}-desc`}
                disabled={status[g.key] === 'saving'}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
