// The app version, for /api/health and the boot log.
//
// The production bundles get it stamped at build time (scripts/build-appkit.mjs
// defines __AI_PRISM_VERSION__ from package.json), so a deploy that ships only
// server-dist/ still knows it. Unbundled dev reads package.json from the app
// root; null if neither is available.
import fs from 'node:fs'

function fromPackageJson() {
  // (in a bundle import.meta.url may be undefined: that candidate just fails)
  for (const p of [() => new URL('../package.json', import.meta.url), () => `${process.cwd()}/package.json`]) {
    try {
      const v = JSON.parse(fs.readFileSync(p(), 'utf8')).version
      if (v) return String(v)
    } catch {
      // next candidate
    }
  }
  return null
}

/* global __AI_PRISM_VERSION__ */
export const APP_VERSION = typeof __AI_PRISM_VERSION__ === 'string' && __AI_PRISM_VERSION__ ? __AI_PRISM_VERSION__ : fromPackageJson()
