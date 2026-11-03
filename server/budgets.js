// Monthly budgets (optional, admin-managed) on top of the cost ledger
// (server/usage.js). The rule set:
//   - budgets off → nobody has a budget (the taxímetro still shows spend);
//   - on → a DEFAULT budget is mandatory and applies to whoever has no
//     explicit override;
//   - overrides target a user (e-mail) or a workspace group; a group override
//     sets the budget of each of its members;
//   - the EFFECTIVE budget is the LARGEST override that applies to the user.
//     The default is NOT part of that max: it only covers users with no
//     override at all (a $100 group rule beats a $200 default for its members).
// Example: Paulo is in `eng_dados` (US$ 200) and has a nominal rule of
// US$ 500 → his budget is US$ 500.
import { getBudgetConfig, monthSpend, saveBudgetSnapshot } from './db.js'
import { userGroups, groupCheckStatus } from './authz.js'
import { monthWindow } from './usage.js'

export const ENFORCEMENT_MODES = ['warn', 'block']

const norm = (s) => String(s || '').trim().toLowerCase()

// Pure: the budget that applies to `email` (member of `groups`, a Set of
// lowercased display names), or null when budgets are off.
export function effectiveBudget({ settings, rules, email, groups }) {
  if (!settings?.enabled) return null
  const me = norm(email)
  const applicable = (rules || []).filter(
    (r) => (r.kind === 'user' && norm(r.principal) === me) || (r.kind === 'group' && groups?.has(norm(r.principal)))
  )
  if (applicable.length) {
    const best = applicable.reduce((a, b) => (b.monthlyUsd > a.monthlyUsd ? b : a))
    return { limitUsd: best.monthlyUsd, source: { kind: best.kind, principal: best.principal } }
  }
  if (settings.defaultUsd == null) return null
  return { limitUsd: settings.defaultUsd, source: { kind: 'default', principal: null } }
}

// ok → below the warning threshold; warn → at/over it; exceeded → at/over the
// budget. A US$ 0 budget is "exceeded" from the start (no allowance at all).
export function budgetState(spentUsd, limitUsd, warnPct) {
  if (limitUsd == null) return null
  if (spentUsd >= limitUsd) return 'exceeded'
  if (limitUsd > 0 && spentUsd >= (limitUsd * warnPct) / 100) return 'warn'
  return 'ok'
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const money = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN)

// Validates the admin's settings payload → { value } or { error } (error is a
// stable code the client localizes).
export function validateBudgetSettings(b = {}) {
  const enabled = !!b.enabled
  const defaultUsd = b.defaultUsd == null || b.defaultUsd === '' ? null : money(Number(b.defaultUsd))
  if (defaultUsd != null && (!Number.isFinite(defaultUsd) || defaultUsd <= 0)) return { error: 'default_invalid' }
  if (enabled && defaultUsd == null) return { error: 'default_required' }
  const enforcement = b.enforcement ?? 'warn'
  if (!ENFORCEMENT_MODES.includes(enforcement)) return { error: 'enforcement_invalid' }
  const warnPct = b.warnPct ?? 80
  if (!Number.isInteger(warnPct) || warnPct < 1 || warnPct > 99) return { error: 'warn_pct_invalid' }
  const timezone = b.timezone ?? 'UTC'
  if (!isValidTimeZone(timezone)) return { error: 'timezone_invalid' }
  return { value: { enabled, defaultUsd, enforcement, warnPct, timezone } }
}

export function validateBudgetRule(b = {}) {
  const kind = b.kind
  if (kind !== 'user' && kind !== 'group') return { error: 'kind_invalid' }
  const principal = norm(b.principal)
  if (!principal || principal.length > 256) return { error: 'principal_invalid' }
  const monthlyUsd = money(Number(b.monthlyUsd))
  if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0) return { error: 'amount_invalid' }
  return { value: { kind, principal, monthlyUsd } }
}

