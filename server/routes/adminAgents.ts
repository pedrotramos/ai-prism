// Scheduled agents, the administrator's side (W4-4d). Design: .megabrain/parity-ux/design-w4.md §1.7 and §1.8.
//
//   GET  /api/admin/agents?status=pending     { agents }  every owner's agents with the hash the admin is about to approve
//                                             (`currentHash`) and, per tool, the identity it runs as (`toolIdentities`)
//   POST /api/admin/agents/:id/approve        { expectedHash, days? } → row | 400 | 404 | 409 stale
//   POST /api/admin/agents/:id/reject         { reason } → row | 400 reason_required | 404 | 409 stale
//   POST /api/admin/agents/:id/revoke         { reason? } → row | 404 | 409 stale
//   GET  /api/admin/agent-versions?status=&limit=&offset=  { versions, hasMore } the review queue, paged in SQL. No status = what needs a
//                                             decision (versions waiting for approval, approved versions with an audience waiting or live),
//                                             requests first; a status = the versions in that status
//   POST /api/admin/agent-versions/:id/:version/approve  { expectedHash } → version | 400 | 404 | 409 stale
//   POST /api/admin/agent-versions/:id/:version/reject   { reason } → version | 400 reason_required | 404 | 409
//   POST /api/admin/agent-versions/:id/:version/revoke   { reason? } → version | 404 | 409   (unshares: the read policy needs an approved version)
//   POST /api/admin/agent-shares/:id/:kind/:principal/approve  { expectedVersion } → share | 400 | 404 | 409 stale | version_not_approved
//   POST /api/admin/agent-shares/:id/:kind/:principal/reject   { expectedVersion, reason } → share | 400 reason_required | 404 | 409
//   POST /api/admin/agent-shares/:id/:kind/:principal/revoke   { expectedVersion, reason? } → share | 404 | 409   (the audience: approved by the admin, pinned to that version)
//   GET  /api/admin/agents/settings           { enabled, maxRunCostUsd, approvalDays, ranges }
//   PUT  /api/admin/agents/settings           { enabled?, maxRunCostUsd?, approvalDays? } → the stored settings | 400 invalid_setting
//
// Same env flag as the owner routes (404 agents_disabled). Every route sits behind auth + requireAdmin: req.isAdmin is
// set there and nowhere else, and the data functions open the admin flag themselves, so no field of a body can grant
// it. The admin's identity for the audit is the caller's (req.email), never a body field. A decision is ONE call to
// decideAgent, which writes the decision and its admin_audit row in one transaction (a stale hash writes neither); a
// settings change is ONE call to writeAgentSettings (value + audit row). Answers are {error, code} with a stable key.
import { authed } from './authed.ts'
import type { Express, RequestHandler } from 'express'
import { auth as realAuth } from '../middleware/auth.ts'
import { requireAdmin as realRequireAdmin } from '../middleware/requireAdmin.ts'
import * as realDb from '../db/agents.ts'
import { AGENT_SETTING_RANGES } from '../db/agents.ts'
import type { AdminAgentRow, AgentStatus } from '../db/agents.ts'
import * as realVersions from '../db/agentVersions.ts'
import type { AdminVersionRow } from '../db/agentVersions.ts'
import { notifyAgentsChanged } from '../agents/events.ts'
import { normalizePrincipal } from '../access.ts'
import { envGate, guarded, sendCode } from './agents.ts'

type Env = Record<string, string | undefined>

/** The slice of server/db/agents.ts the admin routes use (injectable for tests). */
export type AdminAgentsDb = Pick<typeof realDb, 'listAgentsForReview' | 'decideAgent' | 'readAgentSettings' | 'writeAgentSettings'>

export type AdminVersionsDb = Pick<typeof realVersions, 'listVersionsForReview' | 'decideAgentVersion' | 'decideAgentShare'>

export interface AdminAgentRouteDeps {
  auth?: RequestHandler
  requireAdmin?: RequestHandler
  env?: Env
  db?: AdminAgentsDb
  versions?: AdminVersionsDb
  notify?: () => void
}

const STATUSES: ReadonlySet<string> = new Set(['draft', 'pending', 'approved', 'rejected', 'revoked'])
const SETTING_KEYS = ['enabled', 'maxRunCostUsd', 'approvalDays'] as const

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * What the approval screen shows per tool. An unattended run is the app's service principal for the gateway and every
 * tool; `readsWorkspaceData` marks the ones that read Unity Catalog data with the SERVICE PRINCIPAL's grants, not the
 * owner's (Genie One and a catalog MCP service of class `databricks`): see docs/agents.md.
 */
function withToolIdentities<T extends AdminAgentRow | AdminVersionRow>(row: T) {
  const toolIdentities = row.definition.tools.map((tool) => ({ tool, runsAs: 'app_service_principal', readsWorkspaceData: tool === 'genie_one' || tool.startsWith('mcp:') }))
  return { ...row, toolIdentities }
}

