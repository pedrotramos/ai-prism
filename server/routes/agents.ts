// Scheduled agents, the owner's side (W4-4d). Design: .megabrain/parity-ux/design-w4.md §1.7.
//
//   GET    /api/agents/status          any user  { enabled, reason?: 'env_off' | 'admin_off' }   (the only route open with the env flag off)
//   GET    /api/agents                 owner     { agents, limits }
//   POST   /api/agents                 owner     create a draft → 201 row | 400 {code, field} | 409 agents_limit
//   GET    /api/agents/:id             owner     row | 404
//   PATCH  /api/agents/:id             owner     { revision, ...fields } → row | 400 | 404 | 409 conflict
//   DELETE /api/agents/:id             owner     204 | 404
//   POST   /api/agents/:id/submit      owner     draft/rejected/revoked → pending | 404 | 409 bad_state
//   POST   /api/agents/:id/enable      owner     → row with next_run_at | 404 | 409 not_approved | approval_expired | agents_setting_off | no_schedule
//   POST   /api/agents/:id/disable     owner     → row | 404
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
import { AGENT_LIMITS, validateAgentInput } from '../agents/definition.ts'
import type { DefinitionContext } from '../agents/definition.ts'
import { nextOccurrence } from '../agents/schedule.ts'
import { notifyAgentsChanged } from '../agents/events.ts'
import { getUserModels } from '../models.ts'
import { getMcpCatalog } from '../externalMcp.ts'
import { logger } from '../log.ts'

type Env = Record<string, string | undefined>
type Handler = (req: Request, res: Response) => Promise<unknown>

/** The slice of server/db/agents.ts the owner routes use (injectable for tests). */
export type OwnerAgentsDb = Pick<
  typeof realDb,
  'listAgents' | 'getAgent' | 'createAgent' | 'updateAgent' | 'deleteAgent' | 'submitAgent' | 'setAgentEnabled' | 'queueManualRun' | 'listAgentRuns' | 'readAgentSettings'
>

export interface AgentRouteDeps {
  auth?: RequestHandler
  env?: Env
  now?: () => Date
  db?: OwnerAgentsDb
  /** the catalogs a definition is validated against: the caller's models and the admin MCP catalog */
  context?: (req: Request) => Promise<DefinitionContext>
  notify?: () => void
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

export default function registerAgentRoutes(app: Express, deps: AgentRouteDeps = {}) {
  const auth = deps.auth || realAuth
  const env = deps.env || process.env
  const now = deps.now || (() => new Date())
  const db: OwnerAgentsDb = deps.db || realDb
  const context = deps.context || defaultContext
  const notify = deps.notify || notifyAgentsChanged
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
    const saved = await db.updateAgent(who(req).email, who(req).token, cur.id, { name: v.name, description: v.description, definition: v.definition }, { revision })
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
}
