// Scheduled agents, the owner's side (W4-4d). Design: .megabrain/parity-ux/design-w4.md §1.7.
//
//   GET    /api/agents/status          any user  { enabled, reason?: 'env_off' | 'admin_off' }   (the only route open with the env flag off)
//   POST   /api/agents/schedule-preview owner   { schedule, lang? } → 200 { description, next: [3 ISO instants] } | 400 {code, field} (read-only: no row is read or written)
//   GET    /api/agents/tool-options    owner     { kinds, mcp: [{ref, name, description?}] } what an agent may use (admitted kinds + databricks-class catalog services only) | 500 internal_error
//   GET    /api/agents                 owner     { agents, limits }
//   POST   /api/agents                 owner     create a draft → 201 row | 400 {code, field} | 409 agents_limit
//   GET    /api/agents/:id             owner     row | 404
//   PATCH  /api/agents/:id             owner     { revision, ...fields } → row | 400 | 404 | 409 conflict
//   DELETE /api/agents/:id             owner     204 | 404
//   POST   /api/agents/:id/submit      owner     draft/rejected/revoked → pending | 404 | 409 bad_state
//   POST   /api/agents/:id/enable      owner     → row with next_run_at | 404 | 409 not_approved | approval_expired | agents_setting_off | no_schedule
//   POST   /api/agents/:id/disable     owner     → row | 404
//   GET    /api/agents/shared-with-me  any user  { agents } the newest approved version of each agent others shared with the caller
//   GET    /api/agents/:id/versions    owner     ?before=<version>&limit=<1..100> → { versions, hasMore } | 400 bad_query | 404   (the history, newest first)
//   POST   /api/agents/:id/versions/:version/restore   owner   → the agent, saved as a NEW version with that content | 400 | 404 | 409
//   POST   /api/agents/:id/versions/:version/submit    owner   ask an admin to approve THAT version for sharing → version | 404 | 409 bad_state
//   POST   /api/agents/:id/duplicate   owner/recipient { version?, name? } → 201 a new draft agent with that version's content | 400 | 404 | 409 agents_limit
//   GET    /api/agents/:id/shares      owner     { shares }   (each with the admin's decision on that audience)
//   POST   /api/agents/:id/shares      owner     { version, kind: user|group|app, principal? } → 201 share (a REQUEST: pending until an admin approves the audience for this version) | 400 | 404 | 409 shares_limit
//                                         (inert until the share AND the version are approved; moving an approved audience to an approved version keeps its approval)
//   DELETE /api/agents/:id/shares/:kind/:principal   owner   204 | 404
//   POST   /api/agents/:id/run         owner     queue a manual run → 202 { run } | 404 | 409 busy | not_approved | approval_expired | agents_setting_off
//   GET    /api/agents/:id/runs        owner     ?before=<run id>&limit=<1..100> → { runs } | 400 bad_query | 404
//
// Every route answers 404 agents_disabled unless the operator set AGENTS_ENABLED=1 (status excepted). Access is
// owner-only: the identity is the caller's (auth), every query runs under it (RLS) and a row that is not the caller's
// is a 404 identical to an id that does not exist, never a 403. No field of a body names an owner, a status or an
// approval: validateAgentInput keeps only the definition's own keys. Answers are {error, code} where both are the same
// stable key (the client translates it through its i18n error keys); a thrown message is logged, never sent.
// Nothing here runs an agent: a manual run is queued and the scheduler (W4-4c) picks it up after the in-process hint.
import { authed } from './authed.ts'
import type { Express, Request, RequestHandler, Response } from 'express'
import { auth as realAuth } from '../middleware/auth.ts'
import * as realDb from '../db/agents.ts'
import { AgentsError } from '../db/agents.ts'
import type { AgentRow } from '../db/agents.ts'
import * as realVersions from '../db/agentVersions.ts'
import type { ShareKind } from '../db/agentVersions.ts'
import { normalizePrincipal } from '../access.ts'
import { AGENT_LIMITS, validateAgentInput, withPayloadExtras } from '../agents/definition.ts'
import type { AgentSchedule } from '../agents/definition.ts'
import type { DefinitionContext } from '../agents/definition.ts'
import { nextOccurrence, describeSchedule } from '../agents/schedule.ts'
import { notifyAgentsChanged } from '../agents/events.ts'
import { getUserModels } from '../models.ts'
import { getMcpCatalog, buildMcpCatalog } from '../externalMcp.ts'
import { getToolPolicy, listMcpCatalogRows } from '../db.ts'
import { admitAgentTools, FIXED_TOOL_REFS } from '../scheduler/admission.ts'
import { logger } from '../log.ts'

