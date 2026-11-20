// Billed cost of this AI Prism installation, read from the Databricks system
// tables for the admin Costs page (#/costs). Same reality as the `ai-costs`
// AI/BI dashboard (dashboards/ai-costs.lvdash.json), so the numbers reconcile
// for the same period (± rounding):
//
//   - AI model calls: system.serving.endpoint_usage rows stamped
//     usage_context['application'] = 'ai-prism' (NOT ai_gateway request_tags),
//     endpoint name via system.serving.served_entities; each endpoint's daily
//     billed cost (system.billing.usage × system.billing.list_prices) is
//     allocated to users by their share of that endpoint's daily tokens.
//   - Infrastructure: system.billing.usage rows tagged
//     custom_tags['ai_prism_app'] = <app tag> (SQL warehouse, Lakebase, job)
//     plus the Databricks App itself by usage_metadata.app_name (Apps have no
//     tags field; see docs/tags.md).
//
// Every statement is parameterised: the period, the tag key and the scope
// values travel as named parameters, never inlined. The statements run with
// the admin's own OBO token (server/warehouse.js), so the page shows exactly
// what that admin may SELECT; the token is never cached or logged here.
import { execStatement } from './warehouse.ts'
import { getResourceTags, APP_TAG_KEY, USAGE_APPLICATION } from './resourceTags.ts'

export const BREAKDOWNS = ['resource', 'model', 'person', 'tag']
export const DEFAULT_PERIOD_DAYS = 30
export const MAX_PERIOD_DAYS = 366
// system tables are big and a serverless warehouse may be cold
const QUERY_TIMEOUT_MS = 90_000
const DAY_MS = 86_400_000

export class CostsError extends Error {
  constructor(status, code, message = code) {
    super(message)
    this.status = status
    this.code = code
  }
}

const isoDay = (d) => d.toISOString().slice(0, 10)

function parseIsoDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(`${s}T00:00:00Z`)
  // rejects 2026-02-30 and friends: Date rolls them over to another day
  return Number.isNaN(d.getTime()) || isoDay(d) !== s ? null : d
}

/**
 * {from, to} (inclusive ISO days, UTC) from the query string. Both absent →
 * the last DEFAULT_PERIOD_DAYS days ending today. Anything else must be two
 * real ISO dates, from ≤ to ≤ today, at most MAX_PERIOD_DAYS long.
 */
export function parsePeriod(query = {}, now = new Date()) {
  const today = parseIsoDay(isoDay(now))
  const { from, to } = query
  if (from === undefined && to === undefined) {
    return { from: isoDay(new Date(today.getTime() - (DEFAULT_PERIOD_DAYS - 1) * DAY_MS)), to: isoDay(today) }
  }
  const f = parseIsoDay(from)
  const t = parseIsoDay(to)
  if (!f || !t || f > t || t > today || (t - f) / DAY_MS + 1 > MAX_PERIOD_DAYS) throw new CostsError(400, 'bad_period')
  return { from, to }
}

/** What identifies this installation in the system tables. */
export function costScope(env = process.env) {
  const tags = getResourceTags(env)
  const appTag = tags[APP_TAG_KEY]
  return {
    application: USAGE_APPLICATION,
    appTag,
    appName: env.DATABRICKS_APP_NAME || appTag,
    // operator tags first (the useful ones to group by), the built-in last
    tagKeys: [...Object.keys(tags).filter((k) => k !== APP_TAG_KEY), APP_TAG_KEY],
  }
}

// ---- statements ------------------------------------------------------------

