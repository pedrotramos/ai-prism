// Agent versions (migration 0017): the owner's history, restore and duplicate, the audiences a version is shared with, what a
// recipient may read, and the administrator's decision on a version. Design: docs/adr/0020-agent-versions.md.
//
// Every function runs inside withTx with the caller's identity, so RLS limits it; each owner function also scopes by
// owner_email (defence in depth) and a row that is not the caller's is "not found" (null / false), never a different answer.
// The immutability of a version and the approval rules live in the database (aip_agent_versions_guard); the WHERE clauses here
// only avoid raising for the ordinary refusals. The admin functions open the admin flag themselves: the ROUTE decides who may
// call them (requireAdmin), as in server/db/agents.ts.
//
// A version is the agent as it was SAVED: agents.revision is its number, and every save (create, PATCH, restore) inserts the
// row in the same transaction as the agent UPDATE, through `insertVersion`. An agent saved before 0017 has no row for its
// current revision; `ensureHeadVersion` creates it the first time the owner reads the history or saves (a migration cannot
// write rows after 0003), so history starts at the version where the feature became live.
import { actorHash, recordAdminAction } from '../audit.ts'
import { AGENT_LIMITS, approvalHash } from '../agents/definition.ts'
import type { AgentDefinition } from '../agents/definition.ts'
import { withTx } from './pool.ts'
import type { DbClient } from './pool.ts'
import type { AgentStatus } from './agents.ts'

export type ShareKind = 'user' | 'group' | 'app'
export interface VersionOrigin {
  kind: 'restore' | 'duplicate' | 'shared'
  agentId: string
  version: number
}
export interface ShareRow {
  kind: ShareKind
  principal: string
  version: number
  createdAt: string
}
export interface AgentVersionRow {
  agentId: string
  version: number
  ownerEmail: string
  name: string
  description: string
  definition: AgentDefinition
  createdBy: string
  createdAt: string
  origin: VersionOrigin | null
  status: AgentStatus
  decisionReason: string | null
  approvedAt: string | null
  /** sha256 of the canonical definition: what the admin approves */
  hash: string
  /** the agent's current version (its `revision`) */
  isHead: boolean
  /** the audiences pinned to this version */
  shares: ShareRow[]
}
/** What a recipient (or the owner, through "use") may read of a version. */
export interface SharedVersionRow {
  agentId: string
  version: number
  ownerEmail: string
  name: string
  description: string
  definition: AgentDefinition
  approvedAt: string | null
}
export interface AdminVersionRow extends AgentVersionRow {
  currentHash: string
  agentStatus: AgentStatus
  /** the newest earlier version of this agent that was approved, to show what changed since */
  previous: { version: number; name: string; description: string; definition: AgentDefinition } | null
}
export interface VersionInput {
  name: string
  description: string
  definition: AgentDefinition
}

type Raw = Record<string, any> // any: a pg row
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))
const isId = (id: unknown): id is string => typeof id === 'string' && /^\d{1,18}$/.test(id)
const isVersion = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1_000_000
const VERSIONS_PAGE_DEFAULT = 30
const VERSIONS_PAGE_MAX = 100
const REASON_MAX = 500

function shapeShare(r: Raw): ShareRow {
  return { kind: r.kind, principal: r.principal, version: r.version, createdAt: iso(r.created_at) as string }
}

function shapeVersion(r: Raw, headRevision: number | null, shares: ShareRow[]): AgentVersionRow {
  return {
    agentId: String(r.agent_id),
    version: r.version,
    ownerEmail: r.owner_email,
    name: r.name,
    description: r.description,
    definition: r.definition,
    createdBy: r.created_by,
    createdAt: iso(r.created_at) as string,
    origin: r.origin ?? null,
    status: r.status,
    decisionReason: r.decision_reason ?? null,
    approvedAt: iso(r.approved_at),
    hash: approvalHash(r.definition),
    isHead: headRevision !== null && r.version === headRevision,
    shares,
  }
}

const shapeShared = (r: Raw): SharedVersionRow => ({
  agentId: String(r.agent_id),
  version: r.version,
  ownerEmail: r.owner_email,
  name: r.name,
  description: r.description,
  definition: r.definition,
  approvedAt: iso(r.approved_at),
})

/** Inserts the version row of a save. Runs in the transaction of the agent write. */
export async function insertVersion(
  c: DbClient,
  o: { agentId: string; version: number; ownerEmail: string; createdBy: string; createdAt?: string | Date } & VersionInput,
  origin: VersionOrigin | null = null
): Promise<void> {
  await c.query(
    `INSERT INTO agent_versions (agent_id, version, owner_email, name, description, definition, created_by, origin, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, coalesce($9::timestamptz, now()))`,
    [o.agentId, o.version, o.ownerEmail, o.name, o.description, JSON.stringify(o.definition), o.createdBy, origin ? JSON.stringify(origin) : null, o.createdAt ?? null]
  )
}

