// Scheduled agents (W4-4a, migration 0015): the owner's data layer and the admin's decision.
//
// Every function runs inside withTx with the caller's identity, so RLS limits it to the caller's rows; each owner
// function also scopes by owner_email (defence in depth), and a row that is not the caller's is "not found"
// (null / false), never a different answer: no existence leak. The approval rules live in the database (the
// aip_agents_guard trigger); the WHERE clauses here only avoid raising for the ordinary refusals. The two admin
// functions (listAgentsForReview, decideAgent, writeAgentSettings) open the admin flag themselves: the ROUTE decides
// who may call them (requireAdmin), exactly like server/db/admin.ts.
//
// Nothing here runs an agent: the scheduler, the claim and the headless turn are W4-4b/4c. The scheduler's own
// identity (app.scheduler) is set only by server/db/agentScheduler.ts, never here.
import { recordAdminAction, actorHash } from '../audit.ts'
import { AGENT_LIMITS, approvalHash } from '../agents/definition.ts'
import type { AgentDefinition } from '../agents/definition.ts'
import { withTx } from './pool.ts'
import type { DbClient, Ident } from './pool.ts'

export type AgentStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'revoked'
export type AgentRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped'

export interface AgentRow {
  id: string
  ownerEmail: string
  name: string
  description: string
  definition: AgentDefinition
  revision: number
  status: AgentStatus
  approvalExpiresAt: string | null
  decisionReason: string | null
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  consecutiveFailures: number
  disabledReason: string | null
  createdAt: string
  updatedAt: string
}
export interface AgentRunRow {
  id: string
  agentId: string
  trigger: 'schedule' | 'manual'
  slotAt: string
  status: AgentRunStatus
  errorCode: string | null
  startedAt: string | null
  finishedAt: string | null
  sessionId: string | null
  costUsd: number | null
  unpriced: boolean
  toolNames: string[]
}
export interface AdminAgentRow extends AgentRow {
  approvalHash: string | null
  currentHash: string
}
export interface AgentInput {
  name: string
  description: string
  definition: AgentDefinition
}

/** A refusal the routes map to a status: agents_limit (409), invalid_setting (400). */
export class AgentsError extends Error {
  code: string
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
  }
}

export const AGENT_SETTING_KEYS = Object.freeze({ enabled: 'agents_enabled', maxRunCostUsd: 'agents_max_run_cost_usd', approvalDays: 'agents_approval_days' } as const)
export const AGENT_SETTING_DEFAULTS = Object.freeze({ enabled: false, maxRunCostUsd: 1, approvalDays: 90 } as const)
export const AGENT_SETTING_RANGES = Object.freeze({ maxRunCostUsd: [0.05, 50], approvalDays: [1, 365] } as const)
const RUNS_PAGE_DEFAULT = 20
const RUNS_PAGE_MAX = 100

type Raw = Record<string, any> // any: a pg row
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))

function shape(r: Raw): AgentRow {
  return {
    id: String(r.id),
    ownerEmail: r.owner_email,
    name: r.name,
    description: r.description,
    definition: r.definition,
    revision: r.revision,
    status: r.status,
    approvalExpiresAt: iso(r.approval_expires_at),
    decisionReason: r.decision_reason ?? null,
    enabled: r.enabled,
    nextRunAt: iso(r.next_run_at),
    lastRunAt: iso(r.last_run_at),
    consecutiveFailures: r.consecutive_failures,
    disabledReason: r.disabled_reason ?? null,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  }
}
const shapeAdmin = (r: Raw): AdminAgentRow => ({ ...shape(r), approvalHash: r.approval_hash ?? null, currentHash: approvalHash(r.definition) })

function shapeRun(r: Raw): AgentRunRow {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    trigger: r.trigger,
    slotAt: iso(r.slot_at) as string,
    status: r.status,
    errorCode: r.error_code ?? null,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    sessionId: r.session_id == null ? null : String(r.session_id),
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    unpriced: r.unpriced,
    toolNames: r.tool_names ?? [],
  }
}

const isId = (id: unknown): id is string => typeof id === 'string' && /^\d{1,18}$/.test(id)

/** The caller's agents, most recently changed first. */
export async function listAgents(email: string, token: string | null): Promise<AgentRow[]> {
  return withTx(email, token, async (c: DbClient) => {
    const r = await c.query(`SELECT * FROM agents WHERE owner_email = $1 ORDER BY updated_at DESC, id DESC`, [email])
    return r.rows.map(shape)
  })
}

