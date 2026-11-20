// Isolamento entre dois usuários, contra as funções reais de db.js.
//
// Desde a W2-1 o isolamento é do banco: todas as conexões do app usam UM papel
// Postgres (o service principal), que não é dono das tabelas e não tem
// BYPASSRLS; FORCE ROW LEVEL SECURITY vale em toda tabela do app, e withTx
// (server/db/pool.js) define app.user_email / app.is_admin em cada transação.
// Os WHERE por dono continuam no SQL (defesa em profundidade).
//
// Este arquivo cria dois usuários de teste (*.test.invalid), popula um lado e
// tenta ler, alterar e apagar tudo do outro, com db.js conectado como o papel do
// app (ai_prism_app, criado por scripts/ci/pg-roles.sql). Depois confere no banco
// (SQL direto como superusuário, sem passar por db.js nem pela RLS) que nada
// mudou. Também prova que o dono consegue ler o próprio conteúdo (senão o teste
// poderia passar por um erro de conexão), e roda um SELECT cru como o papel do
// app em cada tabela por usuário: 0 linhas alheias.
//
// Requisitos: Postgres com pgvector e um host local. Padrão: o banco do
// `npm run local:up` (127.0.0.1:55432, ai_prism), cujo usuário é superusuário
// (aplica as migrações, as grants e, se faltar, o papel do app). Sem banco, ou
// sem a extensão vector, a suíte inteira é pulada (skip), não falha. Para apontar
// outro host defina ISOLATION_TEST_ANY_HOST=1: o teste grava e apaga linhas de
// teste, então nunca aponte para produção.
//
//   node --test server/isolation.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
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
// the superuser of the test server (migrations, grants, raw checks) and the app
// role db.js connects as (scripts/ci/pg-roles.sql)
const SUPERUSER = env.PGUSER
const APP_ROLE = env.ISOLATION_APP_ROLE || 'ai_prism_app'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

function connectionOptions(user = SUPERUSER) {
  return {
    host: env.PGHOST,
    port: Number(env.PGPORT),
    user,
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
const ADMIN_ROW = `iso-admin-${stamp}@test.invalid`
const TOOL_KEY = `iso-tool-${stamp}`
const MCP_SVC = `iso-mcp-${stamp}`
const MODEL_ID = `iso-model-${stamp}`
const VEC = Array.from({ length: 1024 }, (_, i) => (i % 7) / 10)
// RLS denial of a write (WITH CHECK): SQLSTATE 42501, "row-level security"
const rlsDenied = (e) => e?.code === '42501' && /row-level security/.test(e.message)

let db
let raw
let fx

async function q(sql, params = []) {
  return (await raw.query(sql, params)).rows
}

// As the superuser: the roles fixture (if the server lacks it), every migration
// (0003 = RLS) and the app role's grants. Then db.js connects as the app role.
async function prepareDatabase() {
  raw = new pg.Client(connectionOptions())
  await raw.connect()
  const hasRole = await raw.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])
  if (!hasRole.rows.length && APP_ROLE === 'ai_prism_app') {
    await raw.query(fs.readFileSync(path.join(HERE, '..', 'scripts', 'ci', 'pg-roles.sql'), 'utf8'))
  }
  const { migrateUp } = await import('./db/migrate.js')
  const { applyAppGrants } = await import('./db/grants.js')
  await migrateUp(raw, { log: { log() {}, warn() {} } })
  await applyAppGrants(raw, { role: APP_ROLE, log: { log() {}, warn() {} } })
  env.PGUSER = APP_ROLE
}