/**
 * The row of the agent's current revision, created if an agent saved before 0017 has none. Only the owner's own agent
 * (the SELECT is scoped to her); a no-op for anyone else, and for an agent that already has the row.
 */
export async function ensureHeadVersion(c: DbClient, email: string, agentId: string): Promise<void> {
  const a = (await c.query(`SELECT id, name, description, definition, revision, updated_at FROM agents WHERE id = $1 AND owner_email = $2`, [agentId, email])).rows[0]
  if (!a) return
  const has = (await c.query(`SELECT 1 FROM agent_versions WHERE agent_id = $1 AND version = $2`, [agentId, a.revision])).rows.length > 0
  if (has) return
  // a version above the highest stored one only (the guard refuses the rest): an agent that has later rows already has history
  const top = (await c.query(`SELECT max(version) AS v FROM agent_versions WHERE agent_id = $1`, [agentId])).rows[0].v
  if (top != null && top >= a.revision) return
  // the row records when the agent was last saved, not when the history was first opened
  await insertVersion(c, { agentId: String(a.id), version: a.revision, ownerEmail: email, createdBy: email, createdAt: a.updated_at, name: a.name, description: a.description, definition: a.definition })
}

async function sharesOf(c: DbClient, agentId: string): Promise<ShareRow[]> {
  const r = await c.query(`SELECT kind, principal, version, created_at FROM agent_shares WHERE agent_id = $1 ORDER BY kind, principal`, [agentId])
  return r.rows.map(shapeShare)
}

/** The owner's history, newest first. `before` is a version number (the previous page's last). null = not the caller's agent. */
export async function listAgentVersions(email: string, token: string | null, agentId: string, o: { limit?: number; before?: number } = {}): Promise<{ versions: AgentVersionRow[]; hasMore: boolean } | null> {
  if (!isId(agentId)) return null
  if (o.before !== undefined && !isVersion(o.before)) return { versions: [], hasMore: false }
  const limit = Math.min(VERSIONS_PAGE_MAX, Math.max(1, Number.isInteger(o.limit) ? (o.limit as number) : VERSIONS_PAGE_DEFAULT))
  return withTx(email, token, async (c: DbClient) => {
    const agent = (await c.query(`SELECT revision FROM agents WHERE id = $1 AND owner_email = $2`, [agentId, email])).rows[0]
    if (!agent) return null
    await ensureHeadVersion(c, email, agentId)
    const rows = (
      await c.query(
        `SELECT * FROM agent_versions WHERE agent_id = $1 AND owner_email = $2 AND ($3::int IS NULL OR version < $3::int) ORDER BY version DESC LIMIT $4`,
        [agentId, email, o.before ?? null, limit + 1]
      )
    ).rows
    const shares = await sharesOf(c, agentId)
    const page = rows.slice(0, limit)
    return { versions: page.map((r) => shapeVersion(r, agent.revision, shares.filter((s) => s.version === r.version))), hasMore: rows.length > limit }
  })
}

/**
 * One version the caller may read: her own (any state) or one that was shared with her and approved (RLS decides).
 * `version` null = the owner's head, or the newest version shared with a recipient. Never a draft of somebody else's.
 */
export async function getVersionForUse(email: string, token: string | null, agentId: string, version: number | null): Promise<SharedVersionRow | null> {
  if (!isId(agentId)) return null
  if (version !== null && !isVersion(version)) return null
  return withTx(email, token, async (c: DbClient) => {
    await ensureHeadVersion(c, email, agentId)
    const r = await c.query(`SELECT * FROM agent_versions WHERE agent_id = $1 AND ($2::int IS NULL OR version = $2::int) ORDER BY version DESC LIMIT 1`, [agentId, version])
    return r.rows[0] ? shapeShared(r.rows[0]) : null
  })
}

/** The newest approved version of each agent that others shared with the caller (a user share, one of her groups, or the whole app). */
export async function listSharedWithMe(email: string, token: string | null): Promise<SharedVersionRow[]> {
  return withTx(email, token, async (c: DbClient) => {
    const r = await c.query(
      `SELECT DISTINCT ON (v.agent_id) v.*
         FROM agent_versions v
        WHERE v.status = 'approved' AND v.owner_email <> $1
          AND EXISTS (SELECT 1 FROM agent_shares s
                       WHERE s.agent_id = v.agent_id AND s.version = v.version
                         AND (s.kind = 'app' OR (s.kind = 'user' AND s.principal = lower($1)) OR (s.kind = 'group' AND s.principal = ANY (aip_my_groups()))))
        ORDER BY v.agent_id, v.version DESC`,
      [email]
    )
    return r.rows.map(shapeShared).sort((a, b) => a.name.localeCompare(b.name))
  })
}

