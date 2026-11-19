BEGIN;
SELECT set_config('app.user_email', :'who', true), set_config('app.is_admin', 'off', true);

CREATE TEMP TABLE w213_new_sessions ON COMMIT DROP AS
WITH ins AS (
  INSERT INTO chat_sessions (user_email, title, model, created_at, updated_at)
  SELECT :'who', 'carga ' || g, 'databricks-claude-haiku-5-5',
         now() - (g || ' hours')::interval, now() - (g || ' minutes')::interval
  FROM generate_series(1, :nsess) g
  RETURNING id
) SELECT id FROM ins;

-- :msgs messages per session, alternating user/assistant; 1 in 20 carries attachments
CREATE TEMP TABLE w213_new_msgs ON COMMIT DROP AS
WITH ins AS (
  INSERT INTO chat_messages (session_id, role, content, attachments, created_at)
  SELECT s.id,
         CASE WHEN m % 2 = 1 THEN 'user' ELSE 'assistant' END,
         'mensagem de carga ' || m || ' ' || repeat('lorem ipsum ', 20 + (m % 30)),
         CASE WHEN m % 20 = 1 THEN jsonb_build_array('anexo-' || (m % 7) || '.pdf')::text END,
         now() - ((:msgs - m) || ' minutes')::interval
  FROM w213_new_sessions s CROSS JOIN generate_series(1, :msgs) m
  RETURNING id, session_id, role
) SELECT * FROM ins;

-- one tool call per 10 messages (Q3)
INSERT INTO chat_tool_calls (message_id, seq, call_id, tool_name, tool_label, arguments, result, status, duration_ms)
SELECT id, 0, 'call-' || id, 'genie_one', 'Genie One', '{"q":"x"}', '{"ok":true}', 'done', 120
FROM w213_new_msgs WHERE id % 10 = 0;

INSERT INTO chat_message_embeddings (message_id, session_id, embedding)
SELECT m.id, m.session_id,
       (SELECT array_agg(c.v[i] + (random()::float4 - 0.5) * 0.6 ORDER BY i) FROM generate_series(1, 1024) i)::vector
FROM w213_new_msgs m
JOIN w213_centroids c ON c.k = ((m.session_id * 7 + m.id % 3) % 64);

-- one priced ledger row per assistant message, spread over ~90 days (Q6/Q7)
INSERT INTO usage_ledger (user_email, session_id, message_id, kind, model, prompt_tokens, completion_tokens, estimated, cost_usd, source, created_at)
SELECT :'who', session_id, id, 'chat', 'databricks-claude-haiku-5-5', 900, 40, false, 0.0008, 'live',
       now() - ((id % 90) || ' days')::interval
FROM w213_new_msgs WHERE role = 'assistant';
COMMIT;
