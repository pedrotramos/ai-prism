-- 0016_tool_call_ui_resource (rollback): drops chat_tool_calls.ui_resource and its size CHECK.
-- DATA LOSS: every stored MCP App snapshot goes with the column; the chat keeps the tool call and its plain result, and an App
-- already shown can no longer be reopened. Idempotent.
ALTER TABLE IF EXISTS ai_prism.chat_tool_calls DROP CONSTRAINT IF EXISTS chat_tool_calls_ui_resource_size;
ALTER TABLE IF EXISTS ai_prism.chat_tool_calls DROP COLUMN IF EXISTS ui_resource;
