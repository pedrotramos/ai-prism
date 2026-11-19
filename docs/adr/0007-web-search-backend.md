# ADR 0007: Web search backend, MCP-first

- **Status:** Accepted
- **Date:** 2026-11-18
- **Scope:** `server/webSearch/**`, `web_search` / `web_fetch` registration (`server/tools.js`), the per-turn decision (`server/turn.js`), `app.yaml`, `bundle/optional/`
- **Supersedes:** the rev 2 decision of 2026-11-17 (keyed search API as primary), which was never accepted as an ADR

## Context

AI Prism shipped `web_search` and `web_fetch` disabled: the registration block was
commented out and the grounding directive was kept tool-neutral, because naming a tool
that is not registered breaks the turn. The only search path left was an MCP a user
connected, which hands the model the server's whole tool list and, for a provider whose
key is shared by everyone, is refused by the credential admission of PR #83.

Facts that bound the decision (Databricks docs, accessed 2026-11-18):

- The managed MCP `system.ai.web_search` is Beta, gated by the account preview
  *Enhanced Unity Gateway*, limited to supported US regions or workspaces that allow
  cross-geo processing, and not offered on Azure today. It takes a natural-language
  `query` and returns a synthesized answer with citations. No price is published.
- Any Streamable HTTP MCP server can be registered as a Unity Catalog MCP Service and
  invoked at `/ai-gateway/mcp-services/<catalog>.<schema>.<service>` on AWS, Azure and GCP.
  Its outbound credential lives in a UC HTTP connection; callers need `EXECUTE` (plus
  `USE CATALOG` / `USE SCHEMA`), not `USE CONNECTION`. Tool selection hides the other tools.
  Calls land in `system.ai_gateway.usage` and `system.access.audit`.
- Brave has no hosted MCP endpoint; Firecrawl, You.com, Tavily and Exa do.

**Record of the pivot.** Rev 2 (2026-11-17) made a keyed API primary on the instruction
that the managed MCP could not be primary. On **2026-11-18 the user decided**: "usar o MCP
de busca nativo do workspace sempre que possível. Quando ele não tiver disponível, o
cliente deve poder apontar para um outro MCP (Brave, Firecrawl, You.com, ...)". This ADR
records that decision.

## Decision

1. `web_search` is a native tool backed by an **ordered chain** chosen by
   `WEB_SEARCH_BACKEND` (`auto` by default, or `off`, one backend, or an ordered list):
   the managed MCP `system.ai.web_search`, then the external MCP Service named in
   `WEB_SEARCH_MCP_SERVICE`, then Brave, Tavily and a customer-hosted SearXNG.
   `resolveWebSearchBackend(env)` is a pure function; an unknown token turns the feature
   off (fail closed); `WEB_SEARCH_DISABLED=1` wins over everything.
2. Both MCP backends are called through Unity Gateway **with the user's token**, as every
   other MCP call in the app: per-user grants, gateway rate limits and audit. The external
   provider's credential lives in the UC connection; the app holds none on the MCP paths.
   The external service is designated by environment only (no runtime switch in 2.0.0).
3. **Availability is per user, cached, and never awaited on a turn.** The probe is the
   tool listing the app already caches; negatives are kept 10 min (`forbidden`,
   `unconfigured`) or 60 s / `Retry-After` (transient). The first `GET /api/tool-policy`
   of a user warms it in the background. The managed candidate under `auto` counts only
   when `up`, so a deployment that configured nothing behaves as before.
4. **One decision per turn** (`webSearchForTurn`), computed before the blocks instruction,
   feeds both the grounding directive and `buildToolDefs`: the directive names `web_search`
   iff the tool is registered on that turn.
5. The designated search service is **exempt from the user-facing shared-credential
   refusal** under six invariants: one pinned tool is called (never "the first tool");
   arguments are built by the app from the query and the limit only; the server's
   descriptions and instructions never reach the prompt; `admitMcpConnection` is untouched
   and still refuses the service on every user path; with the native tool on, a user's own
   ref to the managed or the designated service is skipped for the turn; setup requires
   tool selection on the service.
6. One renderer (`renderWebSearchForModel`) produces every tool result, inside a fixed
   untrusted-content envelope whose markers are neutralised inside provider content.
   `web_fetch` stays native and is the only page reader.
7. One usage-ledger row per answered search (ADR 0008).

## Consequences

- Zero setup where the managed MCP exists; elsewhere one MCP Service registration and one
  environment variable; the keyed fallback needs a secret (`bundle/optional/`).
- MCP searches are unpriced in the ledger until an admin sets a price.
- Managed answers are synthesized text, not result lists; the normaliser maps list-shaped
  vendor payloads and falls back to "answer + sources".
- Per-user availability lives in process memory (bounded map); several instances each
  keep their own.
- A previously adopted ref to the designated service still reaches the model when the
  native tool is off, until the turn-time admission filter (W2-11d) lands.

## Alternatives considered

- **External providers through the user MCP catalog:** needs the shared-credential rule
  loosened for everyone and exposes whole servers to the model.
- **Calling vendor MCP URLs directly with a key in the app:** a second MCP trust path
  outside the gateway (no UC grants, audit or rate limits). Revisit only if registering an
  external MCP Service proves unusable on a cloud.
- **Keyed API as primary (rev 2):** overridden by the user; kept as the tail of the chain.
- **Provider-native search through the gateway, a UC function, embedded or replicated
  SearXNG (including on FastAPI):** not model-agnostic, no reliable egress, or a second
  process the Apps runtime does not support plus scraper engines that get banned.

## Rollback

`WEB_SEARCH_DISABLED=1` in `app.yaml` and redeploy, or turn the `web-search` tool policy
off (no redeploy). No schema change to undo.
