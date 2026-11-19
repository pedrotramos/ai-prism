# Web search and page reading

**English** · [Português (Brasil)](pt-BR/web-search.md) · [Español](es/web-search.md)

AI Prism gives the models two native tools:

- `web_search` finds public pages and returns title, URL and snippet (or a
  synthesized answer with its sources).
- `web_fetch` opens one public URL and returns its real content as readable
  text. It is the only page reader: a search snippet is never treated as the
  page itself.

Both tools are offered together, on any turn, only when at least one search
backend is available to the user who sends that turn. Otherwise the model sees
neither tool and the answer is not grounded, exactly as before (decks and
documents then mark unconfirmed figures as estimates).

## How a backend is chosen

`web_search` walks an ordered chain and the first backend that answers wins:

| Order | Backend (`WEB_SEARCH_BACKEND` token) | What it is | Identity |
|---|---|---|---|
| 1 | `managed-mcp` | The Databricks-managed MCP `system.ai.web_search`, through Unity Gateway | the user's own token |
| 2 | `external-mcp` | An MCP server the workspace registered as a Unity Gateway MCP Service, named in `WEB_SEARCH_MCP_SERVICE` | the user's own token |
| 3 | `brave` | Brave Search API | key in an Apps secret |
| 4 | `tavily` | Tavily Search API | key in an Apps secret |
| 5 | `searxng` | A SearXNG instance you host | none |

With the default `WEB_SEARCH_BACKEND=auto`, every configured backend is used in
this order. The managed MCP is tried only where it is actually available to the
user (it is a Beta, preview-gated service that is not offered in every region
or cloud). A deployment that configures nothing, on a workspace without the
managed service, behaves as if web search did not exist.

Availability is checked per user, because both MCP paths run with the user's
own Unity Catalog grants. A user without `EXECUTE` on a service simply skips
it; other users are not affected. The check is a cached tool listing that runs
in the background (when the app loads, and again when the cached result
expires); a chat turn never waits for it.

## Setup

