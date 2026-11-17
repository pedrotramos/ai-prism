# AI Prism security FAQ

**English** · [Português (Brasil)](pt-BR/security-faq.md)

Answers to objections that come up in security reviews. Each answer separates what **the app does** (code in this repository) from what **the Databricks platform or serverless provides**. When an answer depends on workspace configuration, it says so. For details, see the [threat model](security-threat-model.md) (identifiers G1–G13 and C1–C16 come from there).

---

### 1. Does the app implement login?

**No.** The app has no login screen or authentication flow of its own. The workspace's **Apps proxy** authenticates the user (OAuth/SSO) and forwards the request with `x-forwarded-email` and `x-forwarded-access-token`. The app reads these headers (`server/index.js`, `userEmail` and `userToken`) and responds with 401 when there is no token.

*Platform:* authentication, SSO, session expiry, and access revocation.
*App:* trusts the proxy headers (G1 covers the case where the email is missing).

---

### 2. Can one user see another user's conversation?

**Not by design, but the isolation is enforced by the application, not by the database.** Every read of a conversation, message, artifact, and search filters by owner (`WHERE user_email` or a JOIN with `chat_sessions`). A `sessionId` that belongs to someone else gets 403 before the stream starts.

One point reviewers should know: queries run as the app's **service principal** (`withClient`, `server/db.js`), which has DML on every table in the `public` schema, and **there is no RLS**. Automated two-user tests now run in CI: `server/isolation.test.js` (10 cases, against the real `db.js` functions) and `tests/routes.test.mjs` (reading, listing, and deleting another user's chat are denied). CI runs both with `--fail-on-skip` and requires all 10 isolation cases to pass, so a skipped test fails the CI step. These tests cover only what they exercise. A new query outside that coverage can still expose another user's data. This remains the project's highest-impact gap (G2). The gap of having no automated isolation test in CI (G13) is closed at the application level.

*Planned mitigation:* a dedicated schema with minimal-privilege roles, and RLS with `FORCE`. The isolation suite already runs in CI. Once RLS exists, the suite must also run against it.

---

### 3. Where is the data stored?

- **Conversations, artifacts, embeddings, and the ledger:** Lakebase (serverless Postgres) in your own workspace, created by `databricks.yml`.
- **Generated images:** UC Volume `ai_prism_images` in the `ai_prism` catalog.
- **Data queried:** Unity Catalog, Genie, and Vector Search, always with the user's token (OBO).
- **Model outputs:** calls to the workspace's AI Gateway.

The app **does not send data to other destinations**, except MCP or A2A servers that the user or an admin configured, and web search, when an admin enables it.

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

There are **three sources**, and none of them is a complete audit trail for the app:

- **Platform:** `system.access.audit` records workspace and Unity Catalog events. It is the reference source for who did what.
- **App:** `usage_ledger` (cost per call, per user and session) and the chat messages themselves.
- **Logs:** the process's `console` output, not structured. The platform sets the retention (how to query it: [operations.md](operations.md)).

*Gap (G8):* administrative actions (creating an admin, changing the MCP catalog, changing templates) have no audit table of their own in the app.

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

**Not in the app (G4).** An authenticated user can trigger many turns. The existing protections are:

- Resource limits: SQL Warehouse 2X-Small, `max_num_clusters: 1`, 10-minute auto-stop; Lakebase capped at 16 CU.
- Visibility: per-user `usage_ledger` and the cost dashboard.

*Recommendation:* a native per-user or per-group budget in the workspace, and a rate limit at the proxy, if the workspace offers one.

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

**Not verified (G6).** Express does not set its own security headers (`helmet` is not in the project). Check what the Apps proxy adds to the response before you claim any header.

---

### 16. Is there CSRF protection?

**Not verified (G5).** The write routes have no CSRF token of their own. Protection depends on how the proxy issues the credential (a `SameSite` cookie or an `Authorization` header). Treat this as an open item until the proxy's behavior is confirmed.

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
| Rate limiting and usage quotas | Partial (proxy and budgets) | Configures per-user budgets |
