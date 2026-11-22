-- 0016_tool_call_ui_resource (W4-5, MCP Apps): the UI resource an MCP tool declared, stored with the tool call that produced it.
--
-- Why: when a tool the model called declares `_meta.ui.resourceUri` (SEP-1865), the host reads that `ui://` resource once and the
-- chat offers it as an interactive View. The snapshot is what was shown at call time; it is served back by
-- GET /api/mcp-apps/view/:toolCallId and deleted with the chat (the FK cascade of 0001 and the retention sweep).
--
-- What: chat_tool_calls.ui_resource JSONB NULL, `{v, uri, serviceName, toolName, html, csp, prefersBorder, sha256, fetchedAt,
-- structuredContent}`. NULL for every call that has no App (all existing rows). A CHECK bounds the stored size at 1,400,000 bytes
-- (the 1 MiB HTML cap plus the 256 KiB structuredContent cap, with the JSON envelope): the app enforces the caps, the database
-- refuses what slips past.
--
-- No policy or grant changes: the column rides the table's existing policies (owner of the chat, or a member of its project) and
-- the table grants. The sessions payload never selects it; only the view and context routes do.
-- DDL only (after 0003 a migration never touches rows); idempotent.
ALTER TABLE ai_prism.chat_tool_calls ADD COLUMN IF NOT EXISTS ui_resource JSONB;
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_prism.chat_tool_calls'::regclass AND conname = 'chat_tool_calls_ui_resource_size') THEN
    ALTER TABLE ai_prism.chat_tool_calls
      ADD CONSTRAINT chat_tool_calls_ui_resource_size CHECK (ui_resource IS NULL OR pg_column_size(ui_resource) <= 1400000);
  END IF;
END
$mig$;
