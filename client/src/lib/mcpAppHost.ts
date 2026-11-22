// The host side of an MCP App View (W4-5). Design: .megabrain/parity-ux/design-w4.md section 2.4, docs/mcp-apps.md, ADR-0019.
//
// One View = one iframe (sandbox="allow-scripts allow-forms", an opaque origin) + one AppBridge from @modelcontextprotocol/ext-apps
// pinned at 1.7.5. The bridge talks to the View over postMessage through PostMessageTransport(win, win): the message listener
// accepts a message only when `event.source` is the View's own window. Nothing here compares an origin string (an opaque origin has
// none worth comparing).
//
// What the host answers a View, and how:
//   tools/call          asks the user first (service, tool, FULL arguments); over 16 KiB of arguments is refused, never truncated
//   ui/message          text into the composer; the user presses Send (never auto-sent)
//   ui/open-link        https only, behind a confirmation that shows the URL, opened noopener,noreferrer
//   ui/size-changed     the iframe height, clamped to 80..640
//   display-mode        always inline
// The bridge library is loaded when a View opens, not with the chat: the app's first paint never pays for it.
import type { AppBridge as AppBridgeType } from '@modelcontextprotocol/ext-apps/app-bridge'

export const MCP_APP_LIMITS = Object.freeze({ minHeight: 80, maxHeight: 640, maxActive: 3 } as const)
/** Arguments a View may pass to a tool call, as JSON (UTF-8 bytes). Over it the call is refused, never truncated. */
export const TOOL_ARGS_MAX_BYTES = 16 * 1024

export interface ViewContext {
  toolInput: unknown
  toolResult: { content: unknown[]; structuredContent: unknown }
  serviceName: string
  toolName: string
  csp: { connectDomains: string[]; resourceDomains: string[]; frameDomains: string[]; baseUriDomains: string[] }
}

export interface ToolCallRequest {
  serviceName: string
  toolName: string
  /** the arguments exactly as the View sent them, pretty printed, nothing cut */
  argumentsText: string
}

interface ToolResultLike {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

const errorResult = (text: string): ToolResultLike => ({ isError: true, content: [{ type: 'text', text }] })

export function clampViewHeight(h: number): number {
  if (!Number.isFinite(h)) return MCP_APP_LIMITS.minHeight
  return Math.min(MCP_APP_LIMITS.maxHeight, Math.max(MCP_APP_LIMITS.minHeight, Math.round(h)))
}

/** `ui/open-link`: https only. The URL is returned normalized so the confirmation shows what will open. */
export function checkOpenLink(raw: unknown): { ok: true; url: string } | { ok: false } {
  if (typeof raw !== 'string' || !raw) return { ok: false }
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && u.hostname ? { ok: true, url: raw } : { ok: false }
  } catch {
    return { ok: false }
  }
}

/** The standardized MCP Apps theme variables, filled from OUR design tokens (no design system of a customer is assumed). */
export function variablesFromTokens(get: (token: string) => string): Record<string, string> {
  const map: Record<string, string> = {
    '--color-background-primary': '--surface',
    '--color-background-secondary': '--surface-2',
    '--color-background-tertiary': '--surface-3',
    '--color-text-primary': '--text',
    '--color-text-secondary': '--muted',
    '--color-border-primary': '--border',
    '--color-border-secondary': '--border-soft',
    '--color-ring-primary': '--accent',
    '--color-text-danger': '--danger',
  }
  const out: Record<string, string> = {}
  for (const [std, token] of Object.entries(map)) {
    const v = get(token).trim()
    if (v) out[std] = v
  }
  return out
}

export function hostContextFor({ theme, locale, variables }: { theme: 'light' | 'dark'; locale: string; variables: Record<string, string> }) {
  return {
    theme,
    styles: { variables },
    displayMode: 'inline' as const,
    availableDisplayModes: ['inline' as const],
    containerDimensions: { maxHeight: MCP_APP_LIMITS.maxHeight },
    locale,
    platform: 'web' as const,
  }
}

interface BridgeLike {
  connect(transport: unknown): Promise<void>
  close(): Promise<void>
  sendToolInput(p: { arguments: Record<string, unknown> }): Promise<void>
  sendToolResult(p: unknown): Promise<void>
  teardownResource(p: Record<string, never>): Promise<unknown>
  oninitialized?: unknown
  oncalltool?: unknown
  onmessage?: unknown
  onopenlink?: unknown
  onsizechange?: unknown
  onrequestdisplaymode?: unknown
}