export async function getAgent(email: string, token: string | null, id: string): Promise<AgentRow | null> {
  if (!isId(id)) return null
  return withTx(email, token, async (c: DbClient) => {
    const r = await c.query(`SELECT * FROM agents WHERE id = $1 AND owner_email = $2`, [id, email])
    return r.rows[0] ? shape(r.rows[0]) : null
  })
}

/** A new draft. AgentsError('agents_limit') past AGENT_LIMITS.agentsPerOwner (counted under a per-owner lock). */
export async function createAgent(email: string, token: string | null, a: AgentInput): Promise<AgentRow> {
  return withTx(email, token, async (c: DbClient) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('agents:' || $1, 0))`, [email])
    const n = (await c.query(`SELECT count(*)::int AS n FROM agents WHERE owner_email = $1`, [email])).rows[0].n
    if (n >= AGENT_LIMITS.agentsPerOwner) throw new AgentsError('agents_limit')
    const r = await c.query(`INSERT INTO agents (owner_email, name, description, definition) VALUES ($1, $2, $3, $4::jsonb) RETURNING *`, [
      email,
      a.name,
      a.description,
      JSON.stringify(a.definition),
    ])
    return shape(r.rows[0])
  })
}

/**
 * Saves name, description and definition when `revision` is the current one. An edit of the approval scope comes back
 * as a draft (the trigger voided the approval). null = not the caller's; 'conflict' = the revision moved.
 */
export async function updateAgent(email: string, token: string | null, id: string, a: AgentInput, o: { revision: number }): Promise<AgentRow | null | 'conflict'> {
  if (!isId(id)) return null
  return withTx(email, token, async (c: DbClient) => {
    const r = await c.query(
      `UPDATE agents SET name = $3, description = $4, definition = $5::jsonb, revision = revision + 1, updated_at = now()
        WHERE id = $1 AND owner_email = $2 AND revision = $6 RETURNING *`,
      [id, email, a.name, a.description, JSON.stringify(a.definition), o.revision]
    )
    if (r.rows[0]) return shape(r.rows[0])
    const exists = await c.query(`SELECT 1 FROM agents WHERE id = $1 AND owner_email = $2`, [id, email])
    return exists.rows.length ? 'conflict' : null
  })
}

/** Deletes the agent and, by cascade, its runs (their chats stay). */
export async function deleteAgent(email: string, token: string | null, id: string): Promise<boolean> {
  if (!isId(id)) return false
  return withTx(email, token, async (c: DbClient) => ((await c.query(`DELETE FROM agents WHERE id = $1 AND owner_email = $2`, [id, email])).rowCount ?? 0) > 0)
}

/** draft / rejected / revoked -> pending. null when not the caller's or not in one of those states. */
export async function submitAgent(email: string, token: string | null, id: string): Promise<AgentRow | null> {
  if (!isId(id)) return null
  return withTx(email, token, async (c: DbClient) => {
    const r = await c.query(
      `UPDATE agents SET status = 'pending', updated_at = now()
        WHERE id = $1 AND owner_email = $2 AND status IN ('draft', 'rejected', 'revoked') RETURNING *`,
      [id, email]
    )
    return r.rows[0] ? shape(r.rows[0]) : null
  })
}

/**
 * Switches the schedule. Enabling needs an approved, unexpired agent and a next run time (null = refused);
 * disabling always works and clears next_run_at. The database enforces the same rule (trigger), so this never
 * relies on the WHERE clause alone.
 */
export async function setAgentEnabled(email: string, token: string | null, id: string, enabled: boolean, nextRunAt: Date | null): Promise<AgentRow | null> {
  if (!isId(id)) return null
  if (enabled && !(nextRunAt instanceof Date && Number.isFinite(nextRunAt.getTime()))) return null
  return withTx(email, token, async (c: DbClient) => {
    const r = await c.query(
      `UPDATE agents SET enabled = $3, next_run_at = $4::timestamptz, disabled_reason = NULL, consecutive_failures = CASE WHEN $3 THEN 0 ELSE consecutive_failures END, updated_at = now()
        WHERE id = $1 AND owner_email = $2
          AND (NOT $3 OR (status = 'approved' AND approval_hash IS NOT NULL AND approval_expires_at > now()))
        RETURNING *`,
      [id, email, enabled, enabled ? (nextRunAt as Date).toISOString() : null]
    )
    return r.rows[0] ? shape(r.rows[0]) : null
  })
}

/**
 * "Run now": queues one manual run under the approval hash the agent holds right now. null = not the caller's, or not
 * approved and unexpired; 'busy' = a run is already queued or running (the partial unique index decides).
 */
export async function queueManualRun(email: string, token: string | null, id: string): Promise<AgentRunRow | 'busy' | null> {
  if (!isId(id)) return null
  return withTx(email, token, async (c: DbClient) => {
    const a = (
      await c.query(
        `SELECT approval_hash FROM agents
          WHERE id = $1 AND owner_email = $2 AND status = 'approved' AND approval_hash IS NOT NULL AND approval_expires_at > now() FOR UPDATE`,
        [id, email]
      )
    ).rows[0]
    if (!a) return null
    const r = await c.query(
      `INSERT INTO agent_runs (agent_id, owner_email, trigger, slot_at, approval_hash, status)
       VALUES ($1, $2, 'manual', now(), $3, 'queued') ON CONFLICT DO NOTHING RETURNING *`,
      [id, email, a.approval_hash]
    )
    return r.rows[0] ? shapeRun(r.rows[0]) : 'busy'
  })
}

/** Run history, newest first. `before` is a run id (the previous page's last). */
export async function listAgentRuns(email: string, token: string | null, agentId: string, o: { limit?: number; before?: string } = {}): Promise<AgentRunRow[]> {
  if (!isId(agentId)) return []
  if (o.before !== undefined && !isId(o.before)) return []
  const limit = Math.min(RUNS_PAGE_MAX, Math.max(1, Number.isInteger(o.limit) ? (o.limit as number) : RUNS_PAGE_DEFAULT))
  return withTx(email, token, async (c: DbClient) => {
    const r = await c.query(
      `SELECT * FROM agent_runs WHERE agent_id = $1 AND owner_email = $2 AND ($3::bigint IS NULL OR id < $3::bigint) ORDER BY id DESC LIMIT $4`,
      [agentId, email, o.before ?? null, limit]
    )
    return r.rows.map(shapeRun)
  })
}

/** The review queue: every owner's agents (admin flag), optionally one status, with the stored and the current hash. */
export async function listAgentsForReview(adminEmail: string, token: string | null, o: { status?: AgentStatus }): Promise<AdminAgentRow[]> {
  return withTx(
    adminEmail,
    token,
    async (c: DbClient) => {
      const r = await c.query(`SELECT * FROM agents WHERE ($1::text IS NULL OR status = $1) ORDER BY updated_at DESC, id DESC LIMIT 200`, [o.status ?? null])
      return r.rows.map(shapeAdmin)
    },
    { admin: true }
  )
}

/** The names of agents by id (the admin Costs page labels its per-agent rows). An id that no longer exists is absent. */
export async function agentNamesByIds(adminEmail: string, token: string | null, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  return withTx(
    adminEmail,
    token,
    async (c: DbClient) => {
      const r = await c.query(`SELECT id::text AS id, name FROM agents WHERE id = ANY($1::bigint[])`, [ids])
      return new Map<string, string>(r.rows.map((row: { id: string; name: string }) => [row.id, row.name]))
    },
    { admin: true }
  )
}

const REASON_MAX = 500

/**
 * An admin's decision, with its audit row, in ONE transaction. The agent is locked, so the hash the admin saw is
 * compared with the stored definition's hash at the moment of the write: a mismatch (the owner edited meanwhile) or a
 * state that does not fit the decision answers 'stale' and writes nothing, audit row included. null = no such agent.
 * `expectedHash` is required to approve; for reject and revoke an empty one skips the comparison.
 */
export async function decideAgent(
  adminEmail: string,
  token: string | null,
  id: string,
  d: { decision: 'approve' | 'reject' | 'revoke'; expectedHash: string; reason?: string; days?: number }
): Promise<AdminAgentRow | null | 'stale'> {
  if (!isId(id)) return null
  const reason = typeof d.reason === 'string' ? d.reason.trim().slice(0, REASON_MAX) || null : null
  return withTx(
    adminEmail,
    token,
    async (c: DbClient) => {
      const cur = (await c.query(`SELECT * FROM agents WHERE id = $1 FOR UPDATE`, [id])).rows[0]
      if (!cur) return null
      const current = approvalHash(cur.definition)
      const hashOk = d.expectedHash ? d.expectedHash === current : d.decision !== 'approve'
      const stateOk = d.decision === 'revoke' ? cur.status === 'approved' || cur.status === 'pending' : cur.status === 'pending'
      if (!hashOk || !stateOk) return 'stale'

      let row: Raw
      let details: Record<string, unknown>
      if (d.decision === 'approve') {
        const days = d.days ?? (await approvalDaysIn(c))
        if (!Number.isInteger(days) || days < AGENT_SETTING_RANGES.approvalDays[0] || days > AGENT_SETTING_RANGES.approvalDays[1]) throw new AgentsError('invalid_setting', 'days')
        row = (
          await c.query(
            `UPDATE agents SET status = 'approved', approval_hash = $2, approved_snapshot = definition, approved_by_hash = $3,
                    approved_at = now(), approval_expires_at = now() + make_interval(days => $4), decision_reason = NULL, updated_at = now()
              WHERE id = $1 RETURNING *`,
            [id, current, actorHash(adminEmail), days]
          )
        ).rows[0]
        details = { hash: current, expiresAt: iso(row.approval_expires_at), days }
      } else if (d.decision === 'reject') {
        row = (await c.query(`UPDATE agents SET status = 'rejected', decision_reason = $2, enabled = false, next_run_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [id, reason])).rows[0]
        details = { hash: current }
      } else {
        row = (
          await c.query(
            `UPDATE agents SET status = 'revoked', decision_reason = $2, enabled = false, next_run_at = NULL, disabled_reason = 'revoked',
                    approval_hash = NULL, approved_snapshot = NULL, approved_by_hash = NULL, approved_at = NULL, approval_expires_at = NULL, updated_at = now()
              WHERE id = $1 RETURNING *`,
            [id, reason]
          )
        ).rows[0]
        details = { hash: current, wasApproved: cur.status === 'approved' }
      }
      await recordAdminAction(c, adminEmail, { action: `agent.${d.decision}`, target: `agent:${id}`, details })
      return shapeAdmin(row)
    },
    { admin: true }
  )
}

