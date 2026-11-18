# AI Prism security FAQ

**English** · [Português (Brasil)](pt-BR/security-faq.md) · [Español](es/security-faq.md)

Answers to objections that come up in security reviews. Each answer separates what **the app does** (code in this repository) from what **the Databricks platform or serverless provides**. When an answer depends on workspace configuration, it says so. For details, see the [threat model](security-threat-model.md) (identifiers G1–G13 and C1–C18 come from there).

---

### 1. Does the app implement login?

**No.** The app has no login screen or authentication flow of its own. The workspace's **Apps proxy** authenticates the user (OAuth/SSO) and forwards the request with `x-forwarded-email` and `x-forwarded-access-token`. The app reads these headers (`server/requestIdentity.js`) and responds with 401 when the token or the email is missing. It also checks with the workspace (`SCIM /Me`) that the email belongs to the token's owner, and responds with 401 if it does not (`server/identityBinding.js`, `IDENTITY_BINDING`; see [SECURITY.md](../SECURITY.md#email-to-token-binding-serveridentitybindingjs)).

*Platform:* authentication, SSO, session expiry, access revocation, and being the only path to the process.
*App:* requires both headers and the binding between them. If the workspace does not respond, the request goes through and the log records a warning.

---

### 2. Can one user see another user's conversation?

**No: the database enforces it (row-level security, migration 0003).** Every app table in the `ai_prism` schema has `ENABLE` and `FORCE ROW LEVEL SECURITY`. The app connects as **one** Postgres role for every user: its service principal, which owns no table, has no `BYPASSRLS`, and is not a member of the owner role after a deploy. Every query runs inside `withTx` (`server/db/pool.js`), which sets the caller's e-mail (`app.user_email`) and an admin flag (`app.is_admin`) for that transaction only. Without them, the app role sees no rows.

- **Per-user tables** (chats, messages, artifacts, images, cost ledger, MCP connections, selections): a row is visible and writable only when it belongs to the caller, directly (`user_email`) or through its chat (`chat_sessions`).
- **Shared tables** (design-system templates, skills): everyone reads their own rows and the global ones; only an admin request writes a global row.
- **Admin tables** (admins, MCP catalog, tool policy, model catalog): everyone reads; only an admin request writes.

The admin flag is set only by server code after the admin check (`requireAdmin`, `authz.isAdmin`), never from a header or body, and it gives no access to other users' own rows. The queries keep their `WHERE user_email` filters as defence in depth. CI proves it: `server/isolation.test.js` (19 cases) runs `db.js` as a non-owner app role under the policies, including a raw `SELECT` on every per-user table that must return 0 of the other user's rows, and `server/rls.test.js` (16 cases) checks the policies, `FORCE`, the role's attributes, the index use, and the migration round trip. G2 and G13 are closed (see the threat model). Still open: running the same check on a real Lakebase branch (runbook in the PR).

---

### 3. Where is the data stored?

- **Conversations, artifacts, embeddings, and the ledger:** Lakebase (serverless Postgres) in your own workspace, created by `databricks.yml`.
- **Generated images:** UC Volume `ai_prism_images` in the `ai_prism` catalog.
- **Data queried:** Unity Catalog, Genie, and Vector Search, always with the user's token (OBO).
- **Model outputs:** calls to the workspace's AI Gateway.

The app **does not send data to other destinations**, except MCP or A2A servers that the user or an admin configured, and web search, when an admin enables it.

**How long it is kept:** until the user deletes the chat, unless an admin sets a retention period (`retentionDays`, off by default). With retention on, a daily sweep deletes every chat idle for longer than that, with its messages, artifacts and image files. The cost rows stay, without the link to the chat ([operations.md §6.8](operations.md#68-retention-org-instructions-and-the-admin-audit-trail)).

*Platform:* region, residency, and encryption at rest and in transit for the workspace.

---

### 4. Is the data used to train models?

It depends on the **model served by the AI Gateway** and on the terms of that model's provider. The app has no way to change that policy. Before enabling a model, an admin must check the endpoint's terms in the workspace itself. This document makes no claim about third-party policy.

---

### 5. Which permissions does the app use, and on whose behalf?

Two modes, by resource (full table in §4 of the [threat model](security-threat-model.md)):

- **OBO (user token):** models, Genie, SQL Warehouse (UC Functions and Python UDFs), Vector Search, and the user's MCP connections. The user can reach only what the user can already reach.
- **App service principal:** Lakebase (default), the images Volume, and the MCP catalog suggestion listing.

The OBO scopes are in `user_api_scopes` in `databricks.yml`. They must be in the bundle, not in `app.yaml`: `bundle deploy` does not apply the scopes from `app.yaml`.

*Limitation:* the SP has more privilege than any single user's reads, for the reason given in answer 2.

---

### 6. Who is an administrator?

- **Owner:** the email in `APP_OWNER_EMAIL`, when set. The bundle does **not** set this variable.
- **Admins:** the `app_admins` table, by email or by workspace group (the group list comes from SCIM, using the user's own token; if SCIM fails, groups grant no access).
- **Bootstrap:** the auto-config job (`bundle/auto_config.py`) records the person who deployed the app as the first admin.

Admin routes go through `requireAdmin`. There is no two-person approval for changing admins.

---

### 7. Is there an audit trail?

Yes, for administrative actions, and there are other sources for the rest:

- **Admin actions (app):** every admin change writes one row to the `admin_audit` table in the same transaction as the change. This covers admins, MCP catalog, tool policy, template scope, global templates and skills, model endpoints, and the retention and org-instruction settings. The retention sweep also writes a row with its counts. The actor is stored as a hash (the same `user_hash` as the logs), never the e-mail. The app cannot change or delete rows. Admins read it with `GET /api/admin/audit` ([operations.md §6.8](operations.md#68-retention-org-instructions-and-the-admin-audit-trail)).
- **Platform:** `system.access.audit` records workspace and Unity Catalog events. It is the reference source for who did what outside the app.
- **App:** `usage_ledger` (cost per call, per user and session) and the chat messages themselves.
- **Logs:** structured JSON lines with `request_id` and `user_hash`. The platform sets the retention (how to query it: [operations.md](operations.md)).

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

- MCP tool descriptions reach the prompt truncated to 300 characters, with no specific sanitization (G7).
- Attachments enter the context as text, without an "untrusted" marker (G12).

What limits the damage: each tool runs with the user's OBO token, so an injection does not expand privileges beyond what the user can already do. The real risk is the model performing a **write** the user did not intend. For that reason, the recommendation is to restrict write tools by policy (`app_tool_policy`) and to require human confirmation.

---

### 11. Is there SSRF protection?

Yes, in the web fetch (`server/web.js`): it blocks `localhost`, private IPs (IPv4 and IPv6, including mapped addresses), resolves DNS before connecting, and limits redirects. There is a test in `server/web.test.js`. The same control has **not** been verified for URLs of MCP servers that users provide. Treat this as an open item to resolve before a formal review.

---

### 12. Is there rate limiting or protection against cost abuse?

**Yes, per user (G4, mitigated).** `server/middleware/rateLimit.js` gives each user a token bucket keyed by the identity the Apps proxy forwards (`x-forwarded-email`), never by IP alone, since many users share one egress IP:

- 120 `/api` requests per minute (`RATE_LIMIT_API_PER_MIN`) and 12 model turns per minute (`RATE_LIMIT_TURNS_PER_MIN`: chat, continue, regenerate, compact and the studio tweaks). `0` turns a limit off. Above the limit the answer is `429` with `Retry-After`.
- Body limits, per route class from one explicit table (`server/middleware/security.js`; every write route has a class): JSON up to 1 MB by default; 40 MB for a design-system import or update; 48 MiB for the deck studio's save, AI edit and native export and the spreadsheet AI edit, which carry slides, speaker notes and images as data URLs (a 40-slide deck with a brand background on every slide exports a 25.6 MB body; an AI edit with four 6 MiB images and a 9 MiB speaker note is 45.4 MB); 4 MB for a workbook save. Chat uploads up to 80 MB and 10 files, skill uploads up to 5 MB and 1 file. Above the limit the answer is `413`. Under the AppKit boot, AppKit's own JSON parser reads the body of every route (up to 64 MB, the memory bound per request) before the app's middleware: the per-route limit still answers `413` from the declared `Content-Length`, and a JSON body without one (chunked) gets `411 Length Required`, because the parsed object does not show how many bytes arrived. By then the bytes have been read, so it is a policy check rather than a memory guard. Under the legacy boot the parser counts the stream itself, chunked or not.
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

**Partially (G3).** The connection uses TLS (`PGSSLMODE=require`), but with `rejectUnauthorized: false` in `server/db.js`, so the server's identity is not validated against a CA. That leaves the connection exposed to an intermediary who can intercept traffic inside the workspace network. The fix is to pin the Lakebase CA. Until then, the risk must be formally accepted.

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

**Not in CI today (G9).** `.npmrc` sets `audit=false`, and CI does not run `npm audit` or any dependency scan. What exists: `npm ci` with the lockfile (with `--ignore-scripts`), and a deploy that runs the committed bundle. The bundle embeds the runtime dependencies, so a vulnerability in a dependency stays in the artifact until the bundle is regenerated.

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
| User isolation in the database | **Not provided** (it is application-level) | Reviews new queries (see G2) |
| Platform audit | `system.access.audit` | Keeps retention and access to the table |
| Dependency scanning and CVEs | — | Runs the scan and regenerates the bundle |
| Rate limiting and usage quotas | Per-user request and turn limits in the app; budgets in the AI Gateway | Configures per-user budgets |
