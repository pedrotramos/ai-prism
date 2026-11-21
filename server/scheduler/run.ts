// One unattended run of an approved agent (W4-4b): from a claimed run to a RunOutcome, with no browser.
//
// Identity (design §1.6): the model and the tools run as the app's service principal (`withRunIdentity` wraps the
// whole run, so no layer below can forget it), the data the run writes goes through the OWNER's RLS identity, and
// the spend lands on the owner's meter as kind 'scheduled' (`runWithUsageScope`). The caller (the scheduler, W4-4c)
// owns the claim, the lease row and the final bookkeeping; this function never writes agent_runs. It never stores or
// returns a message text: an outcome carries codes and ids only (LibreChat rule, design §1.8).
//
// Error codes (§1.8). Permanent (the scheduler disables the schedule at once): PERMANENT_RUN_ERRORS. Transient (they
// count toward the consecutive-failure threshold): sp_unavailable, gateway_error, timeout, lease_lost, lease_expired,
// db_error. Neither: cost_cap (the answer so far is committed with a notice) and shutdown (cancelled).
import { approvalHash } from '../agents/definition.ts'
import type { AgentDefinition } from '../agents/definition.ts'
import { getAgent } from '../db/agents.ts'
import { appServiceToken, createSession, addMessage, getToolPolicy } from '../db.ts'
import { getMcpCatalog } from '../externalMcp.ts'
import { getUserModels } from '../models.ts'
import { currentRunAs, withRunIdentity } from '../runIdentity.ts'
import { runTurnHeadless } from '../turn.ts'
import type { HeadlessTurnInput, HeadlessTurnResult } from '../turn.ts'
import { runWithUsageScope } from '../usage.ts'
import { logger } from '../log.ts'
import { admitAgentTools } from './admission.ts'
import type { AdmissionContext } from './admission.ts'

export interface ClaimedRun {
  runId: string
  agentId: string
  agentName: string
  ownerEmail: string
  trigger: 'schedule' | 'manual'
  slotAt: string
  approvalHash: string
  /** the approved snapshot (never the live row) */
  definition: AgentDefinition
  instanceId: string
}

export interface RunOutcome {
  status: 'succeeded' | 'failed' | 'cancelled'
  errorCode: string | null
  sessionId: string | null
  messageId: string | null
  costUsd: number | null
  unpriced: boolean
  toolNames: string[]
}

/** disable the schedule at once (§1.8) */
export const PERMANENT_RUN_ERRORS: ReadonlySet<string> = new Set([
  'approval_expired',
  'approval_changed',
  'tool_not_admitted',
  'model_not_allowed',
  'sp_model_denied',
  'sp_no_user_credentials',
  'sp_permission_denied',
])
/** count toward the consecutive-failure threshold */
export const TRANSIENT_RUN_ERRORS: ReadonlySet<string> = new Set(['sp_unavailable', 'gateway_error', 'timeout', 'lease_lost', 'lease_expired', 'db_error'])
/** neither disable nor count */
export const NEUTRAL_RUN_ERRORS: ReadonlySet<string> = new Set(['cost_cap', 'shutdown'])
const KNOWN_CODES: ReadonlySet<string> = new Set([...PERMANENT_RUN_ERRORS, ...TRANSIENT_RUN_ERRORS, ...NEUTRAL_RUN_ERRORS])

/** a model with no price is capped by tokens instead (§1.9) */
export const UNPRICED_TOKEN_CAP = 200_000
const DEFAULT_HEARTBEAT_MS = 30_000
const LEASE_MISSES_TO_ABORT = 2

export interface AgentReadiness {
  status: string
  approvalExpiresAt: string | null
  definition: AgentDefinition
}

/** Everything the run reads or writes outside the turn, injectable for tests. */
export interface RunDeps {
  spToken: () => Promise<string | null>
  /** the owner's live agent row, read through the owner's RLS identity */
  readAgent: (ownerEmail: string, spToken: string, agentId: string) => Promise<AgentReadiness | null>
  admissionContext: (ownerEmail: string, spToken: string) => Promise<AdmissionContext>
  modelAllowed: (ownerEmail: string, spToken: string, model: string) => Promise<boolean>
  createSession: (ownerEmail: string, spToken: string, o: { title: string; model: string; systemPrompt: string }) => Promise<string>
  addUserMessage: (ownerEmail: string, spToken: string, o: { sessionId: string; content: string }) => Promise<void>
  runTurn: (input: HeadlessTurnInput) => Promise<HeadlessTurnResult>
  /** the lease heartbeat (W4-4c wires it to renewLease); absent = the caller renews the lease itself */
  renewLease?: (run: ClaimedRun) => Promise<boolean>
  heartbeatMs: number
  now: () => number
}