// The AI part, shared by every breakdown (the dashboard's ai_prism_detail
// formula, over the requested period). Rows of this installation: the
// application stamp, and the app tag when the row carries one (rows from
// before resource tags existed have none and still belong to the app).
const aiCte = (tagExpr = 'CAST(NULL AS STRING)') => `token_base AS (
  SELECT
    lower(eu.requester) AS user_email,
    se.endpoint_name,
    date(eu.request_time) AS day,
    ${tagExpr} AS tag_value,
    SUM(eu.input_token_count) AS prompt_tokens,
    SUM(eu.output_token_count) AS completion_tokens,
    SUM(eu.input_token_count + eu.output_token_count) AS total_tokens,
    COUNT(*) AS requests
  FROM system.serving.endpoint_usage eu
    JOIN system.serving.served_entities se ON eu.served_entity_id = se.served_entity_id
  WHERE eu.usage_context['application'] = :application
    AND coalesce(eu.usage_context['${APP_TAG_KEY}'], :app_tag) = :app_tag
    AND se.endpoint_name IS NOT NULL
    AND date(eu.request_time) BETWEEN :from AND :to
  GROUP BY ALL
),
endpoint_tokens AS (
  SELECT endpoint_name, day, SUM(total_tokens) AS endpoint_total_tokens
  FROM token_base
  GROUP BY endpoint_name, day
),
endpoint_cost AS (
  SELECT
    u.usage_metadata.endpoint_name AS endpoint_name,
    u.usage_date AS day,
    SUM(u.usage_quantity) AS dbus,
    SUM(u.usage_quantity * lp.pricing.default) AS usd
  FROM system.billing.usage u
    JOIN system.billing.list_prices lp
      ON u.sku_name = lp.sku_name
      AND lp.currency_code = 'USD'
      AND lp.price_start_time <= u.usage_start_time
      AND (lp.price_end_time IS NULL OR lp.price_end_time > u.usage_start_time)
  WHERE u.billing_origin_product = 'MODEL_SERVING'
    AND u.usage_date BETWEEN :from AND :to
  GROUP BY 1, 2
),
ai AS (
  SELECT
    t.*,
    ec.dbus * t.total_tokens / NULLIF(et.endpoint_total_tokens, 0) AS dbus,
    ec.usd * t.total_tokens / NULLIF(et.endpoint_total_tokens, 0) AS usd
  FROM token_base t
    LEFT JOIN endpoint_tokens et ON t.endpoint_name = et.endpoint_name AND t.day = et.day
    LEFT JOIN endpoint_cost ec ON t.endpoint_name = ec.endpoint_name AND t.day = ec.day
)`

// Infrastructure billed to this installation. Model Serving is left to the AI
// allocation above so it is priced once.
const infraCte = (tagExpr = 'CAST(NULL AS STRING)') => `infra AS (
  SELECT
    u.billing_origin_product AS product,
    coalesce(
      u.usage_metadata.warehouse_id,
      u.usage_metadata.app_name,
      u.usage_metadata.database_instance_id,
      u.usage_metadata.job_id,
      u.sku_name
    ) AS resource_id,
    ${tagExpr} AS tag_value,
    u.usage_quantity AS dbus,
    u.usage_quantity * lp.pricing.default AS usd
  FROM system.billing.usage u
    JOIN system.billing.list_prices lp
      ON u.sku_name = lp.sku_name
      AND lp.currency_code = 'USD'
      AND lp.price_start_time <= u.usage_start_time
      AND (lp.price_end_time IS NULL OR lp.price_end_time > u.usage_start_time)
  WHERE u.usage_date BETWEEN :from AND :to
    AND u.billing_origin_product <> 'MODEL_SERVING'
    AND (
      u.custom_tags['${APP_TAG_KEY}'] = :app_tag
      OR (u.billing_origin_product = 'APPS' AND u.usage_metadata.app_name = :app_name)
    )
)`

const QUERIES = {
  resource: {
    columns: ['product', 'resource_id', 'dbus', 'usd'],
    statement: () => `WITH ${aiCte()},
${infraCte()}
SELECT product, resource_id, ROUND(SUM(dbus), 6) AS dbus, ROUND(SUM(usd), 4) AS usd
FROM (
  SELECT product, resource_id, dbus, usd FROM infra
  UNION ALL
  SELECT 'MODEL_SERVING' AS product, endpoint_name AS resource_id, dbus, usd FROM ai
)
GROUP BY product, resource_id
ORDER BY usd DESC NULLS LAST, dbus DESC NULLS LAST`,
  },
  model: {
    columns: ['endpoint_name', 'requests', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'dbus', 'usd'],
    statement: () => `WITH ${aiCte()}
SELECT
  endpoint_name,
  SUM(requests) AS requests,
  SUM(prompt_tokens) AS prompt_tokens,
  SUM(completion_tokens) AS completion_tokens,
  SUM(total_tokens) AS total_tokens,
  ROUND(SUM(dbus), 6) AS dbus,
  ROUND(SUM(usd), 4) AS usd
FROM ai
GROUP BY endpoint_name
ORDER BY usd DESC NULLS LAST, total_tokens DESC`,
  },
  person: {
    columns: ['user_email', 'requests', 'total_tokens', 'dbus', 'usd'],
    statement: () => `WITH ${aiCte()}
SELECT
  user_email,
  SUM(requests) AS requests,
  SUM(total_tokens) AS total_tokens,
  ROUND(SUM(dbus), 6) AS dbus,
  ROUND(SUM(usd), 4) AS usd
FROM ai
GROUP BY user_email
ORDER BY usd DESC NULLS LAST, total_tokens DESC`,
  },
  tag: {
    columns: ['tag_value', 'infra_usd', 'ai_usd', 'dbus', 'usd'],
    statement: () => `WITH ${aiCte('eu.usage_context[:tag_key]')},
${infraCte('u.custom_tags[:tag_key]')}
SELECT
  tag_value,
  ROUND(SUM(CASE WHEN src = 'infra' THEN usd ELSE 0 END), 4) AS infra_usd,
  ROUND(SUM(CASE WHEN src = 'ai' THEN usd ELSE 0 END), 4) AS ai_usd,
  ROUND(SUM(dbus), 6) AS dbus,
  ROUND(SUM(usd), 4) AS usd
FROM (
  SELECT 'infra' AS src, tag_value, dbus, usd FROM infra
  UNION ALL
  SELECT 'ai' AS src, tag_value, dbus, usd FROM ai
)
GROUP BY tag_value
ORDER BY usd DESC NULLS LAST`,
  },
}

