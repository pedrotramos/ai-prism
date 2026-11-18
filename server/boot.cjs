'use strict'
// Production entrypoint launcher (docs/adr/0001-appkit.md, option A).
//
// The build copies this file, unbundled, to server-dist/index.cjs, next to
// server-dist/appkit.mjs (AppKit boot, ESM) and server-dist/legacy.cjs (the
// legacy Express listener, CJS). app.yaml keeps `node server-dist/index.cjs`,
// so switching boot paths is an env change plus an app restart, not a redeploy:
//
//   APPKIT_BOOT unset (or anything but '0')  -> AppKit (default)
//   APPKIT_BOOT=0                            -> legacy Express listener (rollback)
//
// Each branch loads only its own artifact: the AppKit path never touches
// legacy.cjs and the rollback path never touches appkit.mjs, so a broken
// AppKit bundle cannot break the rollback.
if (process.env.APPKIT_BOOT === '0') {
  require('./legacy.cjs')
} else {
  import('./appkit.mjs').catch((err) => {
    console.error('[boot] AppKit failed to start; set APPKIT_BOOT=0 and restart the app to boot the legacy listener.')
    console.error(err)
    process.exit(1)
  })
}
