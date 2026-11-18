import { ensureSchema, rememberGrantsCaller, runAppGrantsFromApp } from '../db.js'
import { startUsageBackfill } from '../usage.js'

// A migration deferred by the database (0002 before the deploy's owner hand-off)
// is retried by a request after this long; the app serves on the old schema meanwhile.
export const DEFERRED_RETRY_MS = 60 * 1000

// Built from its dependencies so the latch can be tested without a database.
export function createEnsureReady({ ensureSchema, startAppGrants, startUsageBackfill, now = Date.now, log = console }) {
  // schema is created once, lazily, with the first user's token. A promise
  // latch: requests that arrive while the DDL runs wait on the same promise
  // instead of running it again; a failed DDL clears the latch so the next
  // request retries; a deferred migration clears it after DEFERRED_RETRY_MS.
  let schemaReady = null
  let retryAfter = Infinity
  let grantsStarted = false
  let backfillStarted = false
  return async function ensureReady(req) {
    if (schemaReady && now() >= retryAfter) {
      schemaReady = null
      retryAfter = Infinity
    }
    if (!schemaReady) {
      const pending = (async () => {
        const result = await ensureSchema(req.email, req.token)
        if (result?.deferred?.length) retryAfter = now() + DEFERRED_RETRY_MS
        if (!backfillStarted) {
          backfillStarted = true
          // one-time copy of pre-ledger spend into the cost ledger (background)
          startUsageBackfill(req.email, req.token)
        }
        // one app grants run per process, in the background (never awaited
        // here: a slow run must not hold TTFT). A no-op on a deployed app,
        // where the connection is the SP itself; the real run is
        // `migrate.mjs grants` by the deploying identity.
        if (!grantsStarted) {
          grantsStarted = true
          Promise.resolve()
            .then(() => startAppGrants(req.email, req.token))
            .catch((e) => log.warn('app grants run failed:', e.message))
        }
      })()
      schemaReady = pending
      pending.catch(() => {
        if (schemaReady === pending) schemaReady = null
      })
    }
    await schemaReady
  }
}

async function startAppGrants(email, token) {
  rememberGrantsCaller(email, token)
  const r = await runAppGrantsFromApp(email, token)
  if (r?.skipped) console.log(`app grants: skipped at boot (${r.skipped})`)
}

export const ensureReady = createEnsureReady({ ensureSchema, startAppGrants, startUsageBackfill })