async function setup() {
  await prepareDatabase()
  db = await import('./db.js')
  await db.ensureSchema(A, 'token-a')

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
  const compA = await db.insertCompaction(A, 'token-a', sA, { uptoMessageId: mA.id, content: 'resumo da Ana', messages: 1 })
  const tplA = await db.createDeckTemplate(A, 'token-a', { name: 'Modelo da Ana' })
  await db.selectDeckTemplate(A, 'token-a', tplA.id)
  await db.setSelectedImageModel(A, 'token-a', 'img-da-ana')
  // global admin rows, written as the superuser (no RLS for it)
  await q(`INSERT INTO app_admins (principal, kind, added_by) VALUES ($1, 'user', 'iso')`, [ADMIN_ROW])
  await q(`INSERT INTO app_tool_policy (tool_key, enabled, updated_by) VALUES ($1, true, 'iso')`, [TOOL_KEY])
  await q(`INSERT INTO app_mcp_catalog (service_name, display_name, added_by) VALUES ($1, 'MCP iso', 'iso')`, [MCP_SVC])
  await q(`INSERT INTO model_catalog_overrides (endpoint_id, enabled, sort_order, price_in, price_out, updated_by) VALUES ($1, true, 7, 1, 2, 'iso')`, [MODEL_ID])

  fx = { sA, mA: mA.id, aA: aA.id, deckA, sheetA, docA, imgA, skillA, connName: `conn-ana-${stamp}`, compA: compA.id, tplA: tplA.id }
  // the owner can read her own data: otherwise the negative checks below prove nothing
  assert.ok(await db.getSession(A, 'token-a', sA))
  assert.ok(await db.getDeck(A, 'token-a', deckA))
  assert.ok(await db.getDocument(A, 'token-a', docA))
  assert.equal((await db.listCompactions(A, 'token-a', sA)).length, 1)
  assert.ok(await db.getDeckTemplate(A, 'token-a', tplA.id))
  assert.equal(await db.getSelectedImageModel(A, 'token-a'), 'img-da-ana')
  return fx
}