const defaultDeps: RunDeps = {
  spToken: () => appServiceToken().catch(() => null),
  readAgent: async (ownerEmail, spToken, agentId) => {
    const a = await getAgent(ownerEmail, spToken, agentId)
    return a ? { status: a.status, approvalExpiresAt: a.approvalExpiresAt, definition: a.definition } : null
  },
  admissionContext: async (ownerEmail, spToken) => {
    const [toolPolicy, entries] = await Promise.all([getToolPolicy(ownerEmail, spToken).catch(() => ({})), getMcpCatalog(ownerEmail, spToken).catch(() => [])])
    return { toolPolicy, catalog: new Map(entries.map((e) => [e.connectionName, { credentialClass: e.credentialClass ?? null }])) }
  },
  modelAllowed: async (ownerEmail, spToken, model) => {
    const list = await getUserModels({ email: ownerEmail, token: spToken })
    return list.some((m: { id: string }) => m.id === model)
  },
  createSession: async (ownerEmail, spToken, o) => String(await createSession(ownerEmail, spToken, o.title, o.model, o.systemPrompt, [])),
  addUserMessage: async (ownerEmail, spToken, o) => {
    await addMessage(ownerEmail, spToken, { sessionId: o.sessionId, role: 'user', content: o.content, attachments: null })
  },
  runTurn: runTurnHeadless,
  heartbeatMs: DEFAULT_HEARTBEAT_MS,
  now: () => Date.now(),
}

class RunError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

/** A failure's stable code. Anything not in the §1.8 vocabulary (a tool's or a driver's own text) becomes a generic one. */
function codeOf(e: unknown): string {
  const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : ''
  if (KNOWN_CODES.has(code)) return code
  if (/^[0-9A-Z]{5}$/.test(code)) return 'db_error' // a Postgres SQLSTATE
  if (/PERMISSION_DENIED/i.test(String((e as { message?: unknown })?.message ?? ''))) return 'sp_permission_denied'
  return 'gateway_error'
}

/** `<agent name> · YYYY-MM-DD HH:mm (<tz>)`, the time of the slot in the agent's schedule zone (UTC for none). */
export function runSessionTitle(name: string, slotAt: string, tz: string | undefined): string {
  const zone = tz || 'UTC'
  let parts: Record<string, string>
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(slotAt))
        .map((p) => [p.type, p.value])
    )
  } catch {
    return runSessionTitle(name, slotAt, 'UTC')
  }
  return `${name} · ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${zone})`
}

type AbortReason = 'timeout' | 'cost_cap' | 'shutdown' | 'lease_lost'
const reasonOf = (signal: AbortSignal): AbortReason => {
  const r = signal.reason
  const text = typeof r === 'string' ? r : r instanceof Error ? r.message : ''
  return text === 'lease_lost' ? 'lease_lost' : 'shutdown' // an external abort with no reason is the shutdown
}

