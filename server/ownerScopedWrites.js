// Gravações chaveadas por id que re-checam o dono DENTRO do próprio SQL.
//
// Todo o isolamento do AI Prism é app-level: as conexões Postgres compartilham a
// identidade do SP, então a única barreira é o WHERE por dono. Uma leitura que
// filtra pelo dono antes não basta se a gravação seguinte usa só o id (o id vem
// do cliente e é enumerável: BIGSERIAL). Cada helper aqui faz a gravação só
// quando a linha alvo pertence, via chat_sessions.user_email, ao chamador.
//
// Ports the fork's server/ownerScopedWrites.js (2.3.x), que checa papel de
// projeto (sessionWritableSql); no AI Prism o dono é só user_email. Os helpers
// recebem um `client` com `query()` (pg Client/PoolClient ou um fake nos testes)
// e não importam db.js, então não há ciclo.

/** Trecho de SQL: a sessão `sessionCol` (ex.: 'm.session_id') pertence a `emailParam`. */
export function ownedSessionSql(sessionCol, emailParam) {
  return `EXISTS (SELECT 1 FROM chat_sessions os WHERE os.id = ${sessionCol} AND os.user_email = ${emailParam})`
}


/**
 * Grava as chamadas de tool de UMA mensagem, só se ela estiver numa sessão do
 * chamador. Retorna quantas linhas entraram (0 = mensagem alheia ou inexistente).
 */
export async function insertOwnedToolCalls(client, userEmail, messageId, trace) {
  let seq = 0
  let written = 0
  for (const t of trace) {
    const result = await client.query(
      `INSERT INTO chat_tool_calls (message_id, seq, call_id, tool_name, tool_label, arguments, result, status, duration_ms)
       SELECT m.id, $2, $3, $4, $5, $6, $7, $8, $9
         FROM chat_messages m
        WHERE m.id = $1 AND ${ownedSessionSql('m.session_id', '$10')}`,
      [
        messageId,
        seq++,
        t.id || null,
        t.name,
        t.label || null,
        JSON.stringify(t.args ?? {}),
        t.result != null ? String(t.result).slice(0, 8000) : null,
        t.status,
        t.durationMs ?? null,
        userEmail,
      ]
    )
    written += result.rowCount || 0
  }
  return written
}

/**
 * Upsert do embedding de UMA mensagem, só se `messageId` estiver em `sessionId`
 * e a sessão for do chamador. `vectorLiteral` é a forma '[0.1,…]' do pgvector.
 */
export async function upsertOwnedMessageEmbedding(client, userEmail, sessionId, messageId, vectorLiteral) {
  const result = await client.query(
    `INSERT INTO chat_message_embeddings (message_id, session_id, embedding)
     SELECT m.id, m.session_id, $3::vector
       FROM chat_messages m
      WHERE m.id = $1 AND m.session_id = $2 AND ${ownedSessionSql('m.session_id', '$4')}
     ON CONFLICT (message_id) DO UPDATE SET embedding = EXCLUDED.embedding, created_at = NOW()`,
    [messageId, sessionId, vectorLiteral, userEmail]
  )
  return result.rowCount || 0
}

/**
 * Marca como ativa só a variante `messageId` do grupo `variantGroup`, e só nas
 * mensagens das sessões do chamador. Sem o filtro de dono, um `variantGroup`
 * de outro usuário (chute ou vazamento) reativaria as variantes alheias.
 */
export async function activateOwnedVariantGroup(client, userEmail, messageId, variantGroup) {
  const result = await client.query(
    `UPDATE chat_messages AS m SET active = (m.id = $1)
      WHERE m.variant_group = $2 AND ${ownedSessionSql('m.session_id', '$3')}`,
    [messageId, variantGroup, userEmail]
  )
  return result.rowCount || 0
}

/** Grava o embedding de uma skill: globais (escritas só por admin na rota) ou as do próprio usuário. */
export async function setOwnedSkillEmbedding(client, userEmail, id, vector) {
  const result = await client.query(
    `UPDATE skills SET embedding = $2
      WHERE id = $1 AND (scope = 'global' OR (scope = 'user' AND owner_email = $3))`,
    [id, vector, userEmail]
  )
  return result.rowCount || 0
}

/** Conversa Genie de uma sessão do chamador (lê ou grava; sem a sessão, nada). */
export async function setOwnedGenieConversation(client, userEmail, sessionId, spaceId, conversationId) {
  const result = await client.query(
    `INSERT INTO chat_genie_conversations (session_id, space_id, conversation_id)
     SELECT s.id, $2, $3 FROM chat_sessions s
      WHERE s.id = $1 AND s.user_email = $4
     ON CONFLICT (session_id, space_id) DO UPDATE SET conversation_id = $3, updated_at = NOW()`,
    [sessionId, spaceId, conversationId, userEmail]
  )
  return result.rowCount || 0
}

export async function getOwnedGenieConversationId(client, userEmail, sessionId, spaceId) {
  const r = await client.query(
    `SELECT g.conversation_id FROM chat_genie_conversations g
       JOIN chat_sessions s ON s.id = g.session_id AND s.user_email = $3
      WHERE g.session_id = $1 AND g.space_id = $2`,
    [sessionId, spaceId, userEmail]
  )
  return r.rows[0]?.conversation_id || null
}

