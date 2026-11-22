# MCP Apps (interactive apps in the chat)

**English** · [Português (Brasil)](pt-BR/mcp-apps.md) · [Español](es/mcp-apps.md)

An MCP tool can ship its own interface. When a tool the model called declares a UI resource
(`_meta.ui.resourceUri`, the MCP Apps extension, SEP-1865), AI Prism shows a placeholder under the answer. Opening it
loads the tool's own **View** (a small HTML app) in a sandboxed frame, next to the conversation.

The feature ships **off**. This page explains what a View can and cannot do, because that is what an administrator
decides when turning it on.

## Turning it on

1. An administrator switches **MCP Apps** on in Settings → Tools (the `mcp_apps_enabled` setting, audited as
   `mcp_apps.settings`).
2. To keep it off for good, the operator sets `MCP_APPS_DISABLED=1` in the app environment. That switch wins over the setting.

While it is off: the app does not advertise the capability to MCP servers, nothing is captured, the routes answer
`404 mcp_apps_disabled` and no placeholder shows. Rolling back is the same in reverse: switch the setting off, then set
`MCP_APPS_DISABLED=1`, then, if needed, deploy the previous release (the column stays; the down migration only drops it).

## What happens

1. With the feature on, the app tells each MCP service it connects to that it can show UI resources
   (`extensions["io.modelcontextprotocol/ui"].mimeTypes = ["text/html;profile=mcp-app"]`).
2. After the model calls a tool that declares a `ui://` resource, the app reads that resource once, with the same URL and
   the same user token, and stores it with the tool call. Only the **MIME type `text/html;profile=mcp-app`** is accepted,
   at most **1 MiB**, at most **4 Apps per answer**, and never in an unattended run (a scheduled agent).
3. If the read fails (wrong type, too large, slow, not found) the answer keeps its plain tool result and the reason code
   is logged. Nothing is stored.
4. The chat shows **Open app · service** with the domains the app may contact. While the answer is still streaming the
   button is disabled ("Available when the answer finishes").
5. Opening it loads the View. At most **3 Views** are active on a page.

A tool whose `visibility` leaves out `model` (an **app-only** tool) is never offered to the model.

## What a View can and cannot do

| | |
|---|---|
| Runs in | an `<iframe sandbox="allow-scripts allow-forms">`: an **opaque origin**, never `allow-same-origin` |
| Served by | `GET /api/mcp-apps/view/:toolCallId`, only for an iframe (`Sec-Fetch-Dest: iframe`, else 400), with its **own** CSP header instead of the app's |
| Can reach | only the origins the server declared (`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`), after filtering |
| Cannot reach | this app's page or DOM, its cookies, storage or API (`/api/...`), the workspace host, any Databricks host |
| Can ask the host to | call a tool of the **same service** (the user confirms, with the full arguments), put text in the composer (never sent), open an https link (the user confirms), resize (80 to 640 px) |
| Cannot | go fullscreen, open popups, navigate the page, use the camera, microphone or location, read resources, sample, download |

The CSP of a View starts with `sandbox allow-scripts allow-forms; default-src 'none'`, never contains `'self'` (except
`frame-ancestors`, so this app can frame it), never `'unsafe-eval'`. The declared lists are filtered: only
`https://host[:port]` and `https://*.host`, at most 32 per directive and 4096 characters in all; this app's host, the
workspace host, any `databricksapps.com` or Databricks host, IP literals, other schemes, quotes, semicolons and paths are
dropped.

### A View's own tool calls

A View may call a tool through `POST /api/mcp-apps/:toolCallId/tools/call`. The call goes through the same rules as a
model call:

- the **requesting user's** token (a project member who opens someone else's App runs with their own identity);
- the service's credential class (`shared` and unverified services are refused);
- the organization's tool policy and the MCP catalog (a hidden service or a disabled group is refused);
- only a tool the server marked callable by an app, on the service the App came from (otherwise 403 with a code);
- 20 s timeout, result at most 1 MiB, 60 calls per minute per user;
- a confirmation dialog in the app (not in the frame) with the service, the tool and the **full arguments**; more than
  16 KiB of arguments is refused, never truncated.

The call is not stored. Only codes are logged.

## Who can open an App

The owner of the chat and, for a project chat, every member of the project (the same rule as reading the chat). Anyone
else gets `404`, identical to an id that does not exist. The stored HTML is a snapshot of what was shown at call time; it is
deleted with the chat (and by retention). The sessions payload never carries the HTML.

## Limits

| Limit | Value |
|---|---|
| Resource size | 1 MiB (the database also checks 1,400,000 bytes) |
| Apps per answer | 4 |
| Active Views per page | 3 |
| Sources per CSP directive | 32; 4096 characters in all |
| Arguments of a View's tool call | 16 KiB in the app, 64 KiB at the server |
| View tool-call timeout / result / rate | 20 s / 1 MiB / 60 per minute per user |
| Frame height | 80 to 640 px |

## Operating notes

- Migration `0016_tool_call_ui_resource` adds `chat_tool_calls.ui_resource` (jsonb, null for every older call). Down drops
  the column and the Apps already shown can no longer be reopened.
- The client uses `@modelcontextprotocol/ext-apps` **1.7.5**, pinned exactly (ADR-0019). It is loaded only when a View
  opens and never enters the server bundle.
- A View cannot use cookies or storage (its origin is opaque); a well-behaved View checks for that.
- Whether the Unity AI Gateway forwards the `extensions` capability, tool `_meta` and `resources/read`, and whether the Apps
  proxy leaves the View's headers untouched, is still to be proven in a deployment (below). If the gateway does not forward them,
  the feature stays off and nothing else changes.

## Pending live check (G-live)

Not run yet; it is a deploy and needs a go:

1. Register a fixture MCP App server as a Unity Catalog MCP service.
2. Record whether the Unity AI Gateway forwards the `extensions` capability, tool `_meta` and `resources/read`.
3. Record that the browser receives this app's CSP and `X-Frame-Options` for the View unmodified through the Apps proxy.
4. If the gateway does not forward them, the feature ships off with the finding documented.
