// Isolamento entre dois usuários, contra as funções reais de db.js.
//
// O isolamento do AI Prism é app-level (WHERE por dono): todas as conexões
// usam a mesma identidade Postgres. Este arquivo cria dois usuários de teste
// (*.test.invalid), popula um lado e tenta ler, alterar e apagar tudo do
// outro. Depois confere no banco (SQL direto, sem passar por db.js) que nada
// mudou. Também prova que o dono consegue ler o próprio conteúdo (senão o
// teste poderia passar por um erro de conexão).
//
// Requisitos: Postgres com pgvector e um host local. Padrão: o banco do
// `npm run local:up` (127.0.0.1:55432, ai_prism). Sem banco, ou sem a extensão
// vector, a suíte inteira é pulada (skip), não falha. Para apontar outro host
// defina ISOLATION_TEST_ANY_HOST=1: o teste grava e apaga linhas de teste, então
// nunca aponte para produção.
//
//   node --test server/isolation.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

const env = process.env
env.PGHOST ||= '127.0.0.1'
env.PGPORT ||= '55432'
env.PGUSER ||= 'ai_prism'
env.PGPASSWORD ||= 'ai_prism'
env.PGDATABASE ||= 'ai_prism'
env.PGSSLMODE ||= 'disable'
env.LOCAL_DEV_MODE ||= '1'
env.LOCAL_PGVECTOR = '1'
// the service-principal pool would route every query through another identity
delete env.DATABRICKS_CLIENT_ID
delete env.DATABRICKS_CLIENT_SECRET

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

function connectionOptions() {
  return {
    host: env.PGHOST,
    port: Number(env.PGPORT),
    user: env.PGUSER,
    password: env.PGPASSWORD,
    database: env.PGDATABASE,
    ssl: false,
    connectionTimeoutMillis: 2000,
  }
}

async function skipReason() {
  if (!LOCAL_HOSTS.has(env.PGHOST) && env.ISOLATION_TEST_ANY_HOST !== '1') {
    return `PGHOST=${env.PGHOST} não é local (defina ISOLATION_TEST_ANY_HOST=1 para usar outro banco de teste)`
  }
  const c = new pg.Client(connectionOptions())
  try {
    await c.connect()
    const ext = await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
    if (!ext.rows.length) return 'pgvector ausente neste Postgres (brew install pgvector, ou a extensão não está instalada)'
    return null
  } catch (e) {
    return `sem Postgres em ${env.PGHOST}:${env.PGPORT} (${e.code || e.message}); rode npm run local:up`
  } finally {
    await c.end().catch(() => {})
  }
}

const SKIP = await skipReason()
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const A = `iso-a-${stamp}@test.invalid`
const B = `iso-b-${stamp}@test.invalid`
const VEC = Array.from({ length: 1024 }, (_, i) => (i % 7) / 10)

let db
let raw
let fx

async function q(sql, params = []) {
  return (await raw.query(sql, params)).rows
}

async function setup() {
  db = await import('./db.js')
  await db.ensureSchema(A, 'token-a')
  raw = new pg.Client(connectionOptions())
  await raw.connect()

  const sA = await db.createSession(A, 'token-a', 'Sessão da Ana', 'm1', null, [])
  const mA = await db.addMessage(A, 'token-a', { sessionId: sA, role: 'user', content: 'segredo da Ana' })
  const aA = await db.addMessage(A, 'token-a', {
    sessionId: sA,
    role: 'assistant',
    content: 'resposta da Ana',
    model: 'm1',
    promptTokens: 100,
    completionTokens: 50,
  })
  await db.addToolCalls(A, 'token-a', aA.id, [{ id: 'c1', name: 'tool', args: {}, status: 'ok', result: 'r' }])
  await db.setMessageEmbedding(A, 'token-a', sA, mA.id, VEC)
  const deckA = await db.createDeck(A, 'token-a', sA, 'Deck da Ana', [{ html: '<section>x</section>' }], {})
  const sheetA = await db.createSpreadsheet(A, 'token-a', sA, 'Planilha da Ana', { title: 'P', sheets: [] })
  const docA = await db.createDocument(A, 'token-a', sA, 'Doc da Ana', '# Ana')
  const imgA = await db.createImage(A, 'token-a', sA, { prompt: 'p', model: 'm', volumePath: '/Volumes/a/x.png', contentType: 'image/png' })
  const skillA = await db.upsertSkill(A, 'token-a', {
    scope: 'user',
    name: `skill-ana-${stamp}`,
    title: 'Skill da Ana',
    description: 'd',
    body: 'corpo',
    triggers: [],
    source: 'write',
    enabled: true,
  })
  await db.adoptUserMcpConnection(A, 'token-a', `conn-ana-${stamp}`, 'comentário', 'ok')
  await db.insertUsageLedger(A, 'token-a', { sessionId: sA, kind: 'chat', model: 'm1', promptTokens: 1000, completionTokens: 1000, costUsd: 9.5 })
  await db.setGenieConversationId(A, 'token-a', sA, 'space-1', 'conv-ana')

  fx = { sA, mA: mA.id, aA: aA.id, deckA, sheetA, docA, imgA, skillA, connName: `conn-ana-${stamp}` }
  // the owner can read her own data: otherwise the negative checks below prove nothing
  assert.ok(await db.getSession(A, 'token-a', sA))
  assert.ok(await db.getDeck(A, 'token-a', deckA))
  assert.ok(await db.getDocument(A, 'token-a', docA))
  return fx
}

