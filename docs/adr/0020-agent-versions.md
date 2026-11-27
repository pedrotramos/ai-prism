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

**Sharing is approved twice, and neither approval is the scheduling one.**

1. *The content of a version.* The status columns of a version follow the rules of ADR 0017 (owner: draft, rejected or
   revoked to pending; admin: pending to approved or rejected, approved or pending to revoked; an approval needs the
   pending state). This lets the owner ask to share exactly that content; it shares it with nobody.
2. *The audience.* `agent_shares` carries its own `status`, `approved_by_hash`, `approved_at` and `decision_reason`.
   Adding a person, a group or the whole app is a **request** (pending, forced by the trigger
   `aip_agent_shares_guard`, whatever the statement says) that an admin approves or rejects, **pinned to the version** it
   names: the decision carries the version the admin saw (`expectedVersion`), and a pin that moved meanwhile is
   `409 stale`. The database refuses to approve an audience for a version that is not approved. Re-pinning an
   **approved** audience to another **approved** version keeps its approval (no new decision); any other move, and any
   new principal, is a new request. The owner cannot write the approval columns, and the trigger discards them when she
   moves a pin. Widening the audience after the content was approved is therefore never live without a decision.

Both are independent of the scheduling approval on `agents`, which is untouched: a run still executes
`approved_snapshot`, the approval still voids when the current definition changes, the scheduler identity reads nothing
new. **Submitting or deciding the agent for scheduling never touches `agent_versions`**, and approving a version for
sharing never approves the agent: one decision, one subject. (An earlier draft coupled them, so approving an agent also
approved its current version for sharing; that put a sharing decision on a screen that does not show the audience, and
it is removed.) Consequently an agent that was pending or approved before 0017 starts with a **draft** current version:
to share it the owner submits that version once.

**Shares pin an audience to a version.** `agent_shares(agent_id, version, kind, principal)` with kind `user`, `group`
or `app` (principal `*`), unique per `(agent_id, kind, principal)`; sharing again moves the pin. A recipient can read a
version only when the version is approved **and** an approved share pins it to an audience that contains them
(`aiav_shared_read`, with `aias_recipient_read`, which also shows only approved rows, so the policy's subquery sees
them). Revoking either approval unshares at once. A recipient reads, tries it in a chat or copies it into a draft of
their own (which needs its own approval); the recipient never runs the owner's agent. The owner's editor lists the
audiences from `GET /api/agents/:id/shares`, each with the status of the version it pins, never from the (paged) history.

**An admin may approve her own agent's version or audience.** Single-admin installs need it. It is allowed, the admin
audit row records `self: true`, and the review screen marks the card as the admin's own agent.

**The review queue is cut in SQL.** `GET /api/admin/agent-versions` returns what needs a decision (versions pending, and
approved versions that have an audience pending or live), requests first, paged with `limit` and `offset` and a
`hasMore` flag; an explicit `status` filters in SQL too. The screen filters nothing, so an old request is never hidden
behind newer saves.

**The payload is open.** A version stores whatever `definition` holds. Restore, duplicate, a copy of a shared version and
an edit of the recipe fields carry over the keys the recipe validator does not own (`withPayloadExtras`), so a later flow
graph is not dropped by them; the approval hash covers every key. The screens read a payload through `payloadSummary`,
which never assumes the recipe fields exist.

**Legacy agents get their first row lazily.** A migration cannot write rows after `0003`, so `ensureHeadVersion`
creates the row of the current revision the first time the owner opens the history or saves; history starts where
the feature became live.

**One definition of "what changed".** `shared/agentVersionDiff.ts` is pure and used by the panel, the admin review
card and the tests: a line diff for instructions and prompt, a set diff for tools, before/after for the rest, and any
other top-level key of the payload compared as a whole, so a payload this code has not learned yet still shows up.

## Consequences

- ADR 0017's invariants hold as written; this ADR adds a second, independent approval and does not weaken the first.
- Two new tables, both in `RLS_TABLES` (ten policies in total); the policy count in `server/rls.test.js` goes from
  108 to 118.
- Admin decisions write `agent.version.{approve,reject,revoke}` and `agent.share.{approve,reject,revoke}` audit rows
  (target `agent:ID:vN`; a recipient's e-mail is stored hashed).
- The lazy first row of a legacy agent takes the agent's row lock (`FOR UPDATE`), the one a save takes, so it cannot
  interleave with a save or another first read.
- Storage grows by one row per save; an agent is limited in size already (ADR 0017) and in audiences (50).
- The down migration drops both tables (history and shares). As with 0015, the documented rollback is to redeploy
  the previous release and keep the schema.

## Rejected

- **Pin the scheduling approval to a version.** It would change ADR 0017's semantics and the runner; the additive
  per-version approval keeps both unchanged.
- **Approve "the agent" for sharing.** The owner could edit after the approval and reach the audience with
  unreviewed text; pinning to an immutable row closes that.
- **Approve the content only and let the owner add audiences.** The owner could widen to the whole app after the
  decision. The audience is part of what the admin approves (as in Natura 2.3.x).
- **Let a scheduling approval carry to the version.** Two different consequences on one decision, on a screen that shows
  only one of them.
- **Diff in SQL or on the server only.** The browser needs the diff for two screens; one pure module avoids two
  definitions.
- **Backfill history in the migration.** Not possible after `0003`, and a lazy row is enough.

## Rollback

Hide the feature by redeploying the previous release (it ignores the new tables). `0017_agent_versions.down.sql`
drops them and is never a routine rollback.
