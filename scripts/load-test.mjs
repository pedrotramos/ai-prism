#!/usr/bin/env node
// Gerador de carga do AI Prism — sem dependências (só fetch e timers do Node).
//
//   APP_URL=https://<app>.databricksapps.com DATABRICKS_TOKEN=<oauth> npm run loadtest
//   npm run loadtest -- --stages 1,5,20 --duration 60 --think 1000
//   npm run loadtest -- --chat --chat-every 5      # inclui turnos de chat (custam tokens!)
//
// Para cada estágio (1/5/20/50 usuários virtuais por padrão) cada usuário virtual
// faz requisições em laço, com "think time" entre elas, até o fim da duração do
// estágio. Imprime em markdown: taxa de erro, throughput e p50/p95/p99 por estágio e
// por endpoint. Números de latência incluem falhas (timeouts entram com o tempo até o
// abort), para que uma degradação não fique escondida pela taxa de erro.
//
// Segurança e escopo:
//   • Recusa rodar quando a variável CI está definida (carga não pertence a pipeline).
//   • Só lê endpoints baratos por padrão. `--chat` cria sessões reais, gasta tokens e
//     grava usage_ledger; cada turno de teste é apagado ao final.
//   • Use contra um ambiente de teste ou um horário combinado — não contra produção
//     de um cliente sem aviso. Ver docs/performance.md.
//
// Variáveis: APP_URL (ou --url), DATABRICKS_TOKEN ou APP_COOKIE (mesmas do smoke),
// SMOKE_MODEL (ou --model) para o modo --chat.

const USAGE = `Uso: node scripts/load-test.mjs [opções]

  --url <URL>            Base do app (padrão: APP_URL)
  --stages <a,b,c>       Usuários virtuais por estágio (padrão: 1,5,20,50)
  --duration <s>         Duração de cada estágio em segundos (padrão: 30)
  --think <ms>           Pausa entre requisições de um mesmo usuário (padrão: 1000)
  --endpoints <p1,p2>    GETs a exercitar (padrão: /api/me,/api/models,/api/sessions)
  --chat                 Inclui turnos de chat reais (custam tokens; sessão apagada ao fim)
  --chat-every <n>       Com --chat: um turno a cada n iterações por usuário (padrão: 10)
  --model <id>           Modelo do turno de chat (padrão: SMOKE_MODEL ou o 1º de /api/models)
  --timeout <ms>         Timeout por requisição (padrão: 30000)
  --help                 Esta ajuda

Códigos de saída: 0 ok · 2 uso/configuração inválida. A taxa de erro NÃO muda o código:
o relatório é o produto; quem decide o limite é o SLO (docs/operations.md).
`

