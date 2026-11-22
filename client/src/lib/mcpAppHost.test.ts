// W4-5: the host side of an MCP App View (client/src/lib/mcpAppHost.ts). The AppBridge is replaced by a recording fake so the
// handlers run without a DOM; the real bridge and an opaque-origin iframe are exercised in client/e2e/mcp-apps.spec.mjs.
//
//   - tools/call: a confirmation with the full arguments, Cancel sends nothing, over 16 KiB is refused (never truncated)
//   - ui/message: the text goes to the composer callback, nothing is sent
//   - ui/open-link: https only, behind a confirmation
//   - ui/size-changed: the height is clamped to 80..640
//   - display-mode requests are rejected; host context is theme, tokens, locale, inline only, maxHeight 640
//   - after `initialized` the tool input and result are sent; teardown on close
//   - the bridge trusts event.source (PostMessageTransport(win, win)), never an origin string
//
//   node --test client/src/lib/mcpAppHost.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createViewHost, clampViewHeight, hostContextFor, checkOpenLink, MCP_APP_LIMITS, TOOL_ARGS_MAX_BYTES } from './mcpAppHost.ts'

const CONTEXT = {
  toolInput: { series: 'a' },
  toolResult: { content: [{ type: 'text', text: 'chart ready' }], structuredContent: { points: [1, 2, 3] } },
  serviceName: 'main.apps.chart',
  toolName: 'show_chart',
  csp: { connectDomains: ['https://api.example.com'], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
}

class FakeBridge {
  sent: Array<[string, unknown]> = []
  connected: unknown = null
  closed = false
  oninitialized?: () => void
  oncalltool?: (p: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>
  onmessage?: (p: { role: string; content: Array<{ type: string; text?: string }> }) => Promise<unknown>
  onopenlink?: (p: { url: string }) => Promise<unknown>
  onsizechange?: (p: { width?: number; height?: number }) => void
  onrequestdisplaymode?: (p: { mode: string }) => Promise<unknown>
  hostContext: unknown = null
  win: unknown
  caps: unknown
  constructor(win: unknown, caps: unknown) {
    this.win = win
    this.caps = caps
  }
  setHostContext(c: unknown) {
    this.hostContext = c
  }
  async connect(t: unknown) {
    this.connected = t
  }
  async sendToolInput(p: unknown) {
    this.sent.push(['input', p])
  }
  async sendToolResult(p: unknown) {
    this.sent.push(['result', p])
  }
  async teardownResource() {
    this.sent.push(['teardown', null])
    return {}
  }
  async close() {
    this.closed = true
  }
}

function make(over: Partial<Parameters<typeof createViewHost>[0]> = {}) {
  const log: Record<string, unknown[]> = { calls: [], messages: [], sizes: [], links: [], confirms: [], linkConfirms: [] }
  const win = { postMessage() {} }
  let bridge!: FakeBridge
  const host = createViewHost({
    window: win as unknown as Window,
    context: CONTEXT,
    hostContext: hostContextFor({ theme: 'dark', locale: 'en-US', variables: { '--color-background-primary': '#000' } }),
    confirmOpenLink: async (url) => (log.linkConfirms!.push(url), true),
    openLink: (url) => void log.links!.push(url),
    callTool: async (name, args) => (log.calls!.push([name, args]), { content: [{ type: 'text', text: 'ok' }] }),
    onMessage: (text) => void log.messages!.push(text),
    onSize: (h) => void log.sizes!.push(h),
    bridgeFactory: (w, caps) => (bridge = new FakeBridge(w, caps)) as never,
    transportFactory: (target, source) => ({ target, source }) as never,
    // the recording wrapper comes last: `over.confirmToolCall` only decides the answer
    confirmToolCall: async (req) => (log.confirms!.push(req), over.confirmToolCall ? over.confirmToolCall(req) : true),
  })
  return { host, log, win, bridge: () => bridge }
}

test('host context: theme, tokens, locale, inline only, maxHeight 640', () => {
  const c = hostContextFor({ theme: 'light', locale: 'pt-BR', variables: { '--color-text-primary': '#111' } }) as any
  assert.equal(c.theme, 'light')
  assert.equal(c.locale, 'pt-BR')
  assert.equal(c.displayMode, 'inline')
  assert.deepEqual(c.availableDisplayModes, ['inline'])
  assert.equal(c.containerDimensions.maxHeight, 640)
  assert.equal(c.styles.variables['--color-text-primary'], '#111')
})

test('the transport is built with the iframe window as target AND source (event.source), never an origin string', async () => {
  const { host, win, bridge } = make()
  await host.connect()
  const t = bridge().connected as { target: unknown; source: unknown }
  assert.equal(t.target, win)
  assert.equal(t.source, win)
  const src = fs.readFileSync(fileURLToPath(new URL('./mcpAppHost.ts', import.meta.url)), 'utf8')
  assert.equal(/\.origin\b/.test(src), false, 'no origin comparison in the bridge')
  assert.equal(/allow-same-origin/.test(src), false)
  assert.match(src, /PostMessageTransport/)
})

test('after initialized the tool input and the tool result are sent', async () => {
  const { host, bridge } = make()
  await host.connect()
  bridge().oninitialized!()
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(bridge().sent.map(([k]) => k), ['input', 'result'])
  assert.deepEqual(bridge().sent[0]![1], { arguments: CONTEXT.toolInput })
  assert.deepEqual(bridge().sent[1]![1], CONTEXT.toolResult)
})

test('tools/call asks first, with the service, tool and full arguments; Cancel sends nothing', async () => {
  let answer = false
  const { host, log, bridge } = make({ confirmToolCall: async () => answer })
  await host.connect()
  const args = { range: '7d', filter: { region: ['EMEA', 'APAC'] } }
  const denied = await bridge().oncalltool!({ name: 'refresh_data', arguments: args }) as any
  assert.equal(denied.isError, true)
  assert.deepEqual(log.calls, [], 'Cancel: nothing reaches the server')
  assert.equal(log.confirms!.length, 1)
  assert.deepEqual(log.confirms![0], { serviceName: 'main.apps.chart', toolName: 'refresh_data', argumentsText: JSON.stringify(args, null, 2) })
  answer = true
  const ok = await bridge().oncalltool!({ name: 'refresh_data', arguments: args }) as any
  assert.deepEqual(log.calls, [['refresh_data', args]])
  assert.equal(ok.isError, undefined)
})

test('tools/call with more than 16 KiB of arguments is refused, never truncated, and never asks', async () => {
  const { host, log, bridge } = make()
  await host.connect()
  const big = { blob: 'x'.repeat(TOOL_ARGS_MAX_BYTES + 1) }
  const r = await bridge().oncalltool!({ name: 'refresh_data', arguments: big }) as any
  assert.equal(r.isError, true)
  assert.deepEqual(log.confirms, [])
  assert.deepEqual(log.calls, [])
  assert.equal(TOOL_ARGS_MAX_BYTES, 16 * 1024)
})

test('ui/message fills the composer with the text and sends nothing', async () => {
  const { host, log, bridge } = make()
  await host.connect()
  const r = await bridge().onmessage!({ role: 'user', content: [{ type: 'text', text: 'Show EMEA only' }] }) as any
  assert.deepEqual(log.messages, ['Show EMEA only'])
  assert.equal(r.isError, undefined)
  const empty = await bridge().onmessage!({ role: 'user', content: [{ type: 'image' }] }) as any
  assert.equal(empty.isError, true)
  assert.deepEqual(log.messages, ['Show EMEA only'])
})

test('ui/open-link: https only, behind a confirmation that shows the URL', async () => {
  const { host, log, bridge } = make()
  await host.connect()
  assert.deepEqual(checkOpenLink('https://example.com/a?b=1'), { ok: true, url: 'https://example.com/a?b=1' })
  for (const bad of ['http://example.com', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'not a url', '']) assert.equal(checkOpenLink(bad).ok, false, bad)
  const refused = await bridge().onopenlink!({ url: 'javascript:alert(1)' }) as any
  assert.equal(refused.isError, true)
  assert.deepEqual(log.linkConfirms, [])
  const ok = await bridge().onopenlink!({ url: 'https://example.com/docs' }) as any
  assert.equal(ok.isError, undefined)
  assert.deepEqual(log.linkConfirms, ['https://example.com/docs'])
  assert.deepEqual(log.links, ['https://example.com/docs'])
})

test('ui/size-changed is clamped to 80..640', async () => {
  assert.equal(MCP_APP_LIMITS.minHeight, 80)
  assert.equal(MCP_APP_LIMITS.maxHeight, 640)
  assert.equal(clampViewHeight(10), 80)
  assert.equal(clampViewHeight(300.4), 300)
  assert.equal(clampViewHeight(5000), 640)
  assert.equal(clampViewHeight(NaN), 80)
  const { host, log, bridge } = make()
  await host.connect()
  bridge().onsizechange!({ height: 9999 })
  bridge().onsizechange!({ height: 120 })
  bridge().onsizechange!({ width: 100 })
  assert.deepEqual(log.sizes, [640, 120])
})

test('display-mode requests are rejected: the answer stays inline', async () => {
  const { host, bridge } = make()
  await host.connect()
  const r = await bridge().onrequestdisplaymode!({ mode: 'fullscreen' }) as any
  assert.equal(r.mode, 'inline')
})

test('close sends the teardown and closes the bridge, once', async () => {
  const { host, bridge } = make()
  await host.connect()
  await host.close()
  await host.close()
  assert.equal(bridge().sent.filter(([k]) => k === 'teardown').length, 1)
  assert.equal(bridge().closed, true)
})
