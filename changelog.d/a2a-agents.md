### Added

- **A2A 1.0 agents as chat tools**: an admin registers a remote agent by card URL or Databricks App name
  (*Settings → Tools → A2A agents*, `server/routes/a2a.ts`), and every enabled agent is offered to the model as an
  `a2a__<slug>` tool (`server/a2aClient.ts`, on `@a2a-js/sdk`). The client reads the Agent Card, sends messages and
  streams task updates and artifacts back as the tool result. Every call runs as the signed-in user, never as the
  app's service principal.
- **Three auth strategies per agent** (`server/a2aAuth.ts`): `databricks-obo` (the user's Databricks token, sent only
  to this workspace, its own Databricks Apps and `databricks:` hosts), `oauth2-user` (authorization code + PKCE
  against any OIDC or OAuth 2.0 provider configured in `A2A_OAUTH_PROVIDERS`, tokens sealed with AES-256-GCM under
  `A2A_TOKEN_ENC_KEY`) and `none` (public agents, origin-pinned). A card that needs an identity provider nobody
  configured is refused; it never falls back to the Databricks token.
- **In-chat authorization**: when a tool needs a sign-in the user has not done, the turn pauses with an
  *Authorization needed* card (SSE `auth_required`, persisted on the tool call). The user authorizes in a pop-up and
  the answer is redone. MCP services that are not connected use the same card.
- **A2A agents in *Settings → MCP connections***: the user's sign-ins per provider (connect, disconnect with
  provider revocation) and a check per agent with their own account.
- **`apps` user scope** in `app.yaml` and `databricks.yml` for app-to-app OBO. Remove the line to turn it off.
- **Migration 0019**: `a2a_agents` (read by everyone, written by admins) and `a2a_oauth_tokens` (owner-only, not
  readable by admins), both under row-level security.
- **Docs**: `docs/a2a.md` in English, Portuguese and Spanish.

### Security

- **Guarded egress for remote agents** (`server/a2aGuard.ts`): https only, per-strategy host allowlist
  (`A2A_ALLOWED_HOSTS`), every DNS answer checked at connect time, no redirects, timeouts, capped bodies and a short
  header allowlist. The `*.databricksapps.com` app-to-app exception applies only to this workspace's id.

### Deploy notes

- New dependencies: `@a2a-js/sdk` and `jose`.
- Migration 0019 is reserved for this feature; renumber it at merge time if the numbers 0017 and 0018 are not taken
  by then.
- Optional settings: `A2A_ALLOWED_HOSTS`, `A2A_OAUTH_PROVIDERS`, `A2A_TOKEN_ENC_KEY`, `A2A_OAUTH_REDIRECT_BASE`,
  `A2A_REQUEST_TIMEOUT_MS`, `A2A_STREAM_TIMEOUT_MS`, `A2A_MAX_RESPONSE_BYTES`. Without them only Databricks Apps of this
  workspace work, with the user's Databricks token.
