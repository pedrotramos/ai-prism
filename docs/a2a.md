# A2A agents in AI Prism

**English** · [Português (Brasil)](pt-BR/a2a.md) · [Español](es/a2a.md)

AI Prism can call **remote agents over the A2A protocol** (Agent2Agent, version 1.0) as tools in
chat. An admin registers an agent once; from then on the model can hand it a task, stream its
progress and use its answer, and every call runs with **the signed-in user's own credential**, never
with the app's service principal.

This page covers what the feature does, how an admin turns it on, how users sign in to agents, the
security rules, and how to try it with a small echo agent.

---

## What you get

- **Card discovery.** You give AI Prism the agent's card URL (or the name of a Databricks App). It
  reads the Agent Card (`/.well-known/agent-card.json`), checks it and shows the agent's name,
  description, skills and the sign-in it needs.
- **Message send and streaming.** The call uses `SendMessage`, or `SendStreamingMessage` when the
  card says the agent streams. The task's status updates and artifacts come back to the chat as the
  tool result.
- **Agents as chat tools.** Each enabled agent in the catalog is offered to the model as a tool
  named `a2a__<slug>`. An agent the admin switches off disappears from the tool list for everyone.
- **Three ways to sign in**, chosen per agent at registration (see [Auth strategies](#auth-strategies)).
- **An in-chat authorization card.** When the agent needs a sign-in the user has not done, the turn
  stops with an *Authorization needed* card. The user authorizes in a pop-up and the answer is
  redone. The same card is used for an MCP service that is not connected for the user.
- **A per-user connections page.** *Settings → MCP connections* has an *A2A agents* section below
  the MCP connections: connect or disconnect each sign-in provider and check each agent for your
  account.

---

## Auth strategies

| Strategy | Who the agent sees | Where the credential may go | Typical agent |
|---|---|---|---|
| `databricks-obo` | The signed-in user, through their Databricks token (on-behalf-of) | Only this workspace: its host, its Databricks Apps (`*.databricksapps.com` of **this** workspace) and hosts the admin marked `databricks:` in `A2A_ALLOWED_HOSTS` | Another Databricks App |
| `oauth2-user` | The user's account at an outside identity provider (any OIDC or OAuth 2.0 provider), through authorization code + PKCE | Only hosts that match that provider's `hostPatterns` | An agent behind your company IdP or a SaaS |
| `none` | Nobody: no credential is sent | Only the agent's own origin, and only for a host the admin allowed with a plain `A2A_ALLOWED_HOSTS` entry | A public agent |

AI Prism picks the strategy from the card and the allowlist when the admin registers the agent, and
re-derives it from the current card before every call. A card that asks for an identity provider no
configured provider covers is rejected: it **never falls back to the Databricks token**.

### Databricks Apps (OBO)

The app's `user_authorization` scopes include `apps` (`app.yaml`, and `databricks.yml` for the
bundle deploy). With it, the user's token can call another Databricks App in the same workspace and
that App sees the real user. Delete the `apps` line to turn app-to-app off. The target App must let
that user in (its own `CAN_USE` permission); a refusal shows up as *No access to this agent*.

The `*.databricksapps.com` exception only applies when AI Prism knows its own workspace id (the
Apps runtime sets `DATABRICKS_WORKSPACE_ID`, or the id is read from `DATABRICKS_APP_URL`). An App of
another workspace never receives the user's token on a guess.

### Outside providers (OAuth 2.0 authorization code + PKCE)

AI Prism runs the sign-in itself, in a pop-up, with PKCE (S256) and a single-use `state`. After the
exchange it checks the identity (the ID token is verified against the provider's keys, and the
provider's e-mail must match the user's by default) and keeps the tokens **encrypted at rest**
(AES-256-GCM; the row's owner and provider are bound in as authenticated data, so a row copied to
another user or provider does not decrypt). The browser never receives a token: the pop-up page only
reports a fixed result code.

---

## Turn it on (admin)

1. **Allow the destination.** `A2A_ALLOWED_HOSTS` is a comma-separated list of `host[:port][/path]`
   patterns (a leading `*.` matches one or more labels):

   ```yaml
   env:
     # `databricks:` entries may receive the user's Databricks token (OBO).
     # Plain entries are public agents (no credential is sent).
     - name: A2A_ALLOWED_HOSTS
       value: 'databricks:agents.example-corp.com,public-agent.example.org'
   ```

   Hosts of this workspace and its own Databricks Apps need no entry. Without a matching rule the
   host is refused, whatever the card says.

2. **For `oauth2-user`, configure a provider** (a JSON array in `A2A_OAUTH_PROVIDERS`), the encryption key and the redirect base:

   ```yaml
   - name: A2A_OAUTH_PROVIDERS
     value: >-
       [{"id":"corp-idp","name":"Corp IdP","issuer":"https://idp.example-corp.com",
         "clientId":"ai-prism","clientSecretEnv":"CORP_IDP_SECRET",
         "scopes":["openid","email","agents.invoke"],
         "hostPatterns":["agents.example-corp.com"]}]
   - name: CORP_IDP_SECRET
     valueFrom: 'corp-idp-secret'          # a secret resource, never a literal
   - name: A2A_TOKEN_ENC_KEY
     valueFrom: 'a2a-token-key'            # 32 random bytes as base64 or 64 hex chars
   - name: A2A_OAUTH_REDIRECT_BASE         # only when it differs from DATABRICKS_APP_URL
     value: 'https://my-app.example.com'
   ```

   Register `<app URL>/api/a2a/oauth/<provider id>/callback` as the redirect URI at the provider
   (*Settings → Tools → A2A agents*, admin only, shows the exact value per provider). Provider fields:

   | Field | Meaning |
   |---|---|
   | `id` | `[a-z0-9_-]`, up to 32 characters. Part of the callback URL |
   | `issuer` | OIDC issuer; endpoints come from its discovery document. Or give `authorizationEndpoint` + `tokenEndpoint` (and optionally `userinfoEndpoint`, `jwksUri`, `revocationEndpoint`) |
   | `clientId`, `clientSecretEnv` | The OAuth client. The secret is read from the env var **named** here; omit it for a public client (`tokenEndpointAuthMethod: none`) |
   | `scopes` | Defaults to `openid email` for OIDC |
   | `hostPatterns` | Where the token may be sent. Each entry is a pattern, or `{ "pattern": "...", "send": "access-token" \| "id-token" }` |
   | `requireEmailMatch` | Default `true`: the provider account's verified e-mail must equal the user's |
   | `idTokenHeader` | Optional extra header name. A pattern with `send: "id-token"` then also receives the ID token there (for a gateway that checks it before forwarding) |
   | `authParams` | Extra authorization-request parameters (never `state`, `code_challenge` and the other protocol ones) |

   Without `A2A_TOKEN_ENC_KEY` the strategy is off and the admin panel says so.

3. **Register the agent.** *Settings → Tools → A2A agents* (admin): paste the card URL, or the name
   of a Databricks App in this workspace, and press *Register*. AI Prism reads the card without any
   credential, derives the strategy, and lists the agent with its status. *Check again* re-reads
   the card; the switch offers or hides the agent; *Remove* deletes it from the catalog. A
   sign-in belongs to the provider, not to the agent, so removing an agent keeps the users' connections.

Other limits (all optional): `A2A_REQUEST_TIMEOUT_MS`, `A2A_STREAM_TIMEOUT_MS`,
`A2A_MAX_RESPONSE_BYTES`, and `A2A_ALLOW_INSECURE_LOCAL=1` (http to loopback, **for local development
only**).

---

## For users

- Ask in chat for something an agent does. If the agent needs a sign-in, the *Authorization needed*
  card appears. Press *Authorize with …*, finish the pop-up, and the answer is redone.
- *Settings → MCP connections → A2A agents* lists the sign-ins and the agents. *Check* tests an agent with your
  own account; *Disconnect* asks the provider to revoke the grant and deletes the sealed tokens. If
  the provider does not confirm the revocation, the connection is kept and you can *Remove here
  anyway*.

---

## Security rules

- **Never the app's identity.** Every strategy uses the end user's credential for the target.
- **One audience per credential.** A credential only goes to the hosts its strategy allows
  (table above); it is attached at the transport and never copied into the model's context, logs
  or the browser.
- **Guarded egress** (`server/a2aGuard.ts`, shared with the SSRF rules of `web_fetch`): https only
  (http to loopback only with `A2A_ALLOW_INSECURE_LOCAL=1`), the destination must satisfy the
  strategy's allowlist, every resolved address is checked at connect time (loopback, link-local,
  metadata, ULA and other reserved ranges are blocked; private ranges only for a proven workspace
  host), redirects are never followed, requests time out, bodies are capped, and the headers sent
  are rebuilt from a short allowlist.
