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
