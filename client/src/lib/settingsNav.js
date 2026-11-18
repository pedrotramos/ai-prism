// Settings navigation model (data only; SettingsModal maps ids to icons and
// panels). Tabs are chunked into Personal / Workspace / Admin and never exceed
// MAX_VISIBLE_TABS for anyone (Miller's law, Choice Overload): tone & prompt
// live inside Preferences and the MCP catalog inside Tools, so their old ids
// stay valid deep links through resolveSettingsTab.

export const MAX_VISIBLE_TABS = 7

const GROUPS = [
  {
    id: 'personal',
    labelKey: 'settings.group.personal',
    tabs: [
      { id: 'personal', labelKey: 'settings.tab.personal' },
      { id: 'mcp', labelKey: 'settings.tab.mcp' },
    ],
  },
  {
    id: 'workspace',
    labelKey: 'settings.group.workspace',
    tabs: [
      { id: 'skills', labelKey: 'settings.tab.skills' },
      { id: 'templates', labelKey: 'settings.tab.templates' },
    ],
  },
  {
    id: 'admin',
    labelKey: 'settings.group.admin',
    admin: true,
    tabs: [
      { id: 'models', labelKey: 'settings.tab.models' },
      { id: 'tools', labelKey: 'settings.tab.tools' },
      { id: 'admins', labelKey: 'settings.tab.admins' },
    ],
  },
]

/** Visible groups for this user, in display (and keyboard) order. */
export function settingsGroups({ isAdmin = false } = {}) {
  return GROUPS.filter((g) => !g.admin || isAdmin).map((g) => ({ ...g, tabs: g.tabs.map((t) => ({ ...t, admin: !!g.admin })) }))
}

// ids that used to be their own tab
const ALIASES = { tone: 'personal', 'mcp-catalog': 'tools' }

/** The tab to show for a requested id (deep link, slash command, picker). */
export function resolveSettingsTab(id, isAdmin = false) {
  const visible = settingsGroups({ isAdmin }).flatMap((g) => g.tabs.map((t) => t.id))
  const target = ALIASES[id] || id
  return visible.includes(target) ? target : visible[0]
}

// Mobile: a two-level list. Level 1 picks the area, level 2 scrolls its tabs.
export const MOBILE_AREAS = [
  { id: 'personal', labelKey: 'settings.area.personal', groups: ['personal'] },
  { id: 'organization', labelKey: 'settings.area.organization', groups: ['workspace', 'admin'] },
]

/** The mobile area a tab belongs to. */
export function mobileArea(tabId) {
  const group = GROUPS.find((g) => g.tabs.some((t) => t.id === tabId))?.id
  return MOBILE_AREAS.find((a) => a.groups.includes(group))?.id || MOBILE_AREAS[0].id
}
