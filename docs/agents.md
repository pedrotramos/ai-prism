# Scheduled agents

**English** · [Português (Brasil)](pt-BR/agents.md) · [Español](es/agents.md)

A scheduled agent is a saved prompt that AI Prism runs on its own, on a schedule, with nobody at the keyboard. Each
run creates one new chat in the owner's history with the answer and any deck, workbook or document it produced.

The feature ships **off**. This page explains who an unattended run acts as and what data it can reach, because that
is the decision an administrator makes when approving an agent.

## Turning it on

Two switches, both needed:

1. The operator sets `AGENTS_ENABLED=1` in the app environment (`app.yaml`) and redeploys. Without it the routes
   answer `404 agents_disabled`, no scheduler starts and the interface is hidden.
2. An administrator turns agents on in Settings (the `agents_enabled` setting). While it is off, an agent can still be
   written and submitted, but it cannot be enabled and "run now" is refused.

To roll back, switch the setting off (soft), then remove `AGENTS_ENABLED` and redeploy (hard). Both keep every
definition and run history.

Administrators also set, in the same place:

| Setting | Default | Range | Meaning |
|---|---|---|---|
| `agents_max_run_cost_usd` | 1.0 | 0.05 – 50 | A run that reaches this cost stops at the next model call; the answer so far is kept with a notice. |
| `agents_approval_days` | 90 | 1 – 365 | How long an approval lasts. After that the agent stops and the owner resubmits. |

Every settings change and every decision writes one row to the admin audit log.

## Life of an agent

1. The owner writes the agent (instructions, prompt, model, tools, optional schedule) and saves it as a **draft**.
   An owner can keep 10 agents.
2. The owner **submits** it. It is now **pending**.
3. An administrator reviews the definition and **approves**, **rejects** (with a reason) or later **revokes** it. The
   screen sends the hash of the definition it showed; if the owner edited the agent in the meantime the approval is
   refused with `409` and nothing is written, so an administrator never approves something they did not read.
4. The owner **enables** the schedule. This is refused unless the agent is approved, the approval has not expired and
   the setting is on. Enabling computes the next run time from the schedule and its time zone.
5. **Run now** queues one manual run of an approved agent. While a run is queued or running, another is refused with
   `409 busy`.

**Any edit of what the administrator approved voids the approval.** The database sets the agent back to draft and
switches it off in the same statement, so no route can forget. Only the name and the description can change without
a new approval. A run always executes the approved snapshot, never the live row, and checks at its start that the
approval is still valid.

## Versions, restore and sharing

Every save of an agent is a **version**: version 1 is the first save, and each later save (any change, including a new
name or description) is the next number. A version never changes afterwards; the database refuses any update of its
content, for everyone. A save that changes nothing is not a version.

- **History.** *Versions* on an agent's card lists every version (who and when, what it was copied from, whether it is
  approved or shared) and shows what changed since the previous one: a line diff of the instructions and the prompt, the
  tools added or removed, and the model, effort, schedule, language, name and description before and after. An agent
  saved before this feature has no earlier history: it starts at the version it had when you first open the history.
- **Restore** saves the content of an old version again as the newest version. Nothing is rewritten or deleted. It goes
  through the same checks as a save, so a model or a tool that is gone cannot come back; and, like any edit of the
  approval scope, it sends an approved or waiting agent back to draft (the screen asks first).
- **Duplicate** copies any of your versions into a new draft agent of yours. It counts against the limit of 10 agents.
- **Sharing is approved twice, and never by the scheduling approval.** First the **content of a version**: *Submit for
  sharing approval* on a version asks an administrator to approve exactly that version. Then each **audience**: you can
  add a person (e-mail), a workspace group, or everyone in the app, and every one of them is a *request* that an
  administrator approves or rejects, pinned to the version it names. Nothing is live until both the version and the
  audience are approved, so adding someone after the content was approved never reaches them without a decision. Moving
  an audience that is already approved to another **approved** version needs no new decision; any other move, or a new
  person or group, is a new request. Revoking either approval stops the sharing at once. An agent can have up to 50
  audiences (moving an audience that is listed does not count against it). The review queue shows what needs a decision,
  requests first, with the audiences of each version and what changed since the last approved version of the same agent;
  it is paged, so an old request is never hidden behind newer saves.
- **Scheduling is unchanged and separate** ([ADR 0017](adr/0017-agent-definitions-approval.md)): the approval that lets
  the app run an agent unattended is still the one on the agent, it still voids when the current content changes, and a
  run still executes the approved snapshot. Submitting or approving the *agent* never approves a version for sharing,
  and approving a version never approves the agent. An agent that was waiting or approved before this feature starts with
  a version that is not submitted: to share it, submit that version once.
- **Who reads it.** A recipient finds the agent under **Shared with you**, reads the approved version, can try it in a
  chat or copy it to their own agents as a draft that needs its own approval. A recipient **cannot run** the owner's
  agent: it still runs only under the owner's approval and as the app. Recipients never see drafts, older or newer
  versions, or who else the agent is shared with.
