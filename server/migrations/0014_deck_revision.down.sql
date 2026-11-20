-- 0014_deck_revision (rollback): drops chat_decks.revision.
-- DATA LOSS: the per-deck revision counter goes with the column; a deck starts again at
-- revision 1 if 0014 is re-applied, and saves stop being checked against a base revision
-- (the app falls back to last-write-wins, as before 0014). Idempotent.
ALTER TABLE IF EXISTS ai_prism.chat_decks DROP COLUMN IF EXISTS revision;
