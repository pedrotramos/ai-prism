// Projects (W2-3, migration 0005): queries for server/routes/projects.js.
//
// Every function runs in ONE withTx transaction as the caller, so row-level
// security binds it (ai_prism.aip_project_rank, the aipj_* policies), and it
// re-checks the caller's role inside that same transaction before writing: the
// role cannot change between the check and the write. A refusal comes back as
// { status } (404 non-member, 403 role too low, 409 conflict) for the route to
// answer; access decisions are server/access.js's.
//
// Also registers the SCIM group resolver of server/access.js with withTx, so
// every transaction of the app carries the caller's groups (app.user_groups).
import { withTx, setTxGroupsResolver } from './pool.js'
import { decide, roleOfRank, canAssignRole, projectGroups } from '../access.ts'
import { memberOfProjectSql } from '../ownerScopedWrites.ts'

setTxGroupsResolver(projectGroups)

const refuse = (status, error) => ({ status, error })

const PROJECT_COLS = `p.id, p.name, p.description, p.instructions, p.created_by, p.created_at, p.updated_at`

function shapeProject(x, role) {
  return {
    id: String(x.id),
    name: x.name,
    description: x.description,
    instructions: x.instructions,
    created_by: x.created_by,
    created_at: x.created_at,
    updated_at: x.updated_at,
    role,
  }
}

async function rankIn(c, projectId) {
  const r = await c.query(`SELECT ai_prism.aip_project_rank($1) AS rank`, [projectId])
  return roleOfRank(r.rows[0]?.rank)
}

/** The caller's role in the project ('owner' | 'manage' | 'view') or null. */
export async function getProjectRole(userEmail, userToken, projectId) {
  return withTx(userEmail, userToken, (c) => rankIn(c, projectId))
}

/** Runs fn(c, role) when the caller's role allows `action`, else returns { status }. */
async function withRole(userEmail, userToken, projectId, action, fn) {
  return withTx(userEmail, userToken, async (c) => {
    const role = await rankIn(c, projectId)
    const status = decide(role, action)
    if (status !== 200) return refuse(status, status === 404 ? 'project_not_found' : 'forbidden')
    return fn(c, role)
  })
}

// ---- projects ----------------------------------------------------------------

