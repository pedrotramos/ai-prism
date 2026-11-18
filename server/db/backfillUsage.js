// One-time reconstruction of the usage ledger from what chat_messages already
// recorded before the ledger existed (W2-1: a data migration run by the owner,
// no longer a per-process job on the request path).
//
// What it copies: the chat-model tokens of every assistant row (active or not —
// regenerated variants were billed too) plus the intent classifier and media
// usage kept in their JSON columns. Only rows OLDER than the first live ledger
// row, so nothing is counted twice; the partial unique index
// uq_usage_ledger_backfill makes repeated or concurrent runs no-ops. Titles,
// embeddings and tweaks were never stored, so the backfilled past is a lower
// bound — the meter says so.
//
// Why the owner: it reads and writes EVERY user's rows, which row-level security
// (migration 0003) denies to the app role. FORCE ROW LEVEL SECURITY binds the
// table owner too, so inside ONE transaction, as the owner, it switches FORCE off
// on the three tables it touches (the owner then skips the policies), does the
// copy and switches FORCE back on. Nobody else ever sees the tables without FORCE:
// ALTER TABLE takes an ACCESS EXCLUSIVE lock held until COMMIT, so EVERY app query
// on usage_ledger, chat_messages and chat_sessions waits for the whole copy (one
// read of the assistant history plus batched inserts). Run it once, off-hours;
// lock_timeout only bounds the wait to acquire the locks behind the app's queries.
// No owner rights → it refuses, changing nothing.
//
// Run by `node scripts/migrate.mjs backfill-usage` as the deploying identity (a
// member of the owner role) or the table owner. `cost(model, usage)` prices a
// usage like server/usage.js priceUsage: { promptTokens, completionTokens, costUsd }.
import { consoleLogger } from '../log.js'
import { ownerRoleName } from './grants.js'

export const BACKFILL_TABLES = Object.freeze(['usage_ledger', 'chat_messages', 'chat_sessions'])
const LOCK_TIMEOUT = '10s'

async function one(c, sql, params) {
  return (await c.query(sql, params)).rows[0]
}

/** Returns { inserted, alreadyDone }. */
export async function backfillUsageLedger(c, { cost, owner = ownerRoleName(), log = consoleLogger } = {}) {
  if (typeof cost !== 'function') throw new Error('backfill-usage: a cost(model, usage) function is required')
  await c.query('SET search_path TO ai_prism, public')
  await c.query('BEGIN')
  try {
    await c.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
    const canSet = await one(
      c,
      `SELECT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                       WHERE g.rolname = $1 AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                         AND m.set_option) AS ok`,
      [owner]
    )
    if (canSet.ok) await c.query(`SET LOCAL ROLE "${owner.replace(/"/g, '""')}"`)
    const rights = await one(
      c,
      `SELECT bool_and(pg_has_role(current_user, c.relowner, 'USAGE')) AS ok
         FROM pg_class c WHERE c.relnamespace = to_regnamespace('ai_prism') AND c.relname = ANY ($1)`,
      [BACKFILL_TABLES]
    )
    if (!rights?.ok) {
      throw new Error(
        `backfill-usage: ${(await one(c, 'SELECT current_user AS me')).me} does not own ${BACKFILL_TABLES.join(', ')} ` +
          '(run it as the deploying identity, a member of the owner role, after `migrate.mjs up`)'
      )
    }
    for (const t of BACKFILL_TABLES) await c.query(`ALTER TABLE ai_prism.${t} NO FORCE ROW LEVEL SECURITY`)

    let inserted = 0
    const done = await c.query(`SELECT 1 FROM usage_ledger WHERE source = 'backfill' LIMIT 1`)
    const alreadyDone = done.rows.length > 0
    if (!alreadyDone) {
      const r = await c.query(
        `SELECT m.id, m.session_id, s.user_email, m.model, m.prompt_tokens, m.completion_tokens,
                m.intent_classify, m.media_processing, m.created_at
           FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
          WHERE m.role = 'assistant'
            AND m.created_at < COALESCE((SELECT MIN(created_at) FROM usage_ledger WHERE source = 'live'), NOW())`
      )
      const rows = []
      for (const m of r.rows) {
        const push = (kind, model, usage) => {
          if (!usage || !(usage.prompt_tokens || usage.completion_tokens)) return
          const priced = cost(model, usage)
          rows.push([m.user_email, m.session_id, m.id, kind, model || null, priced.promptTokens, priced.completionTokens, priced.costUsd, m.created_at])
        }
        push('chat', m.model, { prompt_tokens: m.prompt_tokens, completion_tokens: m.completion_tokens })
        if (m.intent_classify?.usage) push('intent', m.intent_classify.model, m.intent_classify.usage)
        if (m.media_processing?.usage) push('media', m.media_processing.model, m.media_processing.usage)
      }
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500)
        const values = batch.map(
          (_, j) =>
            `($${j * 9 + 1}, $${j * 9 + 2}, $${j * 9 + 3}, $${j * 9 + 4}, $${j * 9 + 5}, $${j * 9 + 6}, $${j * 9 + 7}, $${j * 9 + 8}, 'backfill', $${j * 9 + 9})`
        )
        const res = await c.query(
          `INSERT INTO usage_ledger (user_email, session_id, message_id, kind, model, prompt_tokens, completion_tokens, cost_usd, source, created_at)
           VALUES ${values.join(', ')}
           ON CONFLICT (message_id, kind) WHERE source = 'backfill' DO NOTHING`,
          batch.flat()
        )
        inserted += res.rowCount
      }
    }

    for (const t of BACKFILL_TABLES) await c.query(`ALTER TABLE ai_prism.${t} FORCE ROW LEVEL SECURITY`)
    await c.query('COMMIT')
    if (inserted) log.log(`usage ledger: ${inserted} rows reconstructed from the history`)
    return { inserted, alreadyDone }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  }
}

/** The admin price overrides, read the way the app reads them (for priceUsage). */
export async function readPriceOverrides(c) {
  const r = await c.query(
    `SELECT endpoint_id, price_in::float8 AS price_in, price_out::float8 AS price_out FROM ai_prism.model_catalog_overrides`
  )
  const map = {}
  for (const x of r.rows) map[x.endpoint_id] = { endpointId: x.endpoint_id, priceIn: x.price_in, priceOut: x.price_out }
  return map
}
