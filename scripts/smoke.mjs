#!/usr/bin/env node
// Smoke pós-deploy do AI Prism — percorre o caminho real de um usuário contra uma
// URL (App deployado ou o servidor local) e sai com código != 0 se algo quebrar.
//
//   APP_URL=https://<app>.databricksapps.com DATABRICKS_TOKEN=<oauth> node scripts/smoke.mjs
//   APP_URL=http://127.0.0.1:8000 node scripts/smoke.mjs        # servidor local (npm run dev:local)
//   npm run smoke -- --help
//
// Variáveis (todas opcionais exceto APP_URL):
//   APP_URL              URL base (ou --url). Obrigatória.
//   DATABRICKS_TOKEN     Bearer OAuth do usuário para a URL do App — o proxy do Apps
//                        valida o token e repassa a identidade ao servidor. Gere com
//                        `databricks auth token -p <profile>` (ou o token de sessão de
//                        um navegador logado). NÃO commite nem cole em logs.
//   APP_COOKIE           Alternativa: cabeçalho Cookie de uma sessão do navegador
//                        (ex.: "name=value; name2=value2") quando não há bearer.
//   SMOKE_MODEL          Modelo do turno de chat (ou --model). Padrão: o primeiro de /api/models.
//   SMOKE_EXPECT_EMAIL   Se definido, /api/me precisa devolver exatamente este e-mail.
//   SMOKE_SKIP_ARTIFACT  "1" pula o passo de artefato (documento gerado por chat).
//   SMOKE_SKIP_SPA       "1" pula o passo da SPA (servidor local sem client/dist).
//   SMOKE_TIMEOUT_MS     Teto por requisição/turno. Padrão 120000.
//   SMOKE_KEEP_SESSION   "1" não apaga a sessão de teste (para inspecionar depois).
//
// Local: o servidor local precisa de DATABRICKS_USER_TOKEN real (em .env.local) para o
// turno de chat e para o artefato; com o placeholder `local-dev-token` esses passos
// falham com o erro do gateway — é o esperado, não é bug do smoke.
//
// Não é um health check de infraestrutura: /api/me degrada para "não admin" quando o
// banco cai (por design, identidade nunca derruba o shell). Por isso o passo de
// persistência (leitura de volta das mensagens) é o que prova que o Lakebase responde.

const USAGE = `Uso: node scripts/smoke.mjs [--url <APP_URL>] [--model <id>] [--help]

Verifica, nesta ordem: resposta da SPA (e redirect de login), identidade (/api/me),
modelos (/api/models), turno de chat com SSE (/api/chat), persistência (leitura de
volta das mensagens), listagem da sessão, artefato (documento gerado por chat, se
SMOKE_SKIP_ARTIFACT != 1) e limpeza (DELETE /api/sessions/:id).

Ambiente: APP_URL (obrigatória), DATABRICKS_TOKEN ou APP_COOKIE, SMOKE_MODEL,
SMOKE_EXPECT_EMAIL, SMOKE_SKIP_ARTIFACT, SMOKE_SKIP_SPA, SMOKE_TIMEOUT_MS, SMOKE_KEEP_SESSION.
Códigos de saída: 0 tudo ok · 1 alguma verificação falhou · 2 uso/configuração inválida.
`

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--url') out.url = argv[++i]
    else if (a === '--model') out.model = argv[++i]
    else throw new Error(`argumento desconhecido: ${a}`)
  }
  return out
}