export async function executeAgentRun(
  run: ClaimedRun,
  o: { signal: AbortSignal; maxRunCostUsd: number; timeoutMs: number; deps?: Partial<RunDeps> }
): Promise<RunOutcome> {
  const deps: RunDeps = { ...defaultDeps, ...o.deps }
  return withRunIdentity({ runAs: 'app_sp' }, async () => {
    const out: RunOutcome = { status: 'failed', errorCode: null, sessionId: null, messageId: null, costUsd: null, unpriced: false, toolNames: [] }
    const fail = (code: string): RunOutcome => ({ ...out, status: 'failed', errorCode: code })

    // ---- what can stop the run: the caller's signal (shutdown, lease lost), the timeout, the cost cap ----
    const stop = new AbortController()
    let why: AbortReason | null = null
    const abort = (reason: AbortReason) => {
      if (why) return
      why = reason
      stop.abort(reason)
    }
    const onOuter = () => abort(reasonOf(o.signal))
    if (o.signal.aborted) onOuter()
    else o.signal.addEventListener('abort', onOuter, { once: true })
    const timer = setTimeout(() => abort('timeout'), o.timeoutMs)
    let spent = 0
    let unpricedTokens = 0
    let sawUnpriced = false
    let priced = 0
    let misses = 0
    let beat: ReturnType<typeof setInterval> | null = null
    try {
      if (currentRunAs() !== 'app_sp') throw new RunError('sp_unavailable') // unreachable: asserted for the identity contract
      const spToken = await deps.spToken()
      if (!spToken) return fail('sp_unavailable')
      if (why) return finish(out, why)

      // ---- readiness, as the owner: still the approved definition, still unexpired ----
      let live: AgentReadiness | null
      try {
        live = await deps.readAgent(run.ownerEmail, spToken, run.agentId)
      } catch {
        return fail('db_error')
      }
      if (!live || live.status !== 'approved') return fail('approval_changed')
      if (!live.approvalExpiresAt || new Date(live.approvalExpiresAt).getTime() <= deps.now()) return fail('approval_expired')
      // what runs is the snapshot the admin approved: it must still be that hash, and the row must not have moved on
      if (approvalHash(run.definition) !== run.approvalHash || approvalHash(live.definition) !== run.approvalHash) return fail('approval_changed')

      // ---- admission: today's org policy and catalog, against the approved tools and model ----
      const def = run.definition
      const ctx = await deps.admissionContext(run.ownerEmail, spToken)
      if (!(await deps.modelAllowed(run.ownerEmail, spToken, def.model))) return fail('model_not_allowed')
      const admitted = admitAgentTools(def, ctx)
      if (!admitted.ok) return fail('tool_not_admitted')

      // ---- the owner's new chat, with the agent's prompt as the user message ----
      const sessionId = await deps.createSession(run.ownerEmail, spToken, {
        title: runSessionTitle(run.agentName, run.slotAt, def.schedule?.tz),
        model: def.model,
        systemPrompt: def.instructions,
      })
      out.sessionId = sessionId
      await deps.addUserMessage(run.ownerEmail, spToken, { sessionId, content: def.prompt })
      if (why) return finish(out, why)

      // ---- the lease heartbeat: two misses in a row and the run stops as lease_lost ----
      if (deps.renewLease) {
        beat = setInterval(() => {
          deps.renewLease!(run).then(
            (ok) => {
              misses = ok ? 0 : misses + 1
              if (misses >= LEASE_MISSES_TO_ABORT) abort('lease_lost')
            },
            () => {
              if (++misses >= LEASE_MISSES_TO_ABORT) abort('lease_lost')
            }
          )
        }, deps.heartbeatMs)
      }

      // ---- the turn, inside the run's usage scope: rows are the owner's, kind 'scheduled' ----
      const result = await runWithUsageScope(
        {
          email: run.ownerEmail,
          token: spToken,
          kind: 'scheduled',
          sessionId,
          tags: { agent_id: run.agentId, agent_run_id: run.runId },
          onCost: (costUsd, tokens) => {
            if (costUsd == null) {
              sawUnpriced = true
              unpricedTokens += tokens
              if (unpricedTokens > UNPRICED_TOKEN_CAP) abort('cost_cap')
            } else {
              priced++
              spent += costUsd
              if (spent >= o.maxRunCostUsd) abort('cost_cap')
            }
          },
        },
        () =>
          deps.runTurn({
            email: run.ownerEmail,
            token: spToken,
            requestId: `agent-run-${run.runId}`,
            sessionId,
            userText: def.prompt,
            opts: { model: def.model, systemPrompt: def.instructions, reasoningEffort: def.reasoningEffort, toolRefs: admitted.turnToolRefs, lang: def.lang },
            signal: stop.signal,
          })
      )
      out.messageId = result.messageId
      out.toolNames = result.toolNames
      out.costUsd = priced > 0 ? spent : null
      out.unpriced = sawUnpriced
      if (result.status === 'ok') return { ...out, status: 'succeeded', errorCode: null }
      if (result.status === 'aborted' || why) return finish(out, why ?? 'shutdown')
      return fail(codeOf({ code: result.errorCode }))
    } catch (e) {
      if (why) return finish(out, why)
      const code = codeOf(e)
      logger.warn('agent run failed', { agent_id: run.agentId, run_id: run.runId, code })
      return { ...out, status: 'failed', errorCode: code }
    } finally {
      clearTimeout(timer)
      if (beat) clearInterval(beat)
      o.signal.removeEventListener('abort', onOuter)
    }
  })
}

/** The outcome of a run that was stopped from outside the turn. */
function finish(out: RunOutcome, why: AbortReason): RunOutcome {
  if (why === 'shutdown') return { ...out, status: 'cancelled', errorCode: 'shutdown' }
  return { ...out, status: 'failed', errorCode: why }
}
