import { useEffect, useState } from 'react'
import * as Icon from './Icons.tsx'
import { useT } from '../lib/i18n.tsx'
import { getJSON, postJSON, putJSON, del } from '../api.ts'
import { mcpTitle, prettyMcpName } from '../lib/mcp.ts'
import { Switch, SaveStatus, inputCls as fieldCls } from './SettingsControls.tsx'
import { McpMark } from './ProviderMark.tsx'

// useT()/useI18n() come from i18n.jsx (untyped JS), which infers a one-argument `t`.
type Translate = (key: string, vars?: Record<string, unknown>) => string

const STATUS: Record<string, { labelKey: string; cls: string }> = {
  connected: { labelKey: 'mcp.status.connected', cls: 'text-[var(--success)] border-[color-mix(in_srgb,var(--success)_50%,transparent)]' },
  needs_login: { labelKey: 'mcp.status.needsLogin', cls: 'text-[var(--warning)] border-[color-mix(in_srgb,var(--warning)_50%,transparent)]' },
  unavailable: { labelKey: 'mcp.status.unavailable', cls: 'text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_60%,transparent)]' },
  forbidden: { labelKey: 'mcp.status.forbidden', cls: 'text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_60%,transparent)]' },
}
const MAX_TOOL_CHIPS = 8

const inputCls = fieldCls

// Admin tab: the org's MCP catalog. Curated system.ai.* services can be hidden
// or shown; any other MCP Service created in the AI Gateway can be published by
// name/URL (validated OBO with the admin's token, tools previewed first). Users
// then see the visible set in their "MCP connections" tab and connect as usual.
interface CatalogEntry {
  connectionName: string
  displayName?: string | null
  comment?: string | null
  hidden?: boolean
  source?: string
  overridden?: boolean
}

interface McpTool {
  name: string
  description?: string
}

// Result of POST /api/admin/mcp-catalog/inspect plus the editable fields.
interface Preview {
  serviceName: string
  status?: string
  comment?: string
  error?: string
  tools?: McpTool[]
  displayName: string
  description: string
}

interface EditingState {
  connectionName: string
  displayName: string
  comment: string
}

interface McpCatalogAdminTabProps {
  open: boolean
}

