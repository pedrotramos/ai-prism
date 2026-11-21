# ADR 0014: Message authorship stamped by the database

- **Status:** Accepted
- **Date:** 2026-11-20
- **Scope:** migration `0009_project_context` (`chat_messages.sent_by`, trigger
  `aipj_message_sent_by`), `server/db.ts` (`fetchActiveMessages`)

## Context

In a project chat several people write to the same thread, but `chat_messages` had no author:
only the live `busy.by` of the turn lock existed. A shared thread without "who asked" is
unreadable, and an edit by a manager must show who rewrote.

## Decision

`chat_messages.sent_by TEXT NULL`, set by a `BEFORE INSERT` trigger from the transaction
identity: `NEW.sent_by := NULLIF(current_setting('app.user_email', true), '')`. Every insert
path is covered (the turn commit, the edit, the regenerate, the continue), and the trigger
overwrites whatever a client sends, so authorship cannot be spoofed. An assistant row records
who triggered the turn. Rows written without an identity (maintenance, rows from before the
migration) keep `NULL`. The messages API returns `sent_by` on every message.

## Consequences

- Authorship is a fact of the database, not of each call site.
- It is not shown to the model: prefixing replayed user turns with their author needs
  `server/turn.ts` and is a follow-up.
- Rollback (`down --to 8`) drops the column, so stored `sent_by` values are lost.

## Alternatives rejected

- **Passing the author from each call site:** several insert paths, and one forgotten path would
  record nothing or the wrong person.
