# ADR 0015: Admin aggregate read of the usage ledger through a flag-keyed SELECT policy

- **Status:** Accepted
- **Date:** 2026-11-19
- **Scope:** migration `0010_admin_usage_read`, `server/db/adminUsage.ts`, `server/routes/adminUsage.js`, `client/src/components/costs/WebSearchCostTile.jsx`

## Context

`usage_ledger` is per user under row-level security (migration 0003 `aip_owner`: `user_email = app.user_email`;
0005 adds the member insert). An admin therefore had no way to see what web search costs across users, and no
screen to set its price: the price override existed only as an API call. The Costs page reads the Databricks
system tables with the admin's own token, which says nothing about the fixed per-call rows of ADR 0008.

## Decision

1. **A permissive SELECT policy keyed on the admin flag.** `aipa_admin_read` on `usage_ledger`, `FOR SELECT`,
   `USING (app.is_admin = 'on' AND a non-empty app.user_email)`. It mirrors the shape the repository already
   trusts for `admin_audit`; requiring an identity as well keeps the "no identity fails closed" rule (D1). The
   `aipa_` prefix stays out of the `aip\_%`, `aipj\_%` and `aipr\_%` drop loops of 0003, 0005 and 0007.
2. **Aggregates only.** `server/db/adminUsage.ts` is the only module that reads the ledger with the admin flag.
   It returns totals, per UTC day, per provider and the top ten users. `GET /api/admin/usage/tools` replaces each
   user with the audit hash (keyed `h2:` when `APP_AUDIT_HASH_KEY` is set) and returns nothing else from the
   ledger: no e-mail, session or message. Every other ledger query keeps its `WHERE user_email`.
3. **A narrow price editor.** `PUT /api/admin/tool-prices/:key` accepts `web_search` or `web_search:<known provider>`
   and a price from 0 to 1000 USD per 1,000 calls (or `null` to clear), writes the override and its
   `tool_price.set` audit row in one transaction, and refreshes this instance's price book. A price applies to
   future rows only (`cost_usd` is fixed at write time).
4. **An index for the tile.** `idx_usage_ledger_kind_time (kind, created_at)`, a plain `CREATE INDEX`: it blocks
   ledger inserts while it builds (seconds at current volume), documented in the runbook.

## Consequences

- An admin-flagged transaction could read raw ledger rows (e-mail, session id, model, tokens, cost; the ledger
  holds no prompt content). The flag is set only by server code that checked admin (`requireAdmin`), and the one
  reader returns aggregates. An admin who lost the flag sees only their own rows: wrong numbers, nothing leaked.
- The owner policy and the admin policy are OR'd, so the planner can no longer use the `user_email` index from the
  policy alone. Every ledger query of the app names its user, so it still does (`server/rls.test.js` now asserts
  that with an explicit `user_email`).
- The admin flag still cannot insert, update or delete a ledger row through this policy.
- Rollback: `down --to 0009` drops the policy and the index and touches no data.

## Rejected

- **A SECURITY DEFINER aggregate function.** FORCE ROW LEVEL SECURITY binds the owner, so the definer sees
  nothing unless a policy names the owner role, which is configurable (`AI_PRISM_OWNER_ROLE`) and not switched to
  when a superuser runs the migration. Fragile for little gain over a policy.
- **A daily aggregate table maintained at write time.** Fast at any volume, but it adds a write path, a backfill
  and two sources that can drift. Revisit if the tile query exceeds about 200 ms over a 366-day window, or if more
  tool kinds join the tile.