type Env = Record<string, string | undefined>
type Handler = (req: Request, res: Response) => Promise<unknown>

/** The slice of server/db/agents.ts the owner routes use (injectable for tests). */
export type OwnerAgentsDb = Pick<
  typeof realDb,
  'listAgents' | 'getAgent' | 'createAgent' | 'updateAgent' | 'deleteAgent' | 'submitAgent' | 'setAgentEnabled' | 'queueManualRun' | 'listAgentRuns' | 'readAgentSettings'
>

/** What the tool picker is built from: the org tool policy and the admin MCP catalog as the caller sees it. */
export interface ToolOptionsSource {
  toolPolicy: unknown
  catalog: { connectionName: string; displayName?: string | null; comment?: string | null; credentialClass?: string | null }[]
}

/** The slice of server/db/agentVersions.ts the owner routes use (injectable for tests). */
export type OwnerVersionsDb = Pick<
  typeof realVersions,
  'listAgentVersions' | 'getVersionForUse' | 'listSharedWithMe' | 'submitAgentVersion' | 'listAgentShares' | 'upsertAgentShare' | 'removeAgentShare'
>

export interface AgentRouteDeps {
  auth?: RequestHandler
  env?: Env
  now?: () => Date
  db?: OwnerAgentsDb
  versions?: OwnerVersionsDb
  /** the catalogs a definition is validated against: the caller's models and the admin MCP catalog */
  context?: (req: Request) => Promise<DefinitionContext>
  notify?: () => void
  /** reads the policy and the catalog for GET /api/agents/tool-options; a rejection is a 500, never a partial list */
  toolOptions?: (req: Request) => Promise<ToolOptionsSource>
}

/** True only when the operator turned the feature on in the environment (app.yaml). */
export const agentsEnvOn = (env: Env): boolean => env.AGENTS_ENABLED === '1'

/** An error answer: `error` and `code` are the same stable key, plus optional extra fields (`field`). */
export function sendCode(res: Response, status: number, code: string, extra: Record<string, unknown> = {}) {
  return res.status(status).json({ error: code, code, ...extra })
}

/** A failure of the data layer: a known refusal keeps its status, anything else is a 500 whose text is only logged. */
export function failRoute(res: Response, e: unknown, what: string) {
  if (e instanceof AgentsError) {
    if (e.code === 'agents_limit') return sendCode(res, 409, 'agents_limit')
    if (e.code === 'invalid_setting') return sendCode(res, 400, 'invalid_setting')
  }
  logger.warn(`${what} failed`, { err: e })
  return sendCode(res, 500, 'internal_error')
}

/** Middleware: 404 agents_disabled unless the operator turned agents on. Mount it BEFORE requireAdmin (which may touch the database). */
export function envGate(env: Env): RequestHandler {
  return function agentsEnvGate(_req, res, next) {
    return agentsEnvOn(env) ? next() : sendCode(res, 404, 'agents_disabled')
  }
}