export interface ViewHostOptions {
  /** the iframe's contentWindow: the one window whose messages are trusted (event.source) */
  window: Window
  /** the bridge is connected BEFORE the View loads, so the context may still be on its way: it is awaited where it is used */
  context: ViewContext | Promise<ViewContext>
  hostContext: ReturnType<typeof hostContextFor>
  confirmToolCall: (req: ToolCallRequest) => Promise<boolean>
  confirmOpenLink: (url: string) => Promise<boolean>
  openLink: (url: string) => void
  /** runs the View's tool call on the server (POST /api/mcp-apps/:id/tools/call); the host never calls the MCP service itself */
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResultLike>
  onMessage: (text: string) => void
  onSize: (height: number) => void
  /** tests inject fakes; the defaults load the real AppBridge and PostMessageTransport */
  bridgeFactory?: (win: Window, caps: unknown, hostContext: unknown) => BridgeLike | Promise<BridgeLike>
  transportFactory?: (target: Window, source: Window) => unknown | Promise<unknown>
}

export function createViewHost(o: ViewHostOptions) {
  let bridge: BridgeLike | null = null
  let closed = false
  const msg = {
    cancelled: 'The user cancelled this call.',
    tooLarge: `The arguments are over ${TOOL_ARGS_MAX_BYTES / 1024} KiB: the call was refused.`,
    failed: 'The tool call failed.',
    badLink: 'Only https links can be opened.',
    declined: 'The user did not open the link.',
    noText: 'Only text messages are supported.',
  }

  async function onCallTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<ToolResultLike> {
    const ctx = await o.context
    const args = params.arguments ?? {}
    const argumentsText = JSON.stringify(args, null, 2)
    if (new TextEncoder().encode(JSON.stringify(args)).length > TOOL_ARGS_MAX_BYTES) return errorResult(msg.tooLarge)
    const allowed = await o.confirmToolCall({ serviceName: ctx.serviceName, toolName: params.name, argumentsText })
    if (!allowed) return errorResult(msg.cancelled)
    try {
      return await o.callTool(params.name, args)
    } catch {
      return errorResult(msg.failed)
    }
  }

  async function onUiMessage(params: { content?: Array<{ type: string; text?: string }> }) {
    const text = (params.content || [])
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n')
      .trim()
    if (!text) return { isError: true }
    o.onMessage(text)
    return {}
  }

  async function onOpenLink(params: { url?: string }) {
    const checked = checkOpenLink(params.url)
    if (!checked.ok) return { isError: true }
    if (!(await o.confirmOpenLink(checked.url))) return { isError: true }
    o.openLink(checked.url)
    return {}
  }

  return {
    async connect(): Promise<void> {
      const caps = { openLinks: {}, serverTools: {}, message: { text: {} } }
      if (o.bridgeFactory) bridge = await o.bridgeFactory(o.window, caps, o.hostContext)
      else {
        const { AppBridge } = await import('@modelcontextprotocol/ext-apps/app-bridge')
        bridge = new AppBridge(null, { name: 'AI Prism', version: '1.0.0' }, caps, { hostContext: o.hostContext as never }) as unknown as BridgeLike
      }
      const b = bridge
      b.oninitialized = () => {
        // after the View said it is ready: what the tool was called with, then what it returned
        void Promise.resolve(o.context)
          .then(async (ctx) => {
            await b.sendToolInput({ arguments: (ctx.toolInput ?? {}) as Record<string, unknown> })
            await b.sendToolResult(ctx.toolResult)
          })
          .catch(() => {})
      }
      b.oncalltool = onCallTool
      b.onmessage = onUiMessage
      b.onopenlink = onOpenLink
      b.onsizechange = (p: { height?: number }) => {
        if (typeof p?.height === 'number') o.onSize(clampViewHeight(p.height))
      }
      b.onrequestdisplaymode = async () => ({ mode: 'inline' })
      // trust the View's own window and nothing else: the transport drops a message whose event.source is not `source`
      let transport: unknown
      if (o.transportFactory) transport = await o.transportFactory(o.window, o.window)
      else {
        const { PostMessageTransport } = await import('@modelcontextprotocol/ext-apps/app-bridge')
        transport = new PostMessageTransport(o.window, o.window)
      }
      await b.connect(transport)
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      const b = bridge
      if (!b) return
      await Promise.resolve(b.teardownResource({})).catch(() => {})
      await b.close().catch(() => {})
    },
  }
}

export type ViewHost = ReturnType<typeof createViewHost>
export type { AppBridgeType }