- **Tokens at rest.** `a2a_oauth_tokens` is owner-only under row-level security (not even an admin
  reads it) and its columns are AES-256-GCM sealed. Losing the key means users sign in again.
- **Untrusted output.** What an agent returns is data, not instructions: it is wrapped and
  truncated like other tool results, and the card's text (name, description, skills) is sanitized and
  quoted as metadata before it reaches the prompt.
- **Audit.** Registering, enabling and removing an agent are recorded in the admin audit trail
  (`a2a.agent.add`, `a2a.agent.update`, `a2a.agent.remove`).

See the [threat model](security-threat-model.md) (TB6) and the [security FAQ](security-faq.md).

---

## Try it with the echo agent

`server/testing/a2aEchoAgent.ts` is a tiny A2A 1.0 agent used by the tests. It echoes your message and
has trigger words: `input needed` (the task asks you for more), `fail` (the task fails) and `slow`
(stays working about 20 s unless cancelled).

Locally, with AI Prism running in dev mode:

```bash
A2A_ALLOW_INSECURE_LOCAL=1 A2A_ALLOWED_HOSTS=127.0.0.1:4590 \
  node -e "import('./server/testing/a2aEchoAgent.ts').then(m => m.startEchoAgent({ port: 4590, streaming: true }))"
```

