import pg from 'pg'

if (process.env.LOCAL_DEV_MODE !== '1') {
  throw new Error('local:seed só pode rodar com LOCAL_DEV_MODE=1')
}

const api = `http://127.0.0.1:${process.env.PORT || 8000}`
const ready = await fetch(`${api}/api/me`)
if (!ready.ok) {
  throw new Error(`Servidor local indisponível ou schema não inicializado: HTTP ${ready.status}`)
}

const client = new pg.Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: false,
})

const email = process.env.DATABRICKS_USER_EMAIL || 'local-dev@databricks.com'
await client.connect()
try {
  await client.query('BEGIN')
  // row-level security (migration 0003): write as the seeded user, like withTx does
  await client.query(`SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', 'off', true)`, [email])
  await client.query(`DELETE FROM chat_sessions WHERE user_email = $1 AND title = $2`, [email, 'Ambiente local de demonstração'])
  const { rows: [session] } = await client.query(
    `INSERT INTO chat_sessions (user_email, title, model) VALUES ($1, $2, $3) RETURNING id`,
    [email, 'Ambiente local de demonstração', 'databricks-claude-opus-5']
  )

  const documentMarkdown = `# Documento editável

Este documento existe apenas no **Postgres local**.

## Teste o editor

- Clique em \"Abrir\" e depois em **Markdown**.
- Altere títulos, listas ou **ênfase**.
- O painel rich text deve atualizar enquanto você digita.

> Nenhum token Lakebase é necessário para salvar.`
  const { rows: [document] } = await client.query(
    `INSERT INTO chat_documents (session_id, user_email, title, markdown) VALUES ($1, $2, $3, $4) RETURNING id`,
    [session.id, email, 'Documento editável', documentMarkdown]
  )

  const slides = [{
    layout: 'freeform',
    background: { color: '#F7F5F2' },
    elements: [
      { id: 'title', type: 'text', box: { x: 0.7, y: 0.55, w: 8.6, h: 0.7 }, text: 'Teste local do controle de zoom', style: { fontSize: 24, bold: true, color: '#18343D' } },
      { id: 'panel', type: 'shape', box: { x: 0.8, y: 1.55, w: 8.4, h: 2.8 }, shape: 'roundRect', style: { fill: '#18343D', radius: 0.12 } },
      { id: 'body', type: 'text', box: { x: 1.25, y: 2.15, w: 7.5, h: 1.6 }, text: 'Use + e −. O seletor permanece abaixo do slide e nunca cobre este conteúdo.', style: { fontSize: 20, bold: true, color: '#FFFFFF', align: 'center', valign: 'mid' } },
      { id: 'accent', type: 'shape', box: { x: 0.8, y: 4.7, w: 8.4, h: 0.25 }, shape: 'rect', style: { fill: '#FF3621' } },
    ],
  }]
  const { rows: [deck] } = await client.query(
    `INSERT INTO chat_decks (session_id, user_email, title, slides, meta) VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb) RETURNING id`,
    [session.id, email, 'Apresentação para teste de zoom', JSON.stringify(slides)]
  )

  const blocks = [
    { type: 'document', title: 'Documento editável', markdown: documentMarkdown, documentId: String(document.id) },
    { type: 'deck', title: 'Apresentação para teste de zoom', slides, deckId: String(deck.id) },
  ]
  await client.query(
    `INSERT INTO chat_messages (session_id, role, content, model, blocks) VALUES ($1, 'assistant', $2, $3, $4::jsonb)`,
    [session.id, 'Fixtures locais prontas para testar os Studios.', 'databricks-claude-opus-5', JSON.stringify(blocks)]
  )
  await client.query('COMMIT')
  console.log(`Fixtures locais criadas na conversa ${session.id}. Recarregue http://localhost:5173.`)
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  await client.end()
}
