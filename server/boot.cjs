'use strict'
// Production entrypoint launcher (docs/adr/0001-appkit.md, option A).
//
// The build copies this file, unbundled, to server-dist/index.cjs, next to
// server-dist/appkit.mjs (+ its appkit-*.mjs chunks; AppKit boot, ESM) and server-dist/legacy.cjs (the
// legacy Express listener, CJS). app.yaml keeps `node server-dist/index.cjs`,
// so switching boot paths is an env change, not a rebuild:
//
//   APPKIT_BOOT unset (or anything but '0')  -> AppKit (default)
//   APPKIT_BOOT=0                            -> legacy Express listener (rollback)
//
// Each branch loads only its own artifact: the AppKit path never touches
// legacy.cjs and the rollback path never touches appkit.mjs, so a broken
// AppKit bundle cannot break the rollback.
// Only the exact string '0' rolls back; the log line makes a typo ('false', 'off') visible.
const flag = process.env.APPKIT_BOOT
if (flag === '0') {
  console.log('[boot] APPKIT_BOOT=0: legacy Express listener (server-dist/legacy.cjs)')
  require('./legacy.cjs')
} else {
  console.log(`[boot] APPKIT_BOOT=${flag === undefined ? '(unset)' : JSON.stringify(flag)}: AppKit (server-dist/appkit.mjs)`)
  import('./appkit.mjs').catch((err) => {
    console.error('[boot] AppKit failed to start; set APPKIT_BOOT=0 and restart the app to boot the legacy listener.')
    console.error(err)
    process.exit(1)
  })
}
