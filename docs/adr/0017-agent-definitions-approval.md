# ADR 0017: Agent definitions with database-enforced admin approval

- **Status:** Accepted
- **Date:** 2026-11-21
- **Scope:** migration `0015_agents`, `server/agents/definition.ts`, `server/agents/schedule.ts`,
  `server/agents/events.ts`, `server/db/agents.ts`, `server/db/rls.ts`

## Context

Scheduled agents (Wave 4) let a user save a turn recipe (instructions, prompt, model, tools, a recurring
schedule) that the app later runs unattended, as the app's service principal, with no one watching. That is
the first feature in which a user's text is executed with an identity that is not the user's. Two things must
therefore hold no matter which route, script or future code path writes to the tables: an agent runs only
what an admin looked at, and only while that approval is current.

The repository already enforces isolation in the database (ADR-0003, row-level security with one app role and a
per-transaction identity). Approval is the same kind of rule, so it belongs in the same place.

## Decision

**The approval scope is one jsonb column, `agents.definition`.** It holds instructions, prompt, model, reasoning
effort, tools, schedule and language. `name` and `description` are separate columns outside the scope, so
renaming never voids an approval. `approvalHash` is the sha256 of the canonical form (keys sorted at every
level, array order kept) and is what an admin approves and what a run records.

**A BEFORE INSERT OR UPDATE trigger (`ai_prism.aip_agents_guard`) enforces the rules for every writer:**

1. Without the admin flag the approval columns cannot change, except that the owner moves draft, rejected or
   revoked to pending. An admin decides only pending to approved or rejected, and approved or pending to
   revoked; on someone else's agent an admin can change nothing but those columns and the schedule switch.
2. Any change of `definition` on a pending or approved agent makes it a draft again, disabled, with the
   approval cleared. The comparison is jsonb equality on the stored document, evaluated against the row as it
   is after the statement, so a single `UPDATE ... SET definition = ..., status = ...` cannot keep an approval.
3. An approval is of what is stored: `approved_snapshot` must equal `definition` and only a pending agent can
   be approved. The runner uses the snapshot, never the live row.
4. Under the scheduler identity only `next_run_at`, `last_run_at`, `consecutive_failures`, `disabled_reason`
   and `enabled` (to false only) can change. The check compares the whole row as jsonb, so a column added later
   is guarded by default.
5. `enabled` can become true only while the agent is approved and unexpired. Only the false to true move is
   checked, so a lapsed approval never blocks the scheduler's own bookkeeping.

**Row-level security** (ENABLE and FORCE, `aiag_*` on `agents`, `aiar_*` on `agent_runs`, `aiau_sched_insert`
on `admin_audit`). The owner reaches her rows; an admin reads all agents and runs (and never a chat row); the
**scheduler identity**, defined as "no user and `app.scheduler = 'on'`", reads approved agents, reads and writes
run rows for an agent's own owner, and inserts `system` audit rows of kind `agent.run.*`. Every identity is read
through `NULLIF(..., '')`, so an empty identity matches no row. No other table's policy mentions
`app.scheduler`, so that identity reads nothing else; a test asserts it table by table and a lint test pins
the setting to migration 0015 now and to `server/db/agentScheduler.ts` when that module lands.

**Schedules are structured presets** (hourly, daily, weekdays, weekly, monthly, plus an IANA zone), not cron
strings. They are computed with `Intl`, with the pg-boss rules for the DST gap (runs at the first valid
instant) and for a repeated hour (runs once, at the first occurrence). Nothing more frequent than hourly can be
expressed, and `validateAgentInput` refuses the words and shapes that mean it.

**Tools.** An `mcp:` tool is accepted only for an admin-catalog service of credential class `databricks`; the
other classes need a user credential the service principal does not have.

## Consequences

- A route cannot forget the approval check: the database refuses it. The trigger is the safety net; the
  queries in `server/db/agents.ts` avoid raising for the ordinary refusals (a `WHERE` clause) and answer
  `null`, `'stale'` or `'busy'`.
- Deleting an agent cascades to its runs (their chats stay); retention deleting a chat sets
  `agent_runs.session_id` to null. There is no user table, so `owner_email` has no foreign key: an offboarded
  owner's agents lapse with the approval expiry (default 90 days) or an admin revoke.
- `decideAgent` locks the agent row, compares the hash the admin saw with the hash of the stored definition,
  and writes the decision and its `admin_audit` row in one transaction. A mismatch writes nothing.
- The new tables are not in `APP_TABLES` (that list is the 0002 move set, kept equal to its migration and to
  the hand-off SQL). Like every table created after 0002 they get DML from the owner role's default privileges.
- The down migration is destructive (definitions, approvals and run history). The documented rollback is to
  redeploy the previous release and keep the schema; the previous code ignores these tables.

## Rejected

- **Check the approval in the routes only.** One missed route, script or later feature silently runs an
  unapproved definition. The cost of the trigger is one function; the cost of the miss is unattended execution
  of unreviewed text.
- **A `version` column the approval points to.** It needs a history table and a migration of every reader;
  the snapshot column keeps exactly the approved document and nothing else.
- **Cron strings.** They need a dependency and a validation surface, and they can express a sub-hour storm.
- **A separate database role for the scheduler.** The deployment has one app role by design (ADR-0003); the
  scheduler identity is a transaction-local setting like the user's, with its own narrow policies.

## Rollback

Admin off in Settings (soft), then the operator flag off and a redeploy (hard). Both leave the schema alone.
`0015_agents.down.sql` drops the tables, the trigger and the policies and removes the three settings keys; it
is never a routine rollback.