/** Wraps a handler: env flag first (404 agents_disabled, no query), then the failure mapping. */
export function guarded(env: Env, what: string, fn: Handler): RequestHandler {
  return async (req, res) => {
    if (!agentsEnvOn(env)) return sendCode(res, 404, 'agents_disabled')
    try {
      await fn(req, res)
    } catch (e) {
      failRoute(res, e, what)
    }
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
// the definition's own keys a PATCH may name; anything else in a body is dropped
const PATCHABLE = ['name', 'description', 'instructions', 'prompt', 'model', 'reasoningEffort', 'tools', 'schedule', 'lang'] as const

async function defaultContext(req: Request): Promise<DefinitionContext> {
  const who = authed(req)
  const models = new Set((await getUserModels(who)).map((m: { id: string }) => m.id))
  // a catalog that cannot be read refuses every `mcp:` tool (fail closed) instead of failing the whole save
  const entries = await getMcpCatalog(who.email, who.token).catch(() => [])
  return { models, catalog: new Map(entries.map((e) => [e.connectionName, { credentialClass: e.credentialClass ?? null }])) }
}

async function defaultToolOptions(req: Request): Promise<ToolOptionsSource> {
  const who = authed(req)
  // FAIL CLOSED, as W4-4b's run does: the rows are read DIRECTLY (getMcpCatalog swallows a failed read into a cached or
  // empty catalog, which would answer 200 with a partial list). A read error propagates to `guarded` (500 internal_error).
  const [toolPolicy, rows] = await Promise.all([getToolPolicy(who.email, who.token), listMcpCatalogRows(who.email, who.token)])
  const catalog = buildMcpCatalog(rows)
  return { toolPolicy, catalog }
}

export default function registerAgentRoutes(app: Express, deps: AgentRouteDeps = {}) {
  const auth = deps.auth || realAuth
  const env = deps.env || process.env
  const now = deps.now || (() => new Date())
  const db: OwnerAgentsDb = deps.db || realDb
  const versions: OwnerVersionsDb = deps.versions || realVersions
  const context = deps.context || defaultContext
  const notify = deps.notify || notifyAgentsChanged
  const toolOptions = deps.toolOptions || defaultToolOptions
  const route = (what: string, fn: Handler) => guarded(env, what, fn)
  const who = (req: Request) => authed(req)

  /** The caller's own agent, or the one 404 every refusal shares. */
  async function ownAgent(req: Request, res: Response): Promise<AgentRow | null> {
    const row = await db.getAgent(who(req).email, who(req).token, req.params.id as string)
    if (!row) sendCode(res, 404, 'not_found')
    return row
  }
  /** The reason a manual run or an enable is refused for an agent that is not approved, or null when it may go on. */
  const approvalRefusal = (a: AgentRow): string | null => {
    if (a.status !== 'approved') return 'not_approved'
    if (!a.approvalExpiresAt || new Date(a.approvalExpiresAt).getTime() <= now().getTime()) return 'approval_expired'
    return null
  }
  const settingOn = async (req: Request) => (await db.readAgentSettings(who(req).email, who(req).token)).enabled

  // status is open to every signed-in user so the UI can decide whether to show the feature at all
  app.get('/api/agents/status', auth, async (req, res) => {
    if (!agentsEnvOn(env)) return res.json({ enabled: false, reason: 'env_off' })
    try {
      res.json((await settingOn(req)) ? { enabled: true } : { enabled: false, reason: 'admin_off' })
    } catch (e) {
      failRoute(res, e, 'agents status')
    }
  })

  // The editor shows what a schedule means. The occurrences are computed here, from the same functions the scheduler
  // uses, so the browser never does schedule or time-zone math. It touches no row and no catalog.
  app.post('/api/agents/schedule-preview', auth, route('agents schedule preview', async (req, res) => {
    const body = isObj(req.body) ? req.body : {}
    // the schedule goes through the same validation a saved definition does (same codes), with a minimal valid shell around it
    const v = validateAgentInput(
      { name: 'preview', description: '', instructions: '', prompt: 'preview', model: 'preview', reasoningEffort: null, tools: [], schedule: body.schedule ?? null, lang: 'en' },
      { models: new Set(['preview']), catalog: new Map() },
    )
    if (!v.ok) return sendCode(res, 400, v.code, { field: v.field })
    const schedule: AgentSchedule | null = v.definition.schedule
    if (!schedule) return sendCode(res, 400, 'schedule_invalid', { field: 'schedule' })
    const lang = body.lang === 'pt' || body.lang === 'es' ? body.lang : 'en'
    const next: string[] = []
    let at = now()
    for (let i = 0; i < 3; i++) {
      at = nextOccurrence(schedule, at)
      next.push(at.toISOString())
    }
    res.json({ description: describeSchedule(schedule, lang), next })
  }))

  // What an owner may put on an agent, from the same admission rules a run is checked with (admitAgentTools): the
  // fixed kinds the org policy leaves on, and catalog MCP services of class `databricks` only. Never a personal
  // connection, never per_user/shared/unverified. Registered before /:id so "tool-options" is not read as an id.
  app.get('/api/agents/tool-options', auth, route('agents tool options', async (req, res) => {
    const { toolPolicy, catalog } = await toolOptions(req)
    const admitted = (tool: string) => admitAgentTools({ tools: [tool as never] }, { toolPolicy, catalog: new Map(catalog.map((e) => [e.connectionName, { credentialClass: e.credentialClass ?? null }])) }).ok
    const kinds = (Object.keys(FIXED_TOOL_REFS) as string[]).filter(admitted)
    const mcp = catalog
      .filter((e) => e.credentialClass === 'databricks' && admitted(`mcp:${e.connectionName}`))
      .map((e) => ({ ref: `mcp:${e.connectionName}`, name: e.displayName || e.connectionName, ...(e.comment ? { description: e.comment } : {}) }))
    res.json({ kinds, mcp })
  }))

  // The versions of an agent (migration 0017). Registered before /:id so "shared-with-me" is not read as an id.
  app.get('/api/agents/shared-with-me', auth, route('agents shared with me', async (req, res) => {
    res.json({ agents: await versions.listSharedWithMe(who(req).email, who(req).token) })
  }))

  app.get('/api/agents', auth, route('agents list', async (req, res) => {
    res.json({ agents: await db.listAgents(who(req).email, who(req).token), limits: AGENT_LIMITS })
  }))

  app.post('/api/agents', auth, route('agents create', async (req, res) => {
    const v = validateAgentInput(req.body, await context(req))
    if (!v.ok) return sendCode(res, 400, v.code, { field: v.field })
    res.status(201).json(await db.createAgent(who(req).email, who(req).token, { name: v.name, description: v.description, definition: v.definition }))
  }))

  app.get('/api/agents/:id', auth, route('agents get', async (req, res) => {
    const row = await ownAgent(req, res)
    if (row) res.json(row)
  }))

  app.patch('/api/agents/:id', auth, route('agents update', async (req, res) => {
    const body = isObj(req.body) ? req.body : {}
    const revision = body.revision
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return sendCode(res, 400, 'revision_required')
    const cur = await ownAgent(req, res)
    if (!cur) return
    // the saved agent with the named fields replaced, validated as a whole (a half-edit never reaches the database)
    const merged: Record<string, unknown> = { name: cur.name, description: cur.description, ...cur.definition }
    for (const k of PATCHABLE) if (k in body) merged[k] = body[k]
    const v = validateAgentInput(merged, await context(req))
    if (!v.ok) return sendCode(res, 400, v.code, { field: v.field })
    const saved = await db.updateAgent(who(req).email, who(req).token, cur.id, { name: v.name, description: v.description, definition: withPayloadExtras(v.definition, cur.definition) }, { revision })
    if (saved === null) return sendCode(res, 404, 'not_found')
    if (saved === 'conflict') return sendCode(res, 409, 'conflict')
    // an edit in the approval scope turned an enabled agent off: tell the scheduler
    if (saved.status !== cur.status || saved.enabled !== cur.enabled) notify()
    res.json(saved)
  }))

  app.delete('/api/agents/:id', auth, route('agents delete', async (req, res) => {
    if (!(await db.deleteAgent(who(req).email, who(req).token, req.params.id as string))) return sendCode(res, 404, 'not_found')
    notify()
    res.status(204).end()
  }))

  app.post('/api/agents/:id/submit', auth, route('agents submit', async (req, res) => {
    if (!(await ownAgent(req, res))) return
    const row = await db.submitAgent(who(req).email, who(req).token, req.params.id as string)
    if (!row) return sendCode(res, 409, 'bad_state')
    res.json(row)
  }))

  app.post('/api/agents/:id/enable', auth, route('agents enable', async (req, res) => {
    const cur = await ownAgent(req, res)
    if (!cur) return
    const refusal = approvalRefusal(cur)
    if (refusal) return sendCode(res, 409, refusal)
    if (!(await settingOn(req))) return sendCode(res, 409, 'agents_setting_off')
    const schedule = cur.definition.schedule
    if (!schedule) return sendCode(res, 409, 'no_schedule')
    let next: Date
    try {
      next = nextOccurrence(schedule, now())
    } catch {
      return sendCode(res, 409, 'no_schedule')
    }
    const row = await db.setAgentEnabled(who(req).email, who(req).token, cur.id, true, next)
    // the database refused (approval moved since the read): the same answer as a draft
    if (!row) return sendCode(res, 409, 'not_approved')
    notify()
    res.json(row)
  }))

  app.post('/api/agents/:id/disable', auth, route('agents disable', async (req, res) => {
    const row = await db.setAgentEnabled(who(req).email, who(req).token, req.params.id as string, false, null)
    if (!row) return sendCode(res, 404, 'not_found')
    notify()
    res.json(row)
  }))

  app.post('/api/agents/:id/run', auth, route('agents run', async (req, res) => {
    const cur = await ownAgent(req, res)
    if (!cur) return
    const refusal = approvalRefusal(cur)
    if (refusal) return sendCode(res, 409, refusal)
    if (!(await settingOn(req))) return sendCode(res, 409, 'agents_setting_off')
    const run = await db.queueManualRun(who(req).email, who(req).token, cur.id)
    if (run === 'busy') return sendCode(res, 409, 'busy')
    if (!run) return sendCode(res, 409, 'not_approved')
    notify()
    res.status(202).json({ run })
  }))

  app.get('/api/agents/:id/runs', auth, route('agents runs', async (req, res) => {
    const { before, limit } = req.query
    if (before !== undefined && !(typeof before === 'string' && /^\d{1,18}$/.test(before))) return sendCode(res, 400, 'bad_query')
    if (limit !== undefined && !(typeof limit === 'string' && /^\d{1,4}$/.test(limit) && Number(limit) >= 1)) return sendCode(res, 400, 'bad_query')
    if (!(await ownAgent(req, res))) return
    const o: { before?: string; limit?: number } = {}
    if (typeof before === 'string') o.before = before
    if (typeof limit === 'string') o.limit = Number(limit)
    res.json({ runs: await db.listAgentRuns(who(req).email, who(req).token, req.params.id as string, o) })
  }))

  /** A version number from the path, or null. */
  const versionParam = (v: unknown): number | null => (typeof v === 'string' && /^\d{1,9}$/.test(v) && Number(v) >= 1 ? Number(v) : null)

  app.get('/api/agents/:id/versions', auth, route('agents versions', async (req, res) => {
    const { before, limit } = req.query
    if (before !== undefined && versionParam(before) === null) return sendCode(res, 400, 'bad_query')
    if (limit !== undefined && !(typeof limit === 'string' && /^\d{1,4}$/.test(limit) && Number(limit) >= 1)) return sendCode(res, 400, 'bad_query')
    const o: { before?: number; limit?: number } = {}
    if (typeof before === 'string') o.before = Number(before)
    if (typeof limit === 'string') o.limit = Number(limit)
    const out = await versions.listAgentVersions(who(req).email, who(req).token, req.params.id as string, o)
    if (!out) return sendCode(res, 404, 'not_found')
    res.json(out)
  }))

  // Restore = save the content of an old version as a NEW version (history is never rewritten). The content goes through the
  // same validation as a save, against today's catalogs: a model or a tool that is gone cannot come back through a restore.
  app.post('/api/agents/:id/versions/:version/restore', auth, route('agents restore', async (req, res) => {
    const v = versionParam(req.params.version)
    if (v === null) return sendCode(res, 400, 'invalid_version')
    const cur = await ownAgent(req, res)
    if (!cur) return
    const src = await versions.getVersionForUse(who(req).email, who(req).token, cur.id, v)
    if (!src || src.ownerEmail !== who(req).email) return sendCode(res, 404, 'not_found')
    const val = validateAgentInput({ name: src.name, description: src.description, ...src.definition }, await context(req))
    if (!val.ok) return sendCode(res, 400, val.code, { field: val.field })
    const saved = await db.updateAgent(who(req).email, who(req).token, cur.id, { name: val.name, description: val.description, definition: withPayloadExtras(val.definition, src.definition) }, { revision: cur.revision, origin: { kind: 'restore', agentId: cur.id, version: v } })
    if (saved === null) return sendCode(res, 404, 'not_found')
    if (saved === 'conflict') return sendCode(res, 409, 'conflict')
    if (saved.status !== cur.status || saved.enabled !== cur.enabled) notify()
    res.json(saved)
  }))

  app.post('/api/agents/:id/versions/:version/submit', auth, route('agents version submit', async (req, res) => {
    const v = versionParam(req.params.version)
    if (v === null) return sendCode(res, 400, 'invalid_version')
    if (!(await ownAgent(req, res))) return
    const row = await versions.submitAgentVersion(who(req).email, who(req).token, req.params.id as string, v)
    if (!row) return sendCode(res, 409, 'bad_state')
    res.json(row)
  }))

  // A copy of a version as a new draft agent of the caller. The owner copies any of her own versions; a recipient copies the
  // approved version shared with her (the database lets her read nothing else, so the same lookup serves both). The copy is
  // validated against the CALLER's catalogs and counts against her limit; it needs its own approval like any agent.
  app.post('/api/agents/:id/duplicate', auth, route('agents duplicate', async (req, res) => {
    const body = isObj(req.body) ? req.body : {}
    let v: number | null = null
    if (body.version !== undefined) {
      if (typeof body.version !== 'number' || !Number.isInteger(body.version) || body.version < 1) return sendCode(res, 400, 'invalid_version')
      v = body.version
    }
    const src = await versions.getVersionForUse(who(req).email, who(req).token, req.params.id as string, v)
    if (!src) return sendCode(res, 404, 'not_found')
    const asked = typeof body.name === 'string' ? body.name.trim() : ''
    const name = (asked || `${src.name} (copy)`).slice(0, AGENT_LIMITS.nameMax)
    const val = validateAgentInput({ name, description: src.description, ...src.definition }, await context(req))
    if (!val.ok) return sendCode(res, 400, val.code, { field: val.field })
    const kind = src.ownerEmail === who(req).email ? 'duplicate' : 'shared'
    const row = await db.createAgent(who(req).email, who(req).token, { name: val.name, description: val.description, definition: withPayloadExtras(val.definition, src.definition) }, { kind, agentId: src.agentId, version: src.version })
    res.status(201).json(row)
  }))

  app.get('/api/agents/:id/shares', auth, route('agents shares', async (req, res) => {
    const shares = await versions.listAgentShares(who(req).email, who(req).token, req.params.id as string)
    if (!shares) return sendCode(res, 404, 'not_found')
    res.json({ shares })
  }))

  app.post('/api/agents/:id/shares', auth, route('agents share', async (req, res) => {
    const body = isObj(req.body) ? req.body : {}
    if (typeof body.version !== 'number' || !Number.isInteger(body.version) || body.version < 1) return sendCode(res, 400, 'invalid_version')
    const kind = body.kind
    if (kind !== 'user' && kind !== 'group' && kind !== 'app') return sendCode(res, 400, 'invalid_kind')
    const principal = kind === 'app' ? '*' : normalizePrincipal(kind, body.principal)
    if (!principal) return sendCode(res, 400, 'invalid_principal')
    const out = await versions.upsertAgentShare(who(req).email, who(req).token, req.params.id as string, { version: body.version, kind: kind as ShareKind, principal })
    if (out === null || out === 'no_version') return sendCode(res, 404, 'not_found')
    if (out === 'limit') return sendCode(res, 409, 'shares_limit')
    res.status(201).json(out)
  }))

  app.delete('/api/agents/:id/shares/:kind/:principal', auth, route('agents unshare', async (req, res) => {
    const kind = req.params.kind
    if (kind !== 'user' && kind !== 'group' && kind !== 'app') return sendCode(res, 400, 'invalid_kind')
    const principal = kind === 'app' ? '*' : normalizePrincipal(kind, req.params.principal)
    if (!principal) return sendCode(res, 400, 'invalid_principal')
    if (!(await versions.removeAgentShare(who(req).email, who(req).token, req.params.id as string, kind as ShareKind, principal))) return sendCode(res, 404, 'not_found')
    res.status(204).end()
  }))
}
