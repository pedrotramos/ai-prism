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

## Schedules

An agent runs on a schedule you choose with **Repeat**: every hour, every day, weekdays, every week or every month,
with the time (and day), a **time zone** and a preview of the **next three runs**, computed by the server in that
time zone (a time that does not exist on a daylight-saving day runs at the first valid instant; one that happens
twice runs once).

**Custom (advanced).** For what the five options do not say (two times a day, Monday-Wednesday-Friday, the 1st and
15th), pick **Custom (advanced)** and type a standard five-field cron: `minute hour day-of-month month day-of-week`,
with lists (`1,3,5`), ranges (`1-5`), steps (`*/2`), `JAN-DEC` and `SUN-SAT` names and the shortcuts `@hourly`,
`@daily`, `@weekly`, `@monthly`, `@yearly`. When both day fields are restricted a day matches either one, as in
Vixie cron. The editor starts from the cron of the option you had, shows the next three runs as you type, and says
why a cron is refused: wrong field count, a value out of range, no real date (`0 0 31 2 *`) or **more often than
once an hour** (an agent never runs more often than the hourly option). A cron that one of the five options
already covers is saved as that option, so two spellings of "every Monday at 08:00" are one definition. A custom
cron is part of what the administrator approves: editing it, or the time zone, voids the approval like any other
edit. It is saved in one canonical spelling (`MON-FRI`, `mon-fri` and `1,2,3,4,5` are all stored as `1-5`, `7` as `0`),
so the common respellings never change the approval (a day list that starts with `*` and is not a plain step, such as
`*/2,MON`, keeps its own spelling: respelling it counts as an edit), and the review screen shows the administrator what it means: the
description and the next three runs, with a notice when both day fields are set (`0 9 1,15 * 1` runs on the 1st, the
15th **and** every Monday). A date that is rare but real is accepted: `0 0 29 2 *` runs every 29 February and
`0 0 29 2 */7` on the 29 Februaries that fall on a Sunday (2032, 2060, 2088).

**Daylight saving.** A custom cron follows the same rules as the five options: a local time that does not exist that
day runs at the first valid instant after the gap, and one that happens twice runs once, at its first occurrence. The
"not more often than hourly" rule is checked on the wall clock, so on the day clocks go forward `30 1,2 * * *` runs
at 03:00 for its second time, 30 minutes after the first (02:30 does not exist). It is not a guarantee of an hour
between runs on that one day; an agent still never runs twice at once.

### How the scheduler waits

The scheduler does not poll. It reads the database, claims what is due, and then sleeps until the earliest of the
next scheduled run, a queued manual run and the end of a running run's lease. It also looks again at most every
**6 hours** (`AI_PRISM_SCHEDULER_MAX_SLEEP_MS`, 1 second to 24 hours; the old name `AGENT_SCHEDULER_MAX_SLEEP_MS` is
still read) and shortly after the app starts. Approving, enabling, disabling or deleting an agent and queueing a run
wake it at once in the process that handled the request. Between those moments it makes no query, so the app's
connections close (2 minutes idle) and Lakebase can scale to zero between runs.

Consequences worth knowing:

- Several replicas share the work through the same locks as before: a slot is claimed once, whichever replica wakes
  first.
- A change made on one replica reaches the others through use of the app. While anyone uses it the database is awake
  anyway, so a replica that has not looked at the schedules for 5 minutes looks again on its next signed-in request.
  The guarantee: while the app is in use, a schedule saved on a replica that then stops is seen by another within
  about 5 minutes, well inside the hour of grace, so its slot runs. While the app is idle nothing wakes the other
  replicas sooner than their own next run, the 6-hour check or their start, so a slot saved just before the last
  replica that knew of it stopped can be claimed late and, if it is more than an hour late, recorded as `missed`.
  A change made while the same replica is busy is never lost: if an admin turns agents on while it is reading the
  setting, it plans again from the database instead of sleeping on a stale answer.
- A run whose time passed while no replica was awake (the app was stopped) is claimed late if it is less than an hour
  old, and otherwise recorded as **skipped** with the code `missed`. Missed runs are never replayed: the next slot
  counts from now.
- A run row can stay `running` after its app died until the lease (120 s) has expired **and** a replica next wakes
  (within about 5 minutes while the app is in use, up to the max sleep when it is idle); lower
  `AI_PRISM_SCHEDULER_MAX_SLEEP_MS` if that matters more to you than idle Lakebase time.

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
`409 conflict`), delete, `submit`, `enable`, `disable`, `run`, `runs`, `tool-options` (read-only: the tool kinds and Databricks-managed catalog services an agent may use, with the org tool
policy applied) and `schedule-preview` (read-only: it describes a schedule and lists its next three
occurrences from the same functions the scheduler uses, and touches no record). A record that is not the caller's answers
`404 not_found`, exactly as one that does not exist.

Administrators (`/api/admin/agents`): the review queue with the current hash and the identity of each tool,
`approve` (`expectedHash`, optional `days`), `reject` (`reason`), `revoke`, and `settings` (read and write).

Errors carry a stable code in both `error` and `code`; the interface translates it. Run errors that switch a schedule
off at once: `approval_expired`, `approval_changed`, `tool_not_admitted`, `model_not_allowed`, `sp_model_denied`,
`sp_no_user_credentials`, `sp_permission_denied`. Three consecutive transient failures (`sp_unavailable`,
`gateway_error`, `timeout`, `lease_lost`, `lease_expired`, `db_error`) also switch it off.
