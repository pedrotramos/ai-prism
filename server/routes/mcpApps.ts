// MCP Apps routes (W4-5). Design: .megabrain/parity-ux/design-w4.md section 2.4, docs/mcp-apps.md, ADR-0019.
//
//   GET  /api/mcp-apps/status                   { enabled }            every signed-in user: should the chat show the placeholder?
//   GET  /api/mcp-apps/view/:toolCallId         the stored HTML        only for an iframe (Sec-Fetch-Dest: iframe), with the View's own CSP
//   GET  /api/mcp-apps/:toolCallId/context      { toolInput, toolResult, serviceName, toolName, csp }   what the host bridge sends the View
//   POST /api/mcp-apps/:toolCallId/tools/call   { name, arguments, serviceName? } -> the tool result      a View's own call, admitted like a model call
//   GET/PUT /api/admin/mcp-apps/settings        { enabled, envDisabled }   admin; the switch is audited
//
// Off by default: the setting is absent, and MCP_APPS_DISABLED=1 wins. While off every route but the settings answers 404
// mcp_apps_disabled and nothing reaches an MCP service. A row is readable by the owner of its chat and a member of its project, and by
// nobody else: an id that is not yours answers the same 404 as an id that does not exist. Answers carry a stable `code`.
//
// The view route NEVER sends the app's global policy: it replaces it with the policy built from the sanitized lists the server declared
// (viewResponseHeaders). The HTML is the stored snapshot, untransformed.
import { authed } from './authed.ts'
import type { Express, Request, RequestHandler, Response } from 'express'
import { auth as realAuth } from '../middleware/auth.ts'
import { requireAdmin as realRequireAdmin } from '../middleware/requireAdmin.ts'
import { tokenBucket } from '../middleware/rateLimit.ts'
import * as realDb from '../db/mcpApps.ts'
import { invalidateMcpAppsSetting } from '../mcpAppsSetting.ts'
import { CspTooLongError, isAppVisible, mcpAppsEnabled, uiHostsFromEnv, viewResponseHeaders } from '../mcpApps.ts'
import type { UiHosts } from '../mcpApps.ts'
import { admitMcpConnection, externalMcpUrl, getMcpCatalog, getHiddenMcpNames } from '../externalMcp.ts'
import { callMcpTool, listMcpServerCached, McpToolError } from '../mcpClient.ts'
import { getToolPolicy } from '../db.ts'
import { logger } from '../log.ts'

type Env = Record<string, string | undefined>
type Handler = (req: Request, res: Response) => Promise<unknown>

/** The slice of server/db/mcpApps.ts the routes use (injectable for tests). */
export type McpAppsDb = Pick<typeof realDb, 'readMcpAppsSetting' | 'writeMcpAppsSetting' | 'getUiToolCall'>

/** What the routes need of the MCP side (injectable for tests). */
export interface McpAppsServicePort {
  url(serviceName: string): string
  admit(token: string, email: string, serviceName: string): Promise<{ ok: boolean; credentialClass?: string; code?: string }>
  toolPolicy(email: string, token: string): Promise<Record<string, boolean>>
  hiddenServices(email: string, token: string): Promise<Set<string>>
  listTools(url: string, token: string, key: string): Promise<{ name: string; _meta?: unknown }[]>
  callTool(url: string, token: string, name: string, args: Record<string, unknown>, o: { timeoutMs: number }): Promise<{ text: string; structuredContent: Record<string, unknown> | null }>
}

export interface McpAppsRouteDeps {
  auth?: RequestHandler
  requireAdmin?: RequestHandler
  env?: Env
  db?: McpAppsDb
  service?: McpAppsServicePort
  hosts?: (req: Request) => UiHosts
  /** View tool calls per user per minute (default 60) */
  ratePerMin?: number
}

const TOOL_TIMEOUT_MS = 20_000
const RESULT_MAX_BYTES = 1048576
const ARGS_MAX_BYTES = 65536
const NAME_MAX = 200

const defaultService: McpAppsServicePort = {
  url: (name) => externalMcpUrl(name),
  admit: async (token, email, name) => admitMcpConnection(token, email, name, { catalog: await getMcpCatalog(email, token).catch(() => []) }),
  toolPolicy: (email, token) => getToolPolicy(email, token),
  hiddenServices: (email, token) => getHiddenMcpNames(email, token),
  listTools: async (url, token, key) => (await listMcpServerCached(url, token, key, { timeoutMs: 8000, ui: true }))?.tools ?? [],
  callTool: (url, token, name, args, o) => callMcpTool(url, token, name, args, { timeoutMs: o.timeoutMs, throwOnError: true }),
}

