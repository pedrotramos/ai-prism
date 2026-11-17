// UI string catalogs, one file per language and domain: locales/<lang>/<domain>.js.
// Splitting by domain lets independent UI areas (composer, messages, settings,
// studios, ...) add or change copy without editing the same file. This module
// merges the domain files into one flat key→string catalog per language, which
// is what i18n.jsx consumes.
//
// Rules (enforced by catalogs.test.js):
// - pt/, en/ and es/ carry the same keys in each domain file;
// - a key namespace (the part before the first '.') lives in exactly one domain
//   file — add new keys next to their namespace, or start a new namespace in the
//   domain that owns the UI;
// - after an intentional copy change, regenerate __snapshots__/ (see the test).
import ptCommon from './pt/common.js'
import ptComposer from './pt/composer.js'
import ptMessage from './pt/message.js'
import ptSidebar from './pt/sidebar.js'
import ptWelcome from './pt/welcome.js'
import ptSettings from './pt/settings.js'
import ptAdmin from './pt/admin.js'
import ptStudios from './pt/studios.js'
import ptErrors from './pt/errors.js'
import enCommon from './en/common.js'
import enComposer from './en/composer.js'
import enMessage from './en/message.js'
import enSidebar from './en/sidebar.js'
import enWelcome from './en/welcome.js'
import enSettings from './en/settings.js'
import enAdmin from './en/admin.js'
import enStudios from './en/studios.js'
import enErrors from './en/errors.js'
import esCommon from './es/common.js'
import esComposer from './es/composer.js'
import esMessage from './es/message.js'
import esSidebar from './es/sidebar.js'
import esWelcome from './es/welcome.js'
import esSettings from './es/settings.js'
import esAdmin from './es/admin.js'
import esStudios from './es/studios.js'
import esErrors from './es/errors.js'

export const DOMAINS = ['common', 'composer', 'message', 'sidebar', 'welcome', 'settings', 'admin', 'studios', 'errors']

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
  },
}

const merge = (parts) => Object.assign({}, ...DOMAINS.map((d) => parts[d]))

export const pt = merge(PARTS.pt)
export const en = merge(PARTS.en)
export const es = merge(PARTS.es)

export default { pt, en, es }
