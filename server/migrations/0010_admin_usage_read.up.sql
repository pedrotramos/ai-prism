-- 0010_admin_usage_read: lets an app admin READ the usage ledger of every user
-- (N2, the admin web-search cost tile), and indexes the tile's query.
--
-- usage_ledger is per user (0003 aip_owner: user_email = app.user_email, plus
-- 0005 aipj_member_insert). aipa_admin_read adds ONE permissive SELECT policy
-- keyed on the admin flag, the same shape as admin_audit's read (0007):
--
--   app.is_admin = 'on'  AND  a non-empty app.user_email
--
-- The flag is set by withTx(..., { admin: true }) only for a server-side proof of
-- admin (requireAdmin: req.isAdmin), never from a request. The identity must also
-- be present, so a transaction with no identity fails closed whatever it sets
-- (decision D1). The policy is SELECT only: an admin cannot insert, update or
-- delete another user's ledger row through it.
--
-- What the database will hand an admin-flagged transaction is raw ledger rows
-- (e-mail, session id, model, tokens, cost; no prompt content, the ledger has
-- none). The only code that reads the ledger that way is server/db/adminUsage.js,
-- which exposes aggregates, and the route hashes the users.
--
-- The aipa_ prefix keeps it out of 0003's 'aip\_%' drop loop and 0005's/0007's
-- loops, so re-running those migrations leaves it alone.
--
-- idx_usage_ledger_kind_time serves "one kind over a period" (WHERE kind = $1 AND
-- created_at >= $2 AND created_at < $3). It is a plain, non-concurrent CREATE
-- INDEX (a migration runs in a transaction): it blocks ledger INSERTs while it
-- builds, which takes seconds at current volume. Run the deploy in a quiet
-- window if the ledger is large.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE, CREATE INDEX IF NOT EXISTS.
-- Down: 0010_admin_usage_read.down.sql.

DROP POLICY IF EXISTS aipa_admin_read ON ai_prism.usage_ledger;
CREATE POLICY aipa_admin_read ON ai_prism.usage_ledger FOR SELECT
  USING (
    coalesce(current_setting('app.is_admin', true), '') = 'on'
    AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_usage_ledger_kind_time ON ai_prism.usage_ledger (kind, created_at);