then register `http://127.0.0.1:4590/.well-known/agent-card.json` in *Settings → Tools → A2A agents*
and ask the model to *ask the echo agent to say hello*.

As a Databricks App (to see the OBO path end to end), the same agent is packaged under
`examples/a2a-echo/`. Deploy it as its own App, give the user `CAN_USE`, and register its App name.
Delete the App when you finish.

---

## Reference

| Setting | Where | Purpose |
|---|---|---|
| `apps` | `user_authorization` in `app.yaml`, `databricks.yml` | Lets the user's token call another Databricks App (OBO) |
| `A2A_ALLOWED_HOSTS` | env | `databricks:`-prefixed = may receive the Databricks token; plain = public agent |
| `A2A_OAUTH_PROVIDERS` | env (JSON) | Outside sign-in providers |
| `A2A_TOKEN_ENC_KEY` | env (secret) | 32-byte key (base64 or hex) that seals stored tokens |
| `A2A_OAUTH_REDIRECT_BASE` | env | Public base URL for the callback; defaults to `DATABRICKS_APP_URL` |
| `A2A_REQUEST_TIMEOUT_MS`, `A2A_STREAM_TIMEOUT_MS`, `A2A_MAX_RESPONSE_BYTES` | env | Egress limits |
| `A2A_ALLOW_INSECURE_LOCAL` | env | `1` allows http to loopback (development only) |

| Route | Who | Purpose |
|---|---|---|
| `GET /api/a2a/agents` | any user | Catalog with this user's status per agent |
| `POST /api/a2a/agents`, `POST /api/a2a/agents/:id/verify`, `PUT /api/a2a/agents/:id/enabled`, `DELETE /api/a2a/agents/:id` | admin | Register, re-read the card, offer or hide, remove |
| `POST /api/a2a/agents/:id/check` | any user | Test an agent with the user's own credential |
| `GET /api/a2a/providers`, `GET /api/admin/a2a/providers` | user, admin | Providers (admin view adds the redirect URI and config errors) |
| `GET /api/a2a/oauth/:provider/start`, `GET /api/a2a/oauth/:provider/callback`, `DELETE /api/a2a/oauth/:provider` | user | Pop-up sign-in, callback, disconnect |
