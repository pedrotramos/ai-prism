// Admin web-search cost tile (N2): aggregates of the usage ledger across users,
// and the price editor of the fixed-cost tool rows. Admin only.
//
//   GET /api/admin/usage/tools?kind=web_search[&from=YYYY-MM-DD&to=YYYY-MM-DD]
//       → { kind, period, totals, byDay, byProvider, topUsers, prices }
//       counts and money per day, provider and user (a keyed hash, never the
//       e-mail); no session, message or prompt content exists in the ledger.
//       400 bad_kind | bad_period, 403 (requireAdmin), 500 internal_error.
//   PUT /api/admin/tool-prices/:key        key = web_search | web_search:<provider>
//       body { per1kUsd: 0..1000 | null }  (null clears the override)
//       → { ok: true }; 400 bad_key | bad_price. Audited as 'tool_price.set'.
//       A price applies to FUTURE ledger rows (cost_usd is fixed when a row is
//       written); the tile estimates the unpriced ones at the price in effect now.
//
// The ledger is read with the admin flag only by server/db/adminUsage.js.
import { authed } from './authed.ts'
import type { Express, RequestHandler } from 'express'
import { auth as realAuth } from '../middleware/auth.ts'
import { requireAdmin as realRequireAdmin } from '../middleware/requireAdmin.ts'
import { parsePeriod } from '../costs.ts'
import { auditHash } from '../audit.ts'
import { toolPricePer1k, setPriceOverrides } from '../usage.ts'
import { MCP_SEARCH_PROVIDERS } from '../webSearch/mcpProviders.ts'
import { toolUsageAggregate, listToolPrices, setToolPrice, TOOL_USAGE_KINDS } from '../db/adminUsage.js'
import { listModelOverrides } from '../db.js'
import { invalidateUserModels } from '../models.ts'
import { logger } from '../log.ts'

export const MAX_PRICE_PER_1K_USD = 1000

// the provider ids a web-search row can carry: the native backends and the MCP vendors
export const TOOL_PRICE_PROVIDERS = Object.freeze([...new Set([...MCP_SEARCH_PROVIDERS.map((p: { id: string }) => p.id), 'brave', 'tavily', 'searxng'])])

/** The kind of the query, or null (an allowlist; a repeated parameter is refused). */
export function parseToolKind(v: unknown): string | null {
  return typeof v === 'string' && TOOL_USAGE_KINDS.includes(v) ? v : null
}

/** 'web_search' or 'web_search:<known provider id>', else null. */
export function parsePriceKey(v: unknown): string | null {
  if (typeof v !== 'string') return null
  if (v === 'web_search') return v
  const m = /^web_search:([a-z0-9-]+)$/.exec(v)
  return m && TOOL_PRICE_PROVIDERS.includes(m[1] as string) ? v : null
}

type PriceOverrides = Parameters<typeof toolPricePer1k>[3]

