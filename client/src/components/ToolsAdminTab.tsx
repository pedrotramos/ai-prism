import { useEffect, useRef, useState } from 'react'
import * as Icon from './Icons.tsx'
import { useT } from '../lib/i18n.tsx'
import { getJSON, putJSON } from '../api.ts'
import { Switch, SaveStatus } from './SettingsControls.tsx'
import WebSearchAdminCard from './WebSearchAdminCard.tsx'
import MemoryAdminCard from './MemoryAdminCard.tsx'
import McpAppsAdminCard from './McpAppsAdminCard.tsx'

// Admin tab: turn whole tool GROUPS on/off for the org. A group set to off is
// hidden from every user's tool picker AND blocked server-side (resolveToolDefs).
// A missing policy row means enabled (default-on), so a fresh org has everything
// available and the admin only records exceptions. Mirrors ModelsAdminTab's shape.
type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type ToolGroup =
  | { key: string; card: 'web-search' | 'memory' | 'mcp-apps'; nameKey?: undefined; descKey?: undefined }
  | { key: string; card?: undefined; nameKey: string; descKey: string }

// Two lists, as in the mockup: what is on in every new conversation, then the catalogs people pick from in each one.
const DEFAULT_GROUPS: ToolGroup[] = [
  { key: 'genie-one', nameKey: 'toolsAdmin.genieOne.name', descKey: 'toolsAdmin.genieOne.desc' },
  { key: 'image-gen', nameKey: 'toolsAdmin.imageGen.name', descKey: 'toolsAdmin.imageGen.desc' },
  { key: 'python', nameKey: 'toolsAdmin.python.name', descKey: 'toolsAdmin.python.desc' },
  // 'web-search' is rendered by WebSearchAdminCard (policy switch + chain rows, W2-11b)
  { key: 'web-search', card: 'web-search' },
  // 'memory' is rendered by MemoryAdminCard (org-wide switch for cross-conversation memory, W3-3)
  { key: 'memory', card: 'memory' },
  // MCP Apps has its own settings endpoint (not a tool-policy key)
  { key: 'mcp-apps', card: 'mcp-apps' },
]
const CATALOG_GROUPS: ToolGroup[] = [
  { key: 'genie', nameKey: 'toolsAdmin.genie.name', descKey: 'toolsAdmin.genie.desc' },
  { key: 'vector-search', nameKey: 'toolsAdmin.vectorSearch.name', descKey: 'toolsAdmin.vectorSearch.desc' },
  { key: 'uc', nameKey: 'toolsAdmin.uc.name', descKey: 'toolsAdmin.uc.desc' },
  { key: 'mcp-external', nameKey: 'toolsAdmin.mcp.name', descKey: 'toolsAdmin.mcp.desc' },
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

  const renderGroup = (g: ToolGroup) => {
    const on = isOn(g.key)
    if (g.card === 'mcp-apps') return <McpAppsAdminCard key={g.key} />
    if (g.card === 'memory') return <MemoryAdminCard key={g.key} on={on} onToggle={() => toggle(g.key)} saveState={status[g.key] || null} />
    if (g.card)
      return <WebSearchAdminCard key={g.key} open={open} on={on} onToggle={() => toggle(g.key)} saveState={status[g.key] || null} />
    const nameId = `tool-group-${g.key}`
    return (
      <li key={g.key} className="flex items-center gap-3 px-4 py-3">
        <span className="min-w-0 flex-1">
          <span id={nameId} className="block text-body font-medium">
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
        <Switch checked={on} onChange={() => toggle(g.key)} labelledBy={nameId} describedBy={`${nameId}-desc`} disabled={status[g.key] === 'saving'} />
      </li>
    )
  }

  const listCls = 'rounded-card border border-[var(--border)] bg-raised divide-y divide-[var(--border-soft)]'
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-title font-semibold">{t('toolsAdmin.title')}</h3>
        <p className="text-label text-[var(--muted)] mt-1 max-w-[62ch]">{t('toolsAdmin.subtitle')}</p>
      </div>

      {error && (
        <p role="alert" className="text-label text-[var(--danger)]">
          {error}
        </p>
      )}

      <section aria-labelledby="tools-section-defaults">
        <h4 id="tools-section-defaults" className="text-body font-semibold mb-2">
          {t('toolsAdmin.section.defaults')}
        </h4>
        <ul className={listCls}>{DEFAULT_GROUPS.map(renderGroup)}</ul>
      </section>

      <section aria-labelledby="tools-section-catalogs">
        <h4 id="tools-section-catalogs" className="text-body font-semibold mb-2">
          {t('toolsAdmin.section.catalogs')}
        </h4>
        <ul className={listCls}>{CATALOG_GROUPS.map(renderGroup)}</ul>
      </section>
    </div>
  )
}