async function cleanup() {
  if (!raw) return
  await raw.query(`DELETE FROM chat_sessions WHERE user_email = ANY($1)`, [[A, B]])
  await raw.query(`DELETE FROM usage_ledger WHERE user_email = ANY($1)`, [[A, B]])
  await raw.query(`DELETE FROM user_mcp_connections WHERE user_email = ANY($1)`, [[A, B]])
  await raw.query(`DELETE FROM skills WHERE owner_email = ANY($1)`, [[A, B]])
  await raw.end().catch(() => {})
}

// no database → every test is skipped; a fixture error with a database is a failure
if (!SKIP) await setup()
const skip = SKIP || false
after(cleanup)

test('sessões: a outra usuária não lista, lê, renomeia nem apaga', { skip }, async () => {
  const list = await db.listSessions(B, 'token-b')
  assert.ok(!list.some((s) => s.id === fx.sA))
  assert.equal(await db.getSession(B, 'token-b', fx.sA), null)
  await db.updateSession(B, 'token-b', fx.sA, { title: 'invadida' })
  await db.touchSession(B, 'token-b', fx.sA)
  await db.deleteSession(B, 'token-b', fx.sA)
  const [row] = await q(`SELECT title FROM chat_sessions WHERE id = $1`, [fx.sA])
  assert.equal(row.title, 'Sessão da Ana')
})

test('mensagens: leitura, edição de variante e inserção numa sessão alheia são negadas', { skip }, async () => {
  assert.deepEqual(await db.listMessages(B, 'token-b', fx.sA), [])
  assert.equal(await db.getMessageRaw(B, 'token-b', fx.mA), null)
  assert.equal(await db.getMessageBlocks(B, 'token-b', fx.mA), null)
  assert.equal(await db.setDeckQuestionsAnswers(B, 'token-b', fx.mA, {}, 'now'), null)
  await assert.rejects(
    db.addMessage(B, 'token-b', { sessionId: fx.sA, role: 'user', content: 'injetada' }),
    (e) => e.status === 404
  )
  const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM chat_messages WHERE session_id = $1`, [fx.sA])
  assert.equal(n, 2)
})

test('variantes: um variant_group de outro usuário não reativa nem troca as variantes alheias', { skip }, async () => {
  const before = await q(`SELECT id, active FROM chat_messages WHERE session_id = $1 ORDER BY id`, [fx.sA])
  const bS = await db.createSession(B, 'token-b', 'Sessão do Bruno', 'm1', null, [])
  // B posta na própria sessão apontando o grupo da Ana: o UPDATE de grupo não pode tocar as linhas dela
  await db.addMessage(B, 'token-b', { sessionId: bS, role: 'assistant', content: 'x', variantGroup: fx.aA })
  await db.activateVariant(B, 'token-b', fx.aA)
  const after = await q(`SELECT id, active FROM chat_messages WHERE session_id = $1 ORDER BY id`, [fx.sA])
  assert.deepEqual(after, before)
})

test('tool calls: não entram numa mensagem alheia', { skip }, async () => {
  await db.addToolCalls(B, 'token-b', fx.aA, [{ id: 'evil', name: 'x', args: {}, status: 'ok' }])
  const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM chat_tool_calls WHERE message_id = $1`, [fx.aA])
  assert.equal(n, 1)
})

test('memória: embeddings alheios não são sobrescritos nem retornados pela busca', { skip }, async () => {
  const before = await q(`SELECT embedding::text AS e FROM chat_message_embeddings WHERE message_id = $1`, [fx.mA])
  await db.setMessageEmbedding(B, 'token-b', fx.sA, fx.mA, VEC.map((x) => -x))
  const after = await q(`SELECT embedding::text AS e FROM chat_message_embeddings WHERE message_id = $1`, [fx.mA])
  assert.deepEqual(after, before)

  const hits = await db.searchSessionsByVector(B, 'token-b', VEC, { minSimilarity: 0 })
  assert.ok(!hits.some((h) => h.id === fx.sA))
  const relevant = await db.retrieveRelevantMessages(B, 'token-b', fx.sA, VEC, { excludeRecent: 0, minSimilarity: 0 })
  assert.deepEqual(relevant, [])
  assert.deepEqual(await db.listMessagesMissingEmbedding(B, 'token-b', fx.sA), [])
})

