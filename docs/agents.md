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
`409 conflict`), delete, `submit`, `enable`, `disable`, `run`, `runs`, and `schedule-preview` (read-only: it describes a schedule and lists its next three
occurrences from the same functions the scheduler uses, and touches no record). A record that is not the caller's answers
`404 not_found`, exactly as one that does not exist.

Administrators (`/api/admin/agents`): the review queue with the current hash and the identity of each tool,
`approve` (`expectedHash`, optional `days`), `reject` (`reason`), `revoke`, and `settings` (read and write).

Errors carry a stable code in both `error` and `code`; the interface translates it. Run errors that switch a schedule
off at once: `approval_expired`, `approval_changed`, `tool_not_admitted`, `model_not_allowed`, `sp_model_denied`,
`sp_no_user_credentials`, `sp_permission_denied`. Three consecutive transient failures (`sp_unavailable`,
`gateway_error`, `timeout`, `lease_lost`, `lease_expired`, `db_error`) also switch it off.
