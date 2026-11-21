import { useState, useEffect, useId, useRef } from 'react'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import { useModalDialog } from '../lib/useModalDialog.js'
import { settingsGroups, resolveSettingsTab, mobileArea, MOBILE_AREAS } from '../lib/settingsNav.js'
import DeckTemplatesSettings from './DeckTemplatesSettings.jsx'
import AdminSettings from './AdminSettings.jsx'
import ModelsAdminTab from './ModelsAdminTab.jsx'
import ToolsAdminTab from './ToolsAdminTab.jsx'
import McpConnectionsTab from './McpConnectionsTab.jsx'
import McpCatalogAdminTab from './McpCatalogAdminTab.jsx'
import SkillsTab from './SkillsTab.jsx'
import PersonalTab from './PersonalTab.jsx'

const TAB_ICONS = {
  personal: Icon.User,
  mcp: Icon.Plug,
  skills: Icon.SkillGlyph,
  templates: Icon.Presentation,
  models: Icon.Wrench,
  tools: Icon.Toolbox,
  admins: Icon.Users,
}

// Tone & prompt: part of Preferences (it used to be its own tab).
function ToneSection({ systemPrompt, setSystemPrompt }) {
  const t = useT()
  const promptId = useId()
  const PERSONAS = [
    { emoji: '🤖', name: t('settings.persona.default.name'), prompt: '' },
    { emoji: '🎯', name: t('settings.persona.concise.name'), prompt: t('settings.persona.concise.prompt') },
    { emoji: '👔', name: t('settings.persona.executive.name'), prompt: t('settings.persona.executive.prompt') },
    { emoji: '🧑‍💻', name: t('settings.persona.engineer.name'), prompt: t('settings.persona.engineer.prompt') },
    { emoji: '📊', name: t('settings.persona.analyst.name'), prompt: t('settings.persona.analyst.prompt') },
    { emoji: '🎓', name: t('settings.persona.teacher.name'), prompt: t('settings.persona.teacher.prompt') },
  ]
  return (
    <section className="space-y-4" aria-labelledby={`${promptId}-title`}>
      <div>
        <h3 id={`${promptId}-title`} className="text-title font-semibold">
          {t('settings.tone.title')}
        </h3>
        <p className="text-label text-[var(--muted)] mt-0.5">{t('settings.tone.hint')}</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
          {PERSONAS.map((p) => {
            const active = (systemPrompt || '') === p.prompt
            return (
              <button
                type="button"
                key={p.name}
                aria-pressed={active}
                onClick={() => setSystemPrompt(p.prompt)}
                className={`rounded-card border p-2.5 text-center transition duration-fast ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <div className="text-heading" aria-hidden>
                  {p.emoji}
                </div>
                <div className="text-caption mt-1 font-medium">{p.name}</div>
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <label htmlFor={promptId} className="block text-label font-medium text-[var(--muted)] mb-1">
          {t('settings.systemPrompt.label')}
        </label>
        <textarea
          id={promptId}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={6}
          placeholder={t('settings.systemPrompt.placeholder')}
          className="w-full rounded-card border border-[var(--border)] bg-[var(--surface-2)] p-3 text-body focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
        />
      </div>
    </section>
  )
}

export default function SettingsModal(props) {
  if (!props.open) return null
  return <SettingsDialog {...props} />
}

// Mounted only while open, so the focus trap captures the opener on mount and
// gives focus back to it on unmount (Escape, the close button, Done, scrim).
function SettingsDialog({
  open,
  onClose,
  initialTab,
  systemPrompt,
  setSystemPrompt,
  isAdmin = false,
  onModelsChanged,
  onCreateWithClaude,
  personal,
}) {
  const t = useT()
  const titleId = useId()
  const dialogRef = useRef(null)
  const [tab, setTab] = useState(() => resolveSettingsTab(initialTab, isAdmin))
  const [area, setArea] = useState(() => mobileArea(resolveSettingsTab(initialTab, isAdmin)))

  // a new target while open (e.g. "connect an MCP" from the tool picker), or
  // the admin flag arriving after the first paint
  useEffect(() => {
    if (!initialTab) return
    const next = resolveSettingsTab(initialTab, isAdmin)
    setTab(next)
    setArea(mobileArea(next))
  }, [initialTab, isAdmin])

  useModalDialog(dialogRef, {
    onClose,
    initialFocus: (el) => [...el.querySelectorAll('[aria-current="page"]')].find((n) => n.getClientRects().length > 0),
  })

  const groups = settingsGroups({ isAdmin })
  const select = (id) => {
    setTab(id)
    setArea(mobileArea(id))
  }
  const pickArea = (id) => {
    setArea(id)
    const a = MOBILE_AREAS.find((x) => x.id === id)
    const first = groups.find((g) => a.groups.includes(g.id))?.tabs[0]
    if (first && mobileArea(tab) !== id) setTab(first.id)
  }
  const currentLabel = groups.flatMap((g) => g.tabs).find((x) => x.id === tab)?.labelKey
  const visibleAreas = MOBILE_AREAS.filter((a) => groups.some((g) => a.groups.includes(g.id)))

  const scrollToCatalog = () => {
    const el = dialogRef.current?.querySelector('#settings-mcp-catalog')
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    el?.querySelector('h3')?.focus({ preventScroll: true })
  }

  return (
    <div className="fixed inset-0 z-modal grid place-items-center p-2 md:p-4">
      <div aria-hidden className="absolute inset-0 bg-scrim" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative w-full max-w-4xl h-[90vh] md:h-[80vh] rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-modal animate-fade-in flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 md:px-5 h-14 border-b border-[var(--border)] shrink-0">
          <h2 id={titleId} className="text-title font-bold flex items-center gap-2">
            <Icon.Settings size={18} /> {t('settings.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.close')}
            title={t('settings.close')}
            className="grid place-items-center w-11 h-11 -mr-2 rounded-control hover:bg-[var(--surface-3)] text-[var(--muted)]"
          >
            <Icon.Close size={18} />
          </button>
        </div>

        <div className="flex flex-col md:flex-row flex-1 min-h-0">
          <div className="shrink-0 md:w-56 border-b md:border-b-0 md:border-r border-[var(--border)] bg-[var(--surface-2)] md:overflow-y-auto">
            {/* mobile level 1: which area */}
            <div role="group" aria-label={t('settings.areaLabel')} className="md:hidden flex gap-1 px-3 pt-2">
              {visibleAreas.map((a) => (
                <button
                  type="button"
                  key={a.id}
                  aria-pressed={area === a.id}
                  onClick={() => pickArea(a.id)}
                  className={`flex-1 min-h-11 rounded-control text-body font-semibold transition duration-fast ${
                    area === a.id
                      ? 'bg-[var(--surface)] text-[var(--text)] shadow-raised'
                      : 'text-[var(--muted)] hover:bg-[var(--surface-3)]'
                  }`}
                >
                  {t(a.labelKey)}
                </button>
              ))}
            </div>

            {/* level 2 (mobile: horizontal scroller with an edge fade) / the rail (md+) */}
            <nav
              aria-label={t('settings.sectionsLabel')}
              className="flex md:block gap-1 px-3 md:px-2 py-2 overflow-x-auto md:overflow-visible [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)] md:[mask-image:none]"
            >
              {groups.map((g) => {
                const inArea = MOBILE_AREAS.find((a) => a.id === area)?.groups.includes(g.id)
                return (
                  <div
                    key={g.id}
                    role="group"
                    aria-labelledby={`${titleId}-g-${g.id}`}
                    className={`${inArea ? 'flex' : 'hidden'} md:block gap-1 shrink-0 md:mb-3`}
                  >
                    <div
                      id={`${titleId}-g-${g.id}`}
                      className="hidden md:flex items-center gap-1.5 px-3 pt-1 pb-1 text-caption font-semibold uppercase tracking-wide text-[var(--muted)]"
                    >
                      {g.admin && <Icon.Shield size={12} className="shrink-0" />}
                      {t(g.labelKey)}
                    </div>
                    {g.tabs.map((tabItem) => {
                      const TabIcon = TAB_ICONS[tabItem.id]
                      const active = tab === tabItem.id
                      return (
                        <button
                          type="button"
                          key={tabItem.id}
                          aria-current={active ? 'page' : undefined}
                          onClick={() => select(tabItem.id)}
                          className={`shrink-0 md:w-full flex items-center gap-2.5 px-3 min-h-11 md:min-h-9 rounded-control text-body text-left transition duration-fast md:mb-0.5 whitespace-nowrap ${
                            active
                              ? 'bg-[var(--accent-soft)] text-[var(--accent-text)] font-semibold'
                              : 'text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]'
                          }`}
                        >
                          {TabIcon && <TabIcon size={16} className="shrink-0" />}
                          <span className="md:flex-1 md:truncate">{t(tabItem.labelKey)}</span>
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </nav>
          </div>

          {/* the scroll container is focusable so keyboard users can scroll it */}
          <div
            role="region"
            aria-label={currentLabel ? t(currentLabel) : undefined}
            tabIndex={0}
            className="flex-1 min-w-0 p-4 md:p-5 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
          >
            {tab === 'personal' && (
              <PersonalTab {...personal}>
                <ToneSection systemPrompt={systemPrompt} setSystemPrompt={setSystemPrompt} />
              </PersonalTab>
            )}
            {tab === 'skills' && (
              <SkillsTab open={open} isAdmin={isAdmin} onCreateWithClaude={onCreateWithClaude} />
            )}
            {tab === 'templates' && <DeckTemplatesSettings open={open} isAdmin={isAdmin} />}
            {tab === 'mcp' && <McpConnectionsTab open={open} />}
            {tab === 'models' && isAdmin && <ModelsAdminTab open={open} onModelsChanged={onModelsChanged} />}
            {tab === 'tools' && isAdmin && (
              <div className="space-y-8">
                <ToolsAdminTab open={open} onManageMcpCatalog={scrollToCatalog} />
                <div id="settings-mcp-catalog" className="border-t border-[var(--border)] pt-6 scroll-mt-4">
                  <McpCatalogAdminTab open={open} />
                </div>
              </div>
            )}
            {tab === 'admins' && isAdmin && <AdminSettings open={open} />}
          </div>
        </div>

        <div className="px-4 md:px-5 py-3 border-t border-[var(--border)] flex justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="rounded-card bg-[var(--accent-strong)] hover:brightness-110 text-[var(--on-accent)] font-semibold text-body px-5 min-h-10"
          >
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  )
}
