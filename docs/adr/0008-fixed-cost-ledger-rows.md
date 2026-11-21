# ADR 0008: Fixed-cost usage ledger rows

- **Status:** Accepted
- **Date:** 2026-11-18
- **Scope:** `server/usage.ts` (`recordToolUsage`, `toolPricePer1k`), `usage_ledger`

## Context

The usage ledger (the "taxímetro") priced only token usage: `recordUsage` drops a call without tokens. A web
search (ADR 0007) costs per call, not per token, and the cost must show up in the same
ledger, under the same rules (a cancelled turn writes nothing).

## Decision

`usage_ledger` accepts token-less rows written by `recordToolUsage({ kind, provider,
units, costUsd, model })`: `kind = 'web_search'`, `model` = the provider id, tokens 0,
`cost_usd` from the first match of: the admin price override for
`tool:web_search:<provider>`, then for `tool:web_search` (the `priceIn` field of that
override row, read as USD per 1,000 calls), then `WEB_SEARCH_PRICE_PER_1K_USD` (every
provider, seeded ones included), then the seed (Brave 5, Tavily 8, SearXNG 0; the MCP providers
none, so `null`). The row goes through the same request scope as token rows: buffered in
the turn, dropped with a cancelled turn, held until the session exists. One row per
answered search; failed attempts write none.

## Consequences

- No migration: the existing columns hold the row, and the existing "not priced" flag
  covers `cost_usd = null`.
- A search that already ran in a turn the user then cancelled is not counted (the same
  known under-count as any cancelled model call).
- An override row keyed `tool:web_search[:<provider>]` lives in the model-override
  catalog; the admin UI that creates it (and keeps it out of the model picker) is a
  separate change.

## Rollback

Stop calling `recordToolUsage`; existing rows stay valid ledger rows.