function sendCode(res: Response, status: number, code: string, extra: Record<string, unknown> = {}) {
  return res.status(status).json({ error: code, code, ...extra })
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const ID = /^\d{1,18}$/

export default function registerMcpAppsRoutes(app: Express, deps: McpAppsRouteDeps = {}) {
  const auth = deps.auth || realAuth
  const requireAdmin = deps.requireAdmin || realRequireAdmin
  const env = deps.env || process.env
  const db: McpAppsDb = deps.db || realDb
  const service = deps.service || defaultService
  const bucket = tokenBucket({ perMinute: deps.ratePerMin ?? 60 })
  const hostsOf =
    deps.hosts ||
    ((req: Request): UiHosts => {
      const fromEnv = uiHostsFromEnv(env)
      return { appHost: fromEnv.appHost || String(req.get('host') || ''), workspaceHost: fromEnv.workspaceHost }
    })

  const who = (req: Request) => authed(req)
  const enabledFor = async (req: Request): Promise<boolean> => {
    if (env.MCP_APPS_DISABLED === '1') return false
    return mcpAppsEnabled(env, { mcpAppsEnabled: await db.readMcpAppsSetting(who(req).email, who(req).token) })
  }

  // Logs carry codes only: never the error object or its message (an MCP server's text may hold tool or user data)
  const codeOf = (e: unknown): string | number => {
    const c = (e as { code?: unknown } | null | undefined)?.code
    return typeof c === 'number' || (typeof c === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(c)) ? c : 'unknown'
  }
  const fail = (res: Response, e: unknown, what: string) => {
    logger.warn(`${what} failed code=${codeOf(e)}`)
    return sendCode(res, 500, 'internal_error')
  }

  /** Feature gate first (404, no query on the row), then the handler, whose failures become a coded 500. */
  const gated = (what: string, fn: Handler): RequestHandler => async (req, res) => {
    try {
      if (!(await enabledFor(req))) return sendCode(res, 404, 'mcp_apps_disabled')
      await fn(req, res)
    } catch (e) {
      fail(res, e, what)
    }
  }

  const rowOf = async (req: Request, res: Response) => {
    const id = String(req.params.toolCallId || '')
    const row = ID.test(id) ? await db.getUiToolCall(who(req).email, who(req).token, id) : null
    if (!row) sendCode(res, 404, 'not_found')
    return row
  }

  app.get('/api/mcp-apps/status', auth, async (req, res) => {
    try {
      res.json({ enabled: await enabledFor(req) })
    } catch (e) {
      fail(res, e, 'mcp apps status')
    }
  })

  // The View document. Only an iframe may load it: a navigation or a script fetch is refused before the row is read.
  app.get('/api/mcp-apps/view/:toolCallId', auth, gated('mcp apps view', async (req, res) => {
    if (req.get('sec-fetch-dest') !== 'iframe') return sendCode(res, 400, 'bad_fetch_dest')
    const row = await rowOf(req, res)
    if (!row) return
    // defence in depth: a stored record whose policy is over the cap (a row from before a rule change) is refused, not shortened
    let headers: Record<string, string>
    try {
      headers = viewResponseHeaders(row.ui.csp, hostsOf(req))
    } catch (e) {
      if (e instanceof CspTooLongError) return sendCode(res, 422, 'csp_too_long')
      throw e
    }
    // the app-wide report-only policy and its reporting endpoint do not apply to a View
    res.removeHeader('Content-Security-Policy-Report-Only')
    res.removeHeader('Reporting-Endpoints')
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
    res.status(200).send(row.ui.html)
  }))

  app.get('/api/mcp-apps/:toolCallId/context', auth, gated('mcp apps context', async (req, res) => {
    const row = await rowOf(req, res)
    if (!row) return
    try {
      viewResponseHeaders(row.ui.csp, hostsOf(req))
    } catch (e) {
      if (e instanceof CspTooLongError) return sendCode(res, 422, 'csp_too_long')
      throw e
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      toolInput: row.args ?? {},
      toolResult: { content: [{ type: 'text', text: row.result ?? '' }], structuredContent: row.ui.structuredContent ?? null },
      serviceName: row.ui.serviceName,
      toolName: row.ui.toolName,
      csp: row.ui.csp,
    })
  }))

  // A View's own tool call. Same rules as a model call: the service's credential class, the org tool policy, a hidden service, and the
  // REQUESTING user's token. Only a tool the server marked callable by an app, on the service the App came from. Never persisted.
  app.post('/api/mcp-apps/:toolCallId/tools/call', auth, gated('mcp apps tool call', async (req, res) => {
    const row = await rowOf(req, res)
    if (!row) return
    const body = isObj(req.body) ? req.body : {}
    const { name, arguments: args, serviceName } = body
    if (typeof name !== 'string' || !name || name.length > NAME_MAX) return sendCode(res, 400, 'bad_request')
    if (args !== undefined && !isObj(args)) return sendCode(res, 400, 'bad_request')
    const callArgs = (args ?? {}) as Record<string, unknown>
    if (Buffer.byteLength(JSON.stringify(callArgs), 'utf8') > ARGS_MAX_BYTES) return sendCode(res, 400, 'bad_request')
    if (serviceName !== undefined && serviceName !== row.ui.serviceName) return sendCode(res, 403, 'wrong_service')
    if (!bucket.take(who(req).email).ok) return sendCode(res, 429, 'rate_limited')

    const svc = row.ui.serviceName
    const { email, token } = who(req)
    if ((await service.hiddenServices(email, token).catch(() => new Set<string>())).has(svc)) return sendCode(res, 403, 'service_hidden')
    if ((await service.toolPolicy(email, token).catch(() => ({} as Record<string, boolean>)))['mcp-external'] === false) return sendCode(res, 403, 'tool_group_disabled')
    const admission = await service.admit(token, email, svc)
    if (!admission.ok) return sendCode(res, 403, admission.code || 'credential_unverified')

    const url = service.url(svc)
    let listed: { name: string; _meta?: unknown }[]
    try {
      listed = await service.listTools(url, token, email)
    } catch (e) {
      logger.warn(`mcp apps tool list failed code=${codeOf(e)} service=${svc}`)
      return sendCode(res, 502, 'upstream_error')
    }
    const tool = listed.find((t) => t.name === name)
    if (!tool) return sendCode(res, 403, 'tool_not_found')
    if (!isAppVisible(tool)) return sendCode(res, 403, 'tool_not_app_visible')

    try {
      const out = await service.callTool(url, token, name, callArgs, { timeoutMs: TOOL_TIMEOUT_MS })
      const answer = { content: [{ type: 'text', text: out.text }], ...(out.structuredContent ? { structuredContent: out.structuredContent } : {}) }
      if (Buffer.byteLength(JSON.stringify(answer), 'utf8') > RESULT_MAX_BYTES) return sendCode(res, 502, 'result_too_large')
      logger.info(`mcp apps tool call ok service=${svc}`)
      return res.json(answer)
    } catch (e) {
      const err = e as { code?: unknown; message?: string }
      if (err?.code === 'timeout') return sendCode(res, 504, 'timeout')
      const message = String(err?.message || '')
      // the tool reported an error, or the gateway wants a login (per-user consent): a result the View can show
      if (e instanceof McpToolError && err.code === 'tool_error') return res.json({ isError: true, content: [{ type: 'text', text: message }] })
      if (err?.code === 401 || err?.code === 403 || /unauth|login|consent|authorize/i.test(message)) {
        return res.json({ isError: true, content: [{ type: 'text', text: message.slice(0, 2000) }] })
      }
      logger.warn(`mcp apps tool call failed code=${codeOf(e)} service=${svc}`)
      return sendCode(res, 502, 'upstream_error')
    }
  }))

  // ---- admin ----------------------------------------------------------------------------------------------------
  const settings = async (req: Request) => ({ enabled: await db.readMcpAppsSetting(who(req).email, who(req).token), envDisabled: env.MCP_APPS_DISABLED === '1' })

  app.get('/api/admin/mcp-apps/settings', auth, requireAdmin, async (req, res) => {
    try {
      res.json(await settings(req))
    } catch (e) {
      fail(res, e, 'mcp apps settings read')
    }
  })

  app.put('/api/admin/mcp-apps/settings', auth, requireAdmin, async (req, res) => {
    try {
      const body = req.body
      if (!isObj(body) || Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') return sendCode(res, 400, 'invalid_setting')
      await db.writeMcpAppsSetting(who(req).email, who(req).token, body.enabled)
      invalidateMcpAppsSetting()
      res.json(await settings(req))
    } catch (e) {
      fail(res, e, 'mcp apps settings write')
    }
  })
}

