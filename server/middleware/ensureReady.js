import { ensureSchema, ensureSpGrants } from '../db.js'
import { startUsageBackfill } from '../usage.js'

// schema is created once, lazily, with the first user's token
let schemaReady = false
export async function ensureReady(req) {
  if (!schemaReady) {
    await ensureSchema(req.email, req.token)
    schemaReady = true
    // one-time copy of pre-ledger spend into the cost ledger (background)
    startUsageBackfill(req.email, req.token)
  }
  // separate latch: the SP role can appear long after the schema did, and
  // only the table owner's identity can apply its grants — so this must keep
  // trying past the schemaReady latch (no-op once granted)
  await ensureSpGrants(req.email, req.token)
}
