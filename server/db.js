import { randomUUID } from 'node:crypto'
import { createFifoLimiter } from './fifoLimiter.ts'
import { sanitizeDsHtml } from './sanitizeDsHtml.js'
import {
  activateOwnedVariantGroup,
  getOwnedGenieConversationId,
  insertOwnedDeck,
  insertOwnedDocument,
  insertOwnedMessage,
  insertOwnedSpreadsheet,
  insertOwnedToolCalls,
  setOwnedGenieConversation,
  setOwnedSkillEmbedding,
  updateOwnedChartCandidates,
  upsertOwnedMessageEmbedding,
  historyWriteSql,
  ownSessionSql,
  sessionAccessSql,
  memberOfProjectSql,
} from './ownerScopedWrites.ts'
import { runInIdentityTx, withSchemaClient, withTx } from './db/pool.js'
import { migrateUp } from './db/migrate.js'
import { principalTarget, recordAdminAction, recordBootstrapAdminSeeds } from './audit.ts'
import { logger } from './log.ts'
import { recordEphemeralStarted } from './db/ephemeral.js'

// Connection identity, pooling, TLS, the search path and the SQL entry points
// live in server/db/pool.js; re-exported here so every importer keeps its names.
// New feature queries go in server/db/<feature>.js using withTx: every query
// runs in a transaction that carries the caller's identity for row-level
// security (app.user_email; app.is_admin only when an admin route passes
// { admin: true }). See server/migrations/0003_rls.up.sql.
// Admin mutations (admins, MCP catalog, tool policy, template scope, global
// templates and skills, model overrides) write their admin_audit row inside
// the same transaction (recordAdminAction, server/audit.js; W2-5), only when
// the mutation changed something.
// The SP's grants are no longer applied per request (W1-5): the deploying
// identity runs `node scripts/migrate.mjs grants` (server/db/grants.js).
export {
  APP_SCHEMA,
  APP_SEARCH_PATH,
  appServiceToken,
  PG_POOL_IDLE_TIMEOUT_DEFAULT_MS,
  pgPoolIdleTimeoutMs,
  pgSslOptions,
  rememberGrantsCaller,
  runAppGrantsFromApp,
  withSchemaClient,
  withTx,
} from './db/pool.js'

// Embedding writes (one per message, plus backfills) go through a FIFO with two
// slots: a backfill of a long history must not open a burst of connections that
// starves the chat turn's own queries of pool slots (max 8).
const embeddingWriteLimiter = createFifoLimiter(2)

// Keep-alive for scale to zero: a visible tab pings GET /api/keepalive every few
// minutes, and this runs one `SELECT 1` so the endpoint doesn't suspend under a
// user who is still looking at the app. Throttled per process: at most one query
// per DB_KEEPALIVE_MIN_INTERVAL_MS however many tabs ping. Returns whether a
// query ran. Uses the same pool/identity as every other query (token rotation
// semantics unchanged); a failure resets the throttle so the next ping retries.
export const DB_KEEPALIVE_MIN_INTERVAL_MS = 3 * 60 * 1000
let lastKeepAliveAt = 0
export async function touchDatabase(userEmail, userToken, { now = Date.now(), minIntervalMs = DB_KEEPALIVE_MIN_INTERVAL_MS } = {}) {
  if (now - lastKeepAliveAt < minIntervalMs) return false
  lastKeepAliveAt = now
  try {
    await withTx(userEmail, userToken, (c) => c.query('SELECT 1'))
  } catch (e) {
    lastKeepAliveAt = 0
    throw e
  }
  return true
}

// Schema: versioned SQL migrations (server/migrations/NNNN_<name>.{up,down}.sql)
// applied by server/db/migrate.js under a Postgres advisory lock, recorded in
// schema_migrations. Steady state is two cheap SELECTs and no lock. A database
// with the complete 1.4 schema is recorded as version 1 without re-running DDL.
// Never add DDL here: write a new migration file instead (docs/operations.md).
// Returns migrateUp's result; `deferred` non-empty = retry later (ensureReady).
// After the migrations: the audit row of the deploy's first-admin seed (W2-17,
// server/audit.js recordBootstrapAdminSeeds), which bundle/auto_config.py
// cannot write (it runs before 0007 exists). Admin flag, no user identity; a
// failure is logged and never fails the schema step (the next boot retries).
export async function ensureSchema(userEmail, userToken) {
  return withSchemaClient(userEmail, userToken, async (c) => {
    const result = await migrateUp(c)
    try {
      const n = await runInIdentityTx(c, '', { admin: true }, (tc) => recordBootstrapAdminSeeds(tc))
      if (n) logger.info(`admin audit: recorded ${n} first-admin seed grant(s) of the deploy`)
    } catch (e) {
      logger.warn('admin audit: could not record the first-admin seed grant (retried at the next boot)', { err: e })
    }
    return result
  })
}

// Genie conversations are per (session, space): both read and write are gated on
// the caller owning the session (a guessed session id must not expose or extend
// another user's Genie thread).
export async function getGenieConversationId(userEmail, userToken, sessionId, spaceId) {
  return withTx(userEmail, userToken, async (c) => getOwnedGenieConversationId(c, userEmail, sessionId, spaceId))
}

export async function setGenieConversationId(userEmail, userToken, sessionId, spaceId, conversationId) {
  await withTx(userEmail, userToken, async (c) => {
    await setOwnedGenieConversation(c, userEmail, sessionId, spaceId, conversationId)
  })
}

export async function getSessionChartCandidates(userEmail, userToken, sessionId) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT chart_candidates FROM chat_sessions s WHERE s.id = $1 AND ${sessionAccessSql('s', '$2')}`, [
      sessionId,
      userEmail,
    ])
    const state = r.rows[0]?.chart_candidates
    return { nextId: state?.nextId || 1, items: Array.isArray(state?.items) ? state.items : [] }
  })
}

// The SQL of the answer's writes lives in ownerScopedWrites.js (W2-14): a turn
// writes them in ONE transaction (server/db/turnCommit.js); these wrappers are
// the same statements, each in its own.
export async function saveSessionChartCandidates(userEmail, userToken, sessionId, state) {
  await withTx(userEmail, userToken, (c) => updateOwnedChartCandidates(c, userEmail, sessionId, state))
}

// projectId: a new chat inside that project (W2-3). Row-level security refuses
// it unless the caller is a member (aipj_project_gate); the turn route checks first.
// ephemeral (W3-6): a temporary chat, fixed at creation (never in a project);
// its start is counted in the same transaction (server/db/ephemeral.js).
export async function createSession(userEmail, userToken, title, model, systemPrompt, enabledTools = [], projectId = null, ephemeral = false) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `INSERT INTO chat_sessions (user_email, title, model, system_prompt, enabled_tools, project_id, ephemeral)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [userEmail, title, model, systemPrompt || null, JSON.stringify(enabledTools || []), projectId, ephemeral === true]
    )
    if (ephemeral === true) await recordEphemeralStarted(c)
    return r.rows[0].id
  })
}

const MAX_ATTACHMENT_NAMES_PER_SESSION = 6

export async function listSessions(userEmail, userToken, limit = 100) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT s.id, s.title, s.model, s.system_prompt, s.enabled_tools, s.created_at, s.updated_at, s.project_id, s.ephemeral,
              COALESCE(att.names, ARRAY[]::text[]) AS attachment_names
       FROM chat_sessions s
       LEFT JOIN LATERAL (
         SELECT array_agg(DISTINCT elem) AS names
         FROM chat_messages m
         CROSS JOIN LATERAL jsonb_array_elements_text(m.attachments::jsonb) AS elem
         WHERE m.session_id = s.id AND m.attachments IS NOT NULL
       ) att ON true
       WHERE ${ownSessionSql('s', '$1')}
       ORDER BY s.updated_at DESC LIMIT $2`,
      [userEmail, limit]
    )
    return r.rows.map((x) => ({
      id: String(x.id),
      title: x.title,
      model: x.model,
      system_prompt: x.system_prompt,
      enabled_tools: x.enabled_tools || [],
      created_at: x.created_at,
      updated_at: x.updated_at,
      project_id: x.project_id != null ? String(x.project_id) : null,
      ephemeral: x.ephemeral === true,
      attachment_names: (x.attachment_names || []).slice(0, MAX_ATTACHMENT_NAMES_PER_SESSION),
    }))
  })
}

// One chat the caller can use: her own personal chat, or a project chat of a
// project she is a member of (W2-3). `project_id` / `owner_email` (the creator)
// / `role` (the caller's project role) are null for a personal chat.
export async function getSession(userEmail, userToken, sessionId) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT s.id, s.title, s.model, s.system_prompt, s.enabled_tools, s.project_id, s.user_email, s.ephemeral,
              CASE WHEN s.project_id IS NOT NULL THEN ai_prism.aip_project_rank(s.project_id) END AS rank
         FROM chat_sessions s
        WHERE s.id = $1 AND ${sessionAccessSql('s', '$2')}`,
      [sessionId, userEmail]
    )
    if (!r.rows.length) return null
    const x = r.rows[0]
    const inProject = x.project_id != null
    return {
      id: String(x.id),
      title: x.title,
      model: x.model,
      system_prompt: x.system_prompt,
      enabled_tools: x.enabled_tools || [],
      project_id: inProject ? String(x.project_id) : null,
      ephemeral: x.ephemeral === true,
      owner_email: inProject ? x.user_email : null,
      role: inProject ? ['view', 'manage', 'owner'][Number(x.rank) - 1] || null : null,
    }
  })
}

