# ADR 0020: Immutable agent versions with per-version sharing approval

- **Status:** Accepted
- **Date:** 2026-11-27
- **Scope:** migration `0017_agent_versions`, `server/db/agentVersions.ts`, `server/db/agents.ts`,
  `server/routes/agents.ts`, `server/routes/adminAgents.ts`, `shared/agentVersionDiff.ts`, `server/db/rls.ts`
- **Builds on:** [ADR 0017](./0017-agent-definitions-approval.md) (agent definitions and approval), which stays in
  force unchanged.

## Context

Until now an agent was one mutable row: saving overwrote the recipe, and the only thing an admin could approve was
"what is stored right now" (to let the app run it unattended). Three needs follow from sharing agents: people must be
able to see what changed between saves and go back to an older one; an agent must be shareable with a person, a
group or the whole app; and an admin who approves a share must approve **a specific saved content**, so the owner
cannot change it after the approval and have the change reach the audience.

A later feature (the agent studio) stores flow graphs in the same recipe. The version model must therefore treat
the payload as an open document, not as a fixed set of columns.

## Decision

**Every save is a version.** `agent_versions` holds one immutable row per save: `(agent_id, version)` with
`name`, `description`, the `definition` jsonb payload, who saved it and an optional `origin` (restore, duplicate or
copy of a shared version). `agents.revision` is the number of the current version; create, PATCH and restore insert
the row in the same transaction as the agent write. A save that changes nothing (same name, description and
definition hash) is not a version.

**Immutability is enforced by the database.** A BEFORE INSERT OR UPDATE trigger (`aip_agent_versions_guard`) refuses
any change to a version's content, owner, number and origin, for every writer; version numbers only grow. There is no
DELETE policy: history disappears only with the agent (cascade).

**Sharing approval is per version and additive.** The status columns of a version follow the rules of ADR 0017
(owner: draft/rejected/revoked to pending; admin: pending to approved or rejected, approved or pending to revoked;
an approval needs the pending state). They are independent of the scheduling approval on `agents`, which is untouched:
a run still executes `approved_snapshot`, the approval still voids when the current definition changes, and the
scheduler identity still reads nothing new. Approving the current version of an agent that is itself pending is one
decision on the agent (`decideAgent` moves the head version too); the version route answers `409 agent_pending`.

**Shares pin an audience to a version.** `agent_shares(agent_id, version, kind, principal)` with kind `user`, `group`
or `app` (principal `*`), unique per `(agent_id, kind, principal)`; sharing again moves the pin. A recipient can read
a version only when it is approved **and** pinned to an audience that contains them (`aiav_shared_read`, with
`aias_recipient_read` so the policy's subquery sees the share rows). Revoking the approval unshares at once. A
recipient reads, tries it in a chat or copies it into a draft of their own (which needs its own approval); the
recipient never runs the owner's agent.

**Legacy agents get their first row lazily.** A migration cannot write rows after `0003`, so `ensureHeadVersion`
creates the row of the current revision the first time the owner opens the history or saves; history starts where
the feature became live.

**One definition of "what changed".** `shared/agentVersionDiff.ts` is pure and used by the panel, the admin review
card and the tests: a line diff for instructions and prompt, a set diff for tools, before/after for the rest, and any
other top-level key of the payload compared as a whole, so a payload this code has not learned yet still shows up.

## Consequences

- ADR 0017's invariants hold as written; this ADR adds a second, independent approval and does not weaken the first.
- Two new tables, both in `RLS_TABLES` (nine policies in total); the policy count in `server/rls.test.js` goes from
  108 to 117.
- Admin decisions on a version write `agent.version.{approve,reject,revoke}` audit rows (target `agent:ID:vN`).
- Storage grows by one row per save; an agent is limited in size already (ADR 0017) and in audiences (50).
- The down migration drops both tables (history and shares). As with 0015, the documented rollback is to redeploy
  the previous release and keep the schema.

## Rejected

- **Pin the scheduling approval to a version.** It would change ADR 0017's semantics and the runner; the additive
  per-version approval keeps both unchanged.
- **Approve "the agent" for sharing.** The owner could edit after the approval and reach the audience with
  unreviewed text; pinning to an immutable row closes that.
- **Diff in SQL or on the server only.** The browser needs the diff for two screens; one pure module avoids two
  definitions.
- **Backfill history in the migration.** Not possible after `0003`, and a lazy row is enough.

## Rollback

Hide the feature by redeploying the previous release (it ignores the new tables). `0017_agent_versions.down.sql`
drops them and is never a routine rollback.