export async function listProjects(userEmail, userToken) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT ${PROJECT_COLS}, ai_prism.aip_project_rank(p.id) AS rank FROM projects p
        WHERE ${memberOfProjectSql('p.id')}
        ORDER BY p.updated_at DESC, p.id DESC LIMIT 500`
    )
    return r.rows.map((x) => shapeProject(x, roleOfRank(x.rank)))
  })
}

export async function createProject(userEmail, userToken, { name, description = '', instructions = '' }) {
  const creator = String(userEmail || '').trim().toLowerCase()
  return withTx(userEmail, userToken, async (c) => {
    // no RETURNING: the new row is readable only once the owner row exists (trigger)
    const id = (await c.query(`SELECT nextval(pg_get_serial_sequence('ai_prism.projects', 'id')) AS id`)).rows[0].id
    await c.query(`INSERT INTO projects (id, name, description, instructions, created_by) VALUES ($1, $2, $3, $4, $5)`, [
      id,
      name,
      description,
      instructions,
      creator,
    ])
    const r = await c.query(`SELECT ${PROJECT_COLS} FROM projects p WHERE p.id = $1`, [id])
    return shapeProject(r.rows[0], 'owner')
  })
}

export async function getProject(userEmail, userToken, projectId) {
  return withRole(userEmail, userToken, projectId, 'read', async (c, role) => {
    const r = await c.query(`SELECT ${PROJECT_COLS} FROM projects p WHERE p.id = $1`, [projectId])
    return r.rows.length ? { project: shapeProject(r.rows[0], role) } : refuse(404, 'project_not_found')
  })
}

export async function updateProject(userEmail, userToken, projectId, fields) {
  return withRole(userEmail, userToken, projectId, 'editProject', async (c, role) => {
    const sets = []
    const vals = []
    for (const k of ['name', 'description', 'instructions']) {
      if (fields[k] === undefined) continue
      vals.push(fields[k])
      sets.push(`${k} = $${vals.length}`)
    }
    vals.push(projectId)
    const r = await c.query(
      `UPDATE projects p SET ${[...sets, 'updated_at = NOW()'].join(', ')}
        WHERE p.id = $${vals.length} AND ai_prism.aip_project_rank(p.id) >= 2
        RETURNING ${PROJECT_COLS}`,
      vals
    )
    return r.rows.length ? { project: shapeProject(r.rows[0], role) } : refuse(404, 'project_not_found')
  })
}

/**
 * Deletes the project and its chats (CASCADE). In the same transaction it first
 * collects the Volume paths of the images of ALL the project's chats (every
 * member's: aipj_member_read, migration 0012), because the rows go with the
 * cascade and the files would be orphaned. Returns { ok, imagePaths }: the route
 * deletes the files AFTER the commit (best-effort) and answers { ok: true }.
 */
export async function deleteProject(userEmail, userToken, projectId) {
  return withRole(userEmail, userToken, projectId, 'deleteProject', async (c) => {
    const imgs = await c.query(
      `SELECT i.volume_path FROM chat_images i
         JOIN chat_sessions s ON s.id = i.session_id
        WHERE s.project_id = $1`,
      [projectId]
    )
    const r = await c.query(`DELETE FROM projects p WHERE p.id = $1 AND ai_prism.aip_project_rank(p.id) = 3`, [projectId])
    return r.rowCount ? { ok: true, imagePaths: imgs.rows.map((x) => x.volume_path).filter(Boolean) } : refuse(404, 'project_not_found')
  })
}

// ---- members -----------------------------------------------------------------

function shapeMember(x) {
  return { kind: x.kind, principal: x.principal, role: x.role, added_by: x.added_by, added_at: x.added_at }
}

export async function listMembers(userEmail, userToken, projectId) {
  return withRole(userEmail, userToken, projectId, 'read', async (c) => {
    const r = await c.query(
      `SELECT kind, principal, role, added_by, added_at FROM project_members WHERE project_id = $1 ORDER BY added_at, kind, principal`,
      [projectId]
    )
    return { members: r.rows.map(shapeMember) }
  })
}

export async function addMember(userEmail, userToken, projectId, { kind, principal, role }) {
  return withRole(userEmail, userToken, projectId, 'manageMembers', async (c, actor) => {
    if (!canAssignRole(actor, role)) return refuse(403, 'cannot_grant_role')
    const r = await c.query(
      `INSERT INTO project_members (project_id, kind, principal, role, added_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, kind, principal) DO NOTHING
       RETURNING kind, principal, role, added_by, added_at`,
      [projectId, kind, principal, role, String(userEmail).trim().toLowerCase()]
    )
    return r.rows.length ? { member: shapeMember(r.rows[0]) } : refuse(409, 'already_a_member')
  })
}

// At least one USER owner must remain: a project owned only by a group would
// lose every owner the moment SCIM is unreachable (fail closed).
async function wouldLoseLastOwner(c, projectId, kind, principal) {
  const r = await c.query(
    `SELECT count(*)::int AS n FROM project_members
      WHERE project_id = $1 AND role = 'owner' AND kind = 'user' AND NOT (kind = $2 AND principal = $3)`,
    [projectId, kind, principal]
  )
  return r.rows[0].n === 0
}

async function lockedMember(c, projectId, kind, principal) {
  // the project row serialises roster changes (two owners demoting each other at once)
  await c.query(`SELECT 1 FROM projects WHERE id = $1 FOR UPDATE`, [projectId])
  const r = await c.query(`SELECT kind, principal, role FROM project_members WHERE project_id = $1 AND kind = $2 AND principal = $3`, [
    projectId,
    kind,
    principal,
  ])
  return r.rows[0] || null
}

export async function updateMemberRole(userEmail, userToken, projectId, { kind, principal, role }) {
  return withRole(userEmail, userToken, projectId, 'manageMembers', async (c, actor) => {
    const current = await lockedMember(c, projectId, kind, principal)
    if (!current) return refuse(404, 'member_not_found')
    // touching an owner row, or making one, is an owner's call
    if (!canAssignRole(actor, role) || !canAssignRole(actor, current.role)) return refuse(403, 'cannot_grant_role')
    if (current.role === 'owner' && role !== 'owner' && kind === 'user' && (await wouldLoseLastOwner(c, projectId, kind, principal))) {
      return refuse(409, 'last_owner')
    }
    const r = await c.query(
      `UPDATE project_members SET role = $4 WHERE project_id = $1 AND kind = $2 AND principal = $3
       RETURNING kind, principal, role, added_by, added_at`,
      [projectId, kind, principal, role]
    )
    return r.rows.length ? { member: shapeMember(r.rows[0]) } : refuse(403, 'cannot_grant_role')
  })
}

export async function removeMember(userEmail, userToken, projectId, { kind, principal }) {
  const me = String(userEmail || '').trim().toLowerCase()
  const self = kind === 'user' && principal === me
  return withTx(userEmail, userToken, async (c) => {
    const actor = await rankIn(c, projectId)
    // anyone may leave; removing someone else needs manage (owner rows: owner)
    const status = self ? decide(actor, 'read') : decide(actor, 'manageMembers')
    if (status !== 200) return refuse(status, status === 404 ? 'project_not_found' : 'forbidden')
    const current = await lockedMember(c, projectId, kind, principal)
    if (!current) return refuse(404, 'member_not_found')
    if (!self && !canAssignRole(actor, current.role)) return refuse(403, 'cannot_grant_role')
    if (current.role === 'owner' && kind === 'user' && (await wouldLoseLastOwner(c, projectId, kind, principal))) {
      return refuse(409, 'last_owner')
    }
    const r = await c.query(`DELETE FROM project_members WHERE project_id = $1 AND kind = $2 AND principal = $3`, [projectId, kind, principal])
    return r.rowCount ? { ok: true } : refuse(403, 'forbidden')
  })
}

// ---- files ---------------------------------------------------------------------

export const MAX_FILES_PER_PROJECT = 50

function shapeFile(x, withContent = false) {
  const f = {
    id: String(x.id),
    name: x.name,
    mime: x.mime,
    size_bytes: Number(x.size_bytes),
    uploaded_by: x.uploaded_by,
    created_at: x.created_at,
  }
  if (x.context_tokens != null) f.context_tokens = Number(x.context_tokens)
  if (withContent) f.content_text = x.content_text
  return f
}

/**
 * Members: the files, each with what a chat reads of it (N1a). `deps` is the
 * budget machinery of server/projectContext.js (projectContextDeps()), so the list
 * is decided by the SAME selection the turn uses: per file `context`
 * 'full' | 'partial' | 'excluded', `context_tokens` (counted on read for a file
 * uploaded before migration 0009), `extracted_chars` and `truncated_at_upload`,
 * plus the totals as `context`.
 */
export async function listFiles(userEmail, userToken, projectId, deps) {
  return withRole(userEmail, userToken, projectId, 'read', async (c) => {
    const r = await c.query(
      `SELECT id, name, mime, size_bytes, uploaded_by, created_at, ${FILE_TOKENS_SQL} AS context_tokens,
              length(content_text) AS extracted_chars
         FROM project_files WHERE project_id = $1 ORDER BY id`,
      [projectId]
    )
    if (!deps) return { files: r.rows.map((x) => shapeFile(x)) }
    const sel = deps.select(r.rows.map((x) => ({ id: String(x.id), name: x.name, contextTokens: x.context_tokens })), deps.budget)
    const mode = new Map(sel.files.map((x) => [x.id, x.mode]))
    return {
      files: r.rows.map((x) => ({
        ...shapeFile(x),
        extracted_chars: Number(x.extracted_chars),
        truncated_at_upload: Number(x.extracted_chars) > deps.extractedCharsCap,
        context: mode.get(String(x.id)),
      })),
      context: { budget_tokens: sel.budgetTokens, used_tokens: sel.usedTokens, excluded_count: sel.excludedCount },
    }
  })
}

/**
 * The stored context count of a project file, or, for a file uploaded before
 * migration 0009 (NULL), the same count computed IN SQL from its text, so the text
 * never travels to the app just to be counted. It is not written back: project_files has
 * no UPDATE policy on purpose (a stored file is immutable; projectPolicyEquivalence.test.js
 * asserts it), and only files from before 0009 pay for it. It mirrors memoryTokens
 * (server/memory.js): half a token per ASCII character, one per 0x80-0x7ff, two per
 * 0x800-0xffff, four above (ceil of the half-token sum). Equality with memoryTokens
 * is a test (server/projectContextReads.test.js).
 */
const LEGACY_TOKENS_SQL = String.raw`ceil((char_length(content_text)
    + (char_length(content_text) - char_length(regexp_replace(content_text, '[\u0080-߿]', '', 'g')))
    + 3 * (char_length(content_text) - char_length(regexp_replace(content_text, '[ࠀ-￿]', '', 'g')))
    + 7 * (char_length(content_text) - char_length(regexp_replace(content_text, '[\U00010000-\U0010ffff]', '', 'g')))) / 2.0)::int`
const FILE_TOKENS_SQL = `CASE WHEN context_tokens IS NULL THEN ${LEGACY_TOKENS_SQL} ELSE context_tokens END`


export async function getFile(userEmail, userToken, projectId, fileId) {
  return withRole(userEmail, userToken, projectId, 'read', async (c) => {
    const r = await c.query(
      `SELECT id, name, mime, size_bytes, uploaded_by, created_at, content_text FROM project_files WHERE project_id = $1 AND id = $2`,
      [projectId, fileId]
    )
    return r.rows.length ? { file: shapeFile(r.rows[0], true) } : refuse(404, 'file_not_found')
  })
}

/** files: [{ name, mime, sizeBytes, contentText, contextTokens }] — all or nothing. */
export async function addFiles(userEmail, userToken, projectId, files) {
  const me = String(userEmail || '').trim().toLowerCase()
  return withRole(userEmail, userToken, projectId, 'manageFiles', async (c) => {
    await c.query(`SELECT 1 FROM projects WHERE id = $1 FOR UPDATE`, [projectId])
    const have = (await c.query(`SELECT count(*)::int AS n FROM project_files WHERE project_id = $1`, [projectId])).rows[0].n
    if (have + files.length > MAX_FILES_PER_PROJECT) return refuse(409, 'too_many_files')
    const out = []
    for (const f of files) {
      const r = await c.query(
        `INSERT INTO project_files (project_id, name, mime, size_bytes, content_text, uploaded_by, context_tokens) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, mime, size_bytes, uploaded_by, created_at, context_tokens`,
        [projectId, f.name, f.mime || null, f.sizeBytes, f.contentText, me, f.contextTokens ?? null]
      )
      out.push(shapeFile(r.rows[0]))
    }
    return { files: out }
  })
}

export async function deleteFile(userEmail, userToken, projectId, fileId) {
  return withRole(userEmail, userToken, projectId, 'manageFiles', async (c) => {
    const r = await c.query(`DELETE FROM project_files WHERE project_id = $1 AND id = $2`, [projectId, fileId])
    return r.rowCount ? { ok: true } : refuse(404, 'file_not_found')
  })
}

// ---- sessions in a project --------------------------------------------------------

/**
 * May the caller rewrite the already-written history of a chat (edit a prompt,
 * switch the active variant, regenerate an answer, answer a message's questions,
 * compact)? null = she cannot see the chat at all; { personal: true } for her own
 * personal chat; for a project chat, allowed only with manage or owner (D4: view
 * reads and posts new turns). The SQL of each write re-checks the same rule
 * (historyWriteSql, server/ownerScopedWrites.js).
 */
export async function historyRewriteAccess(userEmail, userToken, sessionId) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT s.project_id, s.user_email, ai_prism.aip_project_rank(s.project_id) AS rank FROM chat_sessions s
        WHERE s.id = $1
          AND ((s.project_id IS NULL AND s.user_email = $2) OR (s.project_id IS NOT NULL AND ${memberOfProjectSql('s.project_id')}))`,
      [sessionId, userEmail]
    )
    if (!r.rows.length) return null
    const x = r.rows[0]
    if (x.project_id == null) return { personal: true, allowed: true }
    return { personal: false, allowed: Number(x.rank) >= 2, role: roleOfRank(x.rank) }
  })
}