export async function updateSession(userEmail, userToken, sessionId, fields) {
  const sets = []
  const vals = []
  let i = 1
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${i++}`)
    vals.push(k === 'enabled_tools' ? JSON.stringify(v || []) : v)
  }
  if (!sets.length) return
  sets.push(`updated_at = NOW()`)
  vals.push(sessionId, userEmail)
  await withTx(userEmail, userToken, async (c) => {
    await c.query(
      `UPDATE chat_sessions SET ${sets.join(', ')} WHERE id = $${i++} AND ${ownSessionSql('chat_sessions', `$${i}`)}`,
      vals
    )
  })
}

export async function touchSession(userEmail, userToken, sessionId) {
  await withTx(userEmail, userToken, async (c) => {
    await c.query(`UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1 AND ${sessionAccessSql('chat_sessions', '$2')}`, [
      sessionId,
      userEmail,
    ])
  })
}

export async function deleteSession(userEmail, userToken, sessionId) {
  await withTx(userEmail, userToken, async (c) => {
    await c.query(`DELETE FROM chat_sessions WHERE id = $1 AND ${ownSessionSql('chat_sessions', '$2')}`, [
      sessionId,
      userEmail,
    ])
  })
}

export async function setSessionEmbedding(userEmail, userToken, sessionId, vec) {
  await embeddingWriteLimiter.run(() =>
    withTx(userEmail, userToken, async (c) => {
      await c.query(
        `UPDATE chat_sessions SET embedding = $1 WHERE id = $2 AND NOT ephemeral AND ${ownSessionSql('chat_sessions', '$3')}`,
        [vec, sessionId, userEmail]
      )
    })
  )
}

// Returns every session with its stored embedding and a concatenated text doc
// (title + message contents) used to (re)build embeddings for semantic search.
export async function listSessionsForSearch(userEmail, userToken) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT s.id, s.title, s.embedding,
              COALESCE(string_agg(m.content, ' ' ORDER BY m.id) FILTER (WHERE m.role = 'user'), s.title) AS doc
       FROM chat_sessions s
       LEFT JOIN chat_messages m ON m.session_id = s.id
       WHERE ${ownSessionSql('s', '$1')}
       GROUP BY s.id, s.title, s.embedding, s.updated_at
       ORDER BY s.updated_at DESC`,
      [userEmail]
    )
    return r.rows.map((x) => ({
      id: String(x.id),
      title: x.title,
      embedding: x.embedding,
      doc: x.doc || x.title,
    }))
  })
}

// pgvector's wire format over node-postgres is a string literal like
// '[0.1,0.2,...]' (there's no array type parser registered), both for INSERT
// params and for the `<=>` distance operator's right-hand side.
function toVectorLiteral(vec) {
  return `[${vec.join(',')}]`
}

// Upserts the embedding for one message. Best-effort caller (tail of a turn);
// session_id is stored so retrieval can filter per session without a JOIN on
// the hot path of the ANN scan. ON CONFLICT keeps it idempotent under retries.
export async function setMessageEmbedding(userEmail, userToken, sessionId, messageId, vec) {
  // owner re-checked in the statement: a message outside the caller's sessions writes nothing
  await embeddingWriteLimiter.run(() =>
    withTx(userEmail, userToken, async (c) => {
      await upsertOwnedMessageEmbedding(c, userEmail, sessionId, messageId, toVectorLiteral(vec))
    })
  )
}

// Semantic retrieval of the most relevant messages from ONE session, EXCLUDING
// the most recent `excludeRecent` messages (those are already replayed verbatim
// by the recency window — no point retrieving them too). Ownership is enforced
// by joining back to chat_sessions on user_email. Returns oldest-first so the
// caller can splice them into the prompt in chronological order. `<=>` is
// cosine distance (0 = identical); we convert to a similarity floor.
export async function retrieveRelevantMessages(
  userEmail,
  userToken,
  sessionId,
  queryVec,
  { topN = 6, excludeRecent = 6, minSimilarity = 0.35 } = {}
) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `WITH scoped AS (
         SELECT m.id, m.role, m.content, m.created_at,
                1 - (e.embedding <=> $2::vector) AS similarity,
                ROW_NUMBER() OVER (ORDER BY m.id DESC) AS recency_rank
           FROM chat_message_embeddings e
           JOIN chat_messages m ON m.id = e.message_id
           JOIN chat_sessions s ON s.id = m.session_id AND ${sessionAccessSql('s', '$3')}
          WHERE e.session_id = $1 AND m.active = true
       )
       SELECT id, role, content, similarity
         FROM scoped
        WHERE recency_rank > $4 AND similarity >= $5
        ORDER BY similarity DESC
        LIMIT $6`,
      [sessionId, toVectorLiteral(queryVec), userEmail, excludeRecent, minSimilarity, topN]
    )
    // return oldest-first (by id) for chronological splicing into the prompt
    return r.rows
      .map((x) => ({ id: String(x.id), role: x.role, content: x.content, similarity: x.similarity }))
      .sort((a, b) => Number(a.id) - Number(b.id))
  })
}

// Session-level semantic search (sidebar) via pgvector: aggregates each
// session's message vectors to its best match against the query, so the search
// reflects any turn in the conversation, not just a single session-level
// embedding. Runs the ranking IN the database (indexed) instead of pulling all
// vectors into Node. Ownership scoped by user_email.
export async function searchSessionsByVector(userEmail, userToken, queryVec, { limit = 20, minSimilarity = 0.3 } = {}) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT s.id, s.title, MAX(1 - (e.embedding <=> $1::vector)) AS score
         FROM chat_message_embeddings e
         JOIN chat_sessions s ON s.id = e.session_id AND NOT s.ephemeral AND ${ownSessionSql('s', '$2')}
        GROUP BY s.id, s.title
       HAVING MAX(1 - (e.embedding <=> $1::vector)) >= $3
        ORDER BY score DESC
        LIMIT $4`,
      [toVectorLiteral(queryVec), userEmail, minSimilarity, limit]
    )
    return r.rows.map((x) => ({ id: String(x.id), title: x.title, score: x.score }))
  })
}

// Messages in a session missing a per-message embedding (lazy backfill target).
// Only user/assistant text is worth embedding; empty rows are skipped.
export async function listMessagesMissingEmbedding(userEmail, userToken, sessionId) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT m.id, m.role, m.content
         FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id AND NOT s.ephemeral AND ${sessionAccessSql('s', '$2')}
         LEFT JOIN chat_message_embeddings e ON e.message_id = m.id
        WHERE m.session_id = $1 AND e.message_id IS NULL
          AND m.content IS NOT NULL AND length(trim(m.content)) > 0
        ORDER BY m.id ASC`,
      [sessionId, userEmail]
    )
    return r.rows.map((x) => ({ id: String(x.id), role: x.role, content: x.content }))
  })
}

// Un-embedded messages across ALL of the user's sessions, newest-first, capped.
// Powers the migration backfill so search/retrieval work on history that predates
// this feature — the newest sessions (most likely searched) index first.
export async function listUserMessagesMissingEmbedding(userEmail, userToken, limit = 200) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT m.id, m.session_id, m.role, m.content
         FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id AND NOT s.ephemeral AND ${ownSessionSql('s', '$1')}
         LEFT JOIN chat_message_embeddings e ON e.message_id = m.id
        WHERE e.message_id IS NULL
          AND m.content IS NOT NULL AND length(trim(m.content)) > 0
        ORDER BY m.id DESC
        LIMIT $2`,
      [userEmail, limit]
    )
    return r.rows.map((x) => ({ id: String(x.id), sessionId: String(x.session_id), role: x.role, content: x.content }))
  })
}

/**
 * Inserts a message. Pass `variantGroup` (the original message's id) to add a
 * regenerated variant to an existing slot — the new row becomes the active
 * one and every sibling in that group is deactivated. Omit it for a normal
 * new message, which becomes its own single-variant group.
 */
export async function addMessage(userEmail, userToken, msg) {
  // ownership is inherited from the session: see insertOwnedMessage
  return withTx(userEmail, userToken, (c) => insertOwnedMessage(c, userEmail, msg))
}

// Raw row lookup for a single message — used by the edit endpoint to verify
// role/ownership and to carry over the variant_group + attachment tail.
export async function getMessageRaw(userEmail, userToken, messageId) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT m.session_id, m.role, m.content, m.attachments, m.variant_group FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND ${sessionAccessSql('s', '$2')}
       WHERE m.id = $1`,
      [messageId, userEmail]
    )
    if (!r.rows.length) return null
    const x = r.rows[0]
    return {
      sessionId: String(x.session_id),
      role: x.role,
      content: x.content,
      attachments: x.attachments,
      variantGroup: String(x.variant_group),
    }
  })
}

