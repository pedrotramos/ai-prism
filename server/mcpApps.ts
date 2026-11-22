// MCP Apps host, the server half (W4-5). Design: .megabrain/parity-ux/design-w4.md Part 2, ADR-0019, docs/mcp-apps.md.
//
// When an MCP tool the model called declares `_meta.ui.resourceUri` (SEP-1865), the host reads that `ui://` resource once, stores
// the HTML with the call, and the chat offers it as an interactive View. The View runs in a sandboxed iframe served by
// GET /api/mcp-apps/view/:id (server/routes/mcpApps.ts) with a CSP header built here, from the lists the server declared, filtered.
//
// Pure helpers and one fetch. Nothing here imports @modelcontextprotocol/ext-apps (client only): the two spec literals live in
// server/mcpAppsConstants.ts and the tests pin them.
import { createHash } from 'node:crypto'
import { readMcpResource } from './mcpClient.ts'
import type { McpResourceContent } from './mcpClient.ts'
import { MCP_APP_MIME, MCP_APP_EXTENSION_ID } from './mcpAppsConstants.ts'
import { toolUiMeta } from './mcpAppsMeta.ts'
import type { McpUiMeta } from './mcpAppsMeta.ts'

export { MCP_APP_MIME, MCP_APP_EXTENSION_ID, toolUiMeta }
export type { McpUiMeta }

export const MCP_APPS_LIMITS = Object.freeze({
  htmlMaxBytes: 1048576,
  structuredMaxBytes: 262144,
  sourcesPerDirective: 32,
  cspMaxChars: 4096,
  appsPerTurn: 4,
} as const)

/** The origins a View may contact, as the server declared them (`_meta.ui.csp`) after sanitizing. */
export interface McpUiCsp {
  connectDomains: string[]
  resourceDomains: string[]
  frameDomains: string[]
  baseUriDomains: string[]
}

/** What is stored with the tool call (chat_tool_calls.ui_resource) and what the routes serve. */
export interface UiResourceRecord {
  v: 1
  uri: string
  serviceName: string
  toolName: string
  html: string
  csp: McpUiCsp
  prefersBorder: boolean
  sha256: string
  fetchedAt: string
  structuredContent: unknown | null
}

export type UiFetchError = { error: 'mime' | 'size' | 'not_found' | 'timeout' | 'rpc' }

export interface UiHosts {
  /** the host of this app (never a legal CSP source for a View) */
  appHost: string
  /** the workspace host (the same) */
  workspaceHost: string
}

// ---- tool visibility (SEP-1865: _meta.ui.visibility) -------------------------------------------------------------------

/** A tool is offered to the model unless its visibility leaves 'model' out (an app-only tool). */
export function isModelVisible(tool: { _meta?: unknown }): boolean {
  const meta = toolUiMeta(tool)
  return !meta || meta.visibility.includes('model')
}

/** A View may call a tool only when the server declared it and its visibility includes 'app'. */
export function isAppVisible(tool: { _meta?: unknown }): boolean {
  const meta = toolUiMeta(tool)
  return !!meta && meta.visibility.includes('app')
}

// ---- CSP -------------------------------------------------------------------------------------------------------------

// https://host[:port] or https://*.host[:port]; host = at least two DNS labels. No path, query, userinfo, quote, semicolon or space.
const ORIGIN = /^https:\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(:\d{1,5})?$/
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
// hosts of the platform that carries this app: never a source a View may talk to, whatever a server declares
const PLATFORM_SUFFIXES = ['databricksapps.com', 'cloud.databricks.com', 'azuredatabricks.net', 'gcp.databricks.com']
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

const hostOf = (h: string): string => {
  const s = String(h || '').trim().toLowerCase()
  if (!s) return ''
  try {
    return new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname
  } catch {
    return ''
  }
}
const isOrUnder = (host: string, suffix: string): boolean => host === suffix || host.endsWith(`.${suffix}`)