/** draft / rejected / revoked -> pending for ONE version (the sharing approval). null = not the caller's, or not in one of those states. */
export async function submitAgentVersion(email: string, token: string | null, agentId: string, version: number): Promise<AgentVersionRow | null> {
  if (!isId(agentId) || !isVersion(version)) return null
  return withTx(email, token, async (c: DbClient) => {
    await ensureHeadVersion(c, email, agentId)
    const r = await c.query(
      `UPDATE agent_versions SET status = 'pending'
        WHERE agent_id = $1 AND version = $2 AND owner_email = $3 AND status IN ('draft', 'rejected', 'revoked') RETURNING *`,
      [agentId, version, email]
    )
    if (!r.rows[0]) return null
    const head = (await c.query(`SELECT revision FROM agents WHERE id = $1`, [agentId])).rows[0]
    return shapeVersion(r.rows[0], head?.revision ?? null, await sharesOf(c, agentId).then((s) => s.filter((x) => x.version === version)))
  })
}

/** Result of adding a share: the row, or why not. */
export type ShareResult = ShareRow | null | 'limit' | 'no_version'

/**
 * Shares `version` with one audience (a user, a group or the whole app); sharing the same principal again moves its pin.
 * Allowed for any state of the version: the share is inert until the version is approved (the read policy says so).
 * null = not the caller's agent; 'no_version' = that version does not exist.
 */
export async function upsertAgentShare(email: string, token: string | null, agentId: string, s: { version: number; kind: ShareKind; principal: string }): Promise<ShareResult> {
  if (!isId(agentId) || !isVersion(s.version)) return null
  return withTx(email, token, async (c: DbClient) => {
    const agent = (await c.query(`SELECT id FROM agents WHERE id = $1 AND owner_email = $2 FOR UPDATE`, [agentId, email])).rows[0]
    if (!agent) return null
    await ensureHeadVersion(c, email, agentId)
    const v = (await c.query(`SELECT 1 FROM agent_versions WHERE agent_id = $1 AND version = $2 AND owner_email = $3`, [agentId, s.version, email])).rows
    if (!v.length) return 'no_version'
    const exists = (await c.query(`SELECT 1 FROM agent_shares WHERE agent_id = $1 AND kind = $2 AND principal = $3`, [agentId, s.kind, s.principal])).rows.length > 0
    if (!exists) {
      const n = (await c.query(`SELECT count(*)::int AS n FROM agent_shares WHERE agent_id = $1`, [agentId])).rows[0].n
      if (n >= AGENT_LIMITS.sharesPerAgent) return 'limit'
    }
    const r = await c.query(
      `INSERT INTO agent_shares (agent_id, version, owner_email, kind, principal, created_by) VALUES ($1, $2, $3, $4, $5, $3)
       ON CONFLICT (agent_id, kind, principal) DO UPDATE SET version = EXCLUDED.version
       RETURNING kind, principal, version, created_at`,
      [agentId, s.version, email, s.kind, s.principal]
    )
    return shapeShare(r.rows[0])
  })
}

export async function removeAgentShare(email: string, token: string | null, agentId: string, kind: ShareKind, principal: string): Promise<boolean> {
  if (!isId(agentId)) return false
  return withTx(email, token, async (c: DbClient) => ((await c.query(`DELETE FROM agent_shares WHERE agent_id = $1 AND owner_email = $2 AND kind = $3 AND principal = $4`, [agentId, email, kind, principal])).rowCount ?? 0) > 0)
}

export async function listAgentShares(email: string, token: string | null, agentId: string): Promise<ShareRow[] | null> {
  if (!isId(agentId)) return null
  return withTx(email, token, async (c: DbClient) => {
    const a = (await c.query(`SELECT 1 FROM agents WHERE id = $1 AND owner_email = $2`, [agentId, email])).rows
    return a.length ? sharesOf(c, agentId) : null
  })
}

// ---- the administrator's side ---------------------------------------------------------

function shapeAdmin(r: Raw, headRevision: number, agentStatus: AgentStatus, shares: ShareRow[], previous: Raw | null): AdminVersionRow {
  return {
    ...shapeVersion(r, headRevision, shares),
    currentHash: approvalHash(r.definition),
    agentStatus,
    previous: previous ? { version: previous.version, name: previous.name, description: previous.description, definition: previous.definition } : null,
  }
}