// Returns the parsed blocks array stored on a message (or null).
export async function getMessageBlocks(userEmail, userToken, messageId) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT m.blocks FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND ${sessionAccessSql('s', '$2')}
       WHERE m.id = $1`,
      [messageId, userEmail]
    )
    return r.rows.length ? r.rows[0].blocks || null : null
  })
}

// Persists answers into a `deck-questions` block stored on a message's blocks
// JSONB. Answers are stamped onto the first deck-questions block found (there's
// only ever one per message). Returns the updated blocks array, or null if the
// message has no such block. `answersMap` is already sanitized by the caller.
export async function setDeckQuestionsAnswers(userEmail, userToken, messageId, answersMap, answeredAt) {
  return withTx(userEmail, userToken, async (c) => {
    // only read/write a message whose session belongs to the caller
    const r = await c.query(
      `SELECT m.blocks FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND ${historyWriteSql('s', '$2')}
       WHERE m.id = $1`,
      [messageId, userEmail]
    )
    if (!r.rows.length || !r.rows[0].blocks) return null
    const blocks = r.rows[0].blocks
    let touched = false
    for (const b of blocks) {
      if (b && b.type === 'deck-questions') {
        b.answers = answersMap
        b.answeredAt = answeredAt
        touched = true
        break
      }
    }
    if (!touched) return null
    // the WHERE still re-checks ownership so a concurrent session move can't slip
    // the write onto another user's row between the SELECT and the UPDATE
    await c.query(
      `UPDATE chat_messages m SET blocks = $2
       FROM chat_sessions s
       WHERE m.id = $1 AND s.id = m.session_id AND ${historyWriteSql('s', '$3')}`,
      [messageId, JSON.stringify(blocks), userEmail]
    )
    return blocks
  })
}

// Marks one specific variant as the active one for its slot — used when the
// user navigates the version carousel to a message other than the latest.
export async function activateVariant(userEmail, userToken, messageId) {
  await withTx(userEmail, userToken, async (c) => {
    // resolve the variant group only for a message in the caller's own session,
    // so the subsequent UPDATE can't flip the active variant in someone else's
    // thread by targeting a guessed message id
    const r = await c.query(
      `SELECT m.variant_group FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND ${historyWriteSql('s', '$2')}
       WHERE m.id = $1`,
      [messageId, userEmail]
    )
    if (!r.rows.length) return
    await activateOwnedVariantGroup(c, userEmail, messageId, r.rows[0].variant_group)
  })
}

// Shared by listMessages (full thread) and listMessagesBeforeMessage (history
// for a regeneration): fetches every row, attaches tool-call traces, then
// keeps only the active variant per slot — optionally cut off before a given
// slot — ordered by slot position rather than row id (see note below).
async function fetchActiveMessages(c, sessionId, userEmail, { beforeVariantGroup } = {}) {
  // ownership is enforced by joining chat_messages back to its parent session:
  // rows surface only when the session belongs to userEmail. Without this an
  // authenticated user could read another user's thread (messages + tool
  // traces) by passing a guessed session id — chat_messages carries no
  // user_email column of its own, and every user shares one PG identity.
  const r = await c.query(
    `SELECT m.id, m.role, m.content, m.attachments, m.model, m.prompt_tokens, m.completion_tokens, m.blocks, m.variant_group, m.active, m.created_at, m.media_processing, m.intent_classify, m.reasoning, m.sent_by
     FROM chat_messages m
     JOIN chat_sessions s ON s.id = m.session_id AND ${sessionAccessSql('s', '$2')}
     WHERE m.session_id = $1 ORDER BY m.id ASC`,
    [sessionId, userEmail]
  )
  const ids = r.rows.map((x) => x.id)
  const toolsByMessage = new Map()
  if (ids.length) {
    const tr = await c.query(
      `SELECT message_id, call_id, tool_name, tool_label, arguments, result, status, duration_ms
       FROM chat_tool_calls WHERE message_id = ANY($1) ORDER BY message_id, seq ASC`,
      [ids]
    )
    for (const t of tr.rows) {
      const list = toolsByMessage.get(t.message_id) || []
      list.push({
        id: t.call_id,
        name: t.tool_name,
        label: t.tool_label,
        args: t.arguments,
        result: t.result,
        status: t.status,
        durationMs: t.duration_ms,
      })
      toolsByMessage.set(t.message_id, list)
    }
  }

  const toShape = (x) => ({
    id: String(x.id),
    role: x.role,
    content: x.content,
    attachments: x.attachments,
    model: x.model,
    prompt_tokens: x.prompt_tokens,
    completion_tokens: x.completion_tokens,
    blocks: x.blocks || null,
    tool_calls: toolsByMessage.get(x.id) || null,
    created_at: x.created_at,
    media_processing: x.media_processing || null,
    intent_classify: x.intent_classify || null,
    reasoning: x.reasoning || null,
    sent_by: x.sent_by ?? null,
  })

  // group every row (active or not) by slot, so each active row can carry
  // its sibling variants for the frontend's version carousel
  const groups = new Map()
  for (const x of r.rows) {
    const g = x.variant_group ?? x.id
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(x)
  }

  // active rows are ordered by their *slot* (variant_group), not by their own
  // id — a regenerated row's id is always the newest in the table, but it
  // must still render at the original position in the conversation
  let activeRows = r.rows.filter((x) => x.active)
  if (beforeVariantGroup != null) {
    activeRows = activeRows.filter((x) => Number(x.variant_group ?? x.id) < Number(beforeVariantGroup))
  }
  activeRows.sort((a, b) => Number(a.variant_group ?? a.id) - Number(b.variant_group ?? b.id))

  return activeRows.map((x) => {
    const shaped = toShape(x)
    const siblings = groups.get(x.variant_group ?? x.id)
    if (siblings && siblings.length > 1) shaped.variants = siblings.map(toShape)
    return shaped
  })
}

export async function listMessages(userEmail, userToken, sessionId) {
  return withTx(userEmail, userToken, (c) => fetchActiveMessages(c, sessionId, userEmail))
}

// Compactions of one session, oldest first (see chat_compactions in runSchemaDdl).
// Ownership: joined to chat_sessions on user_email, like every other read.
export async function listCompactions(userEmail, userToken, sessionId) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT k.id, k.upto_message_id, k.content, k.model, k.auto, k.messages, k.tokens_before,
              k.tokens_after, k.instructions, k.prompt_tokens, k.completion_tokens, k.created_at
       FROM chat_compactions k
       JOIN chat_sessions s ON s.id = k.session_id AND ${sessionAccessSql('s', '$2')}
       WHERE k.session_id = $1
       ORDER BY k.id ASC`,
      [sessionId, userEmail]
    )
    return r.rows.map((x) => ({
      id: String(x.id),
      uptoMessageId: String(x.upto_message_id),
      content: x.content,
      model: x.model,
      auto: !!x.auto,
      messages: x.messages,
      tokensBefore: x.tokens_before,
      tokensAfter: x.tokens_after,
      instructions: x.instructions || '',
      promptTokens: x.prompt_tokens,
      completionTokens: x.completion_tokens,
      created_at: x.created_at,
    }))
  })
}

// Saves a compaction anchored at `uptoMessageId`. The INSERT ... SELECT only
// materializes when the session belongs to the caller AND the anchor message is
// in that session, so a guessed id can't attach a summary to someone else's thread.
export async function insertCompaction(userEmail, userToken, sessionId, row) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `INSERT INTO chat_compactions
         (session_id, upto_message_id, content, model, auto, messages, tokens_before, tokens_after, instructions, prompt_tokens, completion_tokens)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       WHERE EXISTS (SELECT 1 FROM chat_sessions s WHERE s.id = $1 AND ${sessionAccessSql('s', '$12')})
         AND EXISTS (SELECT 1 FROM chat_messages WHERE id = $2 AND session_id = $1)
       RETURNING id, created_at`,
      [
        sessionId,
        row.uptoMessageId,
        row.content,
        row.model ?? null,
        !!row.auto,
        row.messages ?? 0,
        row.tokensBefore ?? null,
        row.tokensAfter ?? null,
        row.instructions || null,
        row.promptTokens ?? null,
        row.completionTokens ?? null,
        userEmail,
      ]
    )
    if (!r.rows[0]) throw new Error('compaction: sessão ou mensagem não encontrada')
    return { ...row, id: String(r.rows[0].id), created_at: r.rows[0].created_at }
  })
}

// Conversation history strictly before the slot `messageId` belongs to — what
// the model should see when regenerating that slot. Returns the resolved
// `variantGroup` too, since addMessage needs it to file the new variant into
// the same slot.
export async function listMessagesBeforeMessage(userEmail, userToken, sessionId, messageId) {
  return withTx(userEmail, userToken, async (c) => {
    // scope the slot lookup to a session the caller owns (join to chat_sessions)
    // so a regenerate can't be aimed at someone else's message id
    const g = await c.query(
      `SELECT m.variant_group FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND ${sessionAccessSql('s', '$3')}
       WHERE m.id = $1 AND m.session_id = $2`,
      [messageId, sessionId, userEmail]
    )
    if (!g.rows.length) return { variantGroup: null, messages: [] }
    const variantGroup = g.rows[0].variant_group
    const messages = await fetchActiveMessages(c, sessionId, userEmail, { beforeVariantGroup: variantGroup })
    return { variantGroup: String(variantGroup), messages }
  })
}

// Persists the ordered trace of tool calls made while producing one assistant
// message — purely for display/audit on reload; the model itself never
// replays this (its own past tool mechanics are irrelevant context, same
// rationale as stripping {{block:N}} placeholders from history).
export async function addToolCalls(userEmail, userToken, messageId, trace) {
  if (!trace?.length) return
  // rows land only under a message of the caller's own session (see ownerScopedWrites.js)
  await withTx(userEmail, userToken, async (c) => {
    await insertOwnedToolCalls(c, userEmail, messageId, trace)
  })
}

// Seeded the first time a user opens their (until-then-empty) template
// collection — pulled straight from the Databricks brand system (Navy/Lava/
// Coral/Oat, DM Sans) so Settings never starts as a blank slate and doubles
// as a concrete "design system" example.
const DATABRICKS_PRESET = {
  name: 'Databricks Corporate',
  primaryColor: '#1B3139',
  secondaryColor: '#FF5F46',
  accentColor: '#FF3621',
  backgroundColor: '#F9F7F4',
  headingFont: 'DM Sans',
  bodyFont: 'DM Sans',
  styleNotes:
    'Tom confiante e direto, como um colega experiente, não um vendedor. Frases curtas, sentence case (nunca Title Case), sem emojis. Fundos quentes (oat), acentos em coral/lava — nunca gradientes azul/roxo de SaaS genérico.',
}