/**
 * Keeps the entries a View may be allowed to contact: `https://host[:port]` and `https://*.host[:port]`, lowercased, deduped, in
 * order, at most 32. It drops everything else: other schemes, quotes, semicolons, spaces, paths, queries, userinfo, bare
 * wildcards (`*`, `https://*.com`), IP literals, this app's host, the workspace host, any Databricks host, and a wildcard that
 * would cover any of those.
 */
export function sanitizeCspDomains(list: unknown, hosts: UiHosts): string[] {
  if (!Array.isArray(list)) return []
  const app = hostOf(hosts?.appHost)
  const ws = hostOf(hosts?.workspaceHost)
  const out: string[] = []
  for (const raw of list) {
    if (typeof raw !== 'string' || raw.length > 253 + 12) continue
    const m = ORIGIN.exec(raw.toLowerCase())
    if (!m) continue
    const wildcard = !!m[1]
    const host = m[2] as string
    if (!host.split('.').every((l) => LABEL.test(l))) continue
    if (IPV4.test(host)) continue
    // a wildcard covers the host itself and everything under it; an exact entry only itself
    const covers = (target: string) => !!target && (wildcard ? isOrUnder(target, host) : target === host)
    if (covers(app) || covers(ws)) continue
    if (PLATFORM_SUFFIXES.some((s) => isOrUnder(host, s) || (wildcard && isOrUnder(s, host)))) continue
    const entry = `https://${wildcard ? '*.' : ''}${host}${m[3] || ''}`
    if (!out.includes(entry)) out.push(entry)
    if (out.length >= MCP_APPS_LIMITS.sourcesPerDirective) break
  }
  return out
}

const NO_HOSTS: UiHosts = { appHost: '', workspaceHost: '' }

/** The four declared lists, sanitized, and as a whole at most `cspMaxChars` characters (later entries are dropped first). */
export function sanitizeCsp(csp: Partial<Record<keyof McpUiCsp, unknown>> | null | undefined, hosts: UiHosts = NO_HOSTS): McpUiCsp {
  const out: McpUiCsp = {
    connectDomains: sanitizeCspDomains(csp?.connectDomains, hosts),
    resourceDomains: sanitizeCspDomains(csp?.resourceDomains, hosts),
    frameDomains: sanitizeCspDomains(csp?.frameDomains, hosts),
    baseUriDomains: sanitizeCspDomains(csp?.baseUriDomains, hosts),
  }
  let budget = MCP_APPS_LIMITS.cspMaxChars
  for (const key of ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const) {
    const kept: string[] = []
    for (const d of out[key]) {
      if (d.length + 1 > budget) break
      budget -= d.length + 1
      kept.push(d)
    }
    out[key] = kept
  }
  return out
}

const list = (head: string[], extra: string[]): string => [...head, ...extra].join(' ')

/**
 * The Content-Security-Policy of a View document. It starts with `sandbox allow-scripts allow-forms` (an opaque origin even when
 * opened top level), denies everything by default and opens only the declared origins. Never 'self' (except frame-ancestors,
 * so this app can frame it), never 'unsafe-eval', never allow-same-origin. The lists are sanitized again here, so a caller that
 * forgot cannot widen the policy.
 */
export function buildViewCsp(csp: Partial<Record<keyof McpUiCsp, unknown>> | null | undefined, hosts: UiHosts = NO_HOSTS): string {
  const c = sanitizeCsp(csp, hosts)
  const connect = c.connectDomains.length ? c.connectDomains.join(' ') : "'none'"
  const frame = c.frameDomains.length ? c.frameDomains.join(' ') : "'none'"
  const base = c.baseUriDomains.length ? c.baseUriDomains.join(' ') : "'none'"
  return [
    'sandbox allow-scripts allow-forms',
    "default-src 'none'",
    `script-src ${list(["'unsafe-inline'"], c.resourceDomains)}`,
    `style-src ${list(["'unsafe-inline'"], c.resourceDomains)}`,
    `img-src ${list(['data:', 'blob:'], c.resourceDomains)}`,
    `font-src ${list(['data:'], c.resourceDomains)}`,
    `media-src ${list(['data:', 'blob:'], c.resourceDomains)}`,
    `connect-src ${connect}`,
    `frame-src ${frame}`,
    `base-uri ${base}`,
    `form-action ${connect}`,
    "object-src 'none'",
    "frame-ancestors 'self'",
  ].join('; ')
}

