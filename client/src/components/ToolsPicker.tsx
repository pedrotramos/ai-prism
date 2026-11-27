import { useState, useRef, useEffect, useId, useLayoutEffect } from 'react'
import type { ReactNode } from 'react'
import * as Icon from './Icons.tsx'
import { getJSON } from '../api.ts'
import { mcpTitle } from '../lib/mcp.ts'
import { useT } from '../lib/i18n.tsx'
import { McpMark } from './ProviderMark.tsx'
import { toolsPopoverFit } from './toolsPlacement.ts'
import type { Fit } from './toolsPlacement.ts'

// A tool reference as the session stores it (and as the search routes return it);
// which fields are present depends on `kind`.
export interface ToolRef {
  kind: string
  id?: string | number
  spaceId?: string
  title?: string
  description?: string
  indexName?: string
  sourceTable?: string
  connectionName?: string
  comment?: string
  fullName?: string
  off?: boolean
}

interface UcFunction extends ToolRef {
  params: { name: string }[]
}

// A connection of GET /api/mcp/connections, as far as the picker reads it.
interface McpConnection {
  connectionName: string
  displayName?: string | null
  comment?: string
  adopted?: boolean
}

type Translate = (key: string, vars?: Record<string, unknown>) => string

export const refKey = (t: ToolRef) => {
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
interface ToolCategorySectionProps<T extends ToolRef> {
  icon: ReactNode
  title: string
  comingSoon?: boolean
  chosen?: number
  searchFn: (query: string) => Promise<T[]>
  isEnabled: (tool: ToolRef) => boolean
  onToggle: (tool: ToolRef) => void
  renderLabel: (item: T) => ReactNode
}

function ToolCategorySection<T extends ToolRef>({ icon, title, comingSoon, chosen = 0, searchFn, isEnabled, onToggle, renderLabel }: ToolCategorySectionProps<T>) {
  // useT() comes from i18n.jsx (untyped JS), which infers a one-argument `t`
  const t = useT() as Translate
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<T[]>([])
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
    <div className="rounded-card border border-[var(--border)] overflow-hidden mb-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-sunk hover:bg-[var(--surface-3)] transition text-left"
      >
        {icon}
        <span className="text-body font-semibold flex-1">{title}</span>
        {chosen > 0 && <span className="text-label text-accent-text font-medium">{t('composer.tools.chosen', { n: chosen })}</span>}
        {comingSoon && (
          <span className="text-caption uppercase font-bold tracking-wide text-[var(--faint)] border border-[var(--border)] rounded px-1.5 py-0.5">
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
            <p className="px-2 py-3 text-label text-[var(--faint)] text-center">
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
                  aria-label={t('tools.searchIn', { title })}
                  className="w-full rounded-lg bg-[var(--surface-2)] border border-[var(--border)] pl-8 pr-3 py-1.5 text-body focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                />
              </div>
              {searching && <p className="px-2 py-2 text-label text-[var(--faint)] text-center">{t('tools.searching')}</p>}
              {!searching && results.length === 0 && (
                <p className="px-2 py-2 text-label text-[var(--faint)] text-center">
                  {query.trim() ? t('tools.nothingFound') : t('tools.typeToSearch')}
                </p>
              )}
              {!searching &&
                results.map((item) => {
                  const active = isEnabled(item)
                  return (
                    <button
                      type="button"
                      key={refKey(item)}
                      aria-pressed={active}
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
                        {active && <Icon.Check size={11} className="text-on-accent" />}
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

function StackIcon({ kind }: { kind: string }) {
  if (kind === 'python') return <Icon.Terminal size={15} />
  if (kind === 'genie-one' || kind === 'genie') return <Icon.Database size={15} />
  if (kind === 'image-gen') return <Icon.Image size={15} />
  if (kind === 'vector-search') return <Icon.Search size={15} />
  if (kind === 'uc') return <Icon.Wrench size={15} />
  if (kind === 'mcp-external') return <McpMark size={15} />
  return <Icon.Wrench size={15} />
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
interface ToolsPickerProps {
  modelSupportsTools: boolean
  enabledTools: ToolRef[]
  onChange: (tools: ToolRef[]) => void
  disabled?: boolean
  onOpenMcpSettings?: () => void
  toolPolicy?: Record<string, boolean>
  /** Which way the popover opens: 'up' from the composer, 'down' elsewhere (default). */
  placement?: 'up' | 'down'
}

export default function ToolsPicker({ modelSupportsTools, enabledTools, onChange, disabled, onOpenMcpSettings, toolPolicy, placement = 'down' }: ToolsPickerProps) {
  // useT() comes from i18n.jsx (untyped JS), which infers a one-argument `t`
  const t = useT() as Translate
  const [open, setOpen] = useState(false)
  const [adoptedMcp, setAdoptedMcp] = useState<McpConnection[] | null>(null) // connections the user has connected
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  // the room above/below the trigger decides the side and the height (measured when it opens and when the window resizes)
  const [fit, setFit] = useState<Fit | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (!r) return
      const next = toolsPopoverFit({ placement, triggerTop: r.top, triggerBottom: r.bottom, viewportH: window.innerHeight })
      setFit(next)
      panelRef.current?.style.setProperty('--tools-max-h', `${Math.round(next.maxHeight)}px`)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, placement])
  const side = fit?.side ?? placement

  // keyboard focus moved to something outside this picker (e.g. its twin): close, so one dialog is open at a time
  const onFocusOut = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null
    if (open && next && !ref.current?.contains(next)) setOpen(false)
  }

  // popover: an outside click closes it; Escape closes it and gives focus back
  // to the trigger (keyboard users stay where they were)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    // move focus into the dialog so keyboard users land on its first control
    requestAnimationFrame(() => document.getElementById(panelId)?.querySelector<HTMLElement>('button, input')?.focus())
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // load adopted MCP connections when the picker opens: the picker only shows
  // connections the user already connected (in Settings) as on/off toggles —
  // default on. Auto-enable any adopted-but-not-yet-in-session connection.
  useEffect(() => {
    if (!open) return
    getJSON<{ connections?: McpConnection[] }>('/api/mcp/connections')
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
  const isEnabled = (t: ToolRef) => enabledTools.some((e) => refKey(e) === refKey(t) && !e.off)
  const toggle = (t: ToolRef) => {
    const rest = enabledTools.filter((e) => refKey(e) !== refKey(t))
    if (t.kind === 'mcp-external') onChange([...rest, isEnabled(t) ? { ...t, off: true } : t])
    else if (isEnabled(t)) onChange(rest)
    else onChange([...enabledTools, t])
  }
  // what is on, counted like the icon stack: Python is always on for a model that takes tools
  const genieOneEnabled = isEnabled({ kind: 'genie-one' })
  const imageGenEnabled = isEnabled({ kind: 'image-gen' })
  // org policy: a tool group set to false by an admin is hidden entirely.
  const allowed = (key: string) => toolPolicy?.[key] !== false
  // MCP connections render in their own adopted-toggle section, and genie-one /
  // image-gen are pinned toggles at the top — keep all of them out of
  // "removableTools" so none is shown twice (image-gen was leaking a duplicate
  // wrench chip with an X below its pinned toggle).
  const pythonOn = modelSupportsTools && allowed('python')
  // the kinds that are on, as the icon stack on the trigger (max 4)
  const stack = [
    ...(pythonOn ? ['python'] : []),
    ...(modelSupportsTools && genieOneEnabled && allowed('genie-one') ? ['genie-one'] : []),
    ...(modelSupportsTools && imageGenEnabled && allowed('image-gen') ? ['image-gen'] : []),
    ...enabledTools.filter((e) => !e.off && !['genie-one', 'image-gen'].includes(e.kind)).map((e) => e.kind),
  ].filter((k, i, all) => all.indexOf(k) === i).slice(0, 4)
  const activeCount = enabledTools.filter((e) => !e.off).length + (pythonOn ? 1 : 0)
  const chosenOf = (kind: string) => enabledTools.filter((e) => e.kind === kind && !e.off).length
  const removableTools = enabledTools.filter(
    (t) => t.kind !== 'genie-one' && t.kind !== 'image-gen' && t.kind !== 'mcp-external'
  )

  return (
    // shrink-0 on the wrapper, not only the button: a shrinking `relative`
    // wrapper squeezed the trigger to 18 px on a 390 px header
    <div className="relative shrink-0" ref={ref} onBlur={onFocusOut}>
      {/* a pill with the stacked icons of what is on and a count (36 px with a
          mouse, 44 px on touch screens); below ~520 px of composer only the icons
          and a corner count remain */}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        // the name starts with the visible text ("2 tools"), as WCAG 2.5.3 asks
        aria-label={activeCount > 0 ? t(activeCount === 1 ? 'composer.tools.countOne' : 'composer.tools.count', { n: activeCount }) : t('tools.title')}
        className="relative shrink-0 flex items-center gap-1.5 min-w-9 min-h-9 [@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:min-h-11 justify-center rounded-control bg-sunk hover:bg-[var(--surface-3)] px-2 text-label font-medium text-fg transition duration-fast disabled:text-disabled-text"
        title={t('tools.title')}
      >
        <span className="flex items-center gap-1 text-muted" aria-hidden>
          {/* one tool (just Python) is the generic glyph; two or more are stacked */}
          {stack.length > 1 ? stack.map((k) => <StackIcon key={k} kind={k} />) : <Icon.ToolsGlyph size={16} className="shrink-0" />}
        </span>
        <span aria-hidden className="hidden [@container(min-width:520px)]:inline tabular-nums">
          {activeCount > 0 ? t(activeCount === 1 ? 'composer.tools.countOne' : 'composer.tools.count', { n: activeCount }) : t('tools.title')}
        </span>
        <Icon.ChevronDown size={13} className="hidden [@container(min-width:520px)]:block text-muted shrink-0" aria-hidden />
        {/* a count, not an alert: neutral colours (a red badge read as "2 errors") */}
        {activeCount > 0 && (
          <span
            aria-hidden
            className="[@container(min-width:520px)]:hidden absolute -top-1.5 -right-1.5 inline-flex items-center justify-center leading-none rounded-pill bg-[var(--surface-3)] text-[var(--text)] border border-[var(--border)] text-caption font-semibold min-w-[18px] h-[18px] px-1 tabular-nums"
          >
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={t('tools.title')}
          ref={panelRef}
          className={`fixed left-3 right-3 w-auto ${side === 'up' ? 'bottom-28 md:bottom-full md:mb-2' : 'top-16 md:top-full md:mt-2'} md:absolute md:left-0 md:right-auto md:w-96 z-dropdown max-h-[70vh] md:max-h-[var(--tools-max-h,70vh)] overflow-y-auto rounded-card border border-[var(--border)] bg-raised shadow-overlay p-1.5 animate-fade-in`}
        >
          <div className="px-3 py-2 text-caption uppercase tracking-wide font-semibold text-[var(--faint)]">
            {t('tools.enabledHeading')}
          </div>
          {modelSupportsTools ? (
            <>
              {allowed('python') && (
                <div className="flex items-center gap-2.5 rounded-card px-3 py-2.5 bg-sunk mb-1">
                  <Icon.Terminal size={16} className="text-[var(--accent)] shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-semibold">Python</span>
                    <span className="block text-label text-[var(--faint)]">
                      {t('tools.pythonDesc')}
                    </span>
                  </span>
                  <Icon.Check size={15} className="text-[var(--accent)] shrink-0" />
                </div>
              )}

              {allowed('genie-one') && (
                <div className="flex items-center gap-2.5 rounded-card px-3 py-2.5 bg-sunk mb-1">
                  <Icon.GenieOne size={20} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-semibold">Genie One</span>
                    <span className="block text-label text-[var(--faint)]">
                      {t('tools.genieOneDesc')}
                    </span>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={genieOneEnabled}
                    aria-label="Genie One"
                    onClick={() => toggle({ kind: 'genie-one' })}
                    className={`shrink-0 w-9 h-5 rounded-full transition relative ${
                      genieOneEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
                    }`}
                    title={genieOneEnabled ? t('tools.genieOneDisable') : t('tools.genieOneEnable')}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-on-accent transition-transform ${
                        genieOneEnabled ? 'translate-x-4' : ''
                      }`}
                    />
                  </button>
                </div>
              )}

              {allowed('image-gen') && (
                <div className="flex items-center gap-2.5 rounded-card px-3 py-2.5 bg-sunk mb-1">
                  <Icon.Image size={17} className="text-[var(--accent)] shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-semibold">{t('tools.imageGen')}</span>
                    <span className="block text-label text-[var(--faint)]">
                      {t('tools.imageGenDesc')}
                    </span>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={imageGenEnabled}
                    aria-label={t('tools.imageGen')}
                    onClick={() => toggle({ kind: 'image-gen' })}
                    className={`shrink-0 w-9 h-5 rounded-full transition relative ${
                      imageGenEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
                    }`}
                    title={imageGenEnabled ? t('tools.imageGenDisable') : t('tools.imageGenEnable')}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-on-accent transition-transform ${
                        imageGenEnabled ? 'translate-x-4' : ''
                      }`}
                    />
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-start gap-2.5 rounded-card px-3 py-2.5 bg-sunk text-[var(--faint)] mb-1">
              <Icon.AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span className="text-label">{t('tools.noToolCalling')}</span>
            </div>
          )}

          {removableTools.map((tool) => (
            <div key={refKey(tool)} className="flex items-center gap-2.5 rounded-card px-3 py-2.5 bg-sunk mb-1">
              {tool.kind === 'genie' ? (
                <Icon.GenieSpaces size={18} />
              ) : tool.kind === 'vector-search' ? (
                <Icon.VectorSearch size={18} />
              ) : tool.kind === 'mcp-external' ? (
                <McpMark size={18} />
              ) : tool.kind === 'uc' ? (
                <Icon.UcFunctions size={18} />
              ) : (
                <Icon.Wrench size={16} className="text-[var(--accent)] shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-body font-semibold truncate">
                  {tool.kind === 'genie'
                    ? tool.title
                    : tool.kind === 'vector-search'
                      ? tool.indexName
                      : tool.kind === 'mcp-external'
                        ? tool.connectionName
                        : tool.fullName}
                </span>
                {tool.kind === 'genie' && tool.description && (
                  <span className="block text-label text-[var(--faint)] mt-0.5 line-clamp-1">{tool.description}</span>
                )}
                {tool.kind === 'vector-search' && tool.sourceTable && (
                  <span className="block text-label text-[var(--faint)] mt-0.5 line-clamp-1 font-mono">
                    {tool.sourceTable}
                  </span>
                )}
                {tool.kind === 'mcp-external' && tool.comment && (
                  <span className="block text-label text-[var(--faint)] mt-0.5 line-clamp-1">{tool.comment}</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => toggle(tool)}
                aria-label={`${t('common.delete')}: ${tool.title || tool.indexName || tool.connectionName || tool.fullName || ''}`}
                className="shrink-0 p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--faint)] hover:text-[var(--text)] transition"
                title={t('common.delete')}
              >
                <Icon.Close size={14} />
              </button>
            </div>
          ))}

          <div className="px-3 pt-2 pb-2 text-caption uppercase tracking-wide font-semibold text-[var(--faint)]">
            {t('tools.addHeading')}
          </div>

          {allowed('genie') && (
          <ToolCategorySection
            icon={<Icon.GenieSpaces size={15} />}
            title={t('tools.catGenieSpaces')}
            chosen={chosenOf('genie')}
            isEnabled={isEnabled}
            onToggle={toggle}
            searchFn={(q) => getJSON<{ results: ToolRef[] }>(`/api/tools/genie/search?q=${encodeURIComponent(q)}`).then((r) => r.results)}
            renderLabel={(space) => (
              <>
                <span className="block text-body font-semibold truncate">{space.title}</span>
                {space.description && (
                  <span className="block text-label text-[var(--faint)] mt-0.5 line-clamp-2">{space.description}</span>
                )}
              </>
            )}
          />
          )}

          {allowed('uc') && (
          <ToolCategorySection
            icon={<Icon.UcFunctions size={15} />}
            title={t('tools.catUcFunctions')}
            chosen={chosenOf('uc')}
            isEnabled={isEnabled}
            onToggle={toggle}
            searchFn={(q) => getJSON<{ results: UcFunction[] }>(`/api/tools/search?q=${encodeURIComponent(q)}`).then((r) => r.results)}
            renderLabel={(fn) => (
              <>
                <span className="block text-body font-semibold font-mono truncate">{fn.fullName}</span>
                {fn.comment && (
                  <span className="block text-label text-[var(--faint)] mt-0.5 line-clamp-2">{fn.comment}</span>
                )}
                {fn.params.length > 0 && (
                  <span className="block text-caption text-[var(--faint)] mt-1 font-mono">
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
            chosen={chosenOf('vector-search')}
            isEnabled={isEnabled}
            onToggle={toggle}
            searchFn={(q) =>
              getJSON<{ results: ToolRef[] }>(`/api/tools/vector-search/search?q=${encodeURIComponent(q)}`).then((r) => r.results)
            }
            renderLabel={(idx) => (
              <>
                <span className="block text-body font-semibold truncate">{idx.indexName}</span>
                {idx.sourceTable && (
                  <span className="block text-label text-[var(--faint)] mt-0.5 line-clamp-1 font-mono">
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
          <div className="rounded-card border border-[var(--border)] overflow-hidden mb-1.5">
            <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--surface-2)]">
              <McpMark size={15} />
              <span className="text-body font-semibold flex-1">{t('tools.catExternalMcp')}</span>
            </div>
            <div className="p-1.5">
              {adoptedMcp === null && (
                <p className="px-2 py-2 text-label text-[var(--faint)] text-center">{t('common.loading')}</p>
              )}
              {adoptedMcp && adoptedMcp.length === 0 && (
                <p className="px-2 py-3 text-label text-[var(--faint)] text-center">
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
                        <span className="block text-body font-semibold truncate">{mcpTitle(conn)}</span>
                        {conn.comment && (
                          <span className="block text-label text-[var(--faint)] mt-0.5 line-clamp-1">
                            {conn.comment}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={active}
                        aria-label={mcpTitle(conn)}
                        onClick={() => toggle(ref)}
                        className={`shrink-0 w-9 h-5 rounded-full transition relative ${
                          active ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
                        }`}
                        title={active ? t('tools.disableInChat') : t('tools.enableInChat')}
                      >
                        <span
                          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-on-accent transition-transform ${
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
                  className="w-full text-left px-2.5 py-2 text-label text-[var(--accent)] font-semibold hover:underline"
                >
                  {t('tools.connectAnotherMcp')}
                </button>
              )}
            </div>
          </div>
          )}
          <p className="px-3 pt-1 pb-1.5 text-caption text-[var(--muted)]">{t('composer.tools.footer')}</p>
        </div>
      )}
    </div>
  )
}