const round6 = (v: number) => Math.round(v * 1e6) / 1e6
const overrideOf = (overrides: PriceOverrides, key: string): number | null => {
  const v = overrides?.[`tool:${key}`]?.priceIn
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * The API shape from the aggregate: users replaced by a hash, the price in effect
 * and the estimate of the unpriced calls per provider, and the overrides of
 * 'web_search' and of each provider seen. Nothing else of the raw result passes.
 */
interface ToolUsageRaw {
  totals: unknown
  byDay: unknown
  byProvider: Array<{ provider?: string | null; calls: number; unpricedCalls: number; costUsd: number | null }>
  topUsers: Array<{ userEmail: string; calls: number; costUsd: number | null }>
}

export function shapeToolUsage(
  raw: ToolUsageRaw,
  {
    kind,
    period,
    overrides = {},
    env = process.env,
    hash = auditHash,
  }: { kind: string; period: unknown; overrides?: PriceOverrides; env?: Record<string, string | undefined>; hash?: (email?: unknown) => unknown }
) {
  const byProvider = raw.byProvider.map((p) => {
    const provider = p.provider || 'unknown'
    const pricePer1k = toolPricePer1k(provider, env, kind, overrides)
    return {
      provider,
      calls: p.calls,
      unpricedCalls: p.unpricedCalls,
      costUsd: p.costUsd,
      pricePer1k,
      estimatedUnpricedUsd: pricePer1k == null ? null : round6((p.unpricedCalls * pricePer1k) / 1000),
    }
  })
  const prices: Record<string, number | null> = { [kind]: overrideOf(overrides, kind) }
  for (const p of byProvider) {
    const key = `${kind}:${p.provider}`
    if (parsePriceKey(key)) prices[key] = overrideOf(overrides, key)
  }
  return {
    kind,
    period,
    totals: raw.totals,
    byDay: raw.byDay,
    byProvider,
    topUsers: raw.topUsers.map((u) => ({ userHash: hash(u.userEmail), calls: u.calls, costUsd: u.costUsd })),
    prices,
  }
}

// this instance prices the next ledger row with the new book at once; the others
// pick it up when their model catalog cache (30 s) reloads (server/models.js)
async function refreshPrices(email: string, token: string): Promise<void> {
  setPriceOverrides(await listModelOverrides(email, token))
  invalidateUserModels()
}

interface AdminUsageDeps {
  auth?: RequestHandler
  requireAdmin?: RequestHandler
  aggregate?: typeof toolUsageAggregate
  listToolPrices?: typeof listToolPrices
  setToolPrice?: typeof setToolPrice
  refreshPrices?: (email: string, token: string) => Promise<void> | void
  env?: Record<string, string | undefined>
  now?: () => Date
  hash?: (email?: unknown) => unknown
}

export default function registerAdminUsageRoutes(app: Express, deps: AdminUsageDeps = {}) {
  const auth = deps.auth || realAuth
  const requireAdmin = deps.requireAdmin || realRequireAdmin
  const aggregate = deps.aggregate || toolUsageAggregate
  const listPrices = deps.listToolPrices || listToolPrices
  const setPrice = deps.setToolPrice || setToolPrice
  const refresh = deps.refreshPrices || refreshPrices
  const env = deps.env || process.env
  const now = deps.now || (() => new Date())
  const hash = deps.hash || auditHash

  app.get('/api/admin/usage/tools', auth, requireAdmin, async function adminToolUsageHandler(req, res) {
    res.set('Cache-Control', 'no-store')
    const kind = parseToolKind(req.query.kind)
    if (!kind) return res.status(400).json({ code: 'bad_kind' })
    let period: ReturnType<typeof parsePeriod>
    try {
      period = parsePeriod({ from: req.query.from, to: req.query.to }, now())
    } catch {
      return res.status(400).json({ code: 'bad_period' })
    }
    try {
      const [raw, overrides] = await Promise.all([aggregate(authed(req).email, authed(req).token, { kind, ...period }), listPrices(authed(req).email, authed(req).token)])
      res.json(shapeToolUsage(raw, { kind, period, overrides, env, hash }))
    } catch (e) {
      logger.warn('admin tool usage failed', { err: e })
      res.status(500).json({ code: 'internal_error' })
    }
  })

  app.put('/api/admin/tool-prices/:key', auth, requireAdmin, async function adminToolPriceHandler(req, res) {
    res.set('Cache-Control', 'no-store')
    const key = parsePriceKey((req.params.key as string))
    if (!key) return res.status(400).json({ code: 'bad_key' })
    const v = req.body?.per1kUsd
    const valid = v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PRICE_PER_1K_USD)
    if (!valid) return res.status(400).json({ code: 'bad_price' })
    try {
      await setPrice(authed(req).email, authed(req).token, key, v, { admin: authed(req).isAdmin === true })
      await refresh(authed(req).email, authed(req).token)
      res.json({ ok: true })
    } catch (e) {
      logger.warn('admin tool price failed', { err: e })
      res.status(500).json({ code: 'internal_error' })
    }
  })
}
