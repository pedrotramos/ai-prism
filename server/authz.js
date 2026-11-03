// App-level authorization: the OWNER comes from env (APP_OWNER_EMAIL in
// app.yaml), further admins from the app_admins table — either user emails
// (guaranteed path, no extra scopes) or workspace group display names,
// resolved through SCIM /Me with the caller's own forwarded token. A SCIM
// failure (e.g. missing IAM scope on the app) degrades gracefully: group
// admins simply don't match, email admins keep working.
import { listAppAdmins, appServiceToken } from './db.js'

function host() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

const GROUPS_TTL_MS = 5 * 60 * 1000
const ADMINS_TTL_MS = 30 * 1000
const groupsCache = new Map() // email -> { groups: Set<string>, ts }
let adminsCache = { rows: null, ts: 0 }
let scimOk = true

export function ownerEmail() {
  return (process.env.APP_OWNER_EMAIL || process.env.DATABRICKS_USER_EMAIL || '').trim().toLowerCase()
}

export function isOwner(email) {
  const owner = ownerEmail()
  return !!owner && !!email && email.trim().toLowerCase() === owner
}

export function invalidateAdminsCache() {
  adminsCache = { rows: null, ts: 0 }
}

async function cachedAdmins(email, token) {
  if (adminsCache.rows && Date.now() - adminsCache.ts < ADMINS_TTL_MS) return adminsCache.rows
  const rows = await listAppAdmins(email, token)
  adminsCache = { rows, ts: Date.now() }
  return rows
}

export async function userGroups(email, token) {
  const hit = groupsCache.get(email)
  if (hit && Date.now() - hit.ts < GROUPS_TTL_MS) return hit.groups
  const groups = new Set()
  try {
    const res = await fetch(`${host()}/api/2.0/preview/scim/v2/Me?attributes=groups`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      const d = await res.json()
      for (const g of d.groups || []) if (g?.display) groups.add(String(g.display).toLowerCase())
      scimOk = true
    } else {
      scimOk = false
    }
  } catch {
    scimOk = false
  }
  groupsCache.set(email, { groups, ts: Date.now() })
  return groups
}

// what the admin UI shows next to the group form — 'unavailable' means the
// forwarded token can't call SCIM /Me (scope missing) so group membership
// can't be verified in this deployment
export function groupCheckStatus() {
  return scimOk ? 'ok' : 'unavailable'
}

// Users/groups that already have CAN_USE/CAN_MANAGE on this app (Databricks
// Apps permissions API) — the natural universe of admin candidates, surfaced
// as autocomplete in the admin panel.
//
// Read preferentially with the APP SERVICE-PRINCIPAL token (client_credentials,
// scope all-apis). The signed-in user's OBO token is DOWNSCOPED and gets blocked
// from the access-management API family (GET /permissions/apps/*) even when
// iam.access-control:read shows in the app's effective scopes — the call 403s
// and the panel showed zero suggestions. The app SP can always read its OWN
// app's ACL, so it's the reliable source. Fall back to the caller's token for
// local dev (no SP creds) where the developer's own token is full-scoped.
const CANDIDATES_TTL_MS = 5 * 60 * 1000
let candidatesCache = { list: null, ts: 0 }

async function fetchAppAcl(appName, token, label) {
  if (!token) return null
  try {
    const res = await fetch(`${host()}/api/2.0/permissions/apps/${encodeURIComponent(appName)}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      console.warn(`authz: app ACL read via ${label} -> HTTP ${res.status}`)
      return null
    }
    return await res.json()
  } catch (e) {
    console.warn(`authz: app ACL read via ${label} threw: ${e.message}`)
    return null
  }
}

export async function appAccessCandidates(token) {
  if (candidatesCache.list && Date.now() - candidatesCache.ts < CANDIDATES_TTL_MS) return candidatesCache.list
  const appName = process.env.DATABRICKS_APP_NAME
  if (!appName) return []
  // Try the app SP token first (all-apis, not downscoped), then the caller's
  // own OBO token — whichever can actually read the app's ACL wins. Logging the
  // per-token status makes a persistently empty list diagnosable.
  const spToken = await appServiceToken().catch(() => null)
  const d =
    (await fetchAppAcl(appName, spToken, 'sp')) ||
    (await fetchAppAcl(appName, token, 'obo'))
  if (!d) return []
  const rank = { CAN_MANAGE: 2, CAN_USE: 1 }
  const list = []
  for (const acl of d.access_control_list || []) {
    const levels = (acl.all_permissions || []).map((p) => p.permission_level)
    const best = levels.sort((a, b) => (rank[b] || 0) - (rank[a] || 0))[0]
    if (!rank[best]) continue
    if (acl.user_name) list.push({ kind: 'user', principal: acl.user_name, display: acl.display_name || '', level: best })
    else if (acl.group_name) list.push({ kind: 'group', principal: acl.group_name, display: '', level: best })
    // service principals can't sign in to the UI — not admin material
  }
  candidatesCache = { list, ts: Date.now() }
  console.log(`authz: app ACL candidates resolved: ${list.length}`)
  return list
}

// True if `principal` (a user email or group name) currently has CAN_USE/
// CAN_MANAGE on the app — i.e. is a legitimate admin candidate. Used to gate
// the "add admin" write so you can only promote principals that already have
// app access. Returns { ok, reachable }: `reachable` is false when the ACL
// couldn't be read at all (SP+OBO both failed) — the caller then can't safely
// enforce the check and should surface that rather than silently rejecting.
export async function isAppAccessPrincipal(principal, kind, token) {
  const candidates = await appAccessCandidates(token)
  // an empty list can mean "no one but the owner" OR "couldn't read the ACL".
  // Distinguish: if the read failed, candidatesCache stays null → not reachable.
  const reachable = candidatesCache.list !== null
  if (!reachable) return { ok: false, reachable: false }
  const p = (principal || '').trim().toLowerCase()
  const ok = candidates.some(
    (c) => c.kind === kind && c.principal.trim().toLowerCase() === p
  )
  return { ok, reachable: true }
}

export async function isAdmin(email, token) {
  if (isOwner(email)) return true
  try {
    const admins = await cachedAdmins(email, token)
    const lower = (email || '').trim().toLowerCase()
    if (admins.some((a) => a.kind === 'user' && a.principal.trim().toLowerCase() === lower)) return true
    const groupAdmins = admins.filter((a) => a.kind === 'group')
    if (groupAdmins.length) {
      const groups = await userGroups(email, token)
      if (groupAdmins.some((a) => groups.has(a.principal.trim().toLowerCase()))) return true
    }
  } catch (e) {
    console.warn('authz: falha ao checar admins (assumindo não-admin):', e.message)
  }
  return false
}