// Extract a lean, self-contained "first slide" from a Templates-group specimen
// for the Settings grid thumbnail. A template card is a whole multi-slide deck
// (a <deck-stage> web component wrapping N <div class="slide">…</div>), often
// hundreds of KB with an inline runtime + external <script src> that 404s in a
// srcdoc. The grid only needs slide 1 as a static picture — so we keep the
// document's <style> blocks (layout + brand type) and the FIRST `.slide`
// element, drop every <script> (a plain div needs no runtime), strip embedded
// webfonts (the token CSS re-declares them from fontAssets) and squeeze
// whitespace. Result is a few tens of KB that renders slide 1 exactly.
// Returns '' when there's no recognizable slide (caller falls back to the
// branded placeholder). Hard cap as a backstop against pathological input.
const PREVIEW_CARD_CAP = 120_000
export function extractFirstTemplateSlide(html) {
  if (typeof html !== 'string' || !html) return ''
  const styles = (html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).join('')
  // first element with a `slide` class — scan balanced <div> depth from its start
  const start = /<div[^>]*class="[^"]*\bslide\b[^"]*"[^>]*>/i.exec(html)
  if (!start) return ''
  let i = start.index
  let depth = 0
  let j = i
  const n = html.length
  for (; j < n; ) {
    if (html.startsWith('<div', j)) {
      depth++
      const gt = html.indexOf('>', j)
      if (gt < 0) break
      j = gt + 1
    } else if (html.startsWith('</div>', j)) {
      depth--
      j += 6
      if (depth === 0) break
    } else {
      j++
    }
  }
  let slide = html.slice(i, j)
  if (!slide) return ''
  // The DS's base typography targets the <section> the <deck-stage> component
  // wraps each slide in (e.g. `section{font-family:var(--font-sans)}`). We pull
  // the bare `.slide` div out of that component, so wrap it back in a <section>
  // — otherwise those inherited rules (font included) never match and the slide
  // falls back to the browser default serif.
  let out = `<!doctype html><html><head><meta charset="utf-8">${styles}<style>html,body{margin:0;padding:0;width:1280px;height:720px;overflow:hidden}section,.slide{width:1280px;height:720px;box-sizing:border-box}</style></head><body><section>${slide}</section></body></html>`
  out = out
    // embedded webfonts: redundant with the injected token CSS in the preview
    .replace(/data:(?:font|application)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '')
    // very large base64 rasters (rare full-bleed photos) → light neutral swatch;
    // small SVGs (logo, nodal motif) stay so the cover still reads as the brand
    .replace(/data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]{4000,}/gi,
      'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22><rect width=%221%22 height=%221%22 fill=%22%23e6e6e6%22/></svg>')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim()
  // last, so nothing after it can reintroduce markup: drops <script> (any end-tag
  // spelling), on* handlers, javascript: URLs and embedding elements
  out = sanitizeDsHtml(out)
  if (out.length > PREVIEW_CARD_CAP) return ''
  return out
}

function rowToTemplate(x) {
  return {
    id: String(x.id),
    scope: x.scope === 'global' ? 'global' : 'user',
    name: x.name || '',
    primaryColor: x.primary_color || '',
    secondaryColor: x.secondary_color || '',
    accentColor: x.accent_color || '',
    backgroundColor: x.background_color || '',
    headingFont: x.heading_font || '',
    bodyFont: x.body_font || '',
    logoDataUrl: x.logo_data_url || '',
    styleNotes: x.style_notes || '',
    iconAssets: x.icon_assets || [],
    previewSlides: x.preview_slides || [],
    coverPlateDataUrl: x.cover_plate_data_url || '',
    minedStyle: x.mined_style || null,
    logoLightDataUrl: x.logo_light_data_url || '',
    readme: x.readme || '',
    brandRules: x.brand_rules || '',
    palette: x.palette || [],
    fontAssets: x.font_assets || [],
    dsCards: x.ds_cards || [],
    // lightweight specimen metadata (group/title/description) for the
    // generation composition brief — present on list/render-cut rows that
    // don't ship the full ds_cards HTML
    ...(x.ds_cards_meta !== undefined ? { dsCardsMeta: x.ds_cards_meta || [] } : {}),
    // list rows carry has-flags instead of the payloads (TEMPLATE_LIST_SELECT)
    ...(x.has_ds_cards !== undefined ? { hasDsCards: !!x.has_ds_cards, hasReadme: !!x.has_readme } : {}),
    // first Templates deck's first slide (extracted + lean) for the grid thumbnail (list rows only)
    ...(x.preview_card_html !== undefined ? { previewCardHtml: extractFirstTemplateSlide(x.preview_card_html) } : {}),
    // selection lives in user_template_selection (selected_by_user computed
    // via LEFT JOIN); rows fetched without the join fall back to the legacy flag
    isSelected: x.selected_by_user !== undefined ? !!x.selected_by_user : !!x.is_selected,
  }
}

// visibility + per-user selection in one shot: the caller sees their own rows
// plus every global row, with isSelected computed from their selection row
const TEMPLATE_SELECT = `
  SELECT t.*, (s.template_id IS NOT NULL) AS selected_by_user
  FROM deck_templates t
  LEFT JOIN user_template_selection s ON s.user_email = $1 AND s.template_id = t.id`

// list path: same visibility join, but the viewer-only payloads (ds_cards
// specimen HTML, readme) never leave the database — a mined design system
// carries MBs of them per row, and the list is fetched on every Studio and
// Settings open. Shipped as has-flags so the grid can still advertise them.
// renderAssets additionally cuts icon_assets in SQL to the kinds the painters
// resolve (icon/image slide refs, illustration theme art) — the backgrounds/
// lockups of a mined bundle are Settings-grid-only and dominate the row size.
const RENDER_ASSET_KINDS_SQL = `
  (SELECT COALESCE(jsonb_agg(e.a ORDER BY e.ord), '[]'::jsonb)
     FROM jsonb_array_elements(t.icon_assets) WITH ORDINALITY AS e(a, ord)
    WHERE (e.a->>'kind') IS NULL OR (e.a->>'kind') IN ('icon', 'image', 'illustration'))`
const templateListSelect = (renderAssets) => `
  SELECT t.id, t.user_email, t.scope, t.name, t.primary_color, t.secondary_color,
         t.accent_color, t.background_color, t.heading_font, t.body_font,
         t.logo_data_url, t.style_notes,
         ${renderAssets ? RENDER_ASSET_KINDS_SQL : 't.icon_assets'} AS icon_assets,
         t.preview_slides,
         t.cover_plate_data_url, t.mined_style, t.logo_light_data_url,
         t.brand_rules, t.palette, t.font_assets, t.is_selected, t.created_at,
         (COALESCE(jsonb_array_length(t.ds_cards), 0) > 0) AS has_ds_cards,
         -- lightweight metadata of the bundle's component/slide specimens
         -- (group/title/description only — the heavy self-contained HTML is
         -- stripped). Feeds the deck generator's composition brief so it can
         -- learn THIS design system's own slide vocabulary; cheap enough to
         -- always ship (KBs, not the MBs of inlined HTML).
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'group', c->>'group', 'title', c->>'title', 'description', c->>'description')), '[]'::jsonb)
            FROM jsonb_array_elements(t.ds_cards) AS c) AS ds_cards_meta,
         -- The FIRST deck in the Templates section for the Settings grid
         -- thumbnail (the preview renderer, restored after the semantic-tree
         -- engine was removed). 'Templates' is the group our importer assigns to
         -- every multi-slide template deck (dsImport.js), regardless of the DS's
         -- own naming — so this is positional ("first template deck"), not
         -- name-matched. extractFirstTemplateSlide (rowToTemplate) pulls just its
         -- first slide + styles so the payload stays small.
         (SELECT c->>'html'
            FROM jsonb_array_elements(t.ds_cards) WITH ORDINALITY AS e(c, ord)
           WHERE c->>'html' IS NOT NULL AND c->>'group' = 'Templates'
           ORDER BY ord
           LIMIT 1) AS preview_card_html,
         (COALESCE(length(t.readme), 0) > 0) AS has_readme,
         (s.template_id IS NOT NULL) AS selected_by_user
  FROM deck_templates t
  LEFT JOIN user_template_selection s ON s.user_email = $1 AND s.template_id = t.id`

// The heavy bundle payloads only matter to specific consumers (viewer,
// preview font loading) — list endpoints strip them so the Settings grid
// isn't shipping tens of MB of fonts/cards per template row.
export function templateSummary(t) {
  const { dsCards, fontAssets, readme, ...rest } = t
  return {
    ...rest,
    // list rows never fetched the payloads — trust their precomputed flags
    hasDsCards: rest.hasDsCards ?? !!dsCards?.length,
    hasReadme: rest.hasReadme ?? !!readme,
    fontAssets, // fonts stay: DeckSlidePreview loads them for brand-true previews
  }
}

export async function listDeckTemplates(userEmail, userToken, { renderAssets = false } = {}) {
  return withTx(userEmail, userToken, async (c) => {
    const list = `${templateListSelect(renderAssets)}
      WHERE t.user_email = $1 OR t.scope = 'global'
      ORDER BY (t.scope = 'global') DESC, t.created_at ASC, t.id ASC`
    let r = await c.query(list, [userEmail])
    // seed the Databricks preset only for a user with no personal templates
    // AND no org-wide (global) template to fall back on — once an admin
    // publishes a global design system, new users start from that instead
    if (!r.rows.length) {
      const ins = await c.query(
        `INSERT INTO deck_templates
           (user_email, name, primary_color, secondary_color, accent_color, background_color, heading_font, body_font, style_notes, is_selected)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true) RETURNING id`,
        [
          userEmail,
          DATABRICKS_PRESET.name,
          DATABRICKS_PRESET.primaryColor,
          DATABRICKS_PRESET.secondaryColor,
          DATABRICKS_PRESET.accentColor,
          DATABRICKS_PRESET.backgroundColor,
          DATABRICKS_PRESET.headingFont,
          DATABRICKS_PRESET.bodyFont,
          DATABRICKS_PRESET.styleNotes,
        ]
      )
      await c.query(
        `INSERT INTO user_template_selection (user_email, template_id) VALUES ($1, $2)
         ON CONFLICT (user_email) DO NOTHING`,
        [userEmail, ins.rows[0].id]
      )
      r = await c.query(list, [userEmail])
    }
    const rows = r.rows.map(rowToTemplate)
    // no selection row (fresh user with globals only, or their selection
    // cascaded away with a deleted template) → first visible acts as selected
    if (rows.length && !rows.some((t) => t.isSelected)) rows[0] = { ...rows[0], isSelected: true }
    return rows
  })
}