- **An administrator who owns the agent** can approve their own version or audience (a single-administrator install has
  no one else). It is allowed, the review card says it is the administrator's own agent, and the audit record notes it
  as a self-approval.

Decision record: [ADR 0020](adr/0020-agent-versions.md). Migration: `0017_agent_versions`.

## Who an unattended run acts as

| Part of the run | Identity |
|---|---|
| The model gateway, every tool and every MCP call | **The app's service principal**, not the owner |
| The chat, its messages and artifacts, the usage ledger | The **owner**: the rows belong to them, as if they had sent the message |
| The record that the run started and finished | A system actor in the admin audit log (codes and ids only, no e-mail and no text) |

The run uses the service principal because nobody is there to sign in: a user's own token only exists while they are
in the app.

### What it may do

- Create one new chat owned by the owner, titled with the agent's name and the run time.
- Write that chat's messages, tool calls and artifacts.
- Read the owner's selected deck template and image model.
- Call the model and the tools the administrator approved.

### What it may not do

- Read the owner's other chats: the run starts in a new, empty chat, and cross-chat history search is not used.
- Read or write the owner's memories, or use project context.
- Use any per-user credential, such as a personal MCP connection. A run that needs one fails with
  `sp_no_user_credentials` and the schedule is switched off.
- Use MCP services whose credential class is `per_user`, `shared` or `unverified`. Only the class `databricks` is
  admitted, and only services in the administrators' MCP catalog.
- Call `web_search` while the organization's tool policy has it off.
- Run a definition other than the approved one, or outlive its approval.

## What data an unattended run can reach

This is the point to read before approving.

`genie_one` and MCP tools of class `databricks` read Unity Catalog data **with the service principal's grants, not
the owner's**. So a scheduled agent can see data its owner cannot, if the service principal was granted it, and it
cannot see data its owner can, if the service principal was not.

What follows for administrators:

- **Grant the service principal only data that every agent owner may see.** Treat the service principal's grants as
  the ceiling for what any scheduled agent can read.
- The approval screen lists each tool of the agent and marks the ones that read workspace data. Approve those
  deliberately.
- An agent that only uses `web_search`, `generate_image` or the deck, spreadsheet and document tools does not read
  workspace data.
- The result lands only in the owner's chat. There is no e-mail, webhook or other delivery channel.
- Treat tool output as untrusted: a page or a table can contain text that tries to steer the agent. That is why the
  tool set is fixed at approval, each tool is least-privilege, and a run has no per-user credentials.

AI Prism does not change any grant in the workspace. Granting the service principal access is an operator decision
made in Unity Catalog.

## Reference: HTTP API

Owners (`/api/agents`): `GET status`, list, create, get, `PATCH` (needs `revision`; a stale one answers
`409 conflict`), delete, `submit`, `enable`, `disable`, `run`, `runs`, `tool-options` (read-only: the tool kinds and Databricks-managed catalog services an agent may use, with the org tool
policy applied) and `schedule-preview` (read-only: it describes a schedule and lists its next three
occurrences from the same functions the scheduler uses, and touches no record). A record that is not the caller's answers
`404 not_found`, exactly as one that does not exist.

Administrators (`/api/admin/agents`): the review queue with the current hash and the identity of each tool,
`approve` (`expectedHash`, optional `days`), `reject` (`reason`), `revoke`, and `settings` (read and write).

Versions and sharing (owners): `GET /api/agents/:id/versions` (`before`, `limit`; newest first, with the audiences pinned to
each), `POST /api/agents/:id/versions/:version/restore`, `POST /api/agents/:id/versions/:version/submit`, `POST
/api/agents/:id/duplicate` (`version`, `name`; also the way a recipient copies a shared version), `GET` and `POST
/api/agents/:id/shares` (`version`, `kind` of `user`, `group` or `app`, `principal`; the list carries each audience's status
and the status of its version, and a new one is a pending request), `DELETE /api/agents/:id/shares/:kind/:principal`, and
`GET /api/agents/shared-with-me`. Administrators: `GET /api/admin/agent-versions` (`status`, `limit`, `offset`; answers
`{ versions, hasMore }`, by default what needs a decision, requests first), `POST
/api/admin/agent-versions/:id/:version/approve|reject|revoke` for the content of a version, and `POST
/api/admin/agent-shares/:id/:kind/:principal/approve|reject|revoke` (`expectedVersion`, and `reason` to reject) for an audience;
each is one decision and one audit row (`agent.version.*`, `agent.share.*`). An audience can be approved only for an approved
version (`409 version_not_approved`), and a pin that moved since the screen loaded is `409 stale`.

Errors carry a stable code in both `error` and `code`; the interface translates it. Run errors that switch a schedule
off at once: `approval_expired`, `approval_changed`, `tool_not_admitted`, `model_not_allowed`, `sp_model_denied`,
`sp_no_user_credentials`, `sp_permission_denied`. Three consecutive transient failures (`sp_unavailable`,
`gateway_error`, `timeout`, `lease_lost`, `lease_expired`, `db_error`) also switch it off.
