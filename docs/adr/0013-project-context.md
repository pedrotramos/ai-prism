# ADR 0013: Project context through the turn context-provider registry, inline under a token budget

- **Status:** Accepted
- **Date:** 2026-11-20
- **Scope:** `server/projectContext.ts`, `server/db/projects.js` (`getProjectTurnContext`,
  `listFiles`), `server/routes/projects.js`, migration `0009_project_context`

## Context

A project stores instructions (up to 20,000 characters) and files (extracted text, clipped to
50,000 characters each, up to 50 files), but neither reached a turn: a project chat answered as
if the project did not exist. The worst case is 2.5 M characters per project, so "send
everything" fits no model. The turn already has a seam for extra system messages
(`registerTurnContextProvider`, used by the organization instructions and by memory), run on
chat, continue and regenerate alike, and `server/turn.js` and `server/llm.js` are owned by
other work in the same wave.

## Decision

One provider, `server/projectContext.ts`, installed from `registerProjectRoutes`, so the prompt
order is organization instructions, project, memory. Per turn it reads the session's project as
the caller (`withTx(req.email, req.token)`, row-level security applies) and returns two framed
system messages:

- the instructions, always in full;
- the files, in upload (id) order, whole, until `PROJECT_CONTEXT_FILES_MAX_TOKENS` tokens
  (default 32,000, counted with the conservative `memoryTokens`, 0 turns files off). The first
  file that no longer fits is clipped when at least 1,000 tokens are left, otherwise excluded;
  a later, smaller file can still fit. Every file not read is named to the model ("Not read in
  this chat (over the context budget): ...") so it can say so.

The same selection function answers `GET /api/projects/:id/files` (`context`,
`context_tokens`, `extracted_chars`, `truncated_at_upload`, totals), which is where the user
learns what a chat will not read. `context_tokens` is stored at upload (migration 0009) and
counted on read for older rows.

The output is deterministic (files in id order, no timestamps), so an unchanged project is
byte-identical on every turn and stays in the prompt cache. File content is framed as data and
cannot close its frame (`</project_` in a body is neutralised). The read is bounded by 1.5 s: a
slow or failed read returns nothing, logs one warning, and the turn goes on without the project.
The bound also reaches the database: the read transaction runs `SET LOCAL statement_timeout`
slightly below the provider timeout (the health route's pattern), so Postgres cancels a slow
statement and the pooled connection comes back instead of staying busy until the pool's 60 s
client timeout. The timeout is set before every statement from the time remaining of one shared
budget, re-checked after that round trip (a slow one is set again, and nothing is issued once less
than 10 ms remain), so no statement outlives the budget.

Only the files the selection reads have their text fetched. A file with no stored count (uploaded
before migration 0009) is counted in SQL, with the same per-script weights as `memoryTokens`,
without moving its text to the app; the count is not written back, because `project_files` has no
UPDATE policy on purpose (a stored file is immutable).

## Consequences

- A bounded input cost per project turn (about $0.06 uncached at 32k on a $2/M-token model;
  tool rounds within the turn read it from the cache).
- Overflow files are not read until retrieval exists. The signal to build it: files with
  `context: 'excluded'` on more than about 20% of active projects.
- Members, directly or through a group, get the context; a non-member and an app admin get
  none. A person removed mid-turn gets none from the next read.
- Rollback: unregister the provider (revert), or set the budget to 0 to switch files off.
  `migrate.mjs down --to 8` drops the new columns.

## Alternatives rejected

- **Retrieval over the files now (pgvector chunks):** a new table with policies, an ingestion
  job, an embedding call on the turn path (first-token latency), and recall to tune.
- **A `read_project_file` tool with a manifest in the prompt:** extra tool rounds, depends on
  the model calling it, and needs the tool definitions owned by other work this wave.
