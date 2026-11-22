# ADR 0019: MCP Apps host: an opaque-origin View route with a header CSP; ext-apps pinned at 1.7.5

- **Status:** Accepted
- **Date:** 2026-11-22
- **Scope:** migration `0016_tool_call_ui_resource`, `server/mcpApps.ts`, `server/routes/mcpApps.ts`, `server/db/mcpApps.ts`,
  `server/mcpClient.ts`, `server/tools.ts`, `client/src/lib/mcpAppHost.ts`, `client/src/components/McpAppFrame.tsx`,
  `package.json` (`@modelcontextprotocol/ext-apps`)

## Context

An MCP tool can declare a UI resource (`_meta.ui.resourceUri`, SEP-1865, stable 2026-01-26): an HTML View the host shows
next to the answer. The View is code written by whoever runs the MCP server, so it must not reach this app's page, API or
session. The spec asks for a sandbox proxy on a different origin from the host. Here:

- the app already enforces a CSP with no `script-src` (the deck and design-system previews need inline scripts);
- MCP servers are reached only through the Unity AI Gateway, with the user's token;
- a Databricks App is one origin; a second origin means a second app per installation, a second deploy, `CAN_USE` for every
  user, and the Apps proxy authenticating the sandbox app inside an iframe (a login redirect that login pages refuse to frame).

## Decision

1. **The View is served by our own route, `GET /api/mcp-apps/view/:toolCallId`, into `<iframe sandbox="allow-scripts allow-forms">`,
   with a CSP header built from the sanitized lists the server declared** (Option B of the design). The header starts with
   `sandbox allow-scripts allow-forms`, so the document has an opaque origin even if opened on its own, and is
   `default-src 'none'` plus the declared origins only. Never `'self'` (except `frame-ancestors`), never `'unsafe-eval'`, never
   `allow-same-origin`. There is no proxy frame: what a proxy would do (apply the CSP) the server does with a real header, which a
   View cannot tamper with, unlike a meta tag. The View route is the only route that replaces the app-wide CSP.
2. **The host bridge validates `event.source`** (`PostMessageTransport(win, win)` of ext-apps), not an origin string.
3. **`@modelcontextprotocol/ext-apps` is pinned at exactly `1.7.5`**, as a client-only build dependency. Its peers (MCP SDK
   `^1.29.0`, zod `^3.25 || ^4`) match the server's. 2.x moves to the MCP SDK 2 split packages and would put two SDK majors
   in one repository; the wire protocol is unchanged and interop-tested, so a 1.7.5 host renders 2.x Views. The server does not
   import it: it needs only `client.readResource` and two spec literals, copied and tested. The lockfile resolves from
   `registry.npmjs.org`.
4. **The UI resource is stored with the tool call** (`chat_tool_calls.ui_resource`, jsonb, CHECK at 1,400,000 bytes) and read only
   by the view and context routes. Row-level security already covers the table (owner, or a member of the chat's project); the
   sessions payload carries `hasUi`, the service name and the declared domains, never the HTML.
5. **A View's tool calls are admitted like a model call** (credential class, org tool policy, hidden services, the requesting
   user's token) and need a confirmation in the host that shows the full arguments.
6. **Off by default**: `app_settings.mcp_apps_enabled`, with `MCP_APPS_DISABLED=1` as an operator kill-switch that wins.

## Consequences

- No second deployment and no new infrastructure; the cost is one route and one header builder.
- A View cannot use cookies or storage (opaque origin), the same as the reference host's inner frame. Views that need a stable
  origin (OAuth callbacks, API-key allowlists keyed on the `domain` field) are not supported.
- No eligible reference host serves the View from the host's own origin: this is our deviation, and its residual risks are
  recorded in the threat model (a browser ignoring the CSP `sandbox` directive is covered by the iframe attribute; an Apps proxy
  that rewrites headers is a live check).
- The gateway may not forward the `extensions` capability, tool `_meta` or `resources/read`. Then there is no UI and the plain
  tool result is shown (graceful degradation is the spec's rule).

## Upgrade trigger

Move `ext-apps` when the server moves to MCP SDK 2 (a separate task), or when a security advisory lands on the 1.x line.
Switch to a dedicated sandbox origin (`MCP_APPS_SANDBOX_URL`, the spec-literal double iframe) if the live check shows the Apps
proxy alters the View's headers, or if a customer needs Views with stable origins. The client is written so a proxy URL can
replace the frame `src`; that is not built.

## Rollback

Switch the setting off, set `MCP_APPS_DISABLED=1`, deploy the previous release. The down migration drops the column (stored
Apps are lost; the tool calls and their plain results stay).