async function cleanup() {
  if (!raw) return
  await raw.query(`DELETE FROM chat_sessions WHERE user_email = ANY($1)`, [[A, B]])
  await raw.query(`DELETE FROM usage_ledger WHERE user_email = ANY($1)`, [[A, B]])
  await raw.query(`DELETE FROM user_mcp_connections WHERE user_email = ANY($1)`, [[A, B]])
  await raw.query(`DELETE FROM skills WHERE owner_email = ANY($1)`, [[A, B]])
  await raw.query(`DELETE FROM user_template_selection WHERE user_email = ANY($1)`, [[A, B]])
  await raw.query(`DELETE FROM deck_templates WHERE user_email = ANY($1)`, [[A, B]])
  await raw.query(`DELETE FROM user_image_model_selection WHERE user_email = ANY($1)`, [[A, B]])
  await raw.query(`DELETE FROM app_admins WHERE principal = ANY($1)`, [[ADMIN_ROW, B]])
  await raw.query(`DELETE FROM app_tool_policy WHERE tool_key = $1`, [TOOL_KEY])
  await raw.query(`DELETE FROM app_mcp_catalog WHERE service_name = $1`, [MCP_SVC])
  await raw.query(`DELETE FROM model_catalog_overrides WHERE endpoint_id = $1`, [MODEL_ID])
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

test('compactions: a outra usuária não lista nem anexa resumo na sessão alheia', { skip }, async () => {
  assert.deepEqual(await db.listCompactions(B, 'token-b', fx.sA), [])
  await assert.rejects(db.insertCompaction(B, 'token-b', fx.sA, { uptoMessageId: fx.mA, content: 'invadido', messages: 1 }))
  const rows = await q(`SELECT content FROM chat_compactions WHERE session_id = $1`, [fx.sA])
  assert.deepEqual(rows.map((r) => r.content), ['resumo da Ana'])
})

test('modelos de deck: o modelo próprio da outra usuária não aparece, nem com a flag de admin', { skip }, async () => {
  const list = await db.listDeckTemplates(B, 'token-b')
  assert.ok(!list.some((t) => String(t.id) === String(fx.tplA)))
  assert.equal(await db.getDeckTemplate(B, 'token-b', fx.tplA), null)
  // a flag de admin abre só as linhas globais, nunca as próprias de outra pessoa
  assert.equal(await db.updateDeckTemplate(B, 'token-b', fx.tplA, { name: 'invadido' }, true), false)
  assert.equal(await db.deleteDeckTemplate(B, 'token-b', fx.tplA, true), false)
  assert.equal(await db.setDeckTemplateScope(B, 'token-b', fx.tplA, 'global', { admin: true }), false)
  const [row] = await q(`SELECT name, scope, user_email FROM deck_templates WHERE id = $1`, [fx.tplA])
  assert.deepEqual(row, { name: 'Modelo da Ana', scope: 'user', user_email: A })
})

test('seleção de modelo: não seleciona o modelo próprio alheio nem mexe na seleção da outra', { skip }, async () => {
  assert.equal(await db.selectDeckTemplate(B, 'token-b', fx.tplA), false)
  const rows = await q(`SELECT user_email, template_id FROM user_template_selection WHERE user_email = ANY($1) ORDER BY user_email`, [[A, B]])
  const byUser = Object.fromEntries(rows.map((r) => [r.user_email, String(r.template_id)]))
  assert.equal(byUser[A], String(fx.tplA))
  assert.notEqual(byUser[B], String(fx.tplA))
})

test('modelo de imagem: a escolha de cada usuária é só dela', { skip }, async () => {
  assert.equal(await db.getSelectedImageModel(B, 'token-b'), null)
  await db.setSelectedImageModel(B, 'token-b', 'img-do-bruno')
  assert.equal(await db.getSelectedImageModel(A, 'token-a'), 'img-da-ana')
  const [row] = await q(`SELECT model_id FROM user_image_model_selection WHERE user_email = $1`, [A])
  assert.equal(row.model_id, 'img-da-ana')
})

test('administradores: todos leem; só com a flag de admin se grava (o banco nega o resto)', { skip }, async () => {
  assert.ok((await db.listAppAdmins(B, 'token-b')).some((a) => a.principal === ADMIN_ROW))
  await assert.rejects(db.addAppAdmin(B, 'token-b', B, 'user'), rlsDenied)
  await db.removeAppAdmin(B, 'token-b', ADMIN_ROW)
  assert.equal((await q(`SELECT count(*)::int AS n FROM app_admins WHERE principal = ANY($1)`, [[ADMIN_ROW, B]]))[0].n, 1)
  await db.addAppAdmin(B, 'token-b', B, 'user', { admin: true })
  await db.removeAppAdmin(B, 'token-b', B, { admin: true })
  assert.equal((await q(`SELECT count(*)::int AS n FROM app_admins WHERE principal = $1`, [B]))[0].n, 0)
})

test('catálogo MCP: todos leem; gravar e apagar exigem a flag de admin', { skip }, async () => {
  assert.ok((await db.listMcpCatalogRows(B, 'token-b')).some((r) => r.serviceName === MCP_SVC))
  await assert.rejects(db.upsertMcpCatalogEntry(B, 'token-b', MCP_SVC, { displayName: 'invadido', hidden: true }), rlsDenied)
  await db.deleteMcpCatalogEntry(B, 'token-b', MCP_SVC)
  const [row] = await q(`SELECT display_name, hidden FROM app_mcp_catalog WHERE service_name = $1`, [MCP_SVC])
  assert.deepEqual(row, { display_name: 'MCP iso', hidden: false })
})

test('política de tools: todos leem; mudar exige a flag de admin', { skip }, async () => {
  assert.equal((await db.getToolPolicy(B, 'token-b'))[TOOL_KEY], true)
  await assert.rejects(db.setToolPolicy(B, 'token-b', TOOL_KEY, false), rlsDenied)
  assert.equal((await q(`SELECT enabled FROM app_tool_policy WHERE tool_key = $1`, [TOOL_KEY]))[0].enabled, true)
})

test('catálogo de modelos: todos leem; preços e ordem só com a flag de admin', { skip }, async () => {
  assert.ok((await db.listModelOverrides(B, 'token-b'))[MODEL_ID])
  await assert.rejects(db.upsertModelOverride(B, 'token-b', MODEL_ID, { enabled: false }), rlsDenied)
  await assert.rejects(db.reorderModelOverrides(B, 'token-b', [MODEL_ID]), rlsDenied)
  assert.equal(await db.clearModelOverridePrices(B, 'token-b', [MODEL_ID]), 0)
  const [row] = await q(`SELECT enabled, sort_order, price_in::float8 AS p FROM model_catalog_overrides WHERE endpoint_id = $1`, [MODEL_ID])
  assert.deepEqual(row, { enabled: true, sort_order: 7, p: 1 })
})

test('SQL cru como o papel do app: 0 linhas alheias em toda tabela por usuário; sem BYPASSRLS, sem ser dono', { skip }, async () => {
  const { RLS_PER_USER_TABLES } = await import('./db/rls.js')
  // what each per-user table holds of A's (counted as the superuser, without RLS)
  const ofA = {
    chat_sessions: [`user_email = $1`],
    chat_decks: [`user_email = $1`],
    chat_spreadsheets: [`user_email = $1`],
    chat_documents: [`user_email = $1`],
    chat_images: [`user_email = $1`],
    usage_ledger: [`user_email = $1`],
    user_mcp_connections: [`user_email = $1`],
    user_template_selection: [`user_email = $1`],
    user_image_model_selection: [`user_email = $1`],
    chat_messages: [`session_id IN (SELECT id FROM chat_sessions WHERE user_email = $1)`],
    chat_genie_conversations: [`session_id IN (SELECT id FROM chat_sessions WHERE user_email = $1)`],
    chat_compactions: [`session_id IN (SELECT id FROM chat_sessions WHERE user_email = $1)`],
    chat_message_embeddings: [`session_id IN (SELECT id FROM chat_sessions WHERE user_email = $1)`],
    chat_tool_calls: [`message_id IN (SELECT m.id FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id WHERE s.user_email = $1)`],
  }
  assert.deepEqual(Object.keys(ofA).sort(), [...RLS_PER_USER_TABLES].sort())
  const app = new pg.Client(connectionOptions(APP_ROLE))
  await app.connect()
  try {
    await app.query(`SET search_path TO ai_prism, public`)
    const me = (await app.query(`SELECT current_user AS me, r.rolbypassrls, r.rolsuper,
        pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'ai_prism.chat_sessions'::regclass)) AS owner
        FROM pg_roles r WHERE r.rolname = current_user`)).rows[0]
    assert.equal(me.me, APP_ROLE)
    assert.equal(me.rolbypassrls, false)
    assert.equal(me.rolsuper, false)
    assert.notEqual(me.owner, me.me, 'o papel do app não é o dono das tabelas')
    for (const t of RLS_PER_USER_TABLES) {
      const where = ofA[t][0]
      const [{ n: total }] = await q(`SELECT count(*)::int AS n FROM ${t} WHERE ${where}`, [A])
      assert.ok(total >= 1, `${t}: a fixture tem linhas da Ana (${total})`)
      // no identity at all
      const none = await app.query(`SELECT count(*)::int AS n FROM ${t} WHERE ${where}`, [A])
      assert.equal(none.rows[0].n, 0, `${t}: sem identidade, 0 linhas`)
      // B's identity, even with the admin flag on
      await app.query('BEGIN')
      await app.query(`SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', 'on', true)`, [B])
      const asB = await app.query(`SELECT count(*)::int AS n FROM ${t} WHERE ${where}`, [A])
      await app.query('COMMIT')
      // the one table an admin may READ across users is the usage ledger (0010,
      // aipa_admin_read: aggregates for the admin cost tile); every other
      // per-user table stays closed to the admin flag
      assert.equal(asB.rows[0].n, t === 'usage_ledger' ? total : 0, `${t}: como a outra usuária (admin inclusive), ${t === 'usage_ledger' ? 'o admin só LÊ o razão' : '0 linhas'}`)
      // the same identity without the flag sees none of A's rows, ledger included
      await app.query('BEGIN')
      await app.query(`SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', 'off', true)`, [B])
      const plainB = await app.query(`SELECT count(*)::int AS n FROM ${t} WHERE ${where}`, [A])
      await app.query('COMMIT')
      assert.equal(plainB.rows[0].n, 0, `${t}: como a outra usuária sem a flag de admin, 0 linhas`)
    }
  } finally {
    await app.end().catch(() => {})
  }
})
