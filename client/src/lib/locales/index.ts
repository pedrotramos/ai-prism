// UI string catalogs, one file per language and domain: locales/<lang>/<domain>.ts.
// Splitting by domain lets independent UI areas (composer, messages, settings,
// studios, ...) add or change copy without editing the same file. This module
// merges the domain files into one flat key→string catalog per language, which
// is what i18n.tsx consumes.
//
// Rules (enforced by catalogs.test.ts):
// - pt/, en/ and es/ carry the same keys in each domain file;
// - a key namespace (the part before the first '.') lives in exactly one domain
//   file — add new keys next to their namespace, or start a new namespace in the
//   domain that owns the UI;
// - after an intentional copy change, regenerate __snapshots__/ (see the test).
import ptCommon from './pt/common.ts'
import ptComposer from './pt/composer.ts'
import ptMessage from './pt/message.ts'
import ptSidebar from './pt/sidebar.ts'
import ptWelcome from './pt/welcome.ts'
import ptSettings from './pt/settings.ts'
import ptAdmin from './pt/admin.ts'
import ptStudios from './pt/studios.ts'
import ptErrors from './pt/errors.ts'
import ptProjects from './pt/projects.ts'
import ptMcpApps from './pt/mcpApps.ts'
import enCommon from './en/common.ts'
import enComposer from './en/composer.ts'
import enMessage from './en/message.ts'
import enSidebar from './en/sidebar.ts'
import enWelcome from './en/welcome.ts'
import enSettings from './en/settings.ts'
import enAdmin from './en/admin.ts'
import enStudios from './en/studios.ts'
import enErrors from './en/errors.ts'
import enProjects from './en/projects.ts'
import enMcpApps from './en/mcpApps.ts'
import esCommon from './es/common.ts'
import esComposer from './es/composer.ts'
import esMessage from './es/message.ts'
import esSidebar from './es/sidebar.ts'
import esWelcome from './es/welcome.ts'
import esSettings from './es/settings.ts'
import esAdmin from './es/admin.ts'
import esStudios from './es/studios.ts'
import esErrors from './es/errors.ts'
import esProjects from './es/projects.ts'
import esMcpApps from './es/mcpApps.ts'

export const DOMAINS = ['common', 'composer', 'message', 'sidebar', 'welcome', 'settings', 'admin', 'studios', 'errors', 'projects', 'mcpApps']

// Per-language, per-domain catalogs (used by the tests; the UI reads the merged ones).
export const PARTS = {
  pt: {
    common: ptCommon,
    composer: ptComposer,
    message: ptMessage,
    sidebar: ptSidebar,
    welcome: ptWelcome,
    settings: ptSettings,
    admin: ptAdmin,
    studios: ptStudios,
    errors: ptErrors,
    projects: ptProjects,
    mcpApps: ptMcpApps,
  },
  en: {
    common: enCommon,
    composer: enComposer,
    message: enMessage,
    sidebar: enSidebar,
    welcome: enWelcome,
    settings: enSettings,
    admin: enAdmin,
    studios: enStudios,
    errors: enErrors,
    projects: enProjects,
    mcpApps: enMcpApps,
  },
  es: {
    common: esCommon,
    composer: esComposer,
    message: esMessage,
    sidebar: esSidebar,
    welcome: esWelcome,
    settings: esSettings,
    admin: esAdmin,
    studios: esStudios,
    errors: esErrors,
    projects: esProjects,
    mcpApps: esMcpApps,
  },
}

const merge = (parts: Record<string, Record<string, string>>): Record<string, string> => Object.assign({}, ...DOMAINS.map((d) => parts[d]))

export const pt = merge(PARTS.pt)
export const en = merge(PARTS.en)
export const es = merge(PARTS.es)

export default { pt, en, es }
