// Settings navigation model (data only; SettingsModal maps ids to icons and
// panels). Tabs are chunked into "Your account" / Admin and never exceed
// MAX_VISIBLE_TABS for anyone (Miller's law, Choice Overload): tone & prompt
// live inside Preferences and the MCP catalog inside Tools, so their old ids
// stay valid deep links through resolveSettingsTab.

export const MAX_VISIBLE_TABS = 8

interface SettingsTab {
  id: string
  labelKey: string
  /** a tab that exists only while this feature is on */
  feature?: 'agents'
}

interface SettingsGroup {
  id: string
  labelKey: string
  admin?: boolean
  tabs: SettingsTab[]
}

const GROUPS: SettingsGroup[] = [
  {
    id: 'personal',
    labelKey: 'settings.group.personal',
    tabs: [
      { id: 'personal', labelKey: 'settings.tab.personal' },
      { id: 'mcp', labelKey: 'settings.tab.mcp' },
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
      // scheduled agents (W4-4e): registered only while the server reports the feature on (see `agents` below)
      { id: 'agents', labelKey: 'settings.tab.agents', feature: 'agents' },
    ],
  },
]

/** Visible groups for this user, in display (and keyboard) order. */
export function settingsGroups({ isAdmin = false, agents = false }: { isAdmin?: boolean; agents?: boolean } = {}): (SettingsGroup & { tabs: (SettingsTab & { admin: boolean })[] })[] {
  return GROUPS.filter((g) => !g.admin || isAdmin).map((g) => ({
    ...g,
    tabs: g.tabs.filter((t) => t.feature !== 'agents' || agents).map((t) => ({ ...t, admin: !!g.admin })),
  }))
}

// ids that used to be their own tab
const ALIASES: Record<string, string> = { tone: 'personal', 'mcp-catalog': 'tools' }

/** The tab to show for a requested id (deep link, slash command, picker). */
export function resolveSettingsTab(id: string, isAdmin = false, agents = false): string {
  const visible = settingsGroups({ isAdmin, agents }).flatMap((g) => g.tabs.map((t) => t.id))
  const target = ALIASES[id] || id
  return visible.includes(target) ? target : (visible[0] as string) // the personal group always has tabs
}

// Mobile: a two-level list. Level 1 picks the area, level 2 scrolls its tabs.
// Desktop shows one "Your account" group; on a phone Skills and Design system
// stay under Organization (they are shared with the workspace), so the area is
// decided per tab, not per group.
export const MOBILE_AREAS: { id: string; labelKey: string; groups: string[] }[] = [
  { id: 'personal', labelKey: 'settings.area.personal', groups: ['personal'] },
  { id: 'organization', labelKey: 'settings.area.organization', groups: ['personal', 'admin'] },
]

const ORGANIZATION_TABS = ['skills', 'templates']

/** The mobile area a tab belongs to. */
export function mobileArea(tabId: string): string {
  if (ORGANIZATION_TABS.includes(tabId)) return 'organization'
  const group = GROUPS.find((g) => g.tabs.some((t) => t.id === tabId))
  return group?.admin ? 'organization' : 'personal'
}
