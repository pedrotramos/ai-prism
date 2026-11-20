# ADR 0016: Project membership as a per-statement set

- **Status:** Accepted
- **Date:** 2026-11-20
- **Scope:** migration `0008_project_member_set`, the `aipj_*` row-level security policies,
  `server/ownerScopedWrites.js`, `server/db/projects.js`, `scripts/bench/explain.sql`

## Context

The project policies (migration 0005) asked "is the caller a member of project X?" with
`aip_project_rank(X) IS NOT NULL`. The function is `SECURITY DEFINER` (it reads
`project_members`, which is not `FORCE`d, as the table owner), so it cannot be inlined. The
policy of `chat_messages` and the other session tables is `EXISTS (SELECT 1 FROM
chat_sessions s WHERE s.id = session_id AND ...)`, and `chat_sessions` carries the
restrictive gate `aipj_project_gate`. The planner turned this into a hashed SubPlan over
every project session the caller can see and called the function twice per row: about 400
calls for 200 sessions, growing linearly, even for a query on a single session (12.6 ms of
13 ms in the W2-13 plan of Q2). The app-side predicates repeated the per-row call.

## Decision

`ai_prism.aip_my_project_ids() RETURNS bigint[]` (`LANGUAGE sql STABLE SECURITY DEFINER`,
pinned `search_path`, owned like `aip_project_rank`) returns the distinct project ids where
the caller has a member row by user (`app.user_email`) or by group (`app.user_groups`), and
`'{}'` without an identity, after a SCIM failure or with malformed groups. Every
**membership** test becomes `x = ANY ((SELECT ai_prism.aip_my_project_ids())::bigint[])`:
the parenthesised scalar subquery is an InitPlan, computed once per statement. The cast is
required: `ANY ((SELECT array_fn()))` parses as `ANY` over a sub-SELECT's rows and compares
`x` with a `bigint[]` row.

`aip_project_rank` stays for **role levels** (`>= 2` manage, `= 3` owner: project, member
and file writes, the `aipj_session_guard` trigger, `historyRewriteAccess`). They touch one
row each and need the role, not the membership.

Semantics are identical by construction (`rank(x) IS NOT NULL` is "a member row matches the
identity", which is "x is in the set"; a NULL `x` is false in both; no identity and malformed
groups give no rows in both) and are proved by an equivalence matrix: the same identities
(owner, manage, view, direct and by group, a non-member, no identity, the admin and
maintenance flags, a failed SCIM lookup, malformed groups) on a database at 0007 and one at
0008, across SELECT, INSERT, UPDATE and DELETE on every `aipj_*` table, see
`server/projectPolicyEquivalence.test.js`. Policy names are unchanged, so
`server/db/rls.js` is untouched; the down migration restores the 0005 policy set verbatim.

## Consequences

- The work no longer depends on the number of project sessions: measured by function calls
  (`docs/performance.md` §4.8), `aip_project_rank` calls drop to 0 on Q1–Q5 and the set is
  read a constant number of times at 200 and at 400 sessions.
- The set is built per statement, so it must stay small: revisit if a caller can be a member
  of more than about 1,000 projects.
- Rule for new policies: membership is a set plus an InitPlan, never a per-row call to a
  `SECURITY DEFINER` function.

## Rejected

- **A security-barrier view of the caller's memberships.** The view runs as its owner and
  `FORCE ROW LEVEL SECURITY` binds the owner, which brings the original problem back, with no
  evidence the planner would avoid the per-row join.
- **The app computes the set and passes it as a setting (`app.project_ids`) in `withTx`.** It
  costs a query on every transaction, including those that touch no project table, and
  freezes the set for the whole transaction, which changes the semantics of transactions that
  edit membership (add a member, then read).