// Every consumer of the *selected* template (generation prompt, PPTX export,
// the /selected render endpoint) only resolves icon/image/illustration assets,
// so this always takes the render cut — the full asset library stays behind
// the list/detail endpoints for the Settings grid.
// The selected template is read on the hot path of EVERY chat turn, but its
// heavy render-cut payload (preview_slides/palette/font_assets/mined_style/
// cover plate — can be MBs of jsonb) changes only when the user edits/selects/
// deletes a template. So memoize it per user with a short TTL and invalidate
// explicitly on writes. TTL is a backstop for cross-process edits (this app can
// run multiple replicas); the explicit bump covers same-process edits instantly.
const SELECTED_TEMPLATE_TTL_MS = 60 * 1000
const selectedTemplateCache = new Map() // email -> { ts, template }

// Bumped by every template write (create/update/select/delete/scope) so the
// next hot-path read re-fetches instead of serving a stale bundle.
export function invalidateSelectedTemplate(userEmail) {
  if (userEmail) selectedTemplateCache.delete(userEmail)
  else selectedTemplateCache.clear()
}

export async function getSelectedDeckTemplate(userEmail, userToken) {
  const hit = selectedTemplateCache.get(userEmail)
  if (hit && Date.now() - hit.ts < SELECTED_TEMPLATE_TTL_MS) return hit.template
  const templates = await listDeckTemplates(userEmail, userToken, { renderAssets: true })
  const template = templates.find((t) => t.isSelected) || templates[0] || null
  selectedTemplateCache.set(userEmail, { ts: Date.now(), template })
  return template
}

export async function createDeckTemplate(userEmail, userToken, tpl) {
  invalidateSelectedTemplate()
  return withTx(userEmail, userToken, async (c) => {
    const existing = await c.query(`SELECT COUNT(*)::int AS n FROM deck_templates WHERE user_email = $1`, [
      userEmail,
    ])
    const isFirst = existing.rows[0].n === 0 // first PERSONAL template
    const r = await c.query(
      `INSERT INTO deck_templates
         (user_email, name, primary_color, secondary_color, accent_color, background_color, heading_font, body_font, logo_data_url, style_notes, icon_assets, preview_slides, cover_plate_data_url, mined_style, logo_light_data_url, readme, brand_rules, palette, font_assets, ds_cards, is_selected)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING *`,
      [
        userEmail,
        tpl.name || null,
        tpl.primaryColor || null,
        tpl.secondaryColor || null,
        tpl.accentColor || null,
        tpl.backgroundColor || null,
        tpl.headingFont || null,
        tpl.bodyFont || null,
        tpl.logoDataUrl || null,
        tpl.styleNotes || null,
        JSON.stringify(tpl.iconAssets || []),
        JSON.stringify(tpl.previewSlides || []),
        tpl.coverPlateDataUrl || null,
        tpl.minedStyle ? JSON.stringify(tpl.minedStyle) : null,
        tpl.logoLightDataUrl || null,
        tpl.readme || null,
        tpl.brandRules || null,
        JSON.stringify(tpl.palette || []),
        JSON.stringify(tpl.fontAssets || []),
        JSON.stringify(tpl.dsCards || []),
        isFirst,
      ]
    )
    // becomes the selection only when the user hasn't selected anything yet
    // (e.g. they may already be using a global template)
    const sel = await c.query(
      `INSERT INTO user_template_selection (user_email, template_id) VALUES ($1, $2)
       ON CONFLICT (user_email) DO NOTHING RETURNING template_id`,
      [userEmail, r.rows[0].id]
    )
    return rowToTemplate({ ...r.rows[0], selected_by_user: sel.rows.length > 0 })
  })
}

// Bundle-heavy columns (readme/palette/font_assets/ds_cards/logo_light) are
// only rewritten when the caller actually sends them — the Settings form
// edits identity fields off a SUMMARY row (see templateSummary) and must not
// blank out payloads it never loaded.
export async function updateDeckTemplate(userEmail, userToken, id, tpl, isAdmin = false) {
  // a global edit affects every user's hot-path read, so clear the whole cache
  invalidateSelectedTemplate()
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `UPDATE deck_templates SET
         name = $1, primary_color = $2, secondary_color = $3, accent_color = $4, background_color = $5,
         heading_font = $6, body_font = $7, logo_data_url = $8, style_notes = $9,
         icon_assets = $10, preview_slides = $11, cover_plate_data_url = $12, mined_style = $13,
         logo_light_data_url = COALESCE($14, logo_light_data_url),
         readme = COALESCE($15, readme),
         brand_rules = COALESCE($16, brand_rules),
         palette = COALESCE($17, palette),
         font_assets = COALESCE($18, font_assets),
         ds_cards = COALESCE($19, ds_cards),
         updated_at = NOW()
       WHERE id = $20 AND (user_email = $21 OR (scope = 'global' AND $22)) RETURNING id, scope`,
      [
        tpl.name || null,
        tpl.primaryColor || null,
        tpl.secondaryColor || null,
        tpl.accentColor || null,
        tpl.backgroundColor || null,
        tpl.headingFont || null,
        tpl.bodyFont || null,
        tpl.logoDataUrl || null,
        tpl.styleNotes || null,
        JSON.stringify(tpl.iconAssets || []),
        JSON.stringify(tpl.previewSlides || []),
        tpl.coverPlateDataUrl || null,
        tpl.minedStyle ? JSON.stringify(tpl.minedStyle) : null,
        tpl.logoLightDataUrl !== undefined ? tpl.logoLightDataUrl || '' : null,
        tpl.readme !== undefined ? tpl.readme || '' : null,
        tpl.brandRules !== undefined ? tpl.brandRules || '' : null,
        tpl.palette !== undefined ? JSON.stringify(tpl.palette || []) : null,
        tpl.fontAssets !== undefined ? JSON.stringify(tpl.fontAssets || []) : null,
        tpl.dsCards !== undefined ? JSON.stringify(tpl.dsCards || []) : null,
        id,
        userEmail,
        isAdmin,
      ]
    )
    // an edit of an org-wide (global) template is an admin action: audited in this transaction
    if (r.rows[0]?.scope === 'global' && isAdmin === true) {
      await recordAdminAction(c, userEmail, { action: 'template.update', target: `deck_template:${id}`, details: { name: tpl.name || null } })
    }
    return r.rows.length > 0
  }, { admin: isAdmin === true })
}

export async function getDeckTemplate(userEmail, userToken, id) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `${TEMPLATE_SELECT} WHERE t.id = $2 AND (t.user_email = $1 OR t.scope = 'global')`,
      [userEmail, id]
    )
    return r.rows.length ? rowToTemplate(r.rows[0]) : null
  })
}

export async function selectDeckTemplate(userEmail, userToken, id) {
  invalidateSelectedTemplate(userEmail)
  return withTx(userEmail, userToken, async (c) => {
    const visible = await c.query(
      `SELECT 1 FROM deck_templates WHERE id = $1 AND (user_email = $2 OR scope = 'global')`,
      [id, userEmail]
    )
    if (!visible.rows.length) return false
    await c.query(
      `INSERT INTO user_template_selection (user_email, template_id) VALUES ($1, $2)
       ON CONFLICT (user_email) DO UPDATE SET template_id = EXCLUDED.template_id, updated_at = NOW()`,
      [userEmail, id]
    )
    return true
  })
}

// admins may edit/delete global rows; everyone else only their own — the
// route computes isAdmin (authz.js) and the SQL mirrors it so a route bug
// can never silently cross-write another user's template
export async function deleteDeckTemplate(userEmail, userToken, id, isAdmin = false) {
  invalidateSelectedTemplate()
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `DELETE FROM deck_templates
       WHERE id = $1 AND (user_email = $2 OR (scope = 'global' AND $3)) RETURNING id, scope, name`,
      [id, userEmail, isAdmin]
    )
    if (r.rows[0]?.scope === 'global' && isAdmin === true) {
      await recordAdminAction(c, userEmail, { action: 'template.delete', target: `deck_template:${id}`, details: { name: r.rows[0].name || null } })
    }
    return r.rows.length > 0
  }, { admin: isAdmin === true })
}

export async function setDeckTemplateScope(userEmail, userToken, id, scope, { admin = false } = {}) {
  invalidateSelectedTemplate()
  return withTx(userEmail, userToken, async (c) => {
    // demoting a global row hands ownership to the acting admin so it doesn't
    // become an orphan visible to nobody
    const r = await c.query(
      `UPDATE deck_templates
       SET scope = $1, user_email = CASE WHEN $1 = 'user' THEN $2 ELSE user_email END, updated_at = NOW()
       WHERE id = $3 AND (user_email = $2 OR scope = 'global') RETURNING id`,
      [scope, userEmail, id]
    )
    if (r.rows.length) await recordAdminAction(c, userEmail, { action: 'template.scope', target: `deck_template:${id}`, details: { scope } })
    return r.rows.length > 0
  }, { admin })
}

// ---- app admins (authz.js resolves owner/groups on top of these rows) -------

export async function listAppAdmins(userEmail, userToken) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT principal, kind, added_by, created_at FROM app_admins ORDER BY created_at ASC`)
    return r.rows.map((x) => ({
      principal: x.principal,
      kind: x.kind === 'group' ? 'group' : 'user',
      addedBy: x.added_by,
      createdAt: x.created_at,
    }))
  })
}

export async function addAppAdmin(userEmail, userToken, principal, kind, { admin = false } = {}) {
  await withTx(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO app_admins (principal, kind, added_by) VALUES ($1, $2, $3)
       ON CONFLICT (principal) DO UPDATE SET kind = EXCLUDED.kind`,
      [principal, kind, userEmail]
    )
    await recordAdminAction(c, userEmail, { action: 'admins.add', target: principalTarget(principal, kind), details: { kind } })
  }, { admin })
}