export async function listProjectSessions(userEmail, userToken, projectId) {
  return withRole(userEmail, userToken, projectId, 'read', async (c) => {
    const r = await c.query(
      `SELECT s.id, s.title, s.model, s.user_email, s.created_at, s.updated_at FROM chat_sessions s
        WHERE s.project_id = $1 AND ${memberOfProjectSql('s.project_id')}
        ORDER BY s.updated_at DESC LIMIT 500`,
      [projectId]
    )
    return {
      sessions: r.rows.map((x) => ({
        id: String(x.id),
        title: x.title,
        model: x.model,
        owner_email: x.user_email,
        created_at: x.created_at,
        updated_at: x.updated_at,
      })),
    }
  })
}

/** Moves the caller's own personal chat into the project (view+). */
export async function attachSession(userEmail, userToken, projectId, sessionId) {
  return withRole(userEmail, userToken, projectId, 'attachSession', async (c) => {
    // a temporary chat (W3-6) never joins a project: 400, before the trigger would refuse
    const eph = await c.query(`SELECT ephemeral FROM chat_sessions WHERE id = $1 AND user_email = $2`, [sessionId, userEmail])
    if (eph.rows[0]?.ephemeral === true) return refuse(400, 'ephemeral_in_project')
    const r = await c.query(
      `UPDATE chat_sessions SET project_id = $1, updated_at = NOW()
        WHERE id = $2 AND user_email = $3 AND project_id IS NULL`,
      [projectId, sessionId, userEmail]
    )
    return r.rowCount ? { ok: true } : refuse(404, 'session_not_found')
  })
}

