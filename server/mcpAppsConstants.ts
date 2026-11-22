// The two literals of the MCP Apps extension (SEP-1865, stable 2026-01-26) the server needs. They are copied here, not imported from
// @modelcontextprotocol/ext-apps: that package is client-only (design-w4.md section 2.3) and must never enter the server bundle.
// server/mcpApps.test.ts pins both values.
export const MCP_APP_MIME = 'text/html;profile=mcp-app'
export const MCP_APP_EXTENSION_ID = 'io.modelcontextprotocol/ui'
