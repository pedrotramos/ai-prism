import { ensureSchema, ensureSpGrants } from '../db.js'
import { startUsageBackfill } from '../usage.js'

// Built from its dependencies so the latch can be tested without a database.
export function createEnsureReady({ ensureSchema, ensureSpGrants, startUsageBackfill }) {
  // schema is created once, lazily, with the first user's token. A promise
  // latch: requests that arrive while the DDL runs wait on the same promise
  // instead of running it again; a failed DDL clears the latch so the next
  // request retries.
  let schemaReady = null
  return async function ensureReady(req) {
    if (!schemaReady) {
      const pending = (async () => {
        await ensureSchema(req.email, req.token)
        // one-time copy of pre-ledger spend into the cost ledger (background)
        startUsageBackfill(req.email, req.token)
      })()
      schemaReady = pending
      pending.catch(() => {
        if (schemaReady === pending) schemaReady = null
      })
    }
    await schemaReady
    // separate latch: the SP role can appear long after the schema did, and
    // only the table owner's identity can apply its grants — so this must keep
    // trying past the schemaReady latch (no-op once granted)
    await ensureSpGrants(req.email, req.token)
  }
}

export const ensureReady = createEnsureReady({ ensureSchema, ensureSpGrants, startUsageBackfill })