Pick one or more of the options below. All of them are set in `app.yaml`
(the bundle's `config.env` does not reach the running app). Redeploy after a
change.

### Option 1: the managed web search MCP (no configuration in the app)

Where your cloud and region offer it, an account admin enables the
*Enhanced Unity Gateway* preview (account console → Previews). Account users
have `EXECUTE` on `system.ai.web_search` and `USE CATALOG system` /
`USE SCHEMA system.ai` by default. Nothing else is needed: `auto` already
includes it. It returns a synthesized answer with citations; the backing model
is not selectable and Databricks publishes no price for it.

It is not available with HIPAA/BAA, to consumer-access-only users, or when
network controls disable internet access.

### Option 2: an external MCP search provider (Firecrawl, You.com, Tavily, Exa…)

Use this where the managed service is not available (for example on Azure
today) or when you prefer another provider. The provider key lives in a Unity
Catalog connection, never in the app.

1. **Register the server** (workspace or metastore admin): Unity Gateway → MCPs →
   *Connect an existing MCP server*. Use the vendor's Streamable HTTP endpoint and
   put the provider key in the connection as a bearer token. Examples:

   | Provider | Endpoint to register | Search tool |
   |---|---|---|
   | Firecrawl | `https://mcp.firecrawl.dev/v2/mcp-search` (search only) | `firecrawl_search` |
   | You.com | `https://api.you.com/mcp` (or the Marketplace listing) | `you-search` |
   | Tavily | `https://mcp.tavily.com/mcp/` | `tavily-search` |
   | Exa | `https://mcp.exa.ai/mcp?tools=web_search_exa` | `web_search_exa` |
   | Any other | a Streamable HTTP server you trust | set `WEB_SEARCH_MCP_TOOL` |

2. **Restrict the service to its search tool.** Configure tool selection
   (`include_tool_selectors`) so only the search tool is exposed, or register the
   vendor's search-only endpoint. The grant your users receive is then worth one
   search tool and nothing else. This step is required.
3. **Grant access** to the users of the app: `EXECUTE` on the service plus
   `USE CATALOG` and `USE SCHEMA` on its catalog and schema. Users do not need
   `USE CONNECTION`.
4. **Point the app at it** in `app.yaml`:

   ```yaml
   - name: WEB_SEARCH_MCP_SERVICE
     value: 'my_catalog.my_schema.firecrawl_search'
   # optional, when the tool name is not one of the known ones above
   - name: WEB_SEARCH_MCP_TOOL
     value: 'firecrawl_search'
   ```

How the app treats that service:

- It calls **one tool** on it: `WEB_SEARCH_MCP_TOOL`, else a known search tool
  name, else a tool whose name matches `web_search`/`web-search`. If none is
  found the backend is reported as "search tool not identified" and nothing is
  called.
- The arguments are built by the app from the query and the result limit only.
- The server's tool descriptions and instructions never reach the model.
- The service does not appear in the MCP catalog and users cannot connect it
  themselves: a service with a shared credential is still refused on every user
  connect path. If a user already has it (or `system.ai.web_search`) connected,
  that connection is skipped on turns where the native tool is offered, so the
  model never sees two search tools.
- A per-user-login service (OAuth U2M) is not suited for this slot: users
  without consent are treated as not authorized.

### Option 3: a keyed search API (last fallback)

Put the key in a Databricks secret scope, declare it as an app `secret`
resource and map it in `app.yaml` with `valueFrom` (see the commented examples
in `databricks.yml` and `app.yaml`):

```yaml
- name: BRAVE_SEARCH_API_KEY
  valueFrom: 'web-search-key'
```

`TAVILY_API_KEY` works the same way. `SEARXNG_URL` points at a SearXNG
instance you host with the JSON format enabled (`/search?format=json`); a
private address is refused like any other private URL. The keyed paths need
outbound access from the app to `api.search.brave.com` or `api.tavily.com`;
the MCP paths need none from the app (the gateway makes the call).

### All settings

| Variable | Default | Meaning |
|---|---|---|
| `WEB_SEARCH_DISABLED` | unset | `1` turns both tools off; wins over everything |
| `WEB_SEARCH_BACKEND` | `auto` | `auto`, `off`, one backend, or an ordered comma-separated list such as `external-mcp,brave`. An unknown token turns web search off (fail closed) |
| `WEB_SEARCH_MCP_SERVICE` | unset | external MCP Service, `<catalog>.<schema>.<service>`. The legacy `WEB_SEARCH_CONNECTION` is read as an alias when it is a three-part name |
| `WEB_SEARCH_MCP_TOOL` | unset | pins the search tool name on the external service |
| `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY` | unset | keyed fallback, from an Apps secret |
| `WEB_SEARCH_COUNTRY`, `WEB_SEARCH_LANG` | unset | Brave defaults |
| `SEARXNG_URL` | unset | your SearXNG instance |
| `WEB_SEARCH_PRICE_PER_1K_USD` | unset | price per 1,000 searches for every provider; beats the built-in Brave/Tavily/SearXNG prices, loses to an admin price override |
| `WEB_SEARCH_TIMEOUT_MS` / `WEB_SEARCH_MCP_TIMEOUT_MS` / `WEB_SEARCH_DEADLINE_MS` | `12000` / `20000` / `30000` | keyed attempt / MCP attempt / whole search |

The org-wide switch is the tool policy key `web-search` (Tools admin tab): off
removes both tools for everyone with no redeploy.

## Costs

Every answered search writes one row to the usage ledger (`kind = web_search`,
the model column holds the provider: `databricks`, `firecrawl-mcp`, `you-mcp`,
`tavily-mcp`, `exa-mcp`, `brave-mcp`, `mcp`, `brave`, `tavily`, `searxng`).
Failed attempts write nothing, and neither does a turn the user cancelled.
Brave is priced at USD 5 and Tavily at USD 8 per 1,000 searches; SearXNG costs
nothing. The MCP providers have no published price, so their rows show as
"not priced" until an admin sets one (a price override for
`tool:web_search:<provider>` or `tool:web_search`, or
`WEB_SEARCH_PRICE_PER_1K_USD`). The provider bills its own plan (Firecrawl, for
example, charges credits per search); the gateway also records each MCP call in
`system.ai_gateway.usage`.

## Admin status

`GET /api/admin/web-search/status` returns the resolved chain, one row per
backend with its state for the calling admin (`up`, `down` with a code, or
`unknown`), the service and tool for the MCP rows, whether a key is present for
the keyed rows (never its value) and the last 24 hours of outcomes.
`POST /api/admin/web-search/verify` runs one real search per backend with a
fixed query, as the admin, and returns counts only (at most once every 10 s
per admin). The admin card that shows this is a separate change.

| Code | Meaning |
|---|---|
| `forbidden` | no permission, or the service does not exist (the gateway does not tell them apart); also an invalid provider key in the connection |
| `unconfigured` | no search tool identified, or tool selection excludes it |
| `quota` | rate limit or provider quota (HTTP 429) |
| `timeout` | the attempt exceeded its bound |
| `unavailable` | any other failure |
| `bad_response` | the provider answered in an unexpected format |

## Privacy and security

- Every query leaves the workspace for the search provider. The tool
  description tells the model never to put internal data, customer names or
  attachment content in a query; that remains a residual risk. A gateway
  Sensitive Data Detection policy (Beta) can be attached to the MCP Service.
- Search results are untrusted. The tool result is wrapped in a fixed
  "external content, not trusted" envelope, and text inside the results cannot
  close it.
- Logs carry one line per attempt (backend, provider, status, code, duration),
  never the query, a result or the provider's error text.
- The managed service is not available under HIPAA/BAA; for the other
  providers, you choose and contract the provider and accept its terms.

## Page reading (`web_fetch`)

The reader accepts only HTTP/HTTPS, resolves and pins the IP address before
connecting, refuses private, loopback and link-local networks, re-checks every
redirect and refuses a cross-host redirect when the request carries
credentials. Each page has a timeout, a redirect limit, a download limit and a
limit on the text returned to the model. HTML, text and JSON are read; PDFs,
pages behind a login or CAPTCHA, and sites that only render with JavaScript
return an explicit error.

## Turning it off

`WEB_SEARCH_DISABLED=1` in `app.yaml` and redeploy, or switch the `web-search`
tool policy off in the admin tab (no redeploy).