const NUMERIC = new Set(['requests', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'dbus', 'usd', 'infra_usd', 'ai_usd'])

/**
 * { statement, parameters, columns } for one breakdown. Only the parameters
 * the statement references are sent (the API rejects neither, but an unused
 * one would hide a typo in a marker).
 */
export function buildCostQuery(by, { from, to, tagKey } = {}, scope = costScope()) {
  // a string only: Object.hasOwn would coerce ['model'] (?by=model&by=model) to 'model'
  const q = typeof by === 'string' && Object.hasOwn(QUERIES, by) ? QUERIES[by] : null
  if (!q) throw new CostsError(400, 'bad_breakdown')
  let key = null
  if (by === 'tag') {
    key = tagKey === undefined || tagKey === '' ? scope.tagKeys[0] : tagKey
    // only a tag this installation actually sets can be grouped by
    if (typeof key !== 'string' || !scope.tagKeys.includes(key)) throw new CostsError(400, 'bad_tag')
  }
  const statement = q.statement()
  const all = {
    from: { value: from, type: 'DATE' },
    to: { value: to, type: 'DATE' },
    application: { value: scope.application, type: 'STRING' },
    app_tag: { value: scope.appTag, type: 'STRING' },
    app_name: { value: scope.appName, type: 'STRING' },
    tag_key: { value: key, type: 'STRING' },
  }
  const used = new Set([...statement.matchAll(/(?<![:\w]):([a-z_]+)/g)].map((m) => m[1]))
  const parameters = Object.entries(all)
    .filter(([name]) => used.has(name))
    .map(([name, p]) => ({ name, value: p.value, type: p.type }))
  return { statement, parameters, columns: q.columns, tagKey: key }
}

// ---- errors ------------------------------------------------------------------

const NO_ACCESS =
  /INSUFFICIENT_PERMISSIONS|PERMISSION_DENIED|TABLE_OR_VIEW_NOT_FOUND|SCHEMA_NOT_FOUND|does not have .*(privilege|permission|USE SCHEMA|USE CATALOG|SELECT)|do not have permission|not authorized|forbidden|HTTP 403/i

/** {status, code} the route answers for a failure (never a 500 for a grant problem). */
export function classifyCostsError(err) {
  if (err instanceof CostsError) return { status: err.status, code: err.code }
  const msg = String(err?.message || err || '')
  if (/SQL_WAREHOUSE_ID/.test(msg)) return { status: 503, code: 'no_warehouse' }
  if (NO_ACCESS.test(msg)) return { status: 403, code: 'no_access' }
  if (/Tempo esgotado|timed? ?out|timeout/i.test(msg)) return { status: 504, code: 'timeout' }
  return { status: 502, code: 'query_failed' }
}

// ---- run ---------------------------------------------------------------------

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Runs one breakdown with the caller's token. `query` is the raw query string
 * ({from, to, tag}); `exec` defaults to the SQL Statement Execution client.
 */
export async function queryCosts({ token, by, query = {}, env = process.env, exec = execStatement, now = new Date() }) {
  const period = parsePeriod(query, now)
  const { statement, parameters, columns, tagKey } = buildCostQuery(by, { ...period, tagKey: query.tag }, costScope(env))
  const res = await exec(token, statement, parameters, { timeoutMs: QUERY_TIMEOUT_MS })
  const idx = new Map((res.columns || []).map((c, i) => [c, i]))
  const rows = (res.rows || []).map((r) => {
    const o = {}
    for (const c of columns) {
      const v = idx.has(c) ? r[idx.get(c)] : null
      o[c] = NUMERIC.has(c) ? toNumber(v) : v ?? null
    }
    return o
  })
  const totals = {}
  for (const k of ['usd', 'dbus', 'requests', 'total_tokens']) {
    if (!columns.includes(k)) continue
    totals[k] = Math.round(rows.reduce((a, r) => a + (r[k] || 0), 0) * 1e6) / 1e6
  }
  return { by, period, currency: 'USD', ...(tagKey ? { tagKey } : {}), columns, rows, totals }
}
