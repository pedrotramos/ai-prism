# Architecture Decision Records

The architecture decisions of AI Prism. Each ADR has the context, the decision, the
consequences and the rollback. Numbers are sequential and are never reused; an accepted ADR is
not rewritten, it is superseded by a new one. Numbers 0002 to 0005 and 0009 to 0012 have no ADR file; they are not
reserved and no ADR will be backfilled under them.

| ADR | Title | Status | Date | Scope |
|---|---|---|---|---|
| [0001](./0001-appkit.md) | Databricks AppKit as the default boot, adopted incrementally | Accepted | 2026-11-18 | Server bootstrap, packaging, Lakebase, telemetry, AppKit plugins |
| [0006](./0006-typescript.md) | TypeScript by ownership, strict for `.ts` only | Accepted | 2026-11-17 | `tsconfig.json`, `shared/**`, the rule for later conversions |
| [0007](./0007-web-search-backend.md) | Web search backend, MCP-first | Accepted | 2026-11-18 | `server/webSearch/**`, `web_search` / `web_fetch` |
| [0008](./0008-fixed-cost-ledger-rows.md) | Fixed-cost usage ledger rows | Accepted | 2026-11-18 | `server/usage.ts`, `usage_ledger` |
| [0013](./0013-project-context.md) | Project context through the turn context-provider registry, inline under a token budget | Accepted | 2026-11-20 | `server/projectContext.js`, `server/db/projects.js`, migration `0009_project_context` |
| [0014](./0014-message-authorship.md) | Message authorship stamped by the database | Accepted | 2026-11-20 | Migration `0009_project_context` (`chat_messages.sent_by`), `server/db.js` |
| [0015](./0015-admin-ledger-read.md) | Admin aggregate read of the usage ledger through a flag-keyed SELECT policy | Accepted | 2026-11-19 | Migration `0010_admin_usage_read`, `server/db/adminUsage.js`, `server/routes/adminUsage.js` |
| [0016](./0016-project-membership-set.md) | Project membership as a per-statement set | Accepted | 2026-11-20 | Migration `0008_project_member_set`, the `aipj_*` policies, `server/ownerScopedWrites.ts`, `server/db/projects.js` |

Status values: **Proposed** (under review), **Accepted** (in force), **Superseded** (replaced by
a later ADR, named in the file). To add one, copy the structure of the latest ADR and use the
next free number.