async function approvalDaysIn(c: DbClient): Promise<number> {
  const r = await c.query(`SELECT value FROM app_settings WHERE key = $1`, [AGENT_SETTING_KEYS.approvalDays])
  return settingOr(r.rows[0]?.value, 'approvalDays') as number
}

function settingOr(v: unknown, field: 'enabled' | 'maxRunCostUsd' | 'approvalDays'): boolean | number {
  if (field === 'enabled') return v === true
  const [lo, hi] = AGENT_SETTING_RANGES[field]
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi && (field !== 'approvalDays' || Number.isInteger(v)) ? v : AGENT_SETTING_DEFAULTS[field]
}

/** The admin-written feature settings; an absent or out-of-range value reads as its default. Any identity may read. */
export async function readAgentSettings(email: string, token: string | null): Promise<{ enabled: boolean; maxRunCostUsd: number; approvalDays: number }> {
  return withTx(email, token, async (c: DbClient) => {
    const r = await c.query(`SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`, [Object.values(AGENT_SETTING_KEYS)])
    const by = Object.fromEntries(r.rows.map((x: Raw) => [x.key, x.value]))
    return {
      enabled: settingOr(by[AGENT_SETTING_KEYS.enabled], 'enabled') as boolean,
      maxRunCostUsd: settingOr(by[AGENT_SETTING_KEYS.maxRunCostUsd], 'maxRunCostUsd') as number,
      approvalDays: settingOr(by[AGENT_SETTING_KEYS.approvalDays], 'approvalDays') as number,
    }
  })
}

