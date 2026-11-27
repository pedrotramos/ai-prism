// Calls to /api/agents* and /api/admin/agents* (W4-4e). A failure keeps the HTTP status and ONE stable code
// (`code`, else an `error` that already is a code); free text from a server is never kept, so a screen can only show
// what the i18n catalogs say for the code (AC5).
import type { AdminAgentRow, AdminVersionRow, AgentLimits, AgentRow, AgentRunRow, AgentSchedule, AgentSettings, AgentShare, AgentStatus, AgentVersion, ShareKind, SharedAgent, ToolOptions } from './agentsLogic.ts'
import type { AgentLang } from './agentsLogic.ts'

export class AgentsApiError extends Error {
  // type-only: `declare` emits no class field, so the constructor's assignment order stays the runtime order
  declare status: number
  declare code: string
  constructor(status: number, code: string) {
    super(code)
    this.name = 'AgentsApiError'
    this.status = status
    this.code = code
  }
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/

async function call<T = unknown>(method: string, url: string, json?: unknown): Promise<T> {
  let r: Response
  try {
    r = await fetch(url, { method, headers: json !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: json !== undefined ? JSON.stringify(json) : undefined })
  } catch {
    throw new AgentsApiError(0, 'network')
  }
  if (r.status === 204) return undefined as T
  // r.json() is `any`: read loosely for `code`/`error`, then handed to the typed caller
  const body = await r.json().catch(() => ({}))
  if (!r.ok) {
    const raw = typeof body?.code === 'string' ? body.code : typeof body?.error === 'string' ? body.error : ''
    throw new AgentsApiError(r.status, CODE.test(raw) ? raw : 'internal_error')
  }
  return body as T
}

const enc = encodeURIComponent
const base = (id: string) => `/api/agents/${enc(id)}`

/**
 * Whether the feature is on for this deployment (AC1). Fail closed: anything but a clean `{enabled: true}`
 * (off, 404, 500, a network failure, a malformed body) reads as "not enabled", so nothing is shown.
 */
export async function fetchAgentsStatus(): Promise<boolean> {
  try {
    const r = await fetch('/api/agents/status')
    if (!r.ok) return false
    const body = await r.json().catch(() => null)
    return body?.enabled === true
  } catch {
    return false
  }
}

export interface SchedulePreview {
  description: string
  next: string[]
}
export type AgentBody = Record<string, unknown>

export const agentsApi = {
  list: () => call<{ agents: AgentRow[]; limits: AgentLimits }>('GET', '/api/agents'),
  create: (body: AgentBody) => call<AgentRow>('POST', '/api/agents', body),
  update: (id: string, body: AgentBody, revision: number) => call<AgentRow>('PATCH', base(id), { ...body, revision }),
  remove: (id: string) => call<void>('DELETE', base(id)),
  submit: (id: string) => call<AgentRow>('POST', `${base(id)}/submit`, {}),
  enable: (id: string) => call<AgentRow>('POST', `${base(id)}/enable`, {}),
  disable: (id: string) => call<AgentRow>('POST', `${base(id)}/disable`, {}),
  run: (id: string) => call<{ run: AgentRunRow }>('POST', `${base(id)}/run`, {}),
  runs: (id: string, o: { before?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (o.before) q.set('before', o.before)
    if (o.limit) q.set('limit', String(o.limit))
    const qs = q.toString()
    return call<{ runs: AgentRunRow[] }>('GET', `${base(id)}/runs${qs ? `?${qs}` : ''}`)
  },
  // versions (0017)
  versions: (id: string, o: { before?: number; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (o.before) q.set('before', String(o.before))
    if (o.limit) q.set('limit', String(o.limit))
    const qs = q.toString()
    return call<{ versions: AgentVersion[]; hasMore: boolean }>('GET', `${base(id)}/versions${qs ? `?${qs}` : ''}`)
  },
  restore: (id: string, version: number) => call<AgentRow>('POST', `${base(id)}/versions/${version}/restore`, {}),
  submitVersion: (id: string, version: number) => call<AgentVersion>('POST', `${base(id)}/versions/${version}/submit`, {}),
  duplicate: (id: string, o: { version?: number; name?: string } = {}) => call<AgentRow>('POST', `${base(id)}/duplicate`, o),
  shares: (id: string) => call<{ shares: AgentShare[] }>('GET', `${base(id)}/shares`),
  share: (id: string, s: { version: number; kind: ShareKind; principal?: string }) => call<AgentShare>('POST', `${base(id)}/shares`, s),
  unshare: (id: string, s: { kind: ShareKind; principal: string }) => call<void>('DELETE', `${base(id)}/shares/${enc(s.kind)}/${enc(s.principal)}`),
  sharedWithMe: () => call<{ agents: SharedAgent[] }>('GET', '/api/agents/shared-with-me'),
  /** The server describes the schedule and lists its next three occurrences; the browser only formats them. */
  previewSchedule: (schedule: AgentSchedule, lang: AgentLang) => call<SchedulePreview>('POST', '/api/agents/schedule-preview', { schedule, lang }),
  /** What an owner may put on an agent (admitted kinds + Databricks-managed catalog services). A failure rejects: no partial list. */
  toolOptions: async (): Promise<ToolOptions> => {
    const r = await call<Partial<ToolOptions>>('GET', '/api/agents/tool-options')
    if (!Array.isArray(r.kinds) || !Array.isArray(r.mcp)) throw new AgentsApiError(500, 'internal_error')
    return { kinds: r.kinds, mcp: r.mcp }
  },
  admin: {
    list: (status?: AgentStatus) => call<{ agents: AdminAgentRow[] }>('GET', `/api/admin/agents${status ? `?status=${enc(status)}` : ''}`),
    approve: (id: string, o: { expectedHash: string; days?: number }) => call<AdminAgentRow>('POST', `/api/admin/agents/${enc(id)}/approve`, o),
    reject: (id: string, reason: string) => call<AdminAgentRow>('POST', `/api/admin/agents/${enc(id)}/reject`, { reason }),
    revoke: (id: string, reason?: string) => call<AdminAgentRow>('POST', `/api/admin/agents/${enc(id)}/revoke`, reason ? { reason } : {}),
    versions: (status?: AgentStatus) => call<{ versions: AdminVersionRow[] }>('GET', `/api/admin/agent-versions${status ? `?status=${enc(status)}` : ''}`),
    approveVersion: (id: string, version: number, expectedHash: string) => call<AdminVersionRow>('POST', `/api/admin/agent-versions/${enc(id)}/${version}/approve`, { expectedHash }),
    rejectVersion: (id: string, version: number, reason: string) => call<AdminVersionRow>('POST', `/api/admin/agent-versions/${enc(id)}/${version}/reject`, { reason }),
    revokeVersion: (id: string, version: number, reason?: string) => call<AdminVersionRow>('POST', `/api/admin/agent-versions/${enc(id)}/${version}/revoke`, reason ? { reason } : {}),
    settings: () => call<AgentSettings>('GET', '/api/admin/agents/settings'),
    saveSettings: (patch: Partial<Pick<AgentSettings, 'enabled' | 'maxRunCostUsd' | 'approvalDays'>>) => call<AgentSettings>('PUT', '/api/admin/agents/settings', patch),
  },
}