export async function removeAppAdmin(userEmail, userToken, principal, { admin = false } = {}) {
  await withTx(userEmail, userToken, async (c) => {
    const r = await c.query(`DELETE FROM app_admins WHERE principal = $1 RETURNING kind`, [principal])
    if (r.rows.length) {
      const kind = r.rows[0].kind === 'group' ? 'group' : 'user'
      await recordAdminAction(c, userEmail, { action: 'admins.remove', target: principalTarget(principal, kind), details: { kind } })
    }
  }, { admin })
}

// ---- admin-curated model catalog overrides ------------------------------
export async function listModelOverrides(userEmail, userToken) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT endpoint_id, enabled, display_name, blurb, sort_order, price_in, price_out, updated_by, updated_at
         FROM model_catalog_overrides`
    )
    const map = {}
    for (const x of r.rows) {
      map[x.endpoint_id] = {
        endpointId: x.endpoint_id,
        enabled: !!x.enabled,
        displayName: x.display_name || '',
        blurb: x.blurb || '',
        sortOrder: x.sort_order,
        priceIn: x.price_in,
        priceOut: x.price_out,
        updatedBy: x.updated_by || '',
        updatedAt: x.updated_at,
      }
    }
    return map
  })
}

export async function upsertModelOverride(
  userEmail,
  userToken,
  endpointId,
  { enabled, displayName, blurb, sortOrder, priceIn, priceOut },
  { admin = false } = {}
) {
  await withTx(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO model_catalog_overrides (endpoint_id, enabled, display_name, blurb, sort_order, price_in, price_out, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (endpoint_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         display_name = EXCLUDED.display_name,
         blurb = EXCLUDED.blurb,
         sort_order = EXCLUDED.sort_order,
         price_in = EXCLUDED.price_in,
         price_out = EXCLUDED.price_out,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [endpointId, !!enabled, displayName || null, blurb || null, sortOrder ?? null, priceIn ?? null, priceOut ?? null, userEmail]
    )
    await recordAdminAction(c, userEmail, {
      action: 'model_endpoints.upsert',
      target: endpointId,
      details: { enabled: !!enabled, sortOrder: sortOrder ?? null, priceIn: priceIn ?? null, priceOut: priceOut ?? null },
    })
  }, { admin })
}

// Reorders enabled models: assigns sequential sort_order from the given ordered
// list of endpoint ids (index 0 → lowest sort_order → first in the picker → the
// default model for new chats). Only touches sort_order — enabled/prices/names
// are untouched. Rows are UPSERTed so an id without a prior override still gets
// ordered. Runs in a single transaction (withTx) so the ordering is atomic.
export async function reorderModelOverrides(userEmail, userToken, orderedIds, { admin = false } = {}) {
  await withTx(
    userEmail,
    userToken,
    async (c) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await c.query(
          `INSERT INTO model_catalog_overrides (endpoint_id, enabled, sort_order, updated_by, updated_at)
             VALUES ($1, TRUE, $2, $3, NOW())
           ON CONFLICT (endpoint_id) DO UPDATE SET
             sort_order = EXCLUDED.sort_order,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()`,
          [orderedIds[i], i, userEmail]
        )
      }
      await recordAdminAction(c, userEmail, { action: 'model_endpoints.reorder', target: null, details: { order: orderedIds.slice(0, 50) } })
    },
    { admin }
  )
}

// Seed the catalog from the static MODELS list the FIRST time an admin opens
// the models tab and no overrides exist yet — so switching /api/models to
// "enabled only" never leaves the org with zero models. Idempotent: only
// inserts rows that don't exist.
export async function seedModelOverridesIfEmpty(userEmail, userToken, seedRows, { admin = false } = {}) {
  return withTx(userEmail, userToken, async (c) => {
    const existing = await c.query(`SELECT COUNT(*)::int AS n FROM model_catalog_overrides`)
    if (existing.rows[0].n > 0) return false
    for (let i = 0; i < seedRows.length; i++) {
      const s = seedRows[i]
      // the default catalog enables the curated current generation; a curated
      // model flagged defaultOn:false (the previous generation) is NOT enabled
      // here but stays one click away in "Add model" (prices already known → no
      // cost prompt). Prices are NOT copied into the override: NULL means
      // "follow the curated price", so a later fix to MODELS reaches this org.
      const enabled = s.defaultOn !== false
      await c.query(
        `INSERT INTO model_catalog_overrides (endpoint_id, enabled, display_name, blurb, sort_order, price_in, price_out, updated_by)
           VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6)
         ON CONFLICT (endpoint_id) DO NOTHING`,
        [s.id, enabled, s.label || null, s.blurb || null, i, userEmail]
      )
    }
    await recordAdminAction(c, userEmail, { action: 'model_endpoints.seed', target: null, details: { count: seedRows.length } })
    return true
  }, { admin })
}

// ---- usage ledger (taxímetro) -----------------------------------------------
export async function insertUsageLedger(userEmail, userToken, row) {
  await withTx(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO usage_ledger (user_email, session_id, kind, model, prompt_tokens, completion_tokens,
                                 cache_read_tokens, cache_write_tokens, estimated, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userEmail,
        row.sessionId ?? null,
        row.kind,
        row.model || null,
        row.promptTokens ?? null,
        row.completionTokens ?? null,
        row.cacheReadTokens ?? null,
        row.cacheWriteTokens ?? null,
        !!row.estimated,
        row.costUsd ?? null,
      ]
    )
  })
}

// Spend totals for the meter. Always scoped to the caller (user_email) — a
// sessionId the caller doesn't own simply sums to zero. `since` is the start of
// the billing month (computed by usage.js in the configured time zone).
export async function usageTotals(userEmail, userToken, { since, sessionId }) {
  return withTx(userEmail, userToken, async (c) => {
    const month = await c.query(
      `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd,
              COALESCE(BOOL_OR(estimated), false) AS estimated,
              COALESCE(BOOL_OR(cost_usd IS NULL), false) AS unpriced
         FROM usage_ledger WHERE user_email = $1 AND created_at >= $2`,
      [userEmail, since]
    )
    let session = null
    if (sessionId) {
      const r = await c.query(
        `SELECT kind, COALESCE(SUM(cost_usd), 0)::float8 AS usd, COUNT(*)::int AS calls,
                COALESCE(BOOL_OR(estimated), false) AS estimated,
                COALESCE(BOOL_OR(cost_usd IS NULL), false) AS unpriced
           FROM usage_ledger WHERE user_email = $1 AND session_id = $2 GROUP BY kind`,
        [userEmail, sessionId]
      )
      const byKind = {}
      let usd = 0
      let estimated = false
      let unpriced = false
      for (const x of r.rows) {
        byKind[x.kind] = { usd: x.usd, calls: x.calls }
        usd += x.usd
        estimated ||= x.estimated
        unpriced ||= x.unpriced
      }
      session = { usd, byKind, estimated, unpriced }
    }
    const m = month.rows[0]
    return { month: { usd: m.usd, estimated: m.estimated, unpriced: m.unpriced }, session }
  })
}

// The one-time reconstruction of the ledger from pre-ledger history is a data
// migration run by the owner (server/db/backfillUsage.js, `node scripts/migrate.mjs
// backfill-usage`): it reads every user's messages, which the app role cannot.

// session a studio artifact belongs to — lets a tweak's cost land on the
// conversation it came from. Owner-scoped like every artifact read.
export async function artifactSessionId(userEmail, userToken, kind, id) {
  const table = { deck: 'chat_decks', spreadsheet: 'chat_spreadsheets', document: 'chat_documents' }[kind]
  if (!table) return null
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT session_id FROM ${table} WHERE id = $1 AND user_email = $2`, [id, userEmail])
    return r.rows[0]?.session_id != null ? String(r.rows[0].session_id) : null
  })
}

// Clears the override price of the given endpoints (→ follow the curated
// price). Used once per process to undo prices the pre-1.4 seed froze into the
// catalog (see staleSeededPriceIds in serving.js). Idempotent.
export async function clearModelOverridePrices(userEmail, userToken, endpointIds, { admin = false } = {}) {
  if (!endpointIds?.length) return 0
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `UPDATE model_catalog_overrides SET price_in = NULL, price_out = NULL
        WHERE endpoint_id = ANY($1::text[]) AND (price_in IS NOT NULL OR price_out IS NOT NULL)`,
      [endpointIds]
    )
    if (r.rowCount > 0) {
      await recordAdminAction(c, userEmail, { action: 'model_endpoints.clear_prices', target: null, details: { endpoints: endpointIds.slice(0, 50), rows: r.rowCount } })
    }
    return r.rowCount
  }, { admin })
}

// ---- per-user adopted external MCP connections --------------------------
export async function listUserMcpConnections(userEmail, userToken) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT connection_name, comment, status, last_checked_at, created_at
         FROM user_mcp_connections WHERE user_email = $1 ORDER BY created_at ASC`,
      [userEmail]
    )
    return r.rows.map((x) => ({
      connectionName: x.connection_name,
      comment: x.comment || '',
      status: x.status || 'unknown',
      lastCheckedAt: x.last_checked_at,
      createdAt: x.created_at,
    }))
  })
}

