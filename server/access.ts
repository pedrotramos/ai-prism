// Project access layer (W2-3, design D4): who may do what in a project.
//
// Roles: owner > manage > view. Viewers read AND post in the project's chats;
// manage edits the project (name, description, instructions), its files and
// members (up to manage); only an owner grants or removes owner and deletes the
// project. A chat inside a project is governed only by the current project
// role: its creator keeps nothing after leaving. App admins (APP_OWNER_EMAIL,
// app_admins) get NO implicit access: a non-member is a non-member.
//
// The database enforces the same rules (migration 0005, row-level security:
// ai_prism.aip_project_rank). This module is what the routes ask first, so a
// refusal is a clean HTTP status: 404 for a non-member (a project's existence
// never leaks), 403 for a member whose role is too low.
//
// Group membership comes from SCIM /Me with the caller's own token (the same
// call server/authz.js makes for group admins). It fails CLOSED: any error,
// timeout or unexpected body = no groups, so a group never grants access it
// cannot prove, and only a complete HTTP 200 counts (206 or a paged list = no
// groups). The result feeds app.user_groups in every transaction
// (server/db/pool.js setTxGroupsResolver).
import { fetchScimMe, workspaceHost } from './authz.ts'
import { logger } from './log.ts'

export const PROJECT_ROLES = Object.freeze(['view', 'manage', 'owner'])
const RANK = { view: 1, manage: 2, owner: 3 }

/** 3 owner, 2 manage, 1 view, 0 anything else (not a member). */
export function roleRank(role?: unknown): number {
  return (typeof role === 'string' && (RANK as Record<string, number>)[role]) || 0 // string-keyed on purpose: same lookup as the JS
}

/** The role name for a rank from ai_prism.aip_project_rank (NULL → null). */
export function roleOfRank(rank?: unknown): string | null {
  return PROJECT_ROLES[Number(rank) - 1] || null
}

// minimum role per action (D4)
const NEEDS = Object.freeze({
  read: 'view',
  post: 'view',
  attachSession: 'view',
  editProject: 'manage',
  manageMembers: 'manage',
  manageFiles: 'manage',
  detachSession: 'manage',
  deleteProject: 'owner',
})

/** HTTP status for `role` doing `action`: 200 allowed, 403 member without the role, 404 non-member. */
export function decide(role: unknown, action: unknown): 200 | 403 | 404 {
  if (!roleRank(role)) return 404
  const need = (NEEDS as Record<string, string | undefined>)[action as string]
  if (!need) return 403
  return roleRank(role) >= roleRank(need) ? 200 : 403
}

