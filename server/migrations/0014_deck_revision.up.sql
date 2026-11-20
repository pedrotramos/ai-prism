-- 0014_deck_revision (N6): optimistic concurrency on deck save.
--
-- Why: two tabs editing the same deck overwrote each other silently (the stale tab's
-- next autosave won). Every deck now carries a revision; a save names the revision it
-- was based on and the UPDATE only matches that one (WHERE id = $1 AND revision = $2),
-- incrementing it in the same statement. A stale save matches no row and the app
-- answers 409 deck_conflict.
--
-- Numbering: 0013 is skipped on purpose. It was reserved by a task (F1) that was
-- cancelled and never merged; leaving the number unused means a branch that still
-- carries a 0013 file can never collide with this one.
--
-- A second, short-lived guard covers the AI edit, which calls a model between reading the
-- deck and writing it: chat_decks.tweak_claim / tweak_claim_until are a lease. An AI edit
-- takes it with one conditional UPDATE before the model call (no transaction is held open
-- across the call); a second simultaneous edit finds it taken and is refused (409
-- deck_busy) before it can spend anything. The winner's final write clears it, the route
-- clears it on every error path, and it expires by itself (120 s, set by the app) if the
-- process dies. Both columns are NULL when no edit is running.
--
-- What: chat_decks.revision INT NOT NULL DEFAULT 1; chat_decks.tweak_claim UUID and
-- chat_decks.tweak_claim_until TIMESTAMPTZ, both nullable. Existing decks read as revision 1
-- (the default fills them; no row is rewritten by application code). No policy or grant
-- changes: the column rides the existing owner UPDATE policy and table grants.
-- DDL only (after 0003 a migration never touches rows); idempotent.
ALTER TABLE ai_prism.chat_decks ADD COLUMN IF NOT EXISTS revision INT NOT NULL DEFAULT 1;
ALTER TABLE ai_prism.chat_decks ADD COLUMN IF NOT EXISTS tweak_claim UUID;
ALTER TABLE ai_prism.chat_decks ADD COLUMN IF NOT EXISTS tweak_claim_until TIMESTAMPTZ;