export async function adoptUserMcpConnection(userEmail, userToken, connectionName, comment, status) {
  await withTx(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO user_mcp_connections (user_email, connection_name, comment, status, last_checked_at)
         VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_email, connection_name) DO UPDATE SET
         comment = EXCLUDED.comment,
         status = EXCLUDED.status,
         last_checked_at = NOW()`,
      [userEmail, connectionName, comment || null, status || 'unknown']
    )
  })
}

export async function setUserMcpStatus(userEmail, userToken, connectionName, status) {
  await withTx(userEmail, userToken, async (c) => {
    await c.query(
      `UPDATE user_mcp_connections SET status = $3, last_checked_at = NOW()
         WHERE user_email = $1 AND connection_name = $2`,
      [userEmail, connectionName, status]
    )
  })
}

export async function forgetUserMcpConnection(userEmail, userToken, connectionName) {
  await withTx(userEmail, userToken, async (c) => {
    await c.query(`DELETE FROM user_mcp_connections WHERE user_email = $1 AND connection_name = $2`, [
      userEmail,
      connectionName,
    ])
  })
}

// ---- authored skills ----------------------------------------------------
function shapeSkill(x) {
  return {
    id: String(x.id),
    scope: x.scope,
    ownerEmail: x.owner_email || null,
    name: x.name,
    title: x.title,
    description: x.description,
    body: x.body,
    triggers: Array.isArray(x.triggers) ? x.triggers : [],
    embedding: x.embedding || null,
    source: x.source || 'write',
    enabled: !!x.enabled,
    createdBy: x.created_by || '',
    updatedAt: x.updated_at,
  }
}

// Every skill this user can see: all global skills ∪ their own. `includeBody`
// false trims the (large) body/embedding for list views; the router needs
// them, the settings list doesn't.
export async function listSkills(userEmail, userToken, { includeBody = true } = {}) {
  return withTx(userEmail, userToken, async (c) => {
    const cols = includeBody
      ? `id, scope, owner_email, name, title, description, body, triggers, embedding, source, enabled, created_by, updated_at`
      : `id, scope, owner_email, name, title, description, '' AS body, triggers, NULL AS embedding, source, enabled, created_by, updated_at`
    const r = await c.query(
      `SELECT ${cols} FROM skills
        WHERE scope = 'global' OR (scope = 'user' AND owner_email = $1)
        ORDER BY scope DESC, updated_at DESC`,
      [userEmail]
    )
    return r.rows.map(shapeSkill)
  })
}

export async function getSkill(userEmail, userToken, id) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT id, scope, owner_email, name, title, description, body, triggers, embedding, source, enabled, created_by, updated_at
         FROM skills WHERE id = $1 AND (scope = 'global' OR (scope = 'user' AND owner_email = $2))`,
      [id, userEmail]
    )
    return r.rows.length ? shapeSkill(r.rows[0]) : null
  })
}

// Insert or update a skill. `scope` decides ownership: 'global' rows have a
// NULL owner (the caller must be admin — enforced at the route); 'user' rows
// belong to the caller. Returns the row's id.
export async function upsertSkill(
  userEmail,
  userToken,
  { id, scope, name, title, description, body, triggers, source, enabled },
  { admin = false } = {}
) {
  return withTx(userEmail, userToken, async (c) => {
    const owner = scope === 'global' ? null : userEmail
    const trig = JSON.stringify(Array.isArray(triggers) ? triggers : [])
    if (id) {
      // update in place, but only a row the caller may touch (own user row, or
      // any global row when this is a global-scoped call from an admin route)
      const r = await c.query(
        `UPDATE skills SET name=$3, title=$4, description=$5, body=$6, triggers=$7::jsonb,
           enabled=$8, embedding=NULL, updated_at=NOW()
         WHERE id=$1 AND (
           (scope='user' AND owner_email=$2) OR (scope='global' AND $9='global')
         )
         RETURNING id`,
        [id, userEmail, name, title, description, body, trig, enabled !== false, scope]
      )
      if (r.rows[0] && scope === 'global') {
        await recordAdminAction(c, userEmail, { action: 'skill.upsert', target: `skill:${r.rows[0].id}`, details: { name, enabled: enabled !== false } })
      }
      return r.rows[0] ? String(r.rows[0].id) : null
    }
    const r = await c.query(
      `INSERT INTO skills (scope, owner_email, name, title, description, body, triggers, source, enabled, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING id`,
      [scope || 'user', owner, name, title, description, body, trig, source || 'write', enabled !== false, userEmail]
    )
    if (scope === 'global') {
      await recordAdminAction(c, userEmail, { action: 'skill.upsert', target: `skill:${r.rows[0].id}`, details: { name, enabled: enabled !== false, created: true } })
    }
    return String(r.rows[0].id)
  }, { admin })
}

export async function setSkillEmbedding(userEmail, userToken, id, vec, { admin = false } = {}) {
  await withTx(userEmail, userToken, async (c) => {
    await setOwnedSkillEmbedding(c, userEmail, id, vec)
  }, { admin })
}

export async function deleteSkill(userEmail, userToken, id, { allowGlobal = false } = {}) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `DELETE FROM skills
         WHERE id = $1 AND ((scope='user' AND owner_email=$2) OR (scope='global' AND $3))
       RETURNING id, scope, name`,
      [id, userEmail, allowGlobal]
    )
    if (r.rows[0]?.scope === 'global') {
      await recordAdminAction(c, userEmail, { action: 'skill.delete', target: `skill:${id}`, details: { name: r.rows[0].name } })
    }
    return r.rows.length > 0
  }, { admin: allowGlobal === true })
}

// Decks are drawn by the model as a structured `deck` prism-block (see
// blocks.js) and persisted here so the Deck Studio can reload/edit/export
// them independent of the chat message's own stored content.
// Artifact inserts only materialize under a session the caller owns (same rule
// as addMessage): a guessed session id yields 404, never a row in someone else's thread.
export async function createDeck(userEmail, userToken, sessionId, title, slides, meta) {
  return withTx(userEmail, userToken, (c) => insertOwnedDeck(c, userEmail, sessionId, title, slides, meta))
}

// Read access to an artifact (N1b): in a PERSONAL chat, the owner's; in a PROJECT
// chat, any CURRENT member's, its creator included (leaving the project removes
// access to what you created there too, like the conversation itself). Writes are
// never widened: every UPDATE below keeps `user_email = me`, and the routes
// answer a non-creator with 403 artifact_read_only before reaching them.
// `read_only` is true for a member reading another member's artifact.
function artifactReadSql(alias, emailParam) {
  return `EXISTS (SELECT 1 FROM chat_sessions rs WHERE rs.id = ${alias}.session_id AND ` +
    `((rs.project_id IS NULL AND ${alias}.user_email = ${emailParam}) OR ` +
    `(rs.project_id IS NOT NULL AND ${memberOfProjectSql('rs.project_id')})))`
}

export async function getDeck(userEmail, userToken, deckId) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT d.id, d.session_id, d.title, d.slides, d.meta, d.revision, d.user_email, d.user_email <> $2 AS read_only
         FROM chat_decks d WHERE d.id = $1 AND ${artifactReadSql('d', '$2')}`, [
      deckId,
      userEmail,
    ])
    if (!r.rows.length) return null
    const x = r.rows[0]
    // sessionId lets an editor pull the originating conversation for grounding;
    // kept off the enumerable spread so it never leaks into the persisted meta.
    return { id: String(x.id), sessionId: x.session_id != null ? String(x.session_id) : null, title: x.title, slides: x.slides || [], ...(x.meta || {}), revision: Number(x.revision), read_only: x.read_only === true }
  })
}

// A studio save is activity on the artifact's conversation (W2-5 retention).
// The session row is refreshed FIRST, then the artifact: the same lock order as
// the retention sweep (session row, then its children by cascade). So an edit
// that commits while the sweep waits has already moved the session's
// updated_at, which the sweep's DELETE re-checks on the row it deletes; and a
// sweep that got the session first deletes it before the edit writes anything
// (the edit then matches no row). Without it, the sweep could wait on the
// artifact row in its cascade and delete the just-committed edit (QA W2-5 r2).
function touchSessionOfArtifact(table) {
  return `UPDATE chat_sessions SET updated_at = NOW()
           WHERE id = (SELECT session_id FROM ${table} WHERE id = $1 AND user_email = $2) AND ${sessionAccessSql('chat_sessions', '$2')}`
}

/**
 * The statements of updateDeckSlides, in order (exported for the retention race test).
 * The write bumps `revision` in the same UPDATE; with a `baseRevision` it only matches
 * that revision (N6), so a save from a stale copy matches no row. Without one (an old
 * client) it writes unconditionally and still bumps.
 */
export function deckEditStatements(deckId, userEmail, title, slides, meta, baseRevision = null, claim = null) {
  const params = [title, JSON.stringify(slides), JSON.stringify(meta || {}), deckId, userEmail]
  if (baseRevision != null) params.push(baseRevision)
  // an AI edit's write is fenced by its own lease token (QA r2): once its lease lapsed and a
  // successor took the deck, the old holder matches no row and cannot clear the successor's claim
  if (claim != null) params.push(claim)
  const claimParam = claim != null ? '$' + params.length : null
  return [
    [touchSessionOfArtifact('chat_decks'), [deckId, userEmail]],
    [
      `UPDATE chat_decks SET title = $1, slides = $2, meta = $3, revision = revision + 1, updated_at = NOW(),
              tweak_claim = NULL, tweak_claim_until = NULL
        WHERE id = $4 AND user_email = $5${baseRevision != null ? ' AND revision = $6' : ''}${claimParam ? ' AND tweak_claim = ' + claimParam + '::uuid' : ''}
        RETURNING revision`,
      params,
    ],
  ]
}

/**
 * Saves a deck. Returns { revision } (the new one) on success, or null when no row matched:
 * the deck is gone / not the caller's, or (with `baseRevision`) it moved on since the
 * caller read it. The route tells the two apart by reading the deck again.
 */
export async function updateDeckSlides(userEmail, userToken, deckId, title, slides, meta, baseRevision = null, claim = null) {
  return withTx(userEmail, userToken, async (c) => {
    let last
    for (const [sql, params] of deckEditStatements(deckId, userEmail, title, slides, meta, baseRevision, claim)) last = await c.query(sql, params)
    return last.rows.length ? { revision: Number(last.rows[0].revision) } : null
  })
}

/** How long an AI edit may hold a deck before the lease lapses on its own (a crashed process). */
export const DECK_TWEAK_LEASE_SECONDS = 120

/**
 * Takes the AI-edit lease on a deck (N6) with ONE conditional UPDATE, before the model is called, so
 * nothing is held open across the call. It matches only a deck of the caller that is at `baseRevision`
 * (when given) and has no live lease. Returns { claim, revision } (the id to release with, and the
 * revision the final write must still match) or null when nothing matched: the deck is gone, moved
 * on, or another edit holds it (the route reads the deck again to tell which).
 * The lease is not an edit: revision and updated_at stay as they were.
 */
export async function claimDeckTweak(userEmail, userToken, deckId, baseRevision = null) {
  const claim = randomUUID()
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `UPDATE chat_decks SET tweak_claim = $3, tweak_claim_until = now() + ($4 || ' seconds')::interval
        WHERE id = $1 AND user_email = $2 AND ($5::int IS NULL OR revision = $5::int)
          AND (tweak_claim_until IS NULL OR tweak_claim_until < now())
        RETURNING revision`,
      [deckId, userEmail, claim, String(DECK_TWEAK_LEASE_SECONDS), baseRevision]
    )
    return r.rows.length ? { claim, revision: Number(r.rows[0].revision) } : null
  })
}

/** Gives the lease back (an edit that ended without writing). Only the holder's own claim is cleared. */
export async function releaseDeckTweak(userEmail, userToken, deckId, claim) {
  await withTx(userEmail, userToken, (c) =>
    c.query(`UPDATE chat_decks SET tweak_claim = NULL, tweak_claim_until = NULL WHERE id = $1 AND user_email = $2 AND tweak_claim = $3`, [deckId, userEmail, claim])
  )
}

// ---- spreadsheets (see sanitizeSpreadsheet in blocks.js) — mirrors the deck
// helpers above: the model draws a `spreadsheet` prism-block, persisted here so
// it can be reloaded/exported (server/xlsx-export.js) independent of the message.
export async function createSpreadsheet(userEmail, userToken, sessionId, title, spec) {
  return withTx(userEmail, userToken, (c) => insertOwnedSpreadsheet(c, userEmail, sessionId, title, spec))
}

export async function getSpreadsheet(userEmail, userToken, sheetId) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT d.id, d.title, d.spec, d.user_email <> $2 AS read_only
         FROM chat_spreadsheets d WHERE d.id = $1 AND ${artifactReadSql('d', '$2')}`, [
      sheetId,
      userEmail,
    ])
    if (!r.rows.length) return null
    const x = r.rows[0]
    return { id: String(x.id), title: x.title, ...(x.spec || {}), read_only: x.read_only === true }
  })
}