/** May an `actorRole` give (or take away) the role `targetRole`? manage up to manage, owner anything. */
export function canAssignRole(actorRole: unknown, targetRole: unknown): boolean {
  if (!roleRank(targetRole) || roleRank(actorRole) < RANK.manage) return false
  return targetRole === 'owner' ? actorRole === 'owner' : true
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/** A member principal, normalised (trimmed, lowercased), or null when invalid. */
export function normalizePrincipal(kind: unknown, principal: unknown): string | null {
  if (typeof principal !== 'string' || CONTROL_RE.test(principal)) return null
  const p = principal.trim().toLowerCase()
  if (!p || p.length > 256) return null
  if (kind === 'user') return EMAIL_RE.test(p) ? p : null
  if (kind === 'group') return p
  return null
}

// ---- SCIM groups (fail closed) ------------------------------------------------

/**
 * A SCIM body that says its `groups` list is a page of something bigger:
 * totalResults beyond the list, a page size below the total, or a page that
 * does not start at 1. Any of these is a partial answer: no grant.
 */
export function isPartialList(d: { groups: unknown[]; totalResults?: unknown; itemsPerPage?: unknown; startIndex?: unknown }): boolean {
  const n = d.groups.length
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const total = num(d.totalResults)
  const perPage = num(d.itemsPerPage)
  const start = num(d.startIndex)
  return (total !== null && total > n) || (perPage !== null && total !== null && perPage < total) || (start !== null && start > 1)
}

export const GROUPS_TTL_MS = 5 * 60 * 1000
export const GROUPS_FAIL_TTL_MS = 30 * 1000
const GROUPS_TIMEOUT_MS = 3000
const MAX_ENTRIES = 5000

/**
 * (email, token) → lowercased group names; [] on ANY failure. Successes are
 * cached per e-mail for ttlMs, failures for failTtlMs (an outage costs one
 * lookup per user per 30 s, then recovers on its own). Concurrent lookups of
 * one e-mail share one SCIM call.
 */
export function createGroupResolver({
  fetchImpl = fetch,
  host = workspaceHost,
  now = Date.now,
  ttlMs = GROUPS_TTL_MS,
  failTtlMs = GROUPS_FAIL_TTL_MS,
  timeoutMs = GROUPS_TIMEOUT_MS,
  log = (msg: string) => logger.warn(msg),
}: {
  fetchImpl?: typeof fetch
  host?: () => string
  now?: () => number
  ttlMs?: number
  failTtlMs?: number
  timeoutMs?: number
  log?: (msg: string) => unknown
} = {}) {
  const cache = new Map<string, { exp: number; value: Promise<string[]> }>() // email -> entry

  async function lookup(token: string): Promise<{ ok: boolean; groups: string[]; why?: string }> {
    const base = host()
    if (!base) return { ok: false, groups: [] }
    // an explicit timer (cleared below), not AbortSignal.timeout: the lookup must
    // settle even when nothing else keeps the event loop alive
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error(`SCIM /Me timed out after ${timeoutMs} ms`)), timeoutMs)
    try {
      const res = await fetchScimMe(token, { attributes: 'groups', fetchImpl, base, signal: ctrl.signal })
      // only a 200 is a complete answer: 206 Partial Content (or any other 2xx)
      // would grant from a list that is known to be incomplete
      if (res.status !== 200) return { ok: false, groups: [], why: `HTTP ${res.status}` }
      const d = await res.json()
      if (!d || !Array.isArray(d.groups)) return { ok: false, groups: [], why: 'no groups array' }
      if (isPartialList(d)) return { ok: false, groups: [], why: 'partial groups list' }
      const groups = new Set<string>()
      for (const g of d.groups) {
        if (!g || typeof g !== 'object' || Array.isArray(g)) return { ok: false, groups: [], why: 'malformed group entry' }
        // an entry without a display name is skipped: it can only grant less
        if (typeof g.display === 'string' && g.display.trim()) groups.add(g.display.trim().toLowerCase())
      }
      return { ok: true, groups: [...groups] }
    } catch (e) {
      return { ok: false, groups: [], why: (e as { message?: string } | null)?.message || 'error' }
    } finally {
      clearTimeout(timer)
    }
  }

  return async function resolve(email?: unknown, token?: string | null): Promise<string[]> {
    const key = typeof email === 'string' ? email.trim().toLowerCase() : ''
    if (!key || !token || !host()) return []
    const hit = cache.get(key)
    if (hit && hit.exp > now()) return hit.value
    const entry: { exp: number; value: Promise<string[]> } = {
      exp: now() + failTtlMs,
      value: null as unknown as Promise<string[]>, // assigned on the next line, before anything reads it
    }
    entry.value = lookup(token).then((r) => {
      entry.exp = now() + (r.ok ? ttlMs : failTtlMs)
      if (!r.ok) log(`access: SCIM groups unavailable (${r.why || 'no host'}); project group grants are off for this user (fail closed)`)
      return r.groups
    })
    cache.delete(key)
    cache.set(key, entry)
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string) // size > 0 here: the oldest key exists
    return entry.value
  }
}

/** The process-wide resolver withTx uses (registered by server/db/projects.js). */
export const projectGroups = createGroupResolver()
