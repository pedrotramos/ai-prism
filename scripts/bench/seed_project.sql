BEGIN;
SELECT set_config('app.user_email', 'outro-usuario@example.com', true), set_config('app.is_admin', 'off', true);
INSERT INTO projects (name, created_by)
SELECT 'w213 shared', 'outro-usuario@example.com'
 WHERE NOT EXISTS (SELECT 1 FROM projects WHERE name = 'w213 shared');
INSERT INTO project_members (project_id, kind, principal, role, added_by)
SELECT id, 'group', 'w213-analysts', 'view', 'outro-usuario@example.com' FROM projects WHERE name = 'w213 shared'
ON CONFLICT DO NOTHING;
UPDATE chat_sessions SET project_id = (SELECT id FROM projects WHERE name = 'w213 shared')
 WHERE id IN (SELECT id FROM chat_sessions
               WHERE user_email = 'outro-usuario@example.com' AND project_id IS NULL
               ORDER BY id LIMIT :proj_sessions);
COMMIT;
