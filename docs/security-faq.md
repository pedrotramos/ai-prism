# AI Prism security FAQ

**English** · [Português (Brasil)](pt-BR/security-faq.md) · [Español](es/security-faq.md)

Answers to objections that come up in security reviews. Each answer separates what **the app does** (code in this repository) from what **the Databricks platform or serverless provides**. When an answer depends on workspace configuration, it says so. For details, see the [threat model](security-threat-model.md) (identifiers G1–G15 and C1–C22 come from there).

---

### 1. Does the app implement login?

**No.** The app has no login screen or authentication flow of its own. The workspace's **Apps proxy** authenticates the user (OAuth/SSO) and forwards the request with `x-forwarded-email` and `x-forwarded-access-token`. The app reads these headers (`server/requestIdentity.ts`) and responds with 401 when the token or the email is missing. It also checks with the workspace (`SCIM /Me`) that the email belongs to the token's owner, and responds with 401 if it does not (`server/identityBinding.js`, `IDENTITY_BINDING`; see [SECURITY.md](../SECURITY.md#email-to-token-binding-serveridentitybindingjs)).

*Platform:* authentication, SSO, session expiry, access revocation, and being the only path to the process.
*App:* requires both headers and the binding between them. If the workspace does not respond, the request goes through and the log records a warning.

---

### 2. Can one user see another user's conversation?

**Not a personal conversation, and the database enforces it (row-level security, migrations 0003 and 0005). The one deliberate exception is a shared project: its conversations are readable by the project's current members.** The app tables in the `ai_prism` schema have `ENABLE` and `FORCE ROW LEVEL SECURITY`. There are two exceptions, and neither holds conversation content. `project_members` has row-level security enabled but not forced, so that the membership function can read it ([threat model TB9](security-threat-model.md#3-trust-boundaries)). `schema_migrations` has none: it holds only migration versions. By default the app connects as **one** Postgres role for every user: its service principal. That role owns no table, has no `BYPASSRLS`, and is not a member of the owner role after a deploy. When the service principal cannot connect, the app falls back to the caller's own database identity ([question 5](#5-which-permissions-does-the-app-use-and-on-whose-behalf)). Every query runs inside `withTx` (`server/db/pool.js`). For that transaction only, it sets the caller's e-mail (`app.user_email`), the caller's workspace groups (`app.user_groups`) and an admin flag (`app.is_admin`). Without a caller identity, no personal or project row is visible. The shared and admin tables below stay readable, because their read policy is open to everyone.

- **Personal data** (chats outside a project with their messages and tool calls, artifacts, images, cost ledger, memory, MCP connections, selections): a row is visible and writable only by the user it belongs to, directly (`user_email`) or through its chat (`chat_sessions`). Membership in a project gives no access to another member's personal chats. A temporary chat (migration 0011) is a personal chat that can never belong to a project; the same owner-only rules apply to it.
- **Project conversations** (migration 0005): a chat created inside a project is readable by the project's *current* members (a person or a confirmed workspace group) with any role (owner, manage, view). They can read the chat, its messages, tool calls, compactions, Genie conversations and embeddings. Every member can post new turns; only manage or owner can rewrite its history. From migration 0012 on, the decks, spreadsheets, documents and images that a member generates in a project chat are also readable (never writable) by the project's current members: the database has one `SELECT` policy per table (`aipj_member_read`, membership as a set), writes stay owner-only, and the app answers a non-creator's edit with 403 `artifact_read_only`. Their cost rows stay readable only by that member. Deleting a project deletes the image files of its chats from the volume (best-effort). From migration 0008 on, membership is evaluated once per statement as a set of project ids (`aip_my_project_ids()`, [ADR 0016](adr/0016-project-membership-set.md)); the access rules do not change. Whoever leaves the project loses access to its chats, including the ones they created. An app admin has no implicit access. Proof: `server/isolation.projects.test.js` (a member reads another member's shared chat; a non-member, an admin and an empty identity do not). See TB9 in the [threat model](security-threat-model.md#3-trust-boundaries).
- **Shared tables** (design-system templates, skills): everyone reads their own rows and the global ones; only an admin request writes a global row.
- **Admin tables** (admins, MCP catalog, tool policy, model catalog, org settings): everyone reads; only an admin request writes. The admin audit trail (`admin_audit`) is readable only with the admin flag. One more read crosses users: the cost ledger (`usage_ledger`) stays per user, except that a request carrying the admin flag **and** a caller identity can read every user's ledger rows through a SELECT-only policy (`aipa_admin_read`, migration 0010, [ADR 0015](adr/0015-admin-ledger-read.md)). The app uses it only for the admin web-search cost aggregates (users hashed in the response); it gives no write access and, without an identity, no read.

The admin flag is set only by server code after the admin check (`requireAdmin`, `authz.isAdmin`), never from a header or body, and it gives no access to other users' own rows. The queries keep their `WHERE user_email` filters as defence in depth. CI proves it: `server/isolation.test.js` (19 cases) runs `db.js` as a non-owner app role under the policies, including a raw `SELECT` on every per-user table that must return 0 of the other user's rows, and `server/rls.test.js` (16 cases) checks the policies, `FORCE`, the role's attributes, the index use, and the migration round trip. G2 and G13 are closed (see the threat model). Still open: running the same check on a real Lakebase branch (G-live-7 in the threat model).

---

### 3. Where is the data stored?

- **Conversations, artifacts, embeddings, and the ledger:** Lakebase (serverless Postgres) in your own workspace, created by `databricks.yml`.
- **Memory entries:** table `user_memories` in the same Lakebase, one row per remembered fact, readable only by its owner ([question 20](#20-what-does-memory-store-and-how-is-it-purged)).
- **Generated images:** a UC Volume, by default `ai_prism.default.ai_prism_images` (configurable with `IMAGE_VOLUME_CATALOG`, `IMAGE_VOLUME_SCHEMA` and `IMAGE_VOLUME_NAME`).
- **Data queried:** Unity Catalog, Genie, and Vector Search, always with the user's token (OBO).
- **Model outputs:** calls to the workspace's AI Gateway.

The app **does not send data to other destinations**, except MCP or A2A servers that the user or an admin configured, and web search, when an admin enables it.

**How long it is kept:** until the user deletes the chat, unless an admin sets a retention period (`retentionDays`, off by default). With retention on, a daily sweep deletes every chat idle for longer than that, with its messages, artifacts and image files. The cost rows stay, without the link to the chat ([operations.md §6.8](operations.md#68-retention-org-instructions-and-the-admin-audit-trail)). A **temporary chat** (chosen in the composer's + menu) is the exception: it is deleted when the user leaves it, and by a sweep once idle for 24 hours (retention on or off). It writes no embeddings, extracts no memory and is never a search result; the audit keeps only a count of how many were started, with no chat id, user, title or content.

*Platform:* region, residency, and encryption at rest and in transit for the workspace.

---

### 4. Is the data used to train models?

It depends on the **model served by the AI Gateway** and on the terms of that model's provider. The app has no way to change that policy. Before enabling a model, an admin must check the endpoint's terms in the workspace itself. This document makes no claim about third-party policy.

---

### 5. Which permissions does the app use, and on whose behalf?

Three ways, by resource (full table in §4 of the [threat model](security-threat-model.md)):

- **OBO (user token):** models, Genie, SQL Warehouse (UC Functions and Python UDFs, and the one-time creation of the images Volume), Vector Search, and the user's MCP connections. The user can reach only what the user can already reach.
- **App service principal, by default:** Lakebase, the images Volume, and the MCP catalog suggestion listing.
- **Fallback to the user's identity.** If the app has no service-principal credentials, or the service principal cannot log in to Lakebase or reach it, the app connects to Lakebase as the caller's own Postgres role, with the user's token as the password. If the service principal is configured and then fails, the app stays on that path for 5 minutes before trying the service principal again; with no service-principal credentials at all, there is nothing to retry, and the app uses the per-user path directly until the configuration changes (`createWithClient` in `server/db/pool.js`; log line `lakebase: service-principal login unavailable, using per-user identity`, alert A3 in [operations.md](operations.md#52-proposed-alert-rules)). The same `withTx` identity and policies apply. Most workspace users have no Lakebase role, so their requests fail during a fallback instead. Right after connecting, the app checks the fallback role: if it is a superuser or has `BYPASSRLS` (on Lakebase, the deploying identity does), the request is refused with a 503 and its work never runs, so no request runs outside the policies (gap G15 in the [threat model](security-threat-model.md#7-declared-gaps); `assertFallbackRlsBound` in `server/db/pool.js`; log line `lakebase: per-user fallback refused`). The check runs once per connection and applies when service-principal credentials are configured or the app runs on Databricks Apps (`DATABRICKS_APP_*`); local development against a local Postgres is not checked. No setting turns it off. During a service-principal outage, the deploying identity therefore loses access instead of bypassing the policies. A permission error (`42501`) or a policy refusal never triggers the fallback. The images Volume uses the user's token when the service-principal token cannot be obtained (`storageToken` in `server/imageStore.ts`). That path needs the user's `files` scope.

The OBO scopes are in `user_api_scopes` in `databricks.yml`. They must be in the bundle, not in `app.yaml`: `bundle deploy` does not apply the scopes from `app.yaml`.

*Limitation:* the SP's own database privilege is wider than any single user's reads; row-level security (answer 2) narrows it per request; in a fallback, a role that would skip it is refused (G15).

---

### 6. Who is an administrator?

- **Owner:** the email in `APP_OWNER_EMAIL`, when set. The bundle does **not** set this variable.
- **Admins:** the `app_admins` table, by email or by workspace group (the group list comes from SCIM, using the user's own token; if SCIM fails, groups grant no access).
- **Bootstrap:** the auto-config job (`bundle/auto_config.py`) records the person who deployed the app as the first admin.

Admin routes go through `requireAdmin`. There is no two-person approval for changing admins.

---

### 7. Is there an audit trail?

Yes, for administrative actions, and there are other sources for the rest:

- **Admin actions (app):** every admin change writes one row to the `admin_audit` table in the same transaction as the change. This covers admins, MCP catalog, tool policy, template scope, global templates and skills, model endpoints, and the retention and org-instruction settings. The retention sweep also writes a row with its counts. Starting a temporary chat inserts one count-only row (`ephemeral.started`, actor `system`, no target, no chat id, user, title or content; migration 0011, policy `aipe_started_insert`), which admins read as a number through `GET /api/admin/ephemeral-chats`. The actor is stored as a hash, never the e-mail: with `APP_AUDIT_HASH_KEY` set it is a keyed HMAC (`h2:` prefix) that does **not** match the `user_hash` in the logs, on purpose; without the key it is the same unsalted `user_hash` as the logs ([how to correlate the two](security-threat-model.md#61-correlating-the-audit-trail-with-the-logs)). The app cannot change or delete rows. Admins read it with `GET /api/admin/audit` ([operations.md §6.8](operations.md#68-retention-org-instructions-and-the-admin-audit-trail)).
- **Platform:** `system.access.audit` records workspace and Unity Catalog events. It is the reference source for who did what outside the app.
- **App:** `usage_ledger` (cost per call, per user and session) and the chat messages themselves.
- **Logs:** structured JSON lines with `request_id` and `user_hash` (the unkeyed hash), with e-mails, tokens and SQL redacted (`server/log.js`). The platform sets the retention (how to query it: [operations.md](operations.md)).

*Limit:* what users do in their own chats is not in `admin_audit`. Their messages and `usage_ledger` are the record.

---

### 8. Does the app run code generated by the model?

**Not in the app process.** The Python tool runs as a UC Function (UDF) on a serverless SQL Warehouse, with the user's token. Execution happens in the warehouse's sandbox and is limited to what the user can run. Unity Catalog tools follow the same rule.

---

### 9. Can the content the model generates run scripts in the browser?

There are three layers, and no single one is enough on its own:

- Markdown: the client does not render raw HTML (no `rehype-raw`).
- HTML slides: `<script>` is removed when the deck is saved (`sanitizeHtmlDeck`), and the iframe uses `sandbox="allow-scripts"` **without** `allow-same-origin`, so it has an opaque origin: no access to cookies, storage, or the app's DOM.
- A preview iframe uses `allow-same-origin`, but **without** `allow-scripts`.

---

### 10. Can prompt injection make the model act against the user?

**This is an open risk, and it cannot be eliminated in the current state.** An MCP server or a web page can put instructions in its content, and today:

- MCP tool descriptions, instructions and schemas, Genie room titles and UC function comments are neutralized before they reach the prompt (`server/toolMetadata.ts`, G7 mitigated). That lowers the risk; it does not remove it.
- Web search results are wrapped in a fixed "external content, not trusted" envelope (G12, mitigated for `web_search`). Attachments and the text from `web_fetch` still enter the context without that marker (G12, open for those two).

What limits the damage: the tools that reach workspace data (Genie, SQL Warehouse and UC Functions, Vector Search, the user's MCP connections, models) run with the user's OBO token, so an injection cannot reach workspace data the user cannot already reach. The app's own storage works differently. Lakebase and the images Volume are reached with the app's service principal by default, and with the caller's own identity only as a fallback ([question 5](#5-which-permissions-does-the-app-use-and-on-whose-behalf)). On either identity the model gets no database connection and chooses no storage path. Every read or write of app data is app code that runs inside `withTx` with the caller's identity; it runs under row-level security on the service-principal path, and the per-user fallback refuses a role that would skip the policies (G15). An image file is reached only through its `chat_images` row. An injection therefore cannot widen what those checks allow. The real risk is the model performing a **write** the user did not intend. For that reason, the recommendation is to restrict write tools by policy (`app_tool_policy`) and to require human confirmation.

---

### 11. Is there SSRF protection?

Yes, in the web fetch (`server/web.ts`): it blocks `localhost`, private IPs (IPv4 and IPv6, including mapped addresses), resolves DNS before connecting, and limits redirects. There is a test in `server/web.test.ts`. Users do not supply MCP server URLs: an MCP connection is a Unity Catalog service, and the app builds its address as the workspace host plus `/ai-gateway/mcp-services/<name>`, with the name URL-encoded as one path segment (`externalMcpUrl`, `server/externalMcp.ts`); `/api/mcp/connections/:name` answers 400 to names with path or query characters. The workspace gateway, not the app, then calls the external server. The `web_fetch` tool is the one place where the app itself fetches an arbitrary public URL, and that is the path with the anti-SSRF checks.

---

### 12. Is there rate limiting or protection against cost abuse?

**Yes, per user (G4, mitigated).** `server/middleware/rateLimit.js` gives each user a token bucket keyed by the identity the Apps proxy forwards (`x-forwarded-email`), never by IP alone, since many users share one egress IP:

- 120 `/api` requests per minute (`RATE_LIMIT_API_PER_MIN`) and 12 model turns per minute (`RATE_LIMIT_TURNS_PER_MIN`: chat, continue, regenerate, compact and the studio tweaks). `0` turns a limit off. Above the limit the answer is `429` with `Retry-After`.
- Body limits, per route class from one explicit table (`server/middleware/security.js`; every write route has a class): JSON up to 1 MB by default; 40 MB for a design-system import or update; 46 MiB for the deck studio's save, AI edit and native export and the spreadsheet AI edit, which carry slides, speaker notes and images as data URLs (a 40-slide deck with a brand background on every slide exports a 25.6 MB body; the deck studio caps its inputs at 9 MiB per speaker note and four attachments of 6 MiB each, and an AI edit at those caps is 45.4 MB; over a cap the answer is `413` naming the limit); 4 MB for a workbook save. Chat uploads up to 80 MB and 10 files, skill uploads up to 5 MB and 1 file. Above the limit the answer is `413`. Under the AppKit boot, AppKit's own JSON parser reads the body of every route (up to 64 MB, the memory bound per request) before the app's middleware: the per-route limit still answers `413` from the declared `Content-Length`, and a JSON body without one (chunked) gets `411 Length Required`, because the parsed object does not show how many bytes arrived. By then the bytes have been read, so it is a policy check rather than a memory guard. Under the legacy boot the parser counts the stream itself, chunked or not.
- Resource limits: SQL Warehouse 2X-Small, `max_num_clusters: 1`, 10-minute auto-stop; Lakebase capped at 16 CU.
- Visibility: per-user `usage_ledger` and the cost dashboard.

*Limits of this control:* the buckets live in each app process, so several instances multiply the ceiling, and a request limit is not a spending cap. *Recommendation:* set per-user or per-group budgets in the Unity AI Gateway for the cost ceiling.

---

### 13. How are keys and passwords stored?

- **No secrets in the repository.** `.env` is in `.gitignore`; `.env.example` has no real values.
- **Service principal:** `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` are injected by the Apps runtime.
- **`PGPASSWORD`:** exists only for the local development database.
- **User tokens:** arrive per request, in the proxy header.

*Platform:* rotation and storage of the SP secret.

---

### 14. Is the database connection verified?

**Partially, and off by default (G3, open).** TLS is on by default (`PGSSLMODE=require`, set in `app.yaml`); `PGSSLMODE=disable` turns it off and is for a local database only. The server certificate is verified only when you opt in: set `PG_SSL_CA` (a PEM or a file path; it pins the CA and turns verification on) or `PG_SSL_VERIFY=1` (verifies against Node's trust store); an explicit `0` turns it off (`pgSslOptions` in `server/db/pool.js`, `SECURITY.md`, tests in `server/pgSsl.test.js`). Without either, the connection is encrypted but the server's identity is not validated, which leaves it exposed to an intermediary who can intercept traffic inside the workspace network. It is not the default because the Lakebase chain has not yet been confirmed against the runtime trust store in a real deployment (G-live-6). Until then, set the variable in your deployment or formally accept the risk.

---

### 15. Does the application set security headers (CSP, HSTS)?

**Partial (G6).** On every response the app sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: SAMEORIGIN` and `Permissions-Policy: microphone=(self), camera=()` (the microphone only for the app's own dictation), removes `X-Powered-By`, and sends two CSPs:

- **Enforced**, conservative: `frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'` (`server/securityHeaders.js`).
- **Report-only**, the target policy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'` (`server/middleware/security.js`). The browser blocks nothing under it; it only reports to `POST /api/csp-report`, which logs one JSON line per violation with the directive, the blocked origin, the document path and the disposition, and no query string, sample or identity.

The target policy is not enforced yet because the `srcdoc` iframes of the decks and design-system previews inherit the page's policy and need inline scripts and design-system assets from other hosts (the reason is in [SECURITY.md](../SECURITY.md#http-protections)). The collected reports are the evidence needed before enforcing it. `Referrer-Policy` stays at `same-origin`, which is stricter than `strict-origin-when-cross-origin`: external sites receive no referrer at all. HSTS comes from the Apps proxy. What the proxy adds to the response has not been verified (threat model §7.1).

---

### 16. Is there CSRF protection?

**Yes (G5, mitigated).** `server/csrfGuard.js` refuses with 403 any `POST`, `PUT`, `PATCH`, or `DELETE` on `/api/*` that comes from another site, before it charges the user's rate limit and, under the legacy boot, before it reads the body (under the AppKit boot, AppKit's JSON parser has already read it): `Sec-Fetch-Site: cross-site` is always refused, even when the `Origin` looks like the app's; otherwise an `Origin` or `Referer` from another host is refused. There is no anti-CSRF token. The origin check covers current browsers and does not depend on the `SameSite` setting of the proxy's cookie, which remains unverified. Requests with none of these headers (scripts, `npm run smoke`) pass, because they do not come from a browser.

---

### 17. Are dependencies audited?

**Reported, not enforced (G9, open).** CI runs `npm audit` (runtime set and full tree) in a report-only step that never fails the job, and `.npmrc` sets `audit=false` for the deploy-time install. There is no dependency-update automation and no gate on findings. What exists: `npm ci` with the lockfile (with `--ignore-scripts`), and a deploy that runs the bundle. The bundle embeds the dependencies, so a vulnerability in one stays in the artifact until the bundle is rebuilt in a release.

---

### 18. How do I report a vulnerability?

Through GitHub's private channel (the **Security** tab), as described in [SECURITY.md](../SECURITY.md). Do not open a public issue with technical details.

---

### 19. What does the platform do, and what is the deployer's responsibility?

| Topic | Databricks platform | Whoever deploys |
|---|---|---|
| Authentication and SSO | Apps proxy, OAuth | Configures the workspace and groups |
| Encryption at rest and in transit | Lakebase, UC, Volumes, Apps | Chooses managed keys, if required |
| Network isolation | Workspace and Lakebase network | Configures the network (for example, private link) |
| Data permissions | UC, Genie, Vector Search | Grants access to tables and Genie Agents |
| Cost and limits | SQL Warehouse, Lakebase, AI Gateway | Sets budgets and auto-stop |
| User isolation in the database | Lakebase enforces the policies; it does not create them | The app ships them (row-level security with `FORCE`, migration 0003); the deployer keeps the app role non-owner and without `BYPASSRLS`, and runs the isolation suite against a real branch (G2, G13) |
| Platform audit | `system.access.audit` | Keeps retention and access to the table |
| Dependency scanning and CVEs | — | Reads the report-only `npm audit` output, applies fixes and rebuilds the bundle (G9) |
| Rate limiting and usage quotas | Per-user request and turn limits in the app; budgets in the AI Gateway | Configures per-user budgets |

---

### 20. What does memory store, and how is it purged?

- **What:** short facts about one user (at most 200 entries of 500 characters each), each with a category, its origin (typed by the user, or learned after a turn) and, for a learned fact, the chat it came from. Table `user_memories` in Lakebase, migration 0006.
- **Who can read it:** only its owner. Row-level security on `user_memories` (`app.user_email`), as for chats; admins get no access.
- **What is learned:** after a turn is answered, the intent classifier's small model reads **only the user's message** (never the answer, tool results or web content) and may keep up to three facts. It runs only on short messages with a first-person cue that do not look pasted (no quotes, code fences or e-mail headers), and it drops any fact that reads like an instruction to the assistant or carries a link or an address, so pasted third-party text cannot plant a lasting instruction. It never keeps health, politics, religion or personal finances; a sensitive entry the user types is used only after the user opts in on that entry. A cancelled turn learns nothing. The call is in the ledger as kind `memory`.
- **What reaches the model:** at most 10 entries per turn and at most 1,500 tokens, counted conservatively per script (about twice the usual rate for every language, so dense scripts such as Chinese cannot overflow it), framed as untrusted data, not instructions, with the block markers neutralised inside entries, so an entry cannot pose as a system instruction (see question 10).
- **Logs:** memory text is never logged.
- **How to purge:** the user deletes an entry or all of them (`DELETE /api/memory/:id`, `DELETE /api/memory`). "Forget everything" also stamps a per-user marker (`user_memory_state.forgot_at`), so an extraction still running on any app instance writes nothing afterwards; deleting a chat does not delete what was learned from it. An admin turns the feature off with the tool policy key `memory` (Settings → Tools): no learning, no injection, no listing; stored rows stay until their owner deletes them, and deleting still works. Rolling back migration 0006 drops the table and every entry.

*Platform:* the same Lakebase encryption, residency and backups as the rest of the data.
