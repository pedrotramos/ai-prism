-- 0010_admin_usage_read (rollback): drops the admin read policy and the
-- (kind, created_at) index. No data is touched: usage_ledger keeps every row
-- and its other policies (0003 aip_owner, 0005 aipj_member_insert) are exactly
-- as they were before 0010. Needs the table owner. Idempotent.
DROP POLICY IF EXISTS aipa_admin_read ON ai_prism.usage_ledger;
DROP INDEX IF EXISTS ai_prism.idx_usage_ledger_kind_time;