export default function McpCatalogAdminTab({ open }: McpCatalogAdminTabProps) {
  const t = useT() as Translate
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null)
  const [suggestions, setSuggestions] = useState<CatalogEntry[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [error, setError] = useState('')
  const [input, setInput] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null) // inspect result + editable fields
  const [publishing, setPublishing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // connectionName being saved
  const [editing, setEditing] = useState<EditingState | null>(null) // { connectionName, displayName, comment }
  const [saved, setSaved] = useState<string | null>(null) // connectionName whose last save succeeded

  const errText = (err: unknown) => {
    const e = err as { message?: string } | null | undefined // a thrown value may be any shape
    return e?.message === 'invalid_service_name'
      ? t('mcpAdmin.err.invalid')
      : e?.message === 'shared_credential'
        ? t('mcpAdmin.err.shared')
        : e?.message || String(err)
  }

  const load = async () => {
    try {
      const r = await getJSON<{ entries?: CatalogEntry[]; suggestions?: CatalogEntry[] }>('/api/admin/mcp-catalog')
      setEntries(r.entries || [])
      setSuggestions(r.suggestions || [])
      setError('')
    } catch (e) {
      setError(errText(e))
      setEntries([])
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const inspect = async (value: string = input) => {
    const v = String(value || '').trim()
    if (!v) return
    setInput(v)
    setInspecting(true)
    setPreview(null)
    setError('')
    try {
      const r = await postJSON<Omit<Preview, 'displayName' | 'description'>>('/api/admin/mcp-catalog/inspect', { input: v })
      setPreview({ ...r, displayName: prettyMcpName(r.serviceName), description: r.comment || '' })
    } catch (e) {
      setError(errText(e))
    } finally {
      setInspecting(false)
    }
  }

  const alreadyIn = preview && entries?.some((e) => e.connectionName === preview.serviceName)
  // the server refuses the same two (see PUT /api/admin/mcp-catalog/:name)
  const publishable = preview && preview.status !== 'unavailable' && preview.status !== 'forbidden'

  const publish = async () => {
    if (!preview) return
    setPublishing(true)
    try {
      await putJSON(`/api/admin/mcp-catalog/${encodeURIComponent(preview.serviceName)}`, {
        displayName: preview.displayName,
        description: preview.description,
        hidden: false,
      })
      setPreview(null)
      setInput('')
      await load()
    } catch (e) {
      setError(errText(e))
    } finally {
      setPublishing(false)
    }
  }

  const save = async (entry: CatalogEntry, fields: Partial<CatalogEntry>) => {
    const next = { ...entry, ...fields }
    setBusy(entry.connectionName)
    setSaved(null)
    // optimistic
    setEntries((list) => (list as CatalogEntry[]).map((e) => (e.connectionName === entry.connectionName ? next : e)))
    try {
      await putJSON(`/api/admin/mcp-catalog/${encodeURIComponent(entry.connectionName)}`, {
        displayName: next.displayName,
        description: next.comment,
        hidden: next.hidden,
      })
      setError('')
      setSaved(entry.connectionName)
      return true
    } catch (e) {
      setError(errText(e))
      setEntries((list) => (list as CatalogEntry[]).map((e) => (e.connectionName === entry.connectionName ? entry : e))) // revert
      return false
    } finally {
      setBusy(null)
    }
  }

  const remove = async (entry: CatalogEntry) => {
    if (entry.source === 'custom' && !window.confirm(t('mcpAdmin.catalog.removeConfirm', { name: mcpTitle(entry) }))) return
    setBusy(entry.connectionName)
    try {
      await del(`/api/admin/mcp-catalog/${encodeURIComponent(entry.connectionName)}`)
      await load()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(null)
    }
  }

  const saveEdit = async (entry: CatalogEntry) => {
    if (await save(entry, { displayName: (editing as EditingState).displayName.trim(), comment: (editing as EditingState).comment.trim() })) setEditing(null)
  }

  if (entries === null) {
    return <div className="text-body text-[var(--muted)]">{t('common.loading')}</div>
  }

  const st = preview && STATUS[preview.status as string]

  return (
    <div className="space-y-5">
      <div>
        <h3 tabIndex={-1} className="text-title font-semibold flex items-center gap-2">
          <McpMark size={16} /> {t('mcpAdmin.title')}
        </h3>
        <p className="text-label text-[var(--muted)] mt-0.5">{t('mcpAdmin.subtitle')}</p>
        <p className="text-caption text-[var(--faint)] mt-1.5 flex items-start gap-1.5">
          <Icon.Shield size={12} className="shrink-0 mt-px" />
          <span>{t('mcpAdmin.grantNote')}</span>
        </p>
      </div>

      {error && (
        <p role="alert" className="text-label text-[var(--danger)]">
          {error}
        </p>
      )}

      {/* add by name / URL */}
      <section className="rounded-card border border-[var(--border)] bg-raised p-3 space-y-3">
        <h4 className="text-body font-semibold">{t('mcpAdmin.add.title')}</h4>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            inspect()
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('mcpAdmin.add.placeholder')}
            aria-label={t('mcpAdmin.add.title')}
            className={`${inputCls} font-mono text-label`}
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={inspecting || !input.trim()}
            className="rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-label font-semibold px-3 py-1.5 disabled:opacity-50 shrink-0"
          >
            {inspecting ? t('mcpAdmin.add.inspecting') : t('mcpAdmin.add.inspect')}
          </button>
        </form>

        {preview && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-3">
            <div className="flex items-center gap-2">
              <McpMark size={16} className="shrink-0 text-[var(--muted)]" />
              <span className="flex-1 min-w-0 text-caption font-mono text-[var(--muted)] truncate">
                {preview.serviceName}
              </span>
              {st && (
                <span className={`text-caption border rounded px-1.5 py-0.5 shrink-0 ${st.cls}`}>{t(st.labelKey)}</span>
              )}
            </div>

            {preview.status === 'connected' && (
              <div>
                <div className="text-caption text-[var(--faint)] mb-1">
                  {t('mcpAdmin.add.tools', { n: preview.tools?.length || 0 })}
                </div>
                {preview.tools?.length ? (
                  <div className="flex flex-wrap gap-1">
                    {preview.tools.slice(0, MAX_TOOL_CHIPS).map((tool) => (
                      <span
                        key={tool.name}
                        title={tool.description}
                        className="text-caption font-mono rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5"
                      >
                        {tool.name}
                      </span>
                    ))}
                    {preview.tools.length > MAX_TOOL_CHIPS && (
                      <span className="text-caption text-[var(--faint)] px-1 py-0.5">
                        {t('mcpAdmin.add.moreTools', { n: preview.tools.length - MAX_TOOL_CHIPS })}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="text-label text-[var(--muted)]">{t('mcpAdmin.add.noTools')}</div>
                )}
              </div>
            )}
            {preview.status === 'needs_login' && (
              <div className="text-label text-[var(--warning)]">{t('mcpAdmin.add.needsLogin')}</div>
            )}
            {(preview.status === 'unavailable' || preview.status === 'forbidden') && (
              <div className="text-label text-[var(--danger)]">
                {t(preview.status === 'forbidden' ? 'mcpAdmin.add.forbidden' : 'mcpAdmin.add.unavailable')}
                {preview.error && <div className="mt-1 font-mono text-caption opacity-80 break-all">{preview.error}</div>}
              </div>
            )}

            {alreadyIn ? (
              <div className="text-label text-[var(--muted)]">{t('mcpAdmin.add.alreadyIn')}</div>
            ) : (
              publishable && (
                <>
                  <label className="block">
                    <span className="block text-caption text-[var(--faint)] mb-1">{t('mcpAdmin.add.displayName')}</span>
                    <input
                      value={preview.displayName}
                      maxLength={120}
                      onChange={(e) => setPreview((p) => ({ ...(p as Preview), displayName: e.target.value }))}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className="block text-caption text-[var(--faint)] mb-1">{t('mcpAdmin.add.description')}</span>
                    <textarea
                      value={preview.description}
                      maxLength={300}
                      rows={2}
                      onChange={(e) => setPreview((p) => ({ ...(p as Preview), description: e.target.value }))}
                      placeholder={t('mcpAdmin.add.descriptionPlaceholder')}
                      className={`${inputCls} resize-none`}
                    />
                  </label>
                </>
              )
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setPreview(null)}
                className="rounded-lg border border-[var(--border)] hover:bg-[var(--surface-3)] text-[var(--muted)] text-label px-3 py-1.5"
              >
                {t('mcpAdmin.add.cancel')}
              </button>
              {!alreadyIn && publishable && (
                <button
                  onClick={publish}
                  disabled={publishing}
                  className="rounded-control bg-action text-on-action hover:opacity-90 text-label font-semibold min-h-9 px-3 py-1.5 disabled:opacity-50 transition duration-fast"
                >
                  {publishing ? t('mcpAdmin.add.publishing') : t('mcpAdmin.add.publish')}
                </button>
              )}
            </div>
          </div>
        )}

        {/* best-effort suggestions from the app service principal's view */}
        {suggestions.length > 0 && (
          <div>
            <button
              type="button"
              aria-expanded={showSuggestions}
              onClick={() => setShowSuggestions((v) => !v)}
              className="flex items-center gap-1 text-label font-semibold text-[var(--muted)] hover:text-[var(--text)]"
            >
              {showSuggestions ? <Icon.ChevronDown size={14} /> : <Icon.ChevronRight size={14} />}
              {t('mcpAdmin.suggestions.title')}
              <span className="font-normal text-[var(--faint)]">({suggestions.length})</span>
            </button>
            {showSuggestions && (
              <div className="mt-2 space-y-1">
                <p className="text-caption text-[var(--faint)]">{t('mcpAdmin.suggestions.note')}</p>
                {suggestions.map((s) => (
                  <div
                    key={s.connectionName}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--surface-2)]"
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block text-body truncate">{prettyMcpName(s.connectionName)}</span>
                      <span className="block text-caption font-mono text-[var(--faint)] truncate">
                        {s.connectionName}
                        {s.comment ? ` — ${s.comment}` : ''}
                      </span>
                    </span>
                    <button
                      onClick={() => inspect(s.connectionName)}
                      disabled={inspecting}
                      className="rounded-lg border border-[var(--border)] hover:bg-[var(--surface-3)] text-label px-2.5 py-1 disabled:opacity-50 shrink-0"
                    >
                      {t('mcpAdmin.add.inspect')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* the published catalog: curated (hide/show) + custom (edit/remove) */}
      <section className="space-y-2">
        <h4 className="text-body font-semibold">{t('mcpAdmin.catalog.title')}</h4>
        {entries.map((e) => {
          const working = busy === e.connectionName
          const isEditing = editing?.connectionName === e.connectionName
          return (
            <div
              key={e.connectionName}
              className={`rounded-card border border-[var(--border)] bg-raised p-3 transition ${e.hidden ? 'opacity-55' : ''}`}
            >
              <div className="flex items-center gap-3">
                <McpMark size={16} className="shrink-0 text-[var(--muted)]" />
                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <div className="space-y-1.5">
                      <input
                        value={editing.displayName}
                        maxLength={120}
                        placeholder={prettyMcpName(e.connectionName)}
                        aria-label={t('mcpAdmin.add.displayName')}
                        onChange={(ev) => setEditing((x) => ({ ...(x as EditingState), displayName: ev.target.value }))}
                        className={inputCls}
                      />
                      <textarea
                        value={editing.comment}
                        maxLength={300}
                        rows={2}
                        placeholder={t('mcpAdmin.add.descriptionPlaceholder')}
                        aria-label={t('mcpAdmin.add.description')}
                        onChange={(ev) => setEditing((x) => ({ ...(x as EditingState), comment: ev.target.value }))}
                        className={`${inputCls} resize-none`}
                      />
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-medium text-body truncate">{mcpTitle(e)}</span>
                        <span className="text-caption rounded border border-[var(--border)] text-[var(--faint)] px-1.5 py-px shrink-0">
                          {e.source === 'curated' ? t('mcpAdmin.catalog.curated') : t('mcpAdmin.catalog.custom')}
                        </span>
                        {e.hidden && (
                          <span className="text-caption text-[var(--faint)] shrink-0">· {t('mcpAdmin.catalog.hidden')}</span>
                        )}
                      </div>
                      {e.comment && <div className="text-label text-[var(--muted)] truncate">{e.comment}</div>}
                    </>
                  )}
                  <div className="text-caption text-[var(--faint)] font-mono truncate mt-0.5">{e.connectionName}</div>
                </div>
                <SaveStatus state={working ? 'saving' : saved === e.connectionName ? 'saved' : 'idle'} />
                {!isEditing && (
                  <Switch
                    checked={!e.hidden}
                    onChange={() => save(e, { hidden: !e.hidden })}
                    label={t('mcpAdmin.catalog.visibleFor', { name: mcpTitle(e) })}
                  />
                )}
              </div>

              <div className="mt-2 flex items-center gap-2 justify-end">
                {isEditing ? (
                  <>
                    <button
                      onClick={() => setEditing(null)}
                      className="rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--muted)] text-label px-3 py-1"
                    >
                      {t('mcpAdmin.add.cancel')}
                    </button>
                    <button
                      onClick={() => saveEdit(e)}
                      disabled={working}
                      className="rounded-control bg-action text-on-action hover:opacity-90 text-label font-semibold min-h-8 px-3 py-1 disabled:opacity-50 transition duration-fast"
                    >
                      {t('mcpAdmin.catalog.save')}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() =>
                        setEditing({ connectionName: e.connectionName, displayName: e.displayName || '', comment: e.comment || '' })
                      }
                      disabled={working}
                      className="flex items-center gap-1 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-label px-2.5 py-1 disabled:opacity-50"
                    >
                      <Icon.Pencil size={12} /> {t('mcpAdmin.catalog.edit')}
                    </button>
                    {e.source === 'custom' ? (
                      <button
                        onClick={() => remove(e)}
                        disabled={working}
                        className="flex items-center gap-1 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--danger)] text-label px-2.5 py-1 disabled:opacity-50"
                      >
                        <Icon.Trash size={12} /> {t('mcpAdmin.catalog.remove')}
                      </button>
                    ) : (
                      e.overridden && (
                        <button
                          onClick={() => remove(e)}
                          disabled={working}
                          className="rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--muted)] text-label px-2.5 py-1 disabled:opacity-50"
                        >
                          {t('mcpAdmin.catalog.reset')}
                        </button>
                      )
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}
