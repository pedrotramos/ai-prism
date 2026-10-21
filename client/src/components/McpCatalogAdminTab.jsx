import { useEffect, useState } from 'react'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import { getJSON, postJSON, putJSON, del } from '../api.js'
import { mcpTitle, prettyMcpName } from '../lib/mcp.js'

const STATUS = {
  connected: { labelKey: 'mcp.status.connected', cls: 'text-[var(--accent)] border-[var(--accent)]/40' },
  needs_login: { labelKey: 'mcp.status.needsLogin', cls: 'text-amber-400 border-amber-400/40' },
  unavailable: { labelKey: 'mcp.status.unavailable', cls: 'text-red-400 border-red-400/40' },
  forbidden: { labelKey: 'mcp.status.forbidden', cls: 'text-red-400 border-red-400/40' },
}
const MAX_TOOL_CHIPS = 8

const inputCls =
  'w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]'

function Toggle({ on, onClick, label }) {
  return (
    <button
      onClick={onClick}
      className={`relative w-10 h-6 rounded-full transition shrink-0 ${on ? 'bg-[var(--accent)]' : 'bg-[var(--surface-3)]'}`}
      aria-label={label}
      title={label}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`}
      />
    </button>
  )
}

// Admin tab: the org's MCP catalog. Curated system.ai.* services can be hidden
// or shown; any other MCP Service created in the AI Gateway can be published by
// name/URL (validated OBO with the admin's token, tools previewed first). Users
// then see the visible set in their "MCP connections" tab and connect as usual.
export default function McpCatalogAdminTab({ open }) {
  const t = useT()
  const [entries, setEntries] = useState(null)
  const [suggestions, setSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [error, setError] = useState('')
  const [input, setInput] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [preview, setPreview] = useState(null) // inspect result + editable fields
  const [publishing, setPublishing] = useState(false)
  const [busy, setBusy] = useState(null) // connectionName being saved
  const [editing, setEditing] = useState(null) // { connectionName, displayName, comment }

  const errText = (e) => (e?.message === 'invalid_service_name' ? t('mcpAdmin.err.invalid') : e?.message || String(e))

  const load = async () => {
    try {
      const r = await getJSON('/api/admin/mcp-catalog')
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

  const inspect = async (value = input) => {
    const v = String(value || '').trim()
    if (!v) return
    setInput(v)
    setInspecting(true)
    setPreview(null)
    setError('')
    try {
      const r = await postJSON('/api/admin/mcp-catalog/inspect', { input: v })
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

  const save = async (entry, fields) => {
    const next = { ...entry, ...fields }
    setBusy(entry.connectionName)
    // optimistic
    setEntries((list) => list.map((e) => (e.connectionName === entry.connectionName ? next : e)))
    try {
      await putJSON(`/api/admin/mcp-catalog/${encodeURIComponent(entry.connectionName)}`, {
        displayName: next.displayName,
        description: next.comment,
        hidden: next.hidden,
      })
      setError('')
      return true
    } catch (e) {
      setError(errText(e))
      setEntries((list) => list.map((e) => (e.connectionName === entry.connectionName ? entry : e))) // revert
      return false
    } finally {
      setBusy(null)
    }
  }

  const remove = async (entry) => {
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

  const saveEdit = async (entry) => {
    if (await save(entry, { displayName: editing.displayName.trim(), comment: editing.comment.trim() })) setEditing(null)
  }

  if (entries === null) {
    return <div className="text-sm text-[var(--muted)]">{t('common.loading')}</div>
  }

  const st = preview && STATUS[preview.status]

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-semibold flex items-center gap-2">
          <Icon.Plug size={16} /> {t('mcpAdmin.title')}
        </h3>
        <p className="text-xs text-[var(--muted)] mt-0.5">{t('mcpAdmin.subtitle')}</p>
        <p className="text-[11px] text-[var(--faint)] mt-1.5 flex items-start gap-1.5">
          <Icon.Shield size={12} className="shrink-0 mt-px" />
          <span>{t('mcpAdmin.grantNote')}</span>
        </p>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      {/* add by name / URL */}
      <section className="rounded-xl border border-[var(--border)] p-3 space-y-3">
        <div className="text-sm font-semibold">{t('mcpAdmin.add.title')}</div>
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
            className={`${inputCls} font-mono text-xs`}
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={inspecting || !input.trim()}
            className="rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-xs font-semibold px-3 py-1.5 disabled:opacity-50 shrink-0"
          >
            {inspecting ? t('mcpAdmin.add.inspecting') : t('mcpAdmin.add.inspect')}
          </button>
        </form>

        {preview && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-3">
            <div className="flex items-center gap-2">
              <Icon.McpExternal size={16} className="shrink-0 text-[var(--muted)]" />
              <span className="flex-1 min-w-0 text-[11px] font-mono text-[var(--muted)] truncate">
                {preview.serviceName}
              </span>
              {st && (
                <span className={`text-[10px] border rounded px-1.5 py-0.5 shrink-0 ${st.cls}`}>{t(st.labelKey)}</span>
              )}
            </div>

            {preview.status === 'connected' && (
              <div>
                <div className="text-[11px] text-[var(--faint)] mb-1">
                  {t('mcpAdmin.add.tools', { n: preview.tools?.length || 0 })}
                </div>
                {preview.tools?.length ? (
                  <div className="flex flex-wrap gap-1">
                    {preview.tools.slice(0, MAX_TOOL_CHIPS).map((tool) => (
                      <span
                        key={tool.name}
                        title={tool.description}
                        className="text-[10px] font-mono rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5"
                      >
                        {tool.name}
                      </span>
                    ))}
                    {preview.tools.length > MAX_TOOL_CHIPS && (
                      <span className="text-[10px] text-[var(--faint)] px-1 py-0.5">
                        {t('mcpAdmin.add.moreTools', { n: preview.tools.length - MAX_TOOL_CHIPS })}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-[var(--muted)]">{t('mcpAdmin.add.noTools')}</div>
                )}
              </div>
            )}
            {preview.status === 'needs_login' && (
              <div className="text-xs text-amber-400">{t('mcpAdmin.add.needsLogin')}</div>
            )}
            {(preview.status === 'unavailable' || preview.status === 'forbidden') && (
              <div className="text-xs text-red-400">
                {t(preview.status === 'forbidden' ? 'mcpAdmin.add.forbidden' : 'mcpAdmin.add.unavailable')}
                {preview.error && <div className="mt-1 font-mono text-[10px] opacity-80 break-all">{preview.error}</div>}
              </div>
            )}

            {alreadyIn ? (
              <div className="text-xs text-[var(--muted)]">{t('mcpAdmin.add.alreadyIn')}</div>
            ) : (
              publishable && (
                <>
                  <label className="block">
                    <span className="block text-[11px] text-[var(--faint)] mb-1">{t('mcpAdmin.add.displayName')}</span>
                    <input
                      value={preview.displayName}
                      maxLength={120}
                      onChange={(e) => setPreview((p) => ({ ...p, displayName: e.target.value }))}
                      className={inputCls}
                    />
                  </label>
                  <label className="block">
                    <span className="block text-[11px] text-[var(--faint)] mb-1">{t('mcpAdmin.add.description')}</span>
                    <textarea
                      value={preview.description}
                      maxLength={300}
                      rows={2}
                      onChange={(e) => setPreview((p) => ({ ...p, description: e.target.value }))}
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
                className="rounded-lg border border-[var(--border)] hover:bg-[var(--surface-3)] text-[var(--muted)] text-xs px-3 py-1.5"
              >
                {t('mcpAdmin.add.cancel')}
              </button>
              {!alreadyIn && publishable && (
                <button
                  onClick={publish}
                  disabled={publishing}
                  className="rounded-lg bg-[var(--accent)] hover:brightness-110 text-white text-xs font-semibold px-3 py-1.5 disabled:opacity-50"
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
              onClick={() => setShowSuggestions((v) => !v)}
              className="flex items-center gap-1 text-xs font-semibold text-[var(--muted)] hover:text-[var(--text)]"
            >
              {showSuggestions ? <Icon.ChevronDown size={14} /> : <Icon.ChevronRight size={14} />}
              {t('mcpAdmin.suggestions.title')}
              <span className="font-normal text-[var(--faint)]">({suggestions.length})</span>
            </button>
            {showSuggestions && (
              <div className="mt-2 space-y-1">
                <p className="text-[11px] text-[var(--faint)]">{t('mcpAdmin.suggestions.note')}</p>
                {suggestions.map((s) => (
                  <div
                    key={s.connectionName}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--surface-2)]"
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm truncate">{prettyMcpName(s.connectionName)}</span>
                      <span className="block text-[10px] font-mono text-[var(--faint)] truncate">
                        {s.connectionName}
                        {s.comment ? ` — ${s.comment}` : ''}
                      </span>
                    </span>
                    <button
                      onClick={() => inspect(s.connectionName)}
                      disabled={inspecting}
                      className="rounded-lg border border-[var(--border)] hover:bg-[var(--surface-3)] text-xs px-2.5 py-1 disabled:opacity-50 shrink-0"
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
        <div className="text-sm font-semibold">{t('mcpAdmin.catalog.title')}</div>
        {entries.map((e) => {
          const working = busy === e.connectionName
          const isEditing = editing?.connectionName === e.connectionName
          return (
            <div
              key={e.connectionName}
              className={`rounded-xl border border-[var(--border)] p-3 transition ${e.hidden ? 'opacity-55' : ''}`}
            >
              <div className="flex items-center gap-3">
                <Icon.McpExternal size={16} className="shrink-0 text-[var(--muted)]" />
                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <div className="space-y-1.5">
                      <input
                        value={editing.displayName}
                        maxLength={120}
                        placeholder={prettyMcpName(e.connectionName)}
                        onChange={(ev) => setEditing((x) => ({ ...x, displayName: ev.target.value }))}
                        className={inputCls}
                      />
                      <textarea
                        value={editing.comment}
                        maxLength={300}
                        rows={2}
                        placeholder={t('mcpAdmin.add.descriptionPlaceholder')}
                        onChange={(ev) => setEditing((x) => ({ ...x, comment: ev.target.value }))}
                        className={`${inputCls} resize-none`}
                      />
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-medium text-sm truncate">{mcpTitle(e)}</span>
                        <span className="text-[10px] rounded border border-[var(--border)] text-[var(--faint)] px-1.5 py-px shrink-0">
                          {e.source === 'curated' ? t('mcpAdmin.catalog.curated') : t('mcpAdmin.catalog.custom')}
                        </span>
                        {e.hidden && (
                          <span className="text-[10px] text-[var(--faint)] shrink-0">· {t('mcpAdmin.catalog.hidden')}</span>
                        )}
                      </div>
                      {e.comment && <div className="text-xs text-[var(--muted)] truncate">{e.comment}</div>}
                    </>
                  )}
                  <div className="text-[10px] text-[var(--faint)] font-mono truncate mt-0.5">{e.connectionName}</div>
                </div>
                {working && <span className="text-[11px] text-[var(--faint)]">{t('common.saving')}</span>}
                {!isEditing && (
                  <Toggle
                    on={!e.hidden}
                    onClick={() => save(e, { hidden: !e.hidden })}
                    label={e.hidden ? t('mcpAdmin.catalog.show') : t('mcpAdmin.catalog.hide')}
                  />
                )}
              </div>

              <div className="mt-2 flex items-center gap-2 justify-end">
                {isEditing ? (
                  <>
                    <button
                      onClick={() => setEditing(null)}
                      className="rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--muted)] text-xs px-3 py-1"
                    >
                      {t('mcpAdmin.add.cancel')}
                    </button>
                    <button
                      onClick={() => saveEdit(e)}
                      disabled={working}
                      className="rounded-lg bg-[var(--accent)] hover:brightness-110 text-white text-xs font-semibold px-3 py-1 disabled:opacity-50"
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
                      className="flex items-center gap-1 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-xs px-2.5 py-1 disabled:opacity-50"
                    >
                      <Icon.Pencil size={12} /> {t('mcpAdmin.catalog.edit')}
                    </button>
                    {e.source === 'custom' ? (
                      <button
                        onClick={() => remove(e)}
                        disabled={working}
                        className="flex items-center gap-1 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-red-400 text-xs px-2.5 py-1 disabled:opacity-50"
                      >
                        <Icon.Trash size={12} /> {t('mcpAdmin.catalog.remove')}
                      </button>
                    ) : (
                      e.overridden && (
                        <button
                          onClick={() => remove(e)}
                          disabled={working}
                          className="rounded-lg border border-[var(--border)] hover:bg-[var(--surface-2)] text-[var(--muted)] text-xs px-2.5 py-1 disabled:opacity-50"
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