// ---- the writes of a turn's answer (W2-14) ----
// Client-taking twins of db.js's saveSessionChartCandidates / addMessage /
// createDeck / createSpreadsheet / createDocument: db.js wraps each in its own
// withTx, server/db/turnCommit.js runs them all in ONE transaction. The SQL lives
// only here. Each throws { status: 404 } when the session is not the caller's.

const notFound = () => Object.assign(new Error('sessão não encontrada'), { status: 404 })

/** Most recent chart candidates kept on a session (older ones are trimmed). */
export const MAX_STORED_CHART_CANDIDATES = 40

/**
 * Stores the session's chart candidates (the newest MAX_STORED_CHART_CANDIDATES).
 * The statement text is pinned by server/turn.test.js's commit-abort probe, which
 * waits on a query starting `UPDATE chat_sessions SET chart_candidates`.
 */
export async function updateOwnedChartCandidates(client, userEmail, sessionId, state) {
  const trimmed = { nextId: state.nextId, items: state.items.slice(-MAX_STORED_CHART_CANDIDATES) }
  const r = await client.query(`UPDATE chat_sessions SET chart_candidates = $1 WHERE id = $2 AND user_email = $3`, [
    JSON.stringify(trimmed),
    sessionId,
    userEmail,
  ])
  if (!r.rowCount) throw notFound()
}

/**
 * Inserts a message. `variantGroup` (the original message's id) adds a regenerated
 * variant to an existing slot: the new row becomes the active one and every
 * sibling in that group is deactivated. Without it the row is its own group.
 */
export async function insertOwnedMessage(client, userEmail, msg) {
  // chat_messages has no user_email of its own — ownership is inherited from the
  // parent session. The INSERT ... SELECT materializes a row only when the target
  // session belongs to the caller, so a client can never inject a message into
  // someone else's thread by passing a guessed (enumerable BIGSERIAL) session id.
  const r = await client.query(
    `INSERT INTO chat_messages (session_id, role, content, attachments, model, prompt_tokens, completion_tokens, blocks, variant_group, media_processing, intent_classify, reasoning)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $11, $12, $13
     WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $1 AND user_email = $10)
     RETURNING id, created_at`,
    [
      msg.sessionId,
      msg.role,
      msg.content,
      msg.attachments || null,
      msg.model || null,
      msg.promptTokens ?? null,
      msg.completionTokens ?? null,
      msg.blocks ? JSON.stringify(msg.blocks) : null,
      msg.variantGroup ?? null,
      userEmail,
      msg.mediaProcessing ? JSON.stringify(msg.mediaProcessing) : null,
      msg.intentClassify ? JSON.stringify(msg.intentClassify) : null,
      msg.reasoning || null,
    ]
  )
  if (!r.rows.length) throw notFound()
  const id = r.rows[0].id
  if (msg.variantGroup == null) {
    // the row was just inserted by this caller (id from RETURNING): safe by id
    await client.query(`UPDATE chat_messages SET variant_group = $1 WHERE id = $1`, [id])
  } else {
    await activateOwnedVariantGroup(client, userEmail, id, msg.variantGroup)
  }
  // a message is activity: the session's last-activity time moves with it, in
  // the same transaction (the retention sweep, server/retention.js, deletes by
  // it; the sidebar orders by it). Before W2-5 nothing on the message path did.
  await client.query(`UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1 AND user_email = $2`, [msg.sessionId, userEmail])
  return { id: String(id), created_at: r.rows[0].created_at }
}

export async function insertOwnedDeck(client, userEmail, sessionId, title, slides, meta) {
  const r = await client.query(
    `INSERT INTO chat_decks (session_id, user_email, title, slides, meta)
     SELECT s.id, $2, $3, $4::jsonb, $5::jsonb FROM chat_sessions s WHERE s.id = $1 AND s.user_email = $2
     RETURNING id`,
    [sessionId, userEmail, title, JSON.stringify(slides), JSON.stringify(meta || {})]
  )
  if (!r.rows.length) throw notFound()
  return String(r.rows[0].id)
}

export async function insertOwnedSpreadsheet(client, userEmail, sessionId, title, spec) {
  const r = await client.query(
    `INSERT INTO chat_spreadsheets (session_id, user_email, title, spec)
     SELECT s.id, $2, $3, $4::jsonb FROM chat_sessions s WHERE s.id = $1 AND s.user_email = $2
     RETURNING id`,
    [sessionId, userEmail, title, JSON.stringify(spec || {})]
  )
  if (!r.rows.length) throw notFound()
  return String(r.rows[0].id)
}

export async function insertOwnedDocument(client, userEmail, sessionId, title, markdown) {
  const r = await client.query(
    `INSERT INTO chat_documents (session_id, user_email, title, markdown)
     SELECT s.id, $2, $3, $4 FROM chat_sessions s WHERE s.id = $1 AND s.user_email = $2
     RETURNING id`,
    [sessionId, userEmail, title, markdown || '']
  )
  if (!r.rows.length) throw notFound()
  return String(r.rows[0].id)
}
