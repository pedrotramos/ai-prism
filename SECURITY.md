# Security Policy

**English** · [Português (Brasil)](docs/pt-BR/SECURITY.md)

AI Prism is an open-source solution accelerator that you deploy in **your own** Databricks workspace. It is not an official Databricks product and has no SLA. We still take vulnerabilities seriously. This document explains how to report them.

## Reporting a vulnerability

**Do not open a public issue** to report a security vulnerability.

Use GitHub's private channel instead:

1. Open the **Security** tab of the repository.
2. Click **Report a vulnerability** (GitHub Security Advisories).

If you prefer, open a minimal issue **with no technical details** asking for a private contact channel. The reply will come through that channel.

Include the following in your report, whenever possible:

- A description of the vulnerability and its potential impact.
- Steps to reproduce it (proof of concept).
- Affected versions and environment (cloud, Databricks CLI version, commit).
- Any mitigation you have already identified.

We will do our best to confirm receipt within a few business days and keep you informed of progress until the issue is resolved.

## Scope

Each installation runs in the workspace of the team that deploys it, so keep the project's trust model in mind:

- **Isolation between users is enforced at the application level** (`WHERE user_email` clauses), on top of an identity supplied by the Apps proxy. Reports of gaps in that isolation (one user accessing another user's data) are especially welcome.
- Authentication uses **user OBO (on-behalf-of)** for API calls, and the **app's service principal** for its own storage (Lakebase, the images Volume).
- Secrets (workspace tokens, Lakebase credentials) must **never** be committed. See [`.env.example`](.env.example) and [`.gitignore`](.gitignore). `.env` is ignored.

## Request identity

The user's identity comes only from the Apps proxy (`server/requestIdentity.js`):

- In the Apps runtime (when `DATABRICKS_APP_NAME`, `DATABRICKS_APP_PORT`, or `DATABRICKS_APP_URL` is set), the request must carry the `x-forwarded-email` and `x-forwarded-access-token` headers. If either one is missing, the response is **401**. In that case, no email or token comes from the environment.
- Outside the runtime, the environment is used only with `LOCAL_DEV_MODE=1` (the `.env.local` from `npm run dev:local`) or `LOCAL_DEV_IDENTITY=1`. `NODE_ENV` does not count: npm sets it to `production` in the repo's scripts.

## Isolation between users

All Postgres connections use the same identity (the app's service principal, or the local user in dev). So every read **and every write** must filter by owner in its own SQL: `chat_sessions.user_email` and, for anything that belongs to a session (messages, tool calls, embeddings, artifacts, the Genie conversation), an `EXISTS` on the caller's session. An enumerable numeric id (BIGSERIAL) cannot be enough on its own.

What this version strengthened:

- **Writes by id** that used to rely on an earlier check now re-check the owner in the same statement (`server/ownerScopedWrites.js`): variant reactivation (the `variant_group` comes from the client), message embeddings, tool calls, the Genie conversation (read and write), skill embedding, and creation of decks, spreadsheets, documents, and images (a session that belongs to someone else gets a 404).
- **Two-user tests** in `server/isolation.test.js`, run against the real functions in `db.js`: sessions, messages, variants, tool calls, embeddings and semantic search, artifacts, MCP connections, skills, Genie, and costs. The suite runs with `node --test server/isolation.test.js` against the Postgres from `npm run local:up`, and it is skipped without that database. It fails on the code from before these changes (variants, tool calls, embeddings, artifacts, skills, and Genie).
- **Writes that depend on the route** (not re-checked in SQL): `upsertSkill`, `deleteSkill`, `updateDeckTemplate`, `deleteDeckTemplate`, and `setDeckTemplateScope` take an admin flag from the caller and are protected by the routes (`requireAdmin` / `isAdmin`). `getUsageStats` (cost audit across all users) does not filter by owner by design, so it may be exposed only behind `requireAdmin`. No route uses it today.

## Third-party content in the prompt

Text that the app does not write, and that goes to the model (descriptions, instructions, and schemas of MCP tools; Genie Agent titles and descriptions; Unity Catalog function comments; document titles), passes through `server/toolMetadata.js`. Imperatives ("ignore the instructions"), role labels ("system:"), HTML, and links are neutralized, and the text is size-limited. This is a partial defense against prompt injection, not a guarantee. The model can still be influenced by text that does not match these patterns. For that reason, tool data must not be treated as a trusted instruction.

Markdown documents are saved without raw HTML and without links that use a dangerous scheme (`shared/markdownSafety.js`). The WYSIWYG editor renders with `innerHTML`, so this prevents a project member from running code in another member's editor.

When the app fetches a URL chosen by the model (the web page tool), the connection follows only public addresses. Loopback, private networks, CGNAT, link-local (including the cloud metadata endpoint), ULA, and reserved addresses are blocked at every redirect hop. The same rule is in `server/a2aGuard.js`, which will be used by A2A.

## TLS for Postgres (Lakebase)

By default the Postgres connection is **encrypted, but the certificate chain is not verified** (`ssl: { rejectUnauthorized: false }` in `server/db.js`, function `pgSslOptions`). This is the project's historical choice, and it has a cost you should know about:

- **Why it exists**: the code does not record the original reason. The likely reason is operational: the app does not bundle the Lakebase CA, so validation against Node's default trust store would fail without extra configuration. The settings below make the CA configurable without changing the default.
- **Threat model**: the connection leaves the app's container and goes to the Lakebase endpoint inside the workspace network. Without verification, an attacker who can intercept that path could impersonate the endpoint and receive the service principal's token or the user's credential (which is the OBO token itself, used as the password). The risk is lower than on a public network, but it is not zero.
- **How to close it**: provide the CA, and verification turns on automatically.

| Variable | Effect |
|---|---|
| (none) | Encrypted, chain not verified (default, unchanged) |
| `PG_SSL_CA` | Inline PEM or file path with the CA. Turns verification on |
| `PG_SSL_REJECT_UNAUTHORIZED=1` | Verifies the chain (with or without `PG_SSL_CA`; without a CA it uses Node's trust store) |
| `PG_SSL_REJECT_UNAUTHORIZED=0` | Does not verify, even with `PG_SSL_CA` (for diagnostics) |
| `PGSSLMODE=disable` | No TLS (local database only) |

With `PG_SSL_CA`, the chain is verified by default, because a pinned CA that is not verified protects nothing. Use the CA that your Lakebase endpoint presents. It is listed in the Lakebase documentation for your workspace.

## Out of scope

- Vulnerabilities in the Databricks platform itself (report them to Databricks).
- Insecure configurations made by whoever deploys the app (for example, exposing secrets or granting overly broad permissions in the workspace).

## Good practices for deployers

- Always run the latest version of `main`.
- Do not hardcode hosts, tokens, or credentials in `app.yaml` or `databricks.yml`. The cloud-agnostic model injects everything at runtime (see the README).
- Restrict access to the app and the workspace with Databricks ACLs.