/** Writes the given settings and ONE audit row ('agents.settings') in one transaction. Validated before any write. */
export async function writeAgentSettings(adminEmail: string, token: string | null, s: Partial<{ enabled: boolean; maxRunCostUsd: number; approvalDays: number }>): Promise<void> {
  const patch: Record<string, boolean | number> = {}
  if (s.enabled !== undefined) {
    if (typeof s.enabled !== 'boolean') throw new AgentsError('invalid_setting', 'enabled')
    patch.enabled = s.enabled
  }
  for (const f of ['maxRunCostUsd', 'approvalDays'] as const) {
    const v = s[f]
    if (v === undefined) continue
    const [lo, hi] = AGENT_SETTING_RANGES[f]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (f === 'approvalDays' && !Number.isInteger(v))) throw new AgentsError('invalid_setting', f)
    patch[f] = v
  }
  if (!Object.keys(patch).length) return
  await withTx(
    adminEmail,
    token,
    async (c: DbClient) => {
      for (const [field, value] of Object.entries(patch)) {
        await c.query(
          `INSERT INTO app_settings (key, value, updated_by_hash, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_hash = EXCLUDED.updated_by_hash, updated_at = NOW()`,
          [AGENT_SETTING_KEYS[field as keyof typeof AGENT_SETTING_KEYS], JSON.stringify(value), actorHash(adminEmail)]
        )
      }
      await recordAdminAction(c, adminEmail, { action: 'agents.settings', target: 'app_settings', details: patch })
    },
    { admin: true }
  )
}