function parseArgs(argv) {
  const o = {
    url: process.env.APP_URL || '',
    stages: [1, 5, 20, 50],
    duration: 30,
    think: 1000,
    endpoints: ['/api/me', '/api/models', '/api/sessions'],
    chat: false,
    chatEvery: 10,
    model: process.env.SMOKE_MODEL || '',
    timeout: 30000,
    help: false,
  }
  const list = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} exige um valor`)
      return v
    }
    if (a === '--help' || a === '-h') o.help = true
    else if (a === '--url') o.url = next()
    else if (a === '--stages') o.stages = list(next()).map(Number)
    else if (a === '--duration') o.duration = Number(next())
    else if (a === '--think') o.think = Number(next())
    else if (a === '--endpoints') o.endpoints = list(next())
    else if (a === '--chat') o.chat = true
    else if (a === '--chat-every') o.chatEvery = Number(next())
    else if (a === '--model') o.model = next()
    else if (a === '--timeout') o.timeout = Number(next())
    else throw new Error(`argumento desconhecido: ${a}`)
  }
  const numbers = [...o.stages, o.duration, o.think, o.timeout, o.chatEvery]
  if (numbers.some((n) => !Number.isFinite(n) || n < 0)) throw new Error('valores numéricos inválidos')
  if (!o.stages.length || o.stages.some((n) => n < 1)) throw new Error('--stages precisa de inteiros >= 1')
  if (o.duration < 1) throw new Error('--duration precisa ser >= 1 segundo')
  if (o.chatEvery < 1) throw new Error('--chat-every precisa ser >= 1')
  if (!o.endpoints.length) throw new Error('--endpoints vazio')
  return o
}

let opts
try {
  opts = parseArgs(process.argv.slice(2))
} catch (e) {
  process.stderr.write(`${e.message}\n\n${USAGE}`)
  process.exit(2)
}
if (opts.help) {
  process.stdout.write(USAGE)
  process.exit(0)
}
if (process.env.CI) {
  process.stderr.write('load-test não roda em CI (variável CI definida). Rode manualmente.\n')
  process.exit(2)
}
if (!opts.url) {
  process.stderr.write(`APP_URL não definida.\n\n${USAGE}`)
  process.exit(2)
}
let BASE
try {
  BASE = new URL(opts.url).origin
} catch {
  process.stderr.write(`URL inválida: ${opts.url}\n`)
  process.exit(2)
}

const TOKEN = process.env.DATABRICKS_TOKEN || ''
const COOKIE = process.env.APP_COOKIE || ''
const RUN_TAG = `loadtest-${Date.now().toString(36)}`

function headers(extra = {}) {
  const h = { ...extra }
  if (TOKEN) h.authorization = `Bearer ${TOKEN}`
  if (COOKIE) h.cookie = COOKIE
  return h
}

/** Uma requisição medida. Nunca lança: devolve {ok, status, ms, error?}. */
async function timed(method, path, { body, form, timeoutMs = opts.timeout, readBody = null } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = performance.now()
  try {
    const init = { method, headers: headers(body && !form ? { 'content-type': 'application/json' } : {}), signal: ctrl.signal, redirect: 'manual' }
    if (body && !form) init.body = JSON.stringify(body)
    if (form) init.body = form
    const res = await fetch(`${BASE}${path}`, init)
    let extra = null
    if (readBody) extra = await readBody(res)
    else await res.arrayBuffer()
    const ms = performance.now() - t0
    const ok = res.status >= 200 && res.status < 300
    return { ok, status: res.status, ms, extra, error: ok ? null : `HTTP ${res.status}` }
  } catch (e) {
    const ms = performance.now() - t0
    const error = e.name === 'AbortError' ? `timeout ${timeoutMs} ms` : e.message || String(e)
    return { ok: false, status: 0, ms, extra: null, error }
  } finally {
    clearTimeout(timer)
  }
}

/** Lê um SSE de /api/chat até `done`/`error` ou fim do stream. */
async function readChatStream(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sessionId = null
  let sawDone = false
  let sawError = null
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
      if (ev.type === 'meta') sessionId = String(ev.sessionId)
      if (ev.type === 'error') sawError = ev.error
      if (ev.type === 'done') sawDone = true
    }
  }
  return { sessionId, sawDone, sawError }
}

async function chatTurn(model) {
  const form = new FormData()
  form.append('payload', JSON.stringify({ prompt: `Responda apenas OK. (${RUN_TAG})`, model, temperature: 0, enabledTools: [] }))
  let sessionId = null
  const r = await timed('POST', '/api/chat', {
    form,
    readBody: async (res) => {
      if (res.status !== 200) {
        await res.arrayBuffer()
        return null
      }
      const info = await readChatStream(res)
      sessionId = info.sessionId
      if (info.sawError) throw new Error(`erro no stream: ${info.sawError}`)
      if (!info.sawDone) throw new Error('stream sem done')
      return info
    },
  }).catch((e) => ({ ok: false, status: 0, ms: 0, error: e.message }))
  // limpeza fora da medição
  if (sessionId) await timed('DELETE', `/api/sessions/${sessionId}`).catch(() => {})
  if (r.error && r.error.startsWith('erro no stream')) r.ok = false
  return r
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

function summarize(samples, elapsedS) {
  const lat = samples.map((s) => s.ms).sort((a, b) => a - b)
  const errors = samples.filter((s) => !s.ok).length
  return {
    requests: samples.length,
    errors,
    errorRate: samples.length ? (errors / samples.length) * 100 : 0,
    throughput: elapsedS > 0 ? samples.length / elapsedS : 0,
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    p99: percentile(lat, 99),
    topErrors: topErrors(samples),
  }
}

function topErrors(samples) {
  const counts = new Map()
  for (const s of samples) if (!s.ok) counts.set(s.error || 'erro', (counts.get(s.error || 'erro') || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
}

const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toString() : '—')

/** Roda um estágio com `vus` usuários virtuais durante `durationS` segundos. */
async function runStage(vus, model) {
  const samples = [] // { name, ok, ms, error }
  const deadline = performance.now() + opts.duration * 1000

  async function virtualUser(id) {
    let i = id // offset para que os usuários não batam todos no mesmo endpoint
    let iter = 0
    while (performance.now() < deadline) {
      iter++
      if (opts.chat && iter % opts.chatEvery === 0) {
        // turno de chat a cada `chatEvery` iterações; o resto são GETs baratos
        const r = await chatTurn(model)
        samples.push({ name: 'POST /api/chat (turno)', ok: r.ok, ms: r.ms, error: r.error })
      } else {
        const path = opts.endpoints[i++ % opts.endpoints.length]
        const g = await timed('GET', path)
        samples.push({ name: `GET ${path}`, ok: g.ok, ms: g.ms, error: g.error })
      }
      if (opts.think > 0) await new Promise((res) => setTimeout(res, opts.think))
    }
  }

  const t0 = performance.now()
  await Promise.all(Array.from({ length: vus }, (_, k) => virtualUser(k)))
  const elapsedS = (performance.now() - t0) / 1000
  return { samples, elapsedS }
}

async function resolveModel() {
  if (!opts.chat || opts.model) return opts.model
  const r = await timed('GET', '/api/models', { readBody: (res) => res.json() })
  if (!r.ok) throw new Error(`não foi possível listar modelos (${r.error}); passe --model`)
  const first = r.extra?.models?.[0]
  const id = typeof first === 'string' ? first : first?.id || first?.name
  if (!id) throw new Error('nenhum modelo em /api/models; passe --model')
  return id
}

async function main() {
  process.stderr.write(`load-test contra ${BASE} — estágios ${opts.stages.join(', ')} usuários × ${opts.duration}s, think ${opts.think} ms${opts.chat ? ', COM turnos de chat' : ''}\n`)
  const model = await resolveModel()
  if (opts.chat) process.stderr.write(`ATENÇÃO: --chat usa o modelo ${model} e gera custo real no gateway.\n`)

  const stageRows = []
  const endpointRows = []
  for (const vus of opts.stages) {
    process.stderr.write(`estágio ${vus} usuário(s)…\n`)
    const { samples, elapsedS } = await runStage(vus, model)
    stageRows.push({ vus, ...summarize(samples, elapsedS), elapsedS })
    const names = [...new Set(samples.map((s) => s.name))]
    for (const name of names) {
      const sub = samples.filter((s) => s.name === name)
      endpointRows.push({ vus, name, ...summarize(sub, elapsedS) })
    }
  }

  const out = []
  out.push(`# AI Prism — teste de carga (${BASE})`)
  out.push('')
  out.push(`Duração por estágio: ${opts.duration} s · think time: ${opts.think} ms · timeout: ${opts.timeout} ms · endpoints: ${opts.endpoints.join(', ')}${opts.chat ? ` · chat a cada ${opts.chatEvery} iterações (modelo ${model})` : ''}`)
  out.push('')
  out.push('## Por estágio (todas as requisições)')
  out.push('')
  out.push('| Usuários | Requisições | Erros | Taxa de erro | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) |')
  out.push('|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const r of stageRows) {
    out.push(`| ${r.vus} | ${r.requests} | ${r.errors} | ${r.errorRate.toFixed(2)}% | ${r.throughput.toFixed(2)} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} |`)
  }
  out.push('')
  out.push('## Por endpoint')
  out.push('')
  out.push('| Usuários | Endpoint | Requisições | Erros | Taxa de erro | p50 (ms) | p95 (ms) | p99 (ms) |')
  out.push('|---:|---|---:|---:|---:|---:|---:|---:|')
  for (const r of endpointRows) {
    out.push(`| ${r.vus} | ${r.name} | ${r.requests} | ${r.errors} | ${r.errorRate.toFixed(2)}% | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} |`)
  }
  const errs = stageRows.flatMap((r) => r.topErrors.map(([msg, n]) => `- ${r.vus} usuário(s): ${msg} × ${n}`))
  if (errs.length) {
    out.push('')
    out.push('## Erros mais frequentes')
    out.push('')
    out.push(...errs)
  }
  out.push('')
  process.stdout.write(out.join('\n'))
}

main().catch((e) => {
  process.stderr.write(`falha: ${e.message}\n`)
  process.exit(1)
})
