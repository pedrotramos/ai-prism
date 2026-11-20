// Admin read of the usage ledger (N2, migration 0010) and the fixed-cost tool
// price book of the admin screen.
//
// toolUsageAggregate is the ONLY module that reads usage_ledger with the admin
// flag. It runs withTx(..., { admin: true }), so the aipa_admin_read policy lets
// the transaction see every user's rows, and it returns AGGREGATES: counts and
// money per day, provider and user. Its one per-user result (topUsers) carries
// the e-mail as the grouping key for the route to hash; the route never returns
// it (server/routes/adminUsage.js). Every other ledger query of the app keeps
// its own WHERE user_email; this one deliberately has none (an admin who lost
// the flag would read only their own rows: wrong numbers, nothing leaked).
//
// Days are UTC dates of created_at; `from` and `to` are inclusive ISO days.
import { withTx } from './pool.js'
import { recordAdminAction } from '../audit.js'

export const TOOL_USAGE_KINDS = Object.freeze(['web_search'])
export const TOP_USERS = 10

const DAY_MS = 86_400_000
const num = (v) => (v == null ? 0 : Number(v))
// cost_usd is NUMERIC(14,6): six decimals are exact, so round the float sum back to them
const usd = (v) => Math.round(num(v) * 1e6) / 1e6

/** [from 00:00:00Z, the day after `to` 00:00:00Z) as ISO instants. */
function bounds(from, to) {
  const start = new Date(`${from}T00:00:00Z`)
  const end = new Date(new Date(`${to}T00:00:00Z`).getTime() + DAY_MS)
  return [start.toISOString(), end.toISOString()]
}

const WHERE = `WHERE kind = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`
const AGG = `count(*)::int AS calls,
             count(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced,
             coalesce(sum(cost_usd), 0) AS cost`

/**
 * One kind (an allowlisted string) over a period → { totals, byDay, byProvider, topUsers }.
 * Zeros and empty lists on an empty ledger.
 */
export async function toolUsageAggregate(adminEmail, adminToken, { kind, from, to }) {
  if (!TOOL_USAGE_KINDS.includes(kind)) throw new Error('unsupported kind')
  const [start, end] = bounds(from, to)
  const args = [kind, start, end]
  return withTx(
    adminEmail,
    adminToken,
    async (c) => {
      const total = (await c.query(`SELECT ${AGG} FROM usage_ledger ${WHERE}`, args)).rows[0]
      const byDay = await c.query(
        `SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, ${AGG}
           FROM usage_ledger ${WHERE} GROUP BY 1 ORDER BY 1`,
        args
      )
      const byProvider = await c.query(
        `SELECT coalesce(model, '') AS provider, ${AGG}
           FROM usage_ledger ${WHERE} GROUP BY 1 ORDER BY calls DESC, provider`,
        args
      )
      const top = await c.query(
        `SELECT user_email, ${AGG}
           FROM usage_ledger ${WHERE} GROUP BY user_email ORDER BY calls DESC, cost DESC, user_email LIMIT ${TOP_USERS}`,
        args
      )
      const calls = num(total.calls)
      const unpricedCalls = num(total.unpriced)
      return {
        totals: { calls, pricedCalls: calls - unpricedCalls, unpricedCalls, costUsd: usd(total.cost) },
        byDay: byDay.rows.map((r) => ({ day: r.day, calls: num(r.calls), unpricedCalls: num(r.unpriced), costUsd: usd(r.cost) })),
        byProvider: byProvider.rows.map((r) => ({ provider: r.provider, calls: num(r.calls), unpricedCalls: num(r.unpriced), costUsd: usd(r.cost) })),
        topUsers: top.rows.map((r) => ({ userEmail: r.user_email, calls: num(r.calls), costUsd: usd(r.cost) })),
      }
    },
    { admin: true }
  )
}

// ---- the fixed-cost tool price book ('tool:<kind>[:<provider>]' rows of model_catalog_overrides) ----

/** { 'tool:web_search': { priceIn }, … }: only the tool price rows that carry a price. */
export async function listToolPrices(userEmail, userToken) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT endpoint_id, price_in FROM model_catalog_overrides WHERE endpoint_id LIKE 'tool:%' AND price_in IS NOT NULL`)
    return Object.fromEntries(r.rows.map((x) => [x.endpoint_id, { priceIn: Number(x.price_in) }]))
  })
}

/**
 * Sets (a number of USD per 1,000 calls) or clears (null) the price of `key`
 * ('web_search' or 'web_search:<provider>', already validated) and writes its
 * audit row in the same transaction. Only this row's price: a tool price row is
 * never a model, so nothing else on it exists to overwrite. A price change
 * affects future ledger rows only: cost_usd is fixed when a row is written.
 */
export async function setToolPrice(userEmail, userToken, key, per1kUsd, { admin = false } = {}) {
  const id = `tool:${key}`
  await withTx(
    userEmail,
    userToken,
    async (c) => {
      if (per1kUsd == null) {
        await c.query(`DELETE FROM model_catalog_overrides WHERE endpoint_id = $1`, [id])
      } else {
        await c.query(
          `INSERT INTO model_catalog_overrides (endpoint_id, enabled, price_in, updated_by, updated_at)
             VALUES ($1, FALSE, $2, $3, NOW())
           ON CONFLICT (endpoint_id) DO UPDATE SET price_in = EXCLUDED.price_in, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
          [id, per1kUsd, userEmail]
        )
      }
      await recordAdminAction(c, userEmail, { action: 'tool_price.set', target: key, details: { per1kUsd: per1kUsd ?? null } })
    },
    { admin }
  )
}