export default function registerAdminAgentRoutes(app: Express, deps: AdminAgentRouteDeps = {}) {
  const auth = deps.auth || realAuth
  const requireAdmin = deps.requireAdmin || realRequireAdmin
  const env = deps.env || process.env
  const db: AdminAgentsDb = deps.db || realDb
  const versions: AdminVersionsDb = deps.versions || realVersions
  const notify = deps.notify || notifyAgentsChanged
  // the disabled-flag answer comes before requireAdmin (and its ensureReady): a non-admin gets 404 too, and no query runs
  const gate = envGate(env)

  const settingsAnswer = async (email: string, token: string) => ({ ...(await db.readAgentSettings(email, token)), ranges: AGENT_SETTING_RANGES })

  app.get('/api/admin/agents', auth, gate, requireAdmin, guarded(env, 'agents review list', async (req, res) => {
    const status = req.query.status
    if (status !== undefined && !(typeof status === 'string' && STATUSES.has(status))) return sendCode(res, 400, 'bad_status')
    const rows = await db.listAgentsForReview(authed(req).email, authed(req).token, status === undefined ? {} : { status: status as AgentStatus })
    res.json({ agents: rows.map(withToolIdentities) })
  }))

  app.get('/api/admin/agents/settings', auth, gate, requireAdmin, guarded(env, 'agents settings read', async (req, res) => {
    res.json(await settingsAnswer(authed(req).email, authed(req).token))
  }))

  app.put('/api/admin/agents/settings', auth, gate, requireAdmin, guarded(env, 'agents settings write', async (req, res) => {
    const body = req.body
    const keys = isObj(body) ? Object.keys(body) : []
    if (!isObj(body) || !keys.length || keys.some((k) => !(SETTING_KEYS as readonly string[]).includes(k))) return sendCode(res, 400, 'invalid_setting')
    const patch: Partial<{ enabled: boolean; maxRunCostUsd: number; approvalDays: number }> = {}
    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') return sendCode(res, 400, 'invalid_setting')
      patch.enabled = body.enabled
    }
    for (const k of ['maxRunCostUsd', 'approvalDays'] as const) {
      if (!(k in body)) continue
      if (typeof body[k] !== 'number') return sendCode(res, 400, 'invalid_setting')
      patch[k] = body[k] as number
    }
    // the range check and the audit row are the data function's: one transaction, validated before any write
    await db.writeAgentSettings(authed(req).email, authed(req).token, patch)
    notify()
    res.json(await settingsAnswer(authed(req).email, authed(req).token))
  }))

  /** Runs one decision and answers it. `stale` (the hash or the state moved) is 409 and writes nothing. */
  async function decide(
    req: Parameters<RequestHandler>[0],
    res: Parameters<RequestHandler>[1],
    d: { decision: 'approve' | 'reject' | 'revoke'; expectedHash: string; reason?: string; days?: number }
  ) {
    const out = await db.decideAgent(authed(req).email, authed(req).token, req.params.id as string, d)
    if (out === null) return sendCode(res, 404, 'not_found')
    if (out === 'stale') return sendCode(res, 409, 'stale')
    notify()
    res.json(withToolIdentities(out))
  }

  app.post('/api/admin/agents/:id/approve', auth, gate, requireAdmin, guarded(env, 'agents approve', async (req, res) => {
    const body = isObj(req.body) ? req.body : {}
    if (typeof body.expectedHash !== 'string' || !body.expectedHash) return sendCode(res, 400, 'expected_hash_required')
    const d: { decision: 'approve'; expectedHash: string; days?: number } = { decision: 'approve', expectedHash: body.expectedHash }
    if (body.days !== undefined) {
      const [lo, hi] = AGENT_SETTING_RANGES.approvalDays
      if (typeof body.days !== 'number' || !Number.isInteger(body.days) || body.days < lo || body.days > hi) return sendCode(res, 400, 'invalid_days')
      d.days = body.days
    }
    await decide(req, res, d)
  }))

  app.post('/api/admin/agents/:id/reject', auth, gate, requireAdmin, guarded(env, 'agents reject', async (req, res) => {
    const body = isObj(req.body) ? req.body : {}
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) return sendCode(res, 400, 'reason_required')
    await decide(req, res, { decision: 'reject', expectedHash: typeof body.expectedHash === 'string' ? body.expectedHash : '', reason })
  }))

  app.post('/api/admin/agents/:id/revoke', auth, gate, requireAdmin, guarded(env, 'agents revoke', async (req, res) => {
    const body = isObj(req.body) ? req.body : {}
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    await decide(req, res, { decision: 'revoke', expectedHash: typeof body.expectedHash === 'string' ? body.expectedHash : '', ...(reason ? { reason } : {}) })
  }))

  // ---- versions: the sharing approval of ONE saved version ---------------------------------------------------------
  app.get('/api/admin/agent-versions', auth, gate, requireAdmin, guarded(env, 'agent versions review list', async (req, res) => {
    const status = req.query.status
    if (status !== undefined && !(typeof status === 'string' && STATUSES.has(status))) return sendCode(res, 400, 'bad_status')
    const { limit, offset } = req.query
    if (limit !== undefined && !(typeof limit === 'string' && /^\d{1,4}$/.test(limit) && Number(limit) >= 1)) return sendCode(res, 400, 'bad_query')
    if (offset !== undefined && !(typeof offset === 'string' && /^\d{1,6}$/.test(offset))) return sendCode(res, 400, 'bad_query')
    const o: { status?: AgentStatus; limit?: number; offset?: number } = {}
    if (status !== undefined) o.status = status as AgentStatus
    if (typeof limit === 'string') o.limit = Number(limit)
    if (typeof offset === 'string') o.offset = Number(offset)
    const page = await versions.listVersionsForReview(authed(req).email, authed(req).token, o)
    res.json({ versions: page.versions.map(withToolIdentities), hasMore: page.hasMore })
  }))

  async function decideVersion(
    req: Parameters<RequestHandler>[0],
    res: Parameters<RequestHandler>[1],
    d: { decision: 'approve' | 'reject' | 'revoke'; expectedHash: string; reason?: string }
  ) {
    const v = typeof req.params.version === 'string' && /^\d{1,9}$/.test(req.params.version) ? Number(req.params.version) : 0
    if (v < 1) return sendCode(res, 400, 'invalid_version')
    const out = await versions.decideAgentVersion(authed(req).email, authed(req).token, req.params.id as string, v, d)
    if (out === null) return sendCode(res, 404, 'not_found')
    if (out === 'stale') return sendCode(res, 409, 'stale')
    res.json(withToolIdentities(out))
  }

  app.post('/api/admin/agent-versions/:id/:version/approve', auth, gate, requireAdmin, guarded(env, 'agent version approve', async (req, res) => {
    const body = isObj(req.body) ? req.body : {}
    if (typeof body.expectedHash !== 'string' || !body.expectedHash) return sendCode(res, 400, 'expected_hash_required')
    await decideVersion(req, res, { decision: 'approve', expectedHash: body.expectedHash })
  }))

  app.post('/api/admin/agent-versions/:id/:version/reject', auth, gate, requireAdmin, guarded(env, 'agent version reject', async (req, res) => {
    const body = isObj(req.body) ? req.body : {}
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) return sendCode(res, 400, 'reason_required')
    await decideVersion(req, res, { decision: 'reject', expectedHash: typeof body.expectedHash === 'string' ? body.expectedHash : '', reason })
  }))

  app.post('/api/admin/agent-versions/:id/:version/revoke', auth, gate, requireAdmin, guarded(env, 'agent version revoke', async (req, res) => {
    const body = isObj(req.body) ? req.body : {}
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    await decideVersion(req, res, { decision: 'revoke', expectedHash: typeof body.expectedHash === 'string' ? body.expectedHash : '', ...(reason ? { reason } : {}) })
  }))

  // ---- shares: the admin approves the AUDIENCE of a version (who may read it), pinned to that version ------------------
  async function decideShare(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], d: { decision: 'approve' | 'reject' | 'revoke'; reason?: string }) {
    const body = isObj(req.body) ? req.body : {}
    const expectedVersion = body.expectedVersion
    if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) return sendCode(res, 400, 'invalid_version')
    const kind = req.params.kind
    if (kind !== 'user' && kind !== 'group' && kind !== 'app') return sendCode(res, 400, 'invalid_kind')
    const principal = kind === 'app' ? '*' : normalizePrincipal(kind, req.params.principal)
    if (!principal) return sendCode(res, 400, 'invalid_principal')
    const out = await versions.decideAgentShare(authed(req).email, authed(req).token, req.params.id as string, { kind, principal }, { ...d, expectedVersion })
    if (out === null) return sendCode(res, 404, 'not_found')
    if (out === 'stale') return sendCode(res, 409, 'stale')
    if (out === 'version_not_approved') return sendCode(res, 409, 'version_not_approved')
    res.json(out)
  }

  app.post('/api/admin/agent-shares/:id/:kind/:principal/approve', auth, gate, requireAdmin, guarded(env, 'agent share approve', async (req, res) => {
    await decideShare(req, res, { decision: 'approve' })
  }))

  app.post('/api/admin/agent-shares/:id/:kind/:principal/reject', auth, gate, requireAdmin, guarded(env, 'agent share reject', async (req, res) => {
    const body = isObj(req.body) ? req.body : {}
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) return sendCode(res, 400, 'reason_required')
    await decideShare(req, res, { decision: 'reject', reason })
  }))

  app.post('/api/admin/agent-shares/:id/:kind/:principal/revoke', auth, gate, requireAdmin, guarded(env, 'agent share revoke', async (req, res) => {
    const body = isObj(req.body) ? req.body : {}
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    await decideShare(req, res, { decision: 'revoke', ...(reason ? { reason } : {}) })
  }))
}