/** The response headers of the view route, exactly (design section 2.4). */
export function viewResponseHeaders(csp: Partial<Record<keyof McpUiCsp, unknown>> | null | undefined, hosts: UiHosts = NO_HOSTS): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': buildViewCsp(csp, hosts),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  }
}

/** The app host and the workspace host this process knows from its environment (a route adds the request's own Host). */
export function uiHostsFromEnv(env: Record<string, string | undefined> = process.env): UiHosts {
  return { appHost: hostOf(env.DATABRICKS_APP_URL || ''), workspaceHost: hostOf(env.DATABRICKS_HOST || '') }
}

// ---- the setting -----------------------------------------------------------------------------------------------------

/** Off unless an admin turned it on; the env kill-switch MCP_APPS_DISABLED=1 wins over the setting. */
export function mcpAppsEnabled(env: Record<string, string | undefined>, settings: { mcpAppsEnabled?: boolean } | null | undefined): boolean {
  if (env.MCP_APPS_DISABLED === '1') return false
  return settings?.mcpAppsEnabled === true
}

// ---- reading the resource --------------------------------------------------------------------------------------------

export interface FetchUiOptions {
  serviceName: string
  toolName: string
  appHost?: string
  workspaceHost?: string
  /** the original call's structuredContent, kept with the record when at most 256 KiB */
  structuredContent?: unknown
  signal?: AbortSignal | null
  timeoutMs?: number
  now?: () => Date
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * `resources/read` of `uri` on the service, as the record the host stores. A resource whose MIME is not exactly
 * `text/html;profile=mcp-app`, that is over 1 MiB, that is missing or that takes too long is `{ error: code }`: the caller keeps
 * the plain tool result and logs the code.
 */
export async function fetchUiResource(url: string, token: string, uri: string, o: FetchUiOptions): Promise<UiResourceRecord | UiFetchError> {
  let contents: McpResourceContent[]
  try {
    contents = await readMcpResource(url, token, uri, { timeoutMs: o.timeoutMs ?? 5000, signal: o.signal ?? null })
  } catch (e) {
    const err = e as { code?: unknown; name?: string }
    if (err?.name === 'AbortError') throw e
    if (err?.code === 'timeout' || err?.code === -32001) return { error: 'timeout' }
    if (err?.code === -32002) return { error: 'not_found' }
    return { error: 'rpc' }
  }
  const item = contents.find((c) => c?.uri === uri) || contents[0]
  if (!item) return { error: 'not_found' }
  if (item.mimeType !== MCP_APP_MIME) return { error: 'mime' }
  let html: string
  if (typeof item.text === 'string') html = item.text
  else if (typeof item.blob === 'string') html = Buffer.from(item.blob, 'base64').toString('utf8')
  else return { error: 'not_found' }
  if (Buffer.byteLength(html, 'utf8') > MCP_APPS_LIMITS.htmlMaxBytes) return { error: 'size' }
  const ui = isObj(item._meta) && isObj(item._meta.ui) ? item._meta.ui : {}
  const hosts: UiHosts = { appHost: o.appHost ?? '', workspaceHost: o.workspaceHost ?? '' }
  let structuredContent: unknown = null
  if (o.structuredContent != null) {
    let size = Infinity
    try {
      size = Buffer.byteLength(JSON.stringify(o.structuredContent), 'utf8')
    } catch {}
    if (size <= MCP_APPS_LIMITS.structuredMaxBytes) structuredContent = o.structuredContent
  }
  return {
    v: 1,
    uri,
    serviceName: o.serviceName,
    toolName: o.toolName,
    html,
    csp: sanitizeCsp(isObj(ui.csp) ? ui.csp : null, hosts),
    prefersBorder: typeof ui.prefersBorder === 'boolean' ? ui.prefersBorder : true,
    sha256: createHash('sha256').update(html).digest('hex'),
    fetchedAt: (o.now ? o.now() : new Date()).toISOString(),
    structuredContent,
  }
}
