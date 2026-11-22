// An in-process MCP server over Streamable HTTP (stateless) that declares an MCP App: one tool with
// `_meta.ui.resourceUri`, one app-only tool, one model-only tool and the `ui://` resource itself. It records what
// a host sent it (the `initialize` capabilities, every `tools/call`, every `resources/read`), so a test can assert
// the capability handshake and that nothing reaches the service without admission.
//
//   const fx = await startMcpAppServer({ html, csp })
//   fx.url                       http://127.0.0.1:<port>/ai-gateway/mcp-services/<any>
//   fx.initializeCapabilities    capabilities of the last `initialize`
//   fx.calls / fx.reads          recorded tools/call and resources/read
//   await fx.close()
//
// Used by server/mcpApps.test.ts and server/routes/mcpApps.test.ts. No Databricks workspace, no network beyond loopback.
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

export const APP_MIME = 'text/html;profile=mcp-app'
export const APP_URI = 'ui://chart/view.html'
const DEFAULT_HTML = '<!doctype html><html><head><title>fixture view</title></head><body><main id="app">hello from the view</main></body></html>'

/**
 * @param {{ html?: string, mimeType?: string, csp?: object, prefersBorder?: boolean, readDelayMs?: number,
 *           readError?: boolean, extraBytes?: number }} [opts]
 */
export async function startMcpAppServer(opts = {}) {
  /** @type {{ initializeCapabilities: any, initializeCount: number, calls: any[], reads: string[], listCount: number }} */
  const state = { initializeCapabilities: null, initializeCount: 0, calls: [], reads: [], listCount: 0 }
  const html = opts.html ?? DEFAULT_HTML
  const body = opts.extraBytes ? html + ' '.repeat(opts.extraBytes) : html

  function build() {
    const server = new McpServer({ name: 'mcp-app-fixture', version: '1.0.0' })
    server.registerTool(
      'show_chart',
      { description: 'Shows a chart', inputSchema: { series: z.string().optional() }, _meta: { ui: { resourceUri: APP_URI } } },
      async (args) => {
        state.calls.push({ name: 'show_chart', args })
        return { content: [{ type: 'text', text: 'chart ready' }], structuredContent: { points: [1, 2, 3] } }
      }
    )
    server.registerTool(
      'refresh_data',
      { description: 'App-only refresh', inputSchema: { range: z.string().optional() }, _meta: { ui: { resourceUri: APP_URI, visibility: ['app'] } } },
      async (args) => {
        state.calls.push({ name: 'refresh_data', args })
        return { content: [{ type: 'text', text: 'refreshed' }] }
      }
    )
    server.registerTool(
      'model_only',
      { description: 'Model-only tool', inputSchema: {}, _meta: { ui: { resourceUri: APP_URI, visibility: ['model'] } } },
      async (args) => {
        state.calls.push({ name: 'model_only', args })
        return { content: [{ type: 'text', text: 'model only ran' }] }
      }
    )
    server.registerTool('plain', { description: 'No UI', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'plain' }] }))
    server.registerResource('chart-view', APP_URI, { mimeType: opts.mimeType ?? APP_MIME }, async (uri) => {
      state.reads.push(uri.href)
      if (opts.readDelayMs) await new Promise((r) => setTimeout(r, opts.readDelayMs))
      if (opts.readError) throw new Error('boom')
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: opts.mimeType ?? APP_MIME,
            text: body,
            _meta: { ui: { ...(opts.csp ? { csp: opts.csp } : {}), prefersBorder: opts.prefersBorder ?? true } },
          },
        ],
      }
    })
    return server
  }

  const httpServer = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      let parsed
      try {
        parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
      } catch {
        parsed = undefined
      }
      const msgs = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
      for (const m of msgs) {
        if (m?.method === 'initialize') {
          state.initializeCount += 1
          state.initializeCapabilities = m.params?.capabilities ?? null
        }
        if (m?.method === 'tools/list') state.listCount += 1
      }
      const server = build()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        transport.close().catch(() => {})
        server.close().catch(() => {})
      })
      try {
        await server.connect(transport)
        await transport.handleRequest(req, res, parsed)
      } catch {
        if (!res.headersSent) res.writeHead(500).end()
      }
    })
  })
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', resolve)
  })
  const port = httpServer.address().port
  return {
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/ai-gateway/mcp-services/main.apps.chart`,
    get initializeCapabilities() {
      return state.initializeCapabilities
    },
    get initializeCount() {
      return state.initializeCount
    },
    calls: state.calls,
    reads: state.reads,
    reset() {
      state.calls.length = 0
      state.reads.length = 0
      state.initializeCapabilities = null
      state.initializeCount = 0
    },
    close: () =>
      new Promise((resolve) => {
        httpServer.close(() => resolve(undefined))
        httpServer.closeAllConnections()
      }),
  }
}