/**
 * Moves a project chat back to its creator's personal chats: the creator, with
 * manage+ (a manager who is not the creator would make it invisible to herself,
 * which row-level security refuses: the row must stay visible to the writer).
 */
export async function detachSession(userEmail, userToken, projectId, sessionId) {
  return withRole(userEmail, userToken, projectId, 'detachSession', async (c) => {
    const s = await c.query(`SELECT user_email FROM chat_sessions WHERE id = $1 AND project_id = $2`, [sessionId, projectId])
    if (!s.rows.length) return refuse(404, 'session_not_found')
    if (s.rows[0].user_email !== userEmail) return refuse(403, 'only_the_creator_can_detach')
    const r = await c.query(`UPDATE chat_sessions SET project_id = NULL, updated_at = NOW() WHERE id = $1 AND project_id = $2 AND user_email = $3`, [
      sessionId,
      projectId,
      userEmail,
    ])
    return r.rowCount ? { ok: true } : refuse(404, 'session_not_found')
  })
}

// ---- the turn's project context (N1a) -------------------------------------------------

// A statement is not started with less than this left of the read's budget.
const MIN_STATEMENT_MS = 10
// A timeout round trip that took longer than this is not trusted: the timeout is set again.
const SETTLE_SLACK_MS = 50

/**
 * What a turn in `sessionId` carries of its project, read in ONE transaction as the
 * caller (RLS): null for a personal chat or a project the caller is not a member of
 * (app admins included), else { projectId, name, instructions, files: [{ id, name,
 * mode, text }] (read, upload order), excluded: [name], usedTokens }. `deps` =
 * projectContextDeps() of server/projectContext.js. Only the files the selection
 * reads have their text fetched: a turn never moves a project's whole text.
 */