const args = (() => {
  try {
    return parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}`)
    process.exit(2)
  }
})()

if (args.help) {
  process.stdout.write(USAGE)
  process.exit(0)
}

const rawUrl = args.url || process.env.APP_URL
if (!rawUrl) {
  process.stderr.write(`APP_URL não definida.\n\n${USAGE}`)
  process.exit(2)
}
let BASE
try {
  BASE = new URL(rawUrl).origin
} catch {
  process.stderr.write(`APP_URL inválida: ${rawUrl}\n`)
  process.exit(2)
}

const TOKEN = process.env.DATABRICKS_TOKEN || ''
const COOKIE = process.env.APP_COOKIE || ''
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 120000)
const SKIP_ARTIFACT = process.env.SMOKE_SKIP_ARTIFACT === '1'
const SKIP_SPA = process.env.SMOKE_SKIP_SPA === '1'
const KEEP_SESSION = process.env.SMOKE_KEEP_SESSION === '1'
const EXPECT_EMAIL = (process.env.SMOKE_EXPECT_EMAIL || '').trim().toLowerCase()
const RUN_ID = `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`

function authHeaders() {
  const h = {}
  if (TOKEN) h.authorization = `Bearer ${TOKEN}`
  if (COOKIE) h.cookie = COOKIE
  return h
}

async function request(method, path, { json, form, timeoutMs = TIMEOUT_MS, redirect = 'manual' } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const headers = { ...authHeaders() }
    let body
    if (json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(json)
    } else if (form) {
      body = form
    }
    return await fetch(`${BASE}${path}`, { method, headers, body, redirect, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(path) {
  const res = await request('GET', path)
  if (res.status !== 200) throw new Error(`GET ${path} → HTTP ${res.status}${hintFor(res.status)}`)
  return res.json()
}

function hintFor(status) {
  if (status === 401) return ' (token ausente/expirado: refaça DATABRICKS_TOKEN)'
  if (status === 302 || status === 303 || status === 307) return ' (redirect de login: o proxy não aceitou a credencial)'
  if (status === 403) return ' (sem permissão para o recurso)'
  return ''
}

/**
 * Consome um stream SSE de /api/chat (mesmo formato de client/src/api.js):
 * frames `data: {...}` separados por linha em branco. Devolve os eventos e o
 * instante do primeiro `token` (TTFT). Falha se o HTTP não for 200.
 */
async function postChatTurn(payload, files = []) {
  const form = new FormData()
  form.append('payload', JSON.stringify(payload))
  for (const f of files) form.append('files', f.blob, f.name)
  const started = performance.now()
  const res = await request('POST', '/api/chat', { form })
  if (res.status !== 200) {
    let msg = ''
    try {
      msg = (await res.json()).error || ''
    } catch {}
    throw new Error(`POST /api/chat → HTTP ${res.status}${msg ? `: ${msg}` : ''}${hintFor(res.status)}`)
  }
  const events = []
  let ttftMs = null
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 2)
      if (!raw.startsWith('data:')) continue
      let ev
      try {
        ev = JSON.parse(raw.slice(5).trim())
      } catch {
        continue
      }
      if (ev.type === 'token' && ttftMs === null) ttftMs = performance.now() - started
      events.push(ev)
    }
  }
  return { events, ttftMs, totalMs: performance.now() - started }
}

const results = []
let sessionId = null

async function step(name, fn) {
  const t0 = performance.now()
  try {
    const detail = (await fn()) || 'ok'
    results.push({ name, ok: true, ms: performance.now() - t0, detail })
    return true
  } catch (e) {
    results.push({ name, ok: false, ms: performance.now() - t0, detail: e.message || String(e) })
    return false
  }
}

function fmtMs(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

function printTable() {
  const rows = results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${fmtMs(r.ms)} | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)
  const lines = [
    `# AI Prism — smoke (${BASE})`,
    '',
    '| # | Verificação | Resultado | Tempo | Detalhe |',
    '|---|---|---|---|---|',
    ...rows,
  ]
  const failed = results.filter((r) => !r.ok)
  lines.push('')
  lines.push(
    failed.length
      ? `${failed.length} de ${results.length} verificação(ões) falharam.`
      : `Todas as ${results.length} verificações passaram.`
  )
  process.stdout.write(lines.join('\n') + '\n')
}

