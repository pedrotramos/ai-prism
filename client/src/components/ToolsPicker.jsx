import { useState, useRef, useEffect } from 'react'
import * as Icon from './Icons.jsx'
import { getJSON } from '../api.js'
import { mcpTitle } from '../lib/mcp.js'
import { useT } from '../lib/i18n.jsx'

const refKey = (t) => {
  if (t.kind === 'genie') return `genie:${t.spaceId}`
  if (t.kind === 'genie-one') return 'genie-one'
  if (t.kind === 'vector-search') return `vector-search:${t.indexName}`
  if (t.kind === 'mcp-external') return `mcp-external:${t.connectionName}`
  if (t.kind === 'uc') return `uc:${t.fullName}`
  return `${t.kind}:${t.id}`
}

// One collapsible category block — search only fires for the category the
// user actually opens, instead of hitting every tool backend on every
// keystroke, and each asset type gets its own scoped result list.
function ToolCategorySection({ icon, title, comingSoon, searchFn, isEnabled, onToggle, renderLabel }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!open || comingSoon) return
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        setResults(await searchFn(query.trim()))
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, comingSoon])

  return (
    <div className="rounded-xl border border-[var(--border)] overflow-hidden mb-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] transition text-left"
      >
        {icon}
        <span className="text-sm font-semibold flex-1">{title}</span>
        {comingSoon && (
          <span className="text-[9px] uppercase font-bold tracking-wide text-[var(--faint)] border border-[var(--border)] rounded px-1.5 py-0.5">
            {t('tools.comingSoon')}
          </span>
        )}
        <Icon.ChevronRight
          size={14}
          className={`text-[var(--faint)] transition-transform shrink-0 ${open ? 'rotate-90' : ''}`}
        />
      </button>

      {open && (
        <div className="p-1.5">
          {comingSoon ? (
            <p className="px-2 py-3 text-xs text-[var(--faint)] text-center">
              {t('tools.notAvailableYet')}
            </p>
          ) : (
            <>
              <div className="relative px-1.5 mb-1.5">
                <Icon.Search size={13} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('tools.searchIn', { title })}
                  className="w-full rounded-lg bg-[var(--surface-2)] border border-[var(--border)] pl-8 pr-3 py-1.5 text-sm outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                />
              </div>
              {searching && <p className="px-2 py-2 text-xs text-[var(--faint)] text-center">{t('tools.searching')}</p>}
              {!searching && results.length === 0 && (
                <p className="px-2 py-2 text-xs text-[var(--faint)] text-center">
                  {query.trim() ? t('tools.nothingFound') : t('tools.typeToSearch')}
                </p>
              )}
              {!searching &&
                results.map((item) => {
                  const active = isEnabled(item)
                  return (
                    <button
                      key={refKey(item)}
                      onClick={() => onToggle(item)}
                      className={`w-full text-left rounded-lg px-2.5 py-2 transition flex gap-2.5 items-start ${
                        active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--surface-2)]'
                      }`}
                    >
                      <span
                        className={`mt-0.5 w-4 h-4 rounded-md border shrink-0 grid place-items-center ${
                          active ? 'bg-[var(--accent)] border-[var(--accent)]' : 'border-[var(--border)]'
                        }`}
                      >
                        {active && <Icon.Check size={11} className="text-white" />}
                      </span>
                      <span className="min-w-0 flex-1">{renderLabel(item)}</span>
                    </button>
                  )
                })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Tool picker, Databricks-Playground-style: the Python UC function is always
 * on (pinned, non-removable) for models that support tool calling; Genie
 * One (the workspace-wide managed MCP) is pinned right below it, on by
 * default but toggleable; everything else is organized by asset type (Genie
 * Spaces, UC Functions, Vector Search Indexes, External MCP Servers) — each
 * its own collapsible block searching only its own kind. Selection lives on
 * the session (see App.jsx), so reopening a past conversation re-enables the
 * same tools automatically.
 */
export default function ToolsPicker({ modelSupportsTools, enabledTools, onChange, disabled, onOpenMcpSettings, toolPolicy }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [adoptedMcp, setAdoptedMcp] = useState(null) // connections the user has connected
  const ref = useRef(null)

  useEffect(() => {
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  // load adopted MCP connections when the picker opens: the picker only shows
  // connections the user already connected (in Settings) as on/off toggles —
  // default on. Auto-enable any adopted-but-not-yet-in-session connection.
  useEffect(() => {
    if (!open) return
    getJSON('/api/mcp/connections')
      .then((r) => {
        const adopted = (r.connections || []).filter((c) => c.adopted)
        setAdoptedMcp(adopted)
        const missing = adopted.filter(
          (c) => !enabledTools.some((e) => e.kind === 'mcp-external' && e.connectionName === c.connectionName)
        )
        if (missing.length) {
          onChange([
            ...enabledTools,
            ...missing.map((c) => ({ kind: 'mcp-external', connectionName: c.connectionName, comment: c.comment })),
          ])
        }
      })
      .catch(() => setAdoptedMcp([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // An MCP ref with `off: true` is an explicit per-chat opt-out: adopted MCPs
  // are on by default (the server adds any the session doesn't mention), so
  // turning one off must be RECORDED — removing the ref would just re-enable it.
  const isEnabled = (t) => enabledTools.some((e) => refKey(e) === refKey(t) && !e.off)
  const toggle = (t) => {
    const rest = enabledTools.filter((e) => refKey(e) !== refKey(t))
    if (t.kind === 'mcp-external') onChange([...rest, isEnabled(t) ? { ...t, off: true } : t])
    else if (isEnabled(t)) onChange(rest)
    else onChange([...enabledTools, t])
  }
  const activeCount = enabledTools.filter((e) => !e.off).length
  const genieOneEnabled = isEnabled({ kind: 'genie-one' })
  const imageGenEnabled = isEnabled({ kind: 'image-gen' })
  // org policy: a tool group set to false by an admin is hidden entirely.
  const allowed = (key) => toolPolicy?.[key] !== false
  // MCP connections render in their own adopted-toggle section, and genie-one /
  // image-gen are pinned toggles at the top — keep all of them out of
  // "removableTools" so none is shown twice (image-gen was leaking a duplicate
  // wrench chip with an X below its pinned toggle).
  const removableTools = enabledTools.filter(
    (t) => t.kind !== 'genie-one' && t.kind !== 'image-gen' && t.kind !== 'mcp-external'
  )

  return (
    <div className="relative" ref={ref}>
      {/* icon-only trigger: the "Tools" label wrapped awkwardly next to long
          model names in the header, and the icon + count badge say the same
          thing in a fraction of the width */}
      <button
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="relative shrink-0 p-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] transition disabled:opacity-50"
        title={t('tools.title')}
      >
        <Icon.ToolsGlyph size={17} />
        {activeCount > 0 && (
          <span className="absolute -top-1 -right-1 inline-flex items-center justify-center leading-none rounded-full bg-[var(--accent)] text-white text-[10px] font-bold w-4 h-4 pt-px tabular-nums">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed left-3 right-3 top-16 w-auto md:absolute md:left-0 md:right-auto md:top-auto md:mt-2 md:w-[380px] z-40 max-h-[70vh] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl shadow-black/40 p-1.5">
          <div className="px-3 py-2 text-[11px] uppercase tracking-wide font-semibold text-[var(--faint)]">
            {t('tools.enabledHeading')}
          </div>
          {modelSupportsTools ? (
            <>
              {allowed('python') && (
                <div className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 bg-[var(--surface-2)] mb-1">
                  <Icon.Terminal size={16} className="text-[var(--accent)] shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">Python</span>
                    <span className="block text-xs text-[var(--faint)]">
                      {t('tools.pythonDesc')}
                    </span>
                  </span>
                  <Icon.Check size={15} className="text-[var(--accent)] shrink-0" />
                </div>
              )}

              {allowed('genie-one') && (
                <div className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 bg-[var(--surface-2)] mb-1">
                  <Icon.GenieOne size={20} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">Genie One</span>
                    <span className="block text-xs text-[var(--faint)]">
                      {t('tools.genieOneDesc')}
                    </span>
                  </span>
                  <button
                    onClick={() => toggle({ kind: 'genie-one' })}
                    className={`shrink-0 w-9 h-5 rounded-full transition relative ${
                      genieOneEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
                    }`}
                    title={genieOneEnabled ? t('tools.genieOneDisable') : t('tools.genieOneEnable')}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                        genieOneEnabled ? 'translate-x-4' : ''
                      }`}
                    />
                  </button>
                </div>
              )}

              {allowed('image-gen') && (
                <div className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 bg-[var(--surface-2)] mb-1">
                  <Icon.Image size={17} className="text-[var(--accent)] shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{t('tools.imageGen')}</span>
                    <span className="block text-xs text-[var(--faint)]">
                      {t('tools.imageGenDesc')}
                    </span>
                  </span>
                  <button
                    onClick={() => toggle({ kind: 'image-gen' })}
                    className={`shrink-0 w-9 h-5 rounded-full transition relative ${
                      imageGenEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
                    }`}
                    title={imageGenEnabled ? t('tools.imageGenDisable') : t('tools.imageGenEnable')}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                        imageGenEnabled ? 'translate-x-4' : ''
                      }`}
                    />
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-start gap-2.5 rounded-xl px-3 py-2.5 bg-[var(--surface-2)] text-[var(--faint)] mb-1">
              <Icon.AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span className="text-xs">{t('tools.noToolCalling')}</span>
            </div>
          )}

          {removableTools.map((tool) => (
            <div key={refKey(tool)} className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 bg-[var(--surface-2)] mb-1">
              {tool.kind === 'genie' ? (
                <Icon.GenieSpaces size={18} />
              ) : tool.kind === 'vector-search' ? (
                <Icon.VectorSearch size={18} />
              ) : tool.kind === 'mcp-external' ? (
                <Icon.McpExternal size={18} />
              ) : tool.kind === 'uc' ? (
                <Icon.UcFunctions size={18} />
              ) : (
                <Icon.Wrench size={16} className="text-[var(--accent)] shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold truncate">
                  {tool.kind === 'genie'
                    ? tool.title
                    : tool.kind === 'vector-search'
                      ? tool.indexName
                      : tool.kind === 'mcp-external'
                        ? tool.connectionName
                        : tool.fullName}
                </span>
                {tool.kind === 'genie' && tool.description && (
                  <span className="block text-xs text-[var(--faint)] mt-0.5 line-clamp-1">{tool.description}</span>
                )}
                {tool.kind === 'vector-search' && tool.sourceTable && (
                  <span className="block text-xs text-[var(--faint)] mt-0.5 line-clamp-1 font-mono">
                    {tool.sourceTable}
                  </span>
                )}
                {tool.kind === 'mcp-external' && tool.comment && (
                  <span className="block text-xs text-[var(--faint)] mt-0.5 line-clamp-1">{tool.comment}</span>
                )}
              </span>
              <button
                onClick={() => toggle(tool)}
                className="shrink-0 p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--faint)] hover:text-[var(--text)] transition"
                title={t('common.delete')}
              >
                <Icon.Close size={14} />
              </button>
            </div>
          ))}

          <div className="px-3 pt-2 pb-2 text-[11px] uppercase tracking-wide font-semibold text-[var(--faint)]">
            {t('tools.addHeading')}
          </div>

          {allowed('genie') && (
          <ToolCategorySection
            icon={<Icon.GenieSpaces size={15} />}
            title={t('tools.catGenieSpaces')}
            isEnabled={isEnabled}
            onToggle={toggle}
            searchFn={(q) => getJSON(`/api/tools/genie/search?q=${encodeURIComponent(q)}`).then((r) => r.results)}
            renderLabel={(space) => (
              <>
                <span className="block text-sm font-semibold truncate">{space.title}</span>
                {space.description && (
                  <span className="block text-xs text-[var(--faint)] mt-0.5 line-clamp-2">{space.description}</span>
                )}
              </>
            )}
          />
          )}

          {allowed('uc') && (
          <ToolCategorySection
            icon={<Icon.UcFunctions size={15} />}
            title={t('tools.catUcFunctions')}
            isEnabled={isEnabled}
            onToggle={toggle}
            searchFn={(q) => getJSON(`/api/tools/search?q=${encodeURIComponent(q)}`).then((r) => r.results)}
            renderLabel={(fn) => (
              <>
                <span className="block text-sm font-semibold font-mono truncate">{fn.fullName}</span>
                {fn.comment && (
                  <span className="block text-xs text-[var(--faint)] mt-0.5 line-clamp-2">{fn.comment}</span>
                )}
                {fn.params.length > 0 && (
                  <span className="block text-[10.5px] text-[var(--faint)] mt-1 font-mono">
                    ({fn.params.map((p) => p.name).join(', ')})
                  </span>
                )}
              </>
            )}
          />
          )}

          {allowed('vector-search') && (
          <ToolCategorySection
            icon={<Icon.VectorSearch size={15} />}
            title={t('tools.catVectorSearch')}
            isEnabled={isEnabled}
            onToggle={toggle}
            searchFn={(q) =>
              getJSON(`/api/tools/vector-search/search?q=${encodeURIComponent(q)}`).then((r) => r.results)
            }
            renderLabel={(idx) => (
              <>
                <span className="block text-sm font-semibold truncate">{idx.indexName}</span>
                {idx.sourceTable && (
                  <span className="block text-xs text-[var(--faint)] mt-0.5 line-clamp-1 font-mono">
                    {idx.sourceTable}
                  </span>
                )}
              </>
            )}
          />
          )}

          {/* External MCPs: only connections the user has connected (in
              Settings) appear here, as on/off toggles — default on. Connecting
              a new one is a one-time flow in Settings, not a per-session search. */}
          {allowed('mcp-external') && (
          <div className="rounded-xl border border-[var(--border)] overflow-hidden mb-1.5">
            <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--surface-2)]">
              <Icon.McpExternal size={15} />
              <span className="text-sm font-semibold flex-1">{t('tools.catExternalMcp')}</span>
            </div>
            <div className="p-1.5">
              {adoptedMcp === null && (
                <p className="px-2 py-2 text-xs text-[var(--faint)] text-center">{t('common.loading')}</p>
              )}
              {adoptedMcp && adoptedMcp.length === 0 && (
                <p className="px-2 py-3 text-xs text-[var(--faint)] text-center">
                  {t('tools.noMcpConnected')}
                  {onOpenMcpSettings && (
                    <>
                      {' '}
                      <button
                        onClick={onOpenMcpSettings}
                        className="text-[var(--accent)] font-semibold hover:underline"
                      >
                        {t('tools.connectInSettings')}
                      </button>
                    </>
                  )}
                </p>
              )}
              {adoptedMcp &&
                adoptedMcp.map((conn) => {
                  const ref = { kind: 'mcp-external', connectionName: conn.connectionName, comment: conn.comment }
                  const active = isEnabled(ref)
                  return (
                    <div
                      key={conn.connectionName}
                      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold truncate">{mcpTitle(conn)}</span>
                        {conn.comment && (
                          <span className="block text-xs text-[var(--faint)] mt-0.5 line-clamp-1">
                            {conn.comment}
                          </span>
                        )}
                      </span>
                      <button
                        onClick={() => toggle(ref)}
                        className={`shrink-0 w-9 h-5 rounded-full transition relative ${
                          active ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
                        }`}
                        title={active ? t('tools.disableInChat') : t('tools.enableInChat')}
                      >
                        <span
                          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                            active ? 'translate-x-4' : ''
                          }`}
                        />
                      </button>
                    </div>
                  )
                })}
              {adoptedMcp && adoptedMcp.length > 0 && onOpenMcpSettings && (
                <button
                  onClick={onOpenMcpSettings}
                  className="w-full text-left px-2.5 py-2 text-xs text-[var(--accent)] font-semibold hover:underline"
                >
                  {t('tools.connectAnotherMcp')}
                </button>
              )}
            </div>
          </div>
          )}
        </div>
      )}
    </div>
  )
}