// ---- config cache --------------------------------------------------------------
// Read on every turn (enforcement) and every meter load; admins rarely change
// it, and every admin write invalidates it.
const CONFIG_TTL_MS = 30 * 1000
let cached = null // { at, config }
export async function loadBudgetConfig(email, token) {
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.config
  const config = await getBudgetConfig(email, token)
  cached = { at: Date.now(), config }
  return config
}
export function invalidateBudgetConfig() {
  cached = null
}

// The billing month's time zone (UTC until an admin sets one).
export async function budgetTimeZone(email, token) {
  try {
    return (await loadBudgetConfig(email, token)).settings.timezone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// ---- per-user resolution ----------------------------------------------------------
// Resolves the caller's budget. SCIM (/Me, with the user's own token) is only
// called when a group rule exists; if it fails, group rules can't apply and the
// result falls back to the user rule / default — flagged groupCheck:'unavailable'.
export async function resolveUserBudget(email, token) {
  const config = await loadBudgetConfig(email, token)
  const { settings, rules } = config
  if (!settings.enabled) return { settings, budget: null, groupCheck: null }
  const hasGroupRules = rules.some((r) => r.kind === 'group')
  const groups = hasGroupRules ? await userGroups(email, token) : new Set()
  const groupCheck = hasGroupRules ? groupCheckStatus() : null
  return { settings, budget: effectiveBudget({ settings, rules, email, groups }), groupCheck }
}

// Snapshot of the last effective budget per user, for the admin's monthly
// table. Written only when it changed or every 10 min, never on the hot path.
const lastSnapshot = new Map() // email -> { key, at }
function snapshot(email, token, budget) {
  const key = budget ? `${budget.limitUsd}|${budget.source.kind}|${budget.source.principal || ''}` : 'none'
  const prev = lastSnapshot.get(email)
  if (prev && prev.key === key && Date.now() - prev.at < 10 * 60 * 1000) return
  lastSnapshot.set(email, { key, at: Date.now() })
  saveBudgetSnapshot(email, token, {
    effectiveUsd: budget?.limitUsd ?? null,
    sourceKind: budget?.source.kind ?? null,
    sourcePrincipal: budget?.source.principal ?? null,
  }).catch((e) => console.warn('budget snapshot failed:', e.message))
}

// What the taxímetro shows next to the month's spend (null = budgets off).
export async function budgetForSummary(email, token, spentUsd) {
  const { settings, budget, groupCheck } = await resolveUserBudget(email, token)
  if (!settings.enabled) return null
  snapshot(email, token, budget)
  if (!budget) return null
  return {
    limitUsd: budget.limitUsd,
    remainingUsd: Math.max(0, budget.limitUsd - spentUsd),
    pct: budget.limitUsd > 0 ? (spentUsd / budget.limitUsd) * 100 : 100,
    source: budget.source,
    warnPct: settings.warnPct,
    enforcement: settings.enforcement,
    state: budgetState(spentUsd, budget.limitUsd, settings.warnPct),
    groupCheck,
  }
}

// Pre-turn gate. Returns null when the caller may proceed, else the details of
// the exceeded budget. Only the `block` mode ever stops anyone; it is a soft
// cap — a turn already running finishes, the NEXT one is refused. A failure to
// evaluate fails OPEN (logged): a DB hiccup must not lock the org out.
export async function checkBudget(email, token) {
  try {
    const { settings, budget } = await resolveUserBudget(email, token)
    if (!settings.enabled || settings.enforcement !== 'block' || !budget) return null
    const { end, start } = monthWindow(settings.timezone)
    const spentUsd = await monthSpend(email, token, start)
    if (spentUsd < budget.limitUsd) return null
    return { limitUsd: budget.limitUsd, spentUsd, resetsAt: end.toISOString(), timezone: settings.timezone }
  } catch (e) {
    console.warn('budget check failed (allowing):', e.message)
    return null
  }
}