export async function updateSpreadsheet(userEmail, userToken, sheetId, title, spec) {
  await withTx(userEmail, userToken, async (c) => {
    await c.query(touchSessionOfArtifact('chat_spreadsheets'), [sheetId, userEmail]) // see updateDeckSlides
    await c.query(
      `UPDATE chat_spreadsheets SET title = $1, spec = $2, updated_at = NOW() WHERE id = $3 AND user_email = $4`,
      [title, JSON.stringify(spec || {}), sheetId, userEmail]
    )
  })
}

// ---- documents (the model writes a `document` prism-block as markdown) —
// mirrors the deck/spreadsheet helpers: persisted so the Document Studio can
// reload/edit/export (DOCX/Markdown/PDF) independent of the chat message.
export async function createDocument(userEmail, userToken, sessionId, title, markdown) {
  return withTx(userEmail, userToken, (c) => insertOwnedDocument(c, userEmail, sessionId, title, markdown))
}

export async function getDocument(userEmail, userToken, docId) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT d.id, d.title, d.markdown, d.user_email <> $2 AS read_only
         FROM chat_documents d WHERE d.id = $1 AND ${artifactReadSql('d', '$2')}`, [
      docId,
      userEmail,
    ])
    if (!r.rows.length) return null
    const x = r.rows[0]
    return { id: String(x.id), title: x.title, markdown: x.markdown || '', read_only: x.read_only === true }
  })
}

export async function updateDocument(userEmail, userToken, docId, title, markdown) {
  await withTx(userEmail, userToken, async (c) => {
    await c.query(touchSessionOfArtifact('chat_documents'), [docId, userEmail]) // see updateDeckSlides
    await c.query(
      `UPDATE chat_documents SET title = $1, markdown = $2, updated_at = NOW() WHERE id = $3 AND user_email = $4`,
      [title, markdown || '', docId, userEmail]
    )
  })
}

// ---- generated images (bytes on a UC Volume; row keeps the path) — the binary
// sibling of decks/spreadsheets. createImage stores the volume_path that the
// image tool just wrote (see server/imageStore.js); getImage returns the row
// (incl. volume_path) so GET /api/images/:id can stream the bytes back, scoped
// by user_email like every other artifact read.
export async function createImage(userEmail, userToken, sessionId, { prompt, model, volumePath, contentType }) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `INSERT INTO chat_images (session_id, user_email, prompt, model, volume_path, content_type)
         SELECT s.id, $2, $3, $4, $5, $6 FROM chat_sessions s WHERE s.id = $1 AND ${sessionAccessSql('s', '$2')}
         RETURNING id`,
      [sessionId, userEmail, prompt || null, model || null, volumePath, contentType || 'image/png']
    )
    if (!r.rows.length) throw Object.assign(new Error('sessão não encontrada'), { status: 404 })
    return String(r.rows[0].id)
  })
}

export async function getImage(userEmail, userToken, imageId) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT d.id, d.prompt, d.model, d.volume_path, d.content_type, d.user_email <> $2 AS read_only,
              EXISTS (SELECT 1 FROM chat_sessions ps WHERE ps.id = d.session_id AND ps.project_id IS NOT NULL) AS shared
         FROM chat_images d WHERE d.id = $1 AND ${artifactReadSql('d', '$2')}`,
      [imageId, userEmail]
    )
    if (!r.rows.length) return null
    const x = r.rows[0]
    return {
      id: String(x.id),
      prompt: x.prompt || '',
      model: x.model || '',
      volumePath: x.volume_path,
      contentType: x.content_type || 'image/png',
      readOnly: x.read_only === true,
      shared: x.shared === true, // in a project chat: access can be revoked
    }
  })
}

// Volume paths for every image in a session — used to purge the Volume files
// before the session (and its cascading chat_images rows) is deleted.
export async function listSessionImagePaths(userEmail, userToken, sessionId) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT volume_path FROM chat_images WHERE session_id = $1 AND user_email = $2`,
      [sessionId, userEmail]
    )
    return r.rows.map((x) => x.volume_path).filter(Boolean)
  })
}

// ---- per-user image-generation model selection (mirrors template selection) --
export async function getSelectedImageModel(userEmail, userToken) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT model_id FROM user_image_model_selection WHERE user_email = $1`, [userEmail])
    return r.rows.length ? r.rows[0].model_id : null
  })
}

export async function setSelectedImageModel(userEmail, userToken, modelId) {
  await withTx(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO user_image_model_selection (user_email, model_id) VALUES ($1, $2)
       ON CONFLICT (user_email) DO UPDATE SET model_id = EXCLUDED.model_id, updated_at = NOW()`,
      [userEmail, modelId]
    )
  })
}

// ---- org-wide tool policy (which built-in tool groups are available) --------
// Returns a { [toolKey]: boolean } map of EXPLICIT admin decisions. A key absent
// from the map means "default" (enabled) — callers treat missing as true. Any DB
// error degrades to {} (everything enabled), never blocking the app.
export async function getToolPolicy(userEmail, userToken) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT tool_key, enabled FROM app_tool_policy`)
    const map = {}
    for (const x of r.rows) map[x.tool_key] = !!x.enabled
    return map
  })
}

export async function setToolPolicy(userEmail, userToken, toolKey, enabled, { admin = false } = {}) {
  await withTx(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO app_tool_policy (tool_key, enabled, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tool_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [toolKey, !!enabled, userEmail]
    )
    await recordAdminAction(c, userEmail, { action: 'tool_policy.set', target: toolKey, details: { enabled: !!enabled } })
  }, { admin })
}

// ---- admin-managed MCP catalog (see app_mcp_catalog) ------------------------
export async function listMcpCatalogRows(userEmail, userToken) {
  return withTx(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT service_name, display_name, description, hidden, credential_class, added_by, created_at, updated_at
         FROM app_mcp_catalog ORDER BY created_at ASC`
    )
    return r.rows.map((x) => ({
      serviceName: x.service_name,
      displayName: x.display_name || '',
      description: x.description || '',
      hidden: !!x.hidden,
      credentialClass: x.credential_class || null,
      addedBy: x.added_by || '',
      createdAt: x.created_at,
      updatedAt: x.updated_at,
    }))
  })
}

export async function upsertMcpCatalogEntry(
  userEmail,
  userToken,
  serviceName,
  { displayName, description, hidden, credentialClass },
  { admin = false } = {}
) {
  await withTx(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO app_mcp_catalog (service_name, display_name, description, hidden, credential_class, added_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (service_name) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description = EXCLUDED.description,
         hidden = EXCLUDED.hidden,
         credential_class = COALESCE(EXCLUDED.credential_class, app_mcp_catalog.credential_class),
         updated_at = NOW()`,
      [serviceName, displayName || null, description || null, !!hidden, credentialClass || null, userEmail]
    )
    await recordAdminAction(c, userEmail, {
      action: 'mcp_catalog.upsert',
      target: serviceName,
      details: { hidden: !!hidden, credentialClass: credentialClass || null },
    })
  }, { admin })
}

export async function deleteMcpCatalogEntry(userEmail, userToken, serviceName, { admin = false } = {}) {
  await withTx(userEmail, userToken, async (c) => {
    const r = await c.query(`DELETE FROM app_mcp_catalog WHERE service_name = $1`, [serviceName])
    if (r.rowCount > 0) await recordAdminAction(c, userEmail, { action: 'mcp_catalog.delete', target: serviceName })
  }, { admin })
}