async function adminRows(c: DbClient, where: string, params: unknown[], limit: number): Promise<AdminVersionRow[]> {
  const r = await c.query(
    `SELECT v.*, a.revision AS head_revision, a.status AS agent_status,
            (SELECT to_jsonb(prev) FROM (SELECT pv.version, pv.name, pv.description, pv.definition FROM agent_versions pv
              WHERE pv.agent_id = v.agent_id AND pv.version < v.version AND pv.status = 'approved' ORDER BY pv.version DESC LIMIT 1) prev) AS previous
       FROM agent_versions v JOIN agents a ON a.id = v.agent_id
      WHERE ${where} ORDER BY v.created_at DESC, v.id DESC LIMIT ${limit}`,
    params
  )
  const ids = [...new Set(r.rows.map((x) => String(x.agent_id)))]
  const shares = ids.length ? (await c.query(`SELECT agent_id, kind, principal, version, created_at FROM agent_shares WHERE agent_id = ANY($1::bigint[]) ORDER BY kind, principal`, [ids])).rows : []
  return r.rows.map((x) =>
    shapeAdmin(x, x.head_revision, x.agent_status, shares.filter((s) => String(s.agent_id) === String(x.agent_id) && s.version === x.version).map(shapeShare), x.previous ?? null)
  )
}

/** The review queue of versions (admin flag), optionally one status. */
export async function listVersionsForReview(adminEmail: string, token: string | null, o: { status?: AgentStatus }): Promise<AdminVersionRow[]> {
  return withTx(adminEmail, token, (c: DbClient) => adminRows(c, `($1::text IS NULL OR v.status = $1)`, [o.status ?? null], 200), { admin: true })
}

/**
 * An administrator's decision on one version, with its audit row, in ONE transaction. A version is immutable, so what the
 * admin saw cannot change under him; `expectedHash` is still compared (to the hash of the stored definition) so the screen and
 * the row are known to match. 'stale' = the hash or the state does not fit the decision, and nothing is written.
 * `expectedHash` is required to approve; for reject and revoke an empty one skips the comparison. null = no such version;
 * 'agent_pending' = the version is the current one of an agent waiting for its own approval: decide it there.
 */
export async function decideAgentVersion(
  adminEmail: string,
  token: string | null,
  agentId: string,
  version: number,
  d: { decision: 'approve' | 'reject' | 'revoke'; expectedHash: string; reason?: string }
): Promise<AdminVersionRow | null | 'stale' | 'agent_pending'> {
  if (!isId(agentId) || !isVersion(version)) return null
  const reason = typeof d.reason === 'string' ? d.reason.trim().slice(0, REASON_MAX) || null : null
  return withTx(
    adminEmail,
    token,
    async (c: DbClient) => {
      const cur = (await c.query(`SELECT v.*, a.revision AS head_revision, a.status AS agent_status FROM agent_versions v JOIN agents a ON a.id = v.agent_id WHERE v.agent_id = $1 AND v.version = $2 FOR UPDATE OF v`, [agentId, version])).rows[0]
      if (!cur) return null
      // the current version of an agent that is itself waiting for approval is decided on the agent card (one decision, one audit
      // row, both approvals: decideAgent)
      if (cur.version === cur.head_revision && cur.agent_status === 'pending') return 'agent_pending'
      const current = approvalHash(cur.definition)
      const hashOk = d.expectedHash ? d.expectedHash === current : d.decision !== 'approve'
      const stateOk = d.decision === 'revoke' ? cur.status === 'approved' || cur.status === 'pending' : cur.status === 'pending'
      if (!hashOk || !stateOk) return 'stale'
      let row: Raw
      if (d.decision === 'approve') {
        row = (await c.query(`UPDATE agent_versions SET status = 'approved', approved_by_hash = $3, approved_at = now(), decision_reason = NULL WHERE agent_id = $1 AND version = $2 RETURNING *`, [agentId, version, actorHash(adminEmail)])).rows[0]
      } else if (d.decision === 'reject') {
        row = (await c.query(`UPDATE agent_versions SET status = 'rejected', decision_reason = $3 WHERE agent_id = $1 AND version = $2 RETURNING *`, [agentId, version, reason])).rows[0]
      } else {
        row = (await c.query(`UPDATE agent_versions SET status = 'revoked', decision_reason = $3, approved_by_hash = NULL, approved_at = NULL WHERE agent_id = $1 AND version = $2 RETURNING *`, [agentId, version, reason])).rows[0]
      }
      await recordAdminAction(c, adminEmail, { action: `agent.version.${d.decision}`, target: `agent:${agentId}:v${version}`, details: { hash: current, wasApproved: cur.status === 'approved' } })
      const out = await adminRows(c, `v.agent_id = $1 AND v.version = $2`, [agentId, row.version], 1)
      return out[0] as AdminVersionRow
    },
    { admin: true }
  )
}