async function main() {
  // 1. A SPA responde sem redirect de login. Com redirect 'manual', um 302 para o
  //    login aparece como falha explícita em vez de um HTML de login "passando".
  if (SKIP_SPA) {
    results.push({ name: 'SPA responde (sem redirect de login)', ok: true, ms: 0, detail: 'pulado (SMOKE_SKIP_SPA=1; servidor sem client/dist)' })
  } else await step('SPA responde (sem redirect de login)', async () => {
    const res = await request('GET', '/')
    if (res.status !== 200) throw new Error(`GET / → HTTP ${res.status}${hintFor(res.status)}`)
    const ct = res.headers.get('content-type') || ''
    if (!ct.includes('text/html')) throw new Error(`GET / devolveu ${ct || 'sem content-type'}, esperado text/html`)
    return `HTTP 200 ${ct.split(';')[0]}`
  })

  // 2. Identidade: o servidor lê o e-mail do proxy (x-forwarded-email) e responde.
  let me = null
  await step('identidade (/api/me)', async () => {
    me = await getJson('/api/me')
    if (typeof me.email !== 'string' || !me.email.includes('@')) throw new Error(`e-mail inválido em /api/me: ${JSON.stringify(me.email)}`)
    if (EXPECT_EMAIL && me.email.trim().toLowerCase() !== EXPECT_EMAIL) {
      throw new Error(`/api/me devolveu ${me.email}, esperado ${EXPECT_EMAIL}`)
    }
    return `${me.email} (admin=${!!me.isAdmin}, owner=${!!me.isOwner})`
  })

  // 3. Catálogo de modelos e escolha do modelo do smoke.
  let model = args.model || process.env.SMOKE_MODEL || ''
  await step('modelos (/api/models)', async () => {
    const data = await getJson('/api/models')
    const models = Array.isArray(data.models) ? data.models : []
    if (!models.length) throw new Error('nenhum modelo habilitado para o usuário')
    const ids = models.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean)
    if (!model) model = ids[0]
    if (!ids.includes(model)) throw new Error(`modelo ${model} não está habilitado (disponíveis: ${ids.slice(0, 5).join(', ')}…)`)
    return `${models.length} modelo(s); usando ${model}`
  })

  // 4. Turno de chat real: cria a sessão no primeiro `meta`, streama tokens e fecha com `done`.
  let answerText = ''
  let chatOk = false
  if (model) {
    chatOk = await step('turno de chat (SSE, sessão nova)', async () => {
      const { events, ttftMs, totalMs } = await postChatTurn({
        prompt: `Responda apenas com a palavra OK. (${RUN_ID})`,
        model,
        temperature: 0,
        enabledTools: [],
      })
      const meta = events.find((e) => e.type === 'meta')
      if (!meta?.sessionId) throw new Error('stream sem evento meta com sessionId')
      sessionId = String(meta.sessionId)
      const errors = events.filter((e) => e.type === 'error')
      if (errors.length) throw new Error(`erro no stream: ${errors.map((e) => e.error).join(' | ')}`)
      if (!events.some((e) => e.type === 'done')) throw new Error('stream terminou sem evento done')
      answerText = events.filter((e) => e.type === 'token').map((e) => e.value || '').join('')
      if (!answerText.trim()) throw new Error('resposta vazia do modelo')
      return `sessão ${sessionId}; TTFT ${ttftMs == null ? '—' : fmtMs(ttftMs)}; total ${fmtMs(totalMs)}; ${answerText.length} chars`
    })
  } else {
    results.push({ name: 'turno de chat (SSE, sessão nova)', ok: false, ms: 0, detail: 'não executado: nenhum modelo disponível (ver passo de modelos)' })
  }

  // 5. Persistência: as mensagens voltam do banco com o prompt e a resposta.
  if (chatOk && sessionId) {
    await step('persistência (leitura de volta das mensagens)', async () => {
      const { messages } = await getJson(`/api/sessions/${sessionId}/messages`)
      const user = messages.find((m) => m.role === 'user' && String(m.content).includes(RUN_ID))
      const assistant = messages.find((m) => m.role === 'assistant' && String(m.content || '').trim())
      if (!user) throw new Error(`mensagem do usuário não encontrada (${messages.length} mensagens lidas)`)
      if (!assistant) throw new Error('resposta do assistente não persistida')
      return `${messages.length} mensagens; resposta persistida com ${String(assistant.content).length} chars`
    })

    await step('listagem (/api/sessions contém a sessão)', async () => {
      const { sessions } = await getJson('/api/sessions')
      if (!sessions.some((s) => String(s.id) === sessionId)) throw new Error('sessão de teste ausente da listagem')
      return `${sessions.length} sessão(ões) listadas`
    })
  }

  // 6. Artefato: pede um documento curto no MESMO chat e confirma que o bloco traz
  //    documentId, que o GET devolve o markdown salvo. Não há rota de criação direta:
  //    artefatos nascem de turnos de chat (server/index.js persistDeckBlocks).
  if (!SKIP_ARTIFACT && chatOk && sessionId) {
    await step('artefato (documento gerado por chat)', async () => {
      const { events } = await postChatTurn({
        prompt: `Crie um documento curto com título "Smoke test" e um parágrafo de uma frase. (${RUN_ID})`,
        model,
        temperature: 0,
        enabledTools: [],
        sessionId,
      })
      const errors = events.filter((e) => e.type === 'error')
      if (errors.length) throw new Error(`erro no stream: ${errors.map((e) => e.error).join(' | ')}`)
      const blocks = events.filter((e) => e.type === 'blocks').flatMap((e) => e.blocks || [])
      const doc = blocks.find((b) => b.type === 'document' && b.documentId)
      if (!doc) {
        const kinds = [...new Set(blocks.map((b) => b.type))].join(', ') || 'nenhum'
        throw new Error(`o modelo não emitiu bloco document persistido (blocos: ${kinds}). Use SMOKE_SKIP_ARTIFACT=1 se o modelo não gera artefatos`)
      }
      const { document } = await getJson(`/api/documents/${doc.documentId}`)
      if (!String(document.markdown || '').trim()) throw new Error('documento salvo sem conteúdo markdown')
      return `documento ${doc.documentId} (${String(document.markdown).length} chars)`
    })
  } else if (SKIP_ARTIFACT) {
    results.push({ name: 'artefato (documento gerado por chat)', ok: true, ms: 0, detail: 'pulado (SMOKE_SKIP_ARTIFACT=1)' })
  }

  // 7. Limpeza: apaga a sessão de teste (inclusive após falhas anteriores).
  if (sessionId && !KEEP_SESSION) {
    await step('limpeza (DELETE /api/sessions/:id)', async () => {
      const res = await request('DELETE', `/api/sessions/${sessionId}`)
      if (res.status !== 200) throw new Error(`DELETE → HTTP ${res.status}`)
      const { sessions } = await getJson('/api/sessions')
      if (sessions.some((s) => String(s.id) === sessionId)) throw new Error('sessão ainda aparece na listagem após DELETE')
      return `sessão ${sessionId} removida`
    })
  } else if (sessionId && KEEP_SESSION) {
    results.push({ name: 'limpeza (DELETE /api/sessions/:id)', ok: true, ms: 0, detail: `mantida por SMOKE_KEEP_SESSION=1 (sessão ${sessionId})` })
  }
}

await main()
printTable()
process.exit(results.every((r) => r.ok) ? 0 : 1)