export async function getProjectTurnContext(userEmail, userToken, sessionId, deps) {
  return withTx(userEmail, userToken, async (c) => {
    // The provider's timeout only stops WAITING: the whole read is also bounded on the SERVER, so a
    // slow statement is cancelled by Postgres and the pooled connection comes back (the health route's
    // pattern). statement_timeout restarts for every statement, so each one gets only what is LEFT of
    // the shared budget (set_config(..., true) = SET LOCAL, gone with the transaction), and a statement
    // is not even issued once less than MIN_STATEMENT_MS remains. No budget (the files API) = no bound.
    const budget = Number(deps.statementTimeoutMs) > 0 ? Math.floor(deps.statementTimeoutMs) : 0
    const deadline = budget ? Date.now() + budget : Infinity
    const run = async (text, values) => {
      if (budget) {
        // The timeout and the statement are two round trips, so the first can itself eat the budget:
        // re-check AFTER it resolves (nothing is issued once less than MIN_STATEMENT_MS remains) and,
        // when it was slow, set the timeout again from the fresh remaining time, so the value in force
        // is never larger than what is left by more than SETTLE_SLACK_MS.
        for (;;) {
          const left = Math.floor(deadline - Date.now())
          if (left < MIN_STATEMENT_MS) throw Object.assign(new Error('project context read timed out'), { code: 'PROJECT_CONTEXT_TIMEOUT' })
          await c.query(`SELECT set_config('statement_timeout', $1, true)`, [String(left)])
          const after = Math.floor(deadline - Date.now())
          if (after < MIN_STATEMENT_MS) throw Object.assign(new Error('project context read timed out'), { code: 'PROJECT_CONTEXT_TIMEOUT' })
          if (left - after <= SETTLE_SLACK_MS) break
        }
      }
      return c.query(text, values)
    }
    const p = await run(`SELECT p.id, p.name, p.instructions FROM chat_sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = $1`, [sessionId])
    if (!p.rows.length) return null
    const project = p.rows[0]
    const list = (
      await run(`SELECT id, name, ${FILE_TOKENS_SQL} AS context_tokens FROM project_files WHERE project_id = $1 ORDER BY id`, [project.id])
    ).rows
    const sel = deps.select(list.map((x) => ({ id: String(x.id), name: x.name, contextTokens: x.context_tokens })), deps.budget)
    const read = sel.files.filter((x) => x.mode !== 'excluded')
    // only the files the selection reads have their text fetched; budget 0 or all-excluded fetches none
    const texts = new Map()
    if (read.length) {
      const r = await run(`SELECT id, content_text FROM project_files WHERE project_id = $1 AND id = ANY($2::bigint[])`, [
        project.id,
        read.map((x) => x.id),
      ])
      for (const t of r.rows) texts.set(String(t.id), t.content_text)
    }
    const byId = new Map(list.map((x) => [String(x.id), x]))
    return {
      projectId: String(project.id),
      name: project.name,
      instructions: project.instructions,
      files: read.map((x) => {
        const text = texts.get(x.id) ?? ''
        return { id: x.id, name: byId.get(x.id).name, mode: x.mode, text: x.mode === 'partial' ? deps.clip(text, x.tokens) : text }
      }),
      excluded: sel.files.filter((x) => x.mode === 'excluded').map((x) => byId.get(x.id).name),
      usedTokens: sel.usedTokens,
    }
  })
}