test('artefatos: leitura, edição e exclusão alheias são negadas; criação em sessão alheia dá 404', { skip }, async () => {
  assert.equal(await db.getDeck(B, 'token-b', fx.deckA), null)
  assert.equal(await db.getSpreadsheet(B, 'token-b', fx.sheetA), null)
  assert.equal(await db.getDocument(B, 'token-b', fx.docA), null)
  assert.equal(await db.getImage(B, 'token-b', fx.imgA), null)
  assert.deepEqual(await db.listSessionImagePaths(B, 'token-b', fx.sA), [])
  assert.equal(await db.artifactSessionId(B, 'token-b', 'deck', fx.deckA), null)

  await db.updateDeckSlides(B, 'token-b', fx.deckA, 'invadido', [], {})
  await db.updateSpreadsheet(B, 'token-b', fx.sheetA, 'invadido', {})
  await db.updateDocument(B, 'token-b', fx.docA, 'invadido', 'x')
  const [d] = await q(`SELECT title FROM chat_decks WHERE id = $1`, [fx.deckA])
  const [s] = await q(`SELECT title FROM chat_spreadsheets WHERE id = $1`, [fx.sheetA])
  const [doc] = await q(`SELECT title FROM chat_documents WHERE id = $1`, [fx.docA])
  assert.equal(d.title, 'Deck da Ana')
  assert.equal(s.title, 'Planilha da Ana')
  assert.equal(doc.title, 'Doc da Ana')

  await assert.rejects(db.createDeck(B, 'token-b', fx.sA, 't', [], {}), (e) => e.status === 404)
  await assert.rejects(db.createSpreadsheet(B, 'token-b', fx.sA, 't', {}), (e) => e.status === 404)
  await assert.rejects(db.createDocument(B, 'token-b', fx.sA, 't', 'x'), (e) => e.status === 404)
  await assert.rejects(
    db.createImage(B, 'token-b', fx.sA, { prompt: 'p', model: 'm', volumePath: '/v', contentType: 'image/png' }),
    (e) => e.status === 404
  )
})

test('conexões MCP: lista, status e esquecimento só do dono', { skip }, async () => {
  assert.deepEqual(await db.listUserMcpConnections(B, 'token-b'), [])
  await db.setUserMcpStatus(B, 'token-b', fx.connName, 'down')
  await db.forgetUserMcpConnection(B, 'token-b', fx.connName)
  const [row] = await q(`SELECT status FROM user_mcp_connections WHERE user_email = $1 AND connection_name = $2`, [A, fx.connName])
  assert.equal(row.status, 'ok')
})

test('skills do usuário: leitura, edição, embedding e exclusão alheias são negadas', { skip }, async () => {
  assert.equal(await db.getSkill(B, 'token-b', fx.skillA), null)
  assert.equal(await db.deleteSkill(B, 'token-b', fx.skillA), false)
  assert.equal(
    await db.upsertSkill(B, 'token-b', { id: fx.skillA, scope: 'user', name: 'x', title: 'x', description: 'x', body: 'x', triggers: [], enabled: true }),
    null
  )
  await db.setSkillEmbedding(B, 'token-b', fx.skillA, VEC)
  const [row] = await q(`SELECT name, embedding IS NULL AS no_embedding FROM skills WHERE id = $1`, [fx.skillA])
  assert.equal(row.name, `skill-ana-${stamp}`)
  assert.equal(row.no_embedding, true)
})

test('conversa Genie: lida e gravada só pelo dono da sessão', { skip }, async () => {
  assert.equal(await db.getGenieConversationId(B, 'token-b', fx.sA, 'space-1'), null)
  await db.setGenieConversationId(B, 'token-b', fx.sA, 'space-1', 'evil')
  assert.equal(await db.getGenieConversationId(A, 'token-a', fx.sA, 'space-1'), 'conv-ana')
})

test('custos: o resumo de quem não é dono não soma gastos alheios', { skip }, async () => {
  const since = '1970-01-01T00:00:00Z'
  const mine = await db.usageTotals(A, 'token-a', { since, sessionId: fx.sA })
  assert.ok(mine.month.usd >= 9.5, `dona deve ver o próprio gasto (${mine.month.usd})`)
  assert.ok(mine.session.usd >= 9.5, 'e o da sessão')
  const theirs = await db.usageTotals(B, 'token-b', { since, sessionId: fx.sA })
  assert.equal(theirs.month.usd, 0)
  assert.equal(theirs.session?.usd ?? 0, 0)
})
