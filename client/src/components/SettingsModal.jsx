import { useState, useEffect } from 'react'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import DeckTemplatesSettings from './DeckTemplatesSettings.jsx'
import AdminSettings from './AdminSettings.jsx'
import ModelsAdminTab from './ModelsAdminTab.jsx'
import ToolsAdminTab from './ToolsAdminTab.jsx'
import McpConnectionsTab from './McpConnectionsTab.jsx'
import McpCatalogAdminTab from './McpCatalogAdminTab.jsx'
import SkillsTab from './SkillsTab.jsx'
import PersonalTab from './PersonalTab.jsx'

function ToneTab({ systemPrompt, setSystemPrompt }) {
  const t = useT()
  const PERSONAS = [
    { emoji: '🤖', name: t('settings.persona.default.name'), prompt: '' },
    { emoji: '🎯', name: t('settings.persona.concise.name'), prompt: t('settings.persona.concise.prompt') },
    { emoji: '👔', name: t('settings.persona.executive.name'), prompt: t('settings.persona.executive.prompt') },
    { emoji: '🧑‍💻', name: t('settings.persona.engineer.name'), prompt: t('settings.persona.engineer.prompt') },
    { emoji: '📊', name: t('settings.persona.analyst.name'), prompt: t('settings.persona.analyst.prompt') },
    { emoji: '🎓', name: t('settings.persona.teacher.name'), prompt: t('settings.persona.teacher.prompt') },
  ]
  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-semibold">{t('settings.tone.title')}</h3>
        <p className="text-xs text-[var(--muted)] mt-0.5">
          {t('settings.tone.hint')}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3">
          {PERSONAS.map((p) => {
            const active = (systemPrompt || '') === p.prompt
            return (
              <button
                key={p.name}
                onClick={() => setSystemPrompt(p.prompt)}
                className={`rounded-xl border p-2.5 text-center transition ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <div className="text-xl">{p.emoji}</div>
                <div className="text-[11px] mt-1 font-medium">{p.name}</div>
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <label className="text-sm font-semibold">{t('settings.systemPrompt.label')}</label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={6}
          placeholder={t('settings.systemPrompt.placeholder')}
          className="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm outline-none focus:border-[var(--accent)] resize-none"
        />
      </div>
    </div>
  )
}

export default function SettingsModal({
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
  const [tab, setTab] = useState('tone')
  // when opened targeting a specific tab (e.g. "connect an MCP" from the tool
  // picker), jump straight to it
  useEffect(() => {
    if (open && initialTab) setTab(initialTab)
  }, [open, initialTab])
  if (!open) return null

  // tabs: everyone sees tone + templates + MCP connections; admins also get
  // model catalog, admins management, and DS-global publishing lives in templates.
  const tabs = [
    { id: 'personal', label: t('settings.tab.personal'), icon: Icon.User },
    { id: 'tone', label: t('settings.tab.tone'), icon: Icon.Sparkle },
    { id: 'skills', label: t('settings.tab.skills'), icon: Icon.SkillGlyph },
    { id: 'templates', label: t('settings.tab.templates'), icon: Icon.Presentation },
    { id: 'mcp', label: t('settings.tab.mcp'), icon: Icon.Plug },
    ...(isAdmin
      ? [
          { id: 'models', label: t('settings.tab.models'), icon: Icon.Wrench, admin: true },
          { id: 'tools', label: t('settings.tab.tools'), icon: Icon.Toolbox, admin: true },
          { id: 'mcp-catalog', label: t('settings.tab.mcpCatalog'), icon: Icon.Plug, admin: true },
          { id: 'admins', label: t('settings.tab.admins'), icon: Icon.Users, admin: true },
        ]
      : []),
  ]

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-4xl h-[80vh] rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl animate-fade-in flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 h-14 border-b border-[var(--border)] shrink-0">
          <h2 className="font-bold flex items-center gap-2">
            <Icon.Settings size={18} /> {t('settings.title')}
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]"
          >
            <Icon.Close size={18} />
          </button>
        </div>

        <div className="flex flex-col md:flex-row flex-1 min-h-0">
          {/* tab rail: horizontal scroller on mobile, vertical rail on md+ */}
          <nav className="flex md:block shrink-0 md:w-56 gap-1 md:gap-0 border-b md:border-b-0 md:border-r border-[var(--border)] p-2 overflow-x-auto md:overflow-x-visible md:overflow-y-auto bg-[var(--surface-2)]">
            {tabs.map((tabItem) => {
              const TabIcon = tabItem.icon
              const active = tab === tabItem.id
              return (
                <button
                  key={tabItem.id}
                  onClick={() => setTab(tabItem.id)}
                  className={`shrink-0 md:w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition md:mb-0.5 whitespace-nowrap ${
                    active
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-semibold'
                      : 'text-[var(--muted)] hover:bg-[var(--surface-3)]'
                  }`}
                >
                  <TabIcon size={16} className="shrink-0" />
                  <span className="md:flex-1 md:truncate">{tabItem.label}</span>
                  {tabItem.admin && <Icon.Shield size={12} className="shrink-0 opacity-60" />}
                </button>
              )
            })}
          </nav>

          {/* tab content */}
          <div className="flex-1 min-w-0 p-5 overflow-y-auto">
            {tab === 'personal' && <PersonalTab {...personal} />}
            {tab === 'tone' && <ToneTab systemPrompt={systemPrompt} setSystemPrompt={setSystemPrompt} />}
            {tab === 'skills' && (
              <SkillsTab open={open} isAdmin={isAdmin} onCreateWithClaude={onCreateWithClaude} />
            )}
            {tab === 'templates' && <DeckTemplatesSettings open={open} isAdmin={isAdmin} />}
            {tab === 'mcp' && <McpConnectionsTab open={open} />}
            {tab === 'models' && isAdmin && <ModelsAdminTab open={open} onModelsChanged={onModelsChanged} />}
            {tab === 'tools' && isAdmin && <ToolsAdminTab open={open} onManageMcpCatalog={() => setTab('mcp-catalog')} />}
            {tab === 'mcp-catalog' && isAdmin && <McpCatalogAdminTab open={open} />}
            {tab === 'admins' && isAdmin && <AdminSettings open={open} />}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-[var(--border)] flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="rounded-xl bg-[var(--accent)] hover:brightness-110 text-white font-semibold text-sm px-5 py-2"
          >
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  )
}
