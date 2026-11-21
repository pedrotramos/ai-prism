#!/usr/bin/env node
// N3 bench: session search (Q5) exact scan vs HNSW candidates, on REAL embeddings.
//
// Three steps; each guards what it touches. Nothing here deploys or reads production.
//
//   embed  Builds the corpus from two public datasets (OpenAssistant oasst1, Apache-2.0, and
//          Gustrd/dolly-15k-libretranslate-pt, CC-BY-SA-3.0, downloaded by the caller into their own
//          directories), holds out natural-language questions as queries, estimates the embedding spend
//          and REFUSES above the cap, then embeds with the workspace's embedding endpoint (the model the
//          app uses, server/llm.js EMBED_MODEL). Writes float32 files + jsonl to --out.
//            node scripts/bench/q5-ann.mjs embed --oasst trees.jsonl.gz --dolly dolly-pt.jsonl \
//                 --out DIR --profile P [--cap-usd 10] [--dry-run]
//   load   Inserts users/sessions/messages/embeddings from --out into the disposable branch database.
//   run    Runs every query as 3 users through the SHIPPED server/db.js code (runSessionVectorSearch),
//          as a NOSUPERUSER/NOBYPASSRLS role, and writes the report JSON.
//            PGHOST=<branch host> N3_BRANCH_HOST=<same> PGDATABASE=ai_prism_n3 PGUSER=<owner> \
//            PGPASSWORD=<db credential> node scripts/bench/q5-ann.mjs run --out DIR --report FILE
//
// The database credential is read from PGPASSWORD and never printed.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import readline from 'node:readline'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import pg from 'pg'

const DIM = 1024
const EMBED_MODEL = 'databricks-qwen3-embedding-0-6b' // server/llm.js
const PRICE_IN_PER_M = 0.02 // server/serving.ts, USD per 1M input tokens
const BENCH_ROLE = 'n3_bench'
const BENCH_DB = 'ai_prism_n3'
const TOPICAL_QUERIES = [0, 25, 50] // indexes into queries.jsonl: first pt-BR, first en, first es
const QUERY_PREFIX = 'Instruct: Dada uma busca do usuário, recupere conversas de chat relevantes.\nQuery: ' // server/routes/sessions.js

const args = process.argv.slice(3)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const has = (name) => args.includes(`--${name}`)
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)

// ---------------------------------------------------------------- corpus
async function readJsonl(file) {
  const input = file.endsWith('.gz') ? fs.createReadStream(file).pipe(zlib.createGunzip()) : fs.createReadStream(file)
  const out = []
  for await (const line of readline.createInterface({ input })) if (line.trim()) out.push(JSON.parse(line))
  return out
}

function* walk(m) {
  yield m
  for (const r of m.replies || []) yield* walk(r)
}

// conversations: [{ id, source, lang, title, messages: [{ role, lang, text }] }]
async function buildConversations() {
  const convs = []
  for (const t of await readJsonl(opt('oasst'))) {
    const msgs = [...walk(t.prompt)]
      .filter((m) => !m.deleted && typeof m.text === 'string' && m.text.trim())
      .map((m) => ({ role: m.role === 'prompter' ? 'user' : 'assistant', lang: m.lang, text: m.text.trim() }))
    if (msgs.length) convs.push({ id: `oasst:${t.message_tree_id}`, source: 'oasst1', lang: t.prompt.lang, title: msgs[0].text, messages: msgs })
  }
  let i = 0
  for (const r of await readJsonl(opt('dolly'))) {
    i++
    const q = String(r.instruction || '').trim()
    const a = String(r.response || '').trim()
    if (!q || !a) continue
    convs.push({
      id: `dolly:${i}`,
      source: 'dolly-pt',
      lang: 'pt-BR',
      title: q,
      messages: [{ role: 'user', lang: 'pt-BR', text: q }, { role: 'assistant', lang: 'pt-BR', text: a }],
    })
  }
  return convs
}

// ---------------------------------------------------------------- embed
function dbxJson(...a) {
  return JSON.parse(execFileSync('databricks', [...a, '--profile', opt('profile'), '-o', 'json'], { encoding: 'utf8' }))
}
let tokenAt = 0
let token = ''
function getToken() {
  if (!token || Date.now() - tokenAt > 20 * 60 * 1000) {
    token = dbxJson('auth', 'token').access_token
    tokenAt = Date.now()
  }
  return token
}

async function embedBatch(host, texts, attempt = 0) {
  const res = await fetch(`${host}/serving-endpoints/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  })
  if (res.status === 401) tokenAt = 0
  if ((res.status === 401 || res.status === 429 || res.status >= 500) && attempt < 6) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    return embedBatch(host, texts, attempt + 1)
  }
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const j = await res.json()
  const vecs = (j.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding)
  if (vecs.length !== texts.length || vecs.some((v) => v.length !== DIM)) throw new Error('unexpected embedding shape')
  return { vecs, tokens: j.usage?.prompt_tokens || 0 }
}

async function cmdEmbed() {
  const out = opt('out')
  const capUsd = Number(opt('cap-usd', '10'))
  fs.mkdirSync(path.join(out, 'chunks'), { recursive: true })
  const convs = await buildConversations()
  // held-out queries: real questions (first user turn of a conversation) in pt-BR / en / es, which are NOT in the corpus
  const want = { 'pt-BR': 25, en: 25, es: 25 }
  const byLang = {}
  for (const c of convs) {
    const t = c.messages[0].text
    if (t.length >= 20 && t.length <= 300 && t.includes(' ') && want[c.lang] !== undefined) (byLang[c.lang] ||= []).push(c)
  }
  const held = new Set()
  const queries = []
  for (const lang of Object.keys(want)) {
    const pool = (byLang[lang] || []).sort((a, b) => (sha(a.id) < sha(b.id) ? -1 : 1)).slice(0, want[lang])
    for (const c of pool) {
      held.add(c.id)
      queries.push({ id: c.id, lang, text: c.messages[0].text })
    }
  }
  // the cap on texts (brief: at most 100k): whole conversations, in a stable hash order, until it is reached
  const maxTexts = Number(opt('max-texts', '100000'))
  const corpusConvs = []
  let nTexts = 0
  for (const c of convs.filter((x) => !held.has(x.id)).sort((a, b) => (sha(a.id) < sha(b.id) ? -1 : 1))) {
    const n = c.messages.filter((m) => m.text.length <= 2000).length
    if (nTexts + n > maxTexts) continue
    corpusConvs.push(c)
    nTexts += n
  }
  const rows = []
  for (const c of corpusConvs) for (const m of c.messages) if (m.text.length <= 2000) rows.push({ conv: c.id, source: c.source, role: m.role, lang: m.lang, text: m.text })
  const bytes = rows.reduce((a, r) => a + Buffer.byteLength(r.text), 0) + queries.reduce((a, q) => a + Buffer.byteLength(QUERY_PREFIX + q.text), 0)
  // conservative: 1 token per 2.5 UTF-8 bytes (English prose runs ~4; CJK and Cyrillic are the worst case)
  const estTokens = Math.ceil(bytes / 2.5)
  const estUsd = (estTokens / 1e6) * PRICE_IN_PER_M
  console.log(JSON.stringify({ conversations: corpusConvs.length, texts: rows.length, queries: queries.length, utf8_bytes: bytes, est_tokens: estTokens, est_usd: +estUsd.toFixed(4), cap_usd: capUsd }))
  if (estUsd > capUsd) {
    console.error(`estimated spend US$ ${estUsd.toFixed(2)} is above the cap US$ ${capUsd}: stopping before embedding`)
    process.exit(3)
  }
  if (has('dry-run')) return
  const host = dbxJson('auth', 'env').env.DATABRICKS_HOST.replace(/\/$/, '')

  fs.writeFileSync(path.join(out, 'corpus.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  fs.writeFileSync(path.join(out, 'queries.jsonl'), queries.map((q) => JSON.stringify(q)).join('\n') + '\n')
  const BATCH = 32
  const CHUNK = 1024
  let tokens = 0
  const jobs = []
  for (let i = 0; i < rows.length; i += CHUNK) jobs.push(i)
  let next = 0
  let done = 0
  async function worker() {
    for (;;) {
      const j = next++
      if (j >= jobs.length) return
      const start = jobs[j]
      const file = path.join(out, 'chunks', `${String(start).padStart(7, '0')}.f32`)
      if (fs.existsSync(file)) { done++; continue }
      const slice = rows.slice(start, start + CHUNK)
      const buf = Buffer.alloc(slice.length * DIM * 4)
      for (let b = 0; b < slice.length; b += BATCH) {
        const r = await embedBatch(host, slice.slice(b, b + BATCH).map((x) => x.text))
        tokens += r.tokens
        r.vecs.forEach((v, k) => v.forEach((x, d) => buf.writeFloatLE(x, ((b + k) * DIM + d) * 4)))
      }
      fs.writeFileSync(file + '.tmp', buf)
      fs.renameSync(file + '.tmp', file)
      if (++done % 10 === 0) console.log(`chunks ${done}/${jobs.length}, tokens so far ${tokens}`)
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  fs.writeFileSync(path.join(out, 'vectors.f32'), Buffer.concat(jobs.map((s) => fs.readFileSync(path.join(out, 'chunks', `${String(s).padStart(7, '0')}.f32`)))))
  // queries: same endpoint, same Instruct/Query prefix the app uses
  const qb = Buffer.alloc(queries.length * DIM * 4)
  for (let b = 0; b < queries.length; b += BATCH) {
    const r = await embedBatch(host, queries.slice(b, b + BATCH).map((q) => QUERY_PREFIX + q.text))
    tokens += r.tokens
    r.vecs.forEach((v, k) => v.forEach((x, d) => qb.writeFloatLE(x, ((b + k) * DIM + d) * 4)))
  }
  fs.writeFileSync(path.join(out, 'qvectors.f32'), qb)
  const actual = { model: EMBED_MODEL, texts: rows.length, queries: queries.length, billed_tokens_this_run: tokens, est_usd_this_run: +((tokens / 1e6) * PRICE_IN_PER_M).toFixed(4), note: 'a resumed run counts only the chunks it embedded' }
  fs.writeFileSync(path.join(out, 'embed-summary.json'), JSON.stringify(actual, null, 1))
  console.log(JSON.stringify(actual))
}

// ---------------------------------------------------------------- database
function guard(allowOwner) {
  const host = process.env.PGHOST
  if (!host || host !== process.env.N3_BRANCH_HOST || process.env.PGDATABASE !== BENCH_DB || /production/i.test(`${host}${process.env.PGDATABASE}`)) {
    console.error(`refusing: PGHOST must equal N3_BRANCH_HOST and PGDATABASE must be ${BENCH_DB}`)
    process.exit(2)
  }
  return allowOwner
}
async function connect() {
  const c = new pg.Client({ ssl: { rejectUnauthorized: false } }) // host, user, password, database from PG* env
  await c.connect()
  await c.query('SET search_path = ai_prism, public')
  return c
}

function layout(rows, vecs, qvecs) {
  // deterministic: conversations sorted by hash. U_main ~70% of vectors, U_huge: 3 huge sessions + 300 small, the rest spread over 20 users
  const byConv = new Map()
  rows.forEach((r, i) => {
    if (!byConv.has(r.conv)) byConv.set(r.conv, [])
    byConv.get(r.conv).push(i)
  })
  const order = [...byConv.keys()].sort((a, b) => (sha(a) < sha(b) ? -1 : 1))
  const total = rows.length
  const sessions = [] // { user, title, idx: [row indexes] }
  let p = 0
  const huge = [[], [], []]
  let hugeN = 0
  while (hugeN < 4500 && p < order.length) {
    const idx = byConv.get(order[p++])
    huge[(p - 1) % 3].push(...idx)
    hugeN += idx.length
  }
  huge.forEach((idx, k) => sessions.push({ user: 'n3-huge@example.com', title: `huge session ${k + 1}`, idx }))
  for (let i = 0; i < 300 && p < order.length; i++) {
    const idx = byConv.get(order[p++])
    sessions.push({ user: 'n3-huge@example.com', title: rows[idx[0]].text.slice(0, 80), idx })
  }
  // the adversarial user: 3 huge sessions, each holding the 700 corpus messages nearest to one real query
  // (one pt-BR, one en, one es), plus 300 ordinary small sessions. For those queries the nearest 400 messages
  // all sit in ONE session, which is what starves a fixed candidate cut. Rows are copies of corpus rows.
  const norm = (buf, i) => {
    let a = 0
    for (let d = 0; d < DIM; d++) a += buf.readFloatLE((i * DIM + d) * 4) ** 2
    return Math.sqrt(a)
  }
  const rowNorm = new Float64Array(total).map((_, i) => norm(vecs, i))
  TOPICAL_QUERIES.forEach((qi, k) => {
    const sims = new Float64Array(total)
    const qn = norm(qvecs, qi)
    for (let i = 0; i < total; i++) {
      let dot = 0
      for (let d = 0; d < DIM; d++) dot += vecs.readFloatLE((i * DIM + d) * 4) * qvecs.readFloatLE((qi * DIM + d) * 4)
      sims[i] = dot / (rowNorm[i] * qn)
    }
    const idx = Array.from({ length: total }, (_, i) => i).sort((a, b) => sims[b] - sims[a]).slice(0, 700)
    sessions.push({ user: 'n3-topical@example.com', title: `huge topical session ${k + 1}`, idx })
  })
  for (let i = 0; i < 300; i++) {
    const idx = byConv.get(order[order.length - 1 - i])
    sessions.push({ user: 'n3-topical@example.com', title: rows[idx[0]].text.slice(0, 80), idx })
  }
  let mainN = 0
  while (mainN < total * 0.7 && p < order.length) {
    const idx = byConv.get(order[p++])
    sessions.push({ user: 'n3-main@example.com', title: rows[idx[0]].text.slice(0, 80), idx })
    mainN += idx.length
  }
  let u = 0
  while (p < order.length) {
    const idx = byConv.get(order[p++])
    sessions.push({ user: `n3-user${String((u++ % 20) + 1).padStart(2, '0')}@example.com`, title: rows[idx[0]].text.slice(0, 80), idx })
  }
  return sessions
}

const vecLiteral = (buf, i) => {
  const parts = new Array(DIM)
  for (let d = 0; d < DIM; d++) parts[d] = buf.readFloatLE((i * DIM + d) * 4).toFixed(6)
  return `[${parts.join(',')}]`
}

async function cmdLoad() {
  guard(true)
  const out = opt('out')
  const rows = (await readJsonl(path.join(out, 'corpus.jsonl')))
  const vecs = fs.readFileSync(path.join(out, 'vectors.f32'))
  if (vecs.length !== rows.length * DIM * 4) throw new Error('vectors.f32 does not match corpus.jsonl')
  const qvecs = fs.readFileSync(path.join(out, 'qvectors.f32'))
  const sessions = layout(rows, vecs, qvecs)
  const c = await connect()
  await c.query('DROP INDEX IF EXISTS idx_msg_emb_hnsw') // rebuilt once, after the load
  await c.query('TRUNCATE chat_sessions CASCADE') // a re-run starts clean (this is the disposable database)
  let n = 0
  // sessions in bulk; ids come back in insertion order
  for (let i = 0; i < sessions.length; i += 1000) {
    const part = sessions.slice(i, i + 1000)
    const ids = (await c.query(
      `INSERT INTO chat_sessions (user_email, title, model) SELECT u, t, 'bench' FROM unnest($1::text[], $2::text[]) AS x(u, t) RETURNING id`,
      [part.map((s) => s.user), part.map((s) => s.title)]
    )).rows.map((r) => r.id).sort((a, b) => Number(a) - Number(b))
    part.forEach((s, k) => (s.id = ids[k]))
  }
  const flat = []
  for (const s of sessions) for (const k of s.idx) flat.push([s.id, k])
  for (let i = 0; i < flat.length; i += 500) {
    const part = flat.slice(i, i + 500)
    const ids = (await c.query(
      `INSERT INTO chat_messages (session_id, role, content) SELECT sid, r, t FROM unnest($1::bigint[], $2::text[], $3::text[]) AS x(sid, r, t) RETURNING id`,
      [part.map(([sid]) => sid), part.map(([, k]) => rows[k].role), part.map(([, k]) => rows[k].text)]
    )).rows.map((r) => r.id).sort((a, b) => Number(a) - Number(b))
    await c.query(
      `INSERT INTO chat_message_embeddings (message_id, session_id, embedding) SELECT m, sid, v::vector FROM unnest($1::bigint[], $2::bigint[], $3::text[]) AS x(m, sid, v)`,
      [ids, part.map(([sid]) => sid), part.map(([, k]) => vecLiteral(vecs, k))]
    )
    n += part.length
    if ((i / 500) % 20 === 0) console.log(`vectors ${n}/${flat.length}`)
  }
  await c.query(`SET maintenance_work_mem = '1GB'`)
  const t0 = Date.now()
  await c.query(`CREATE INDEX idx_msg_emb_hnsw ON chat_message_embeddings USING hnsw (embedding vector_cosine_ops)`)
  console.log(`hnsw build ${Math.round((Date.now() - t0) / 1000)}s`)
  await c.query('ANALYZE chat_message_embeddings')
  await c.query('ANALYZE chat_sessions')
  const dist = {}
  for (const s of sessions) (dist[s.user.startsWith('n3-user') ? 'n3-userNN (20 users)' : s.user] ||= []).push(s.idx.length)
  const summary = Object.fromEntries(
    Object.entries(dist).map(([u, xs]) => [u, { sessions: xs.length, vectors: xs.reduce((a, b) => a + b, 0), size_p50: pct(xs, 50), size_p95: pct(xs, 95), size_max: Math.max(...xs) }])
  )
  fs.writeFileSync(path.join(out, 'layout.json'), JSON.stringify({ vectors: n, sessions: sessions.length, users: new Set(sessions.map((s) => s.user)).size, per_user: summary }, null, 1))
  console.log(JSON.stringify({ vectors: n, sessions: sessions.length, summary }))
  await c.end()
}

// ---------------------------------------------------------------- run
async function cmdRun() {
  guard(false)
  const out = opt('out')
  const { runSessionVectorSearch, Q5_EXACT_SQL } = await import('../../server/db.js')
  const queries = await readJsonl(path.join(out, 'queries.jsonl'))
  const qb = fs.readFileSync(path.join(out, 'qvectors.f32'))
  const qv = queries.map((_, i) => Array.from({ length: DIM }, (_, d) => qb.readFloatLE((i * DIM + d) * 4)))
  const c = await connect()
  await c.query(`SET ROLE ${BENCH_ROLE}`)
  const who = (await c.query(`SELECT current_user AS role, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`)).rows[0]
  if (who.rolsuper || who.rolbypassrls) throw new Error(`bench role bypasses RLS: ${JSON.stringify(who)}`)
  const version = (await c.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`)).rows[0].extversion
  const pgv = (await c.query('SHOW server_version')).rows[0].server_version

  // one identity transaction, as withTx sets it
  async function tx(user, fn) {
    await c.query('BEGIN')
    try {
      await c.query(`SELECT set_config('app.user_email', $1, true), set_config('app.is_admin', 'off', true), set_config('app.user_groups', '[]', true)`, [user])
      return await fn()
    } finally {
      await c.query('ROLLBACK')
    }
  }
  const execMs = async (sql, params) => {
    const r = await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)
    const p = r.rows[0]['QUERY PLAN'][0]
    return { ms: p['Execution Time'], hnsw: JSON.stringify(p.Plan).includes('idx_msg_emb_hnsw') }
  }
  const users = opt('users', 'n3-main@example.com,n3-huge@example.com,n3-topical@example.com,n3-user01@example.com').split(',')
  const allVariants = [
    { name: 'K400/ef400 (shipped)', opts: {} },
    { name: 'K100/ef100', opts: { candidates: 100 } },
    { name: 'K1000/ef1000', opts: { candidates: 1000 } },
    { name: 'K400, single round (no diversity guard)', opts: { maxRounds: 1 } },
    { name: 'K100, single round (no diversity guard)', opts: { candidates: 100, maxRounds: 1 } },
  ]
  // `--variants core` (small users): shipped, K100 with the guard, K100 without it
  const variants = opt('variants', 'all') === 'core' ? [allVariants[0], allVariants[1], allVariants[4]] : allVariants
  const report = { generated: new Date().toISOString(), identity: who, pgvector: version, postgres: pgv, queries: queries.length, query_langs: queries.reduce((a, q) => ((a[q.lang] = (a[q.lang] || 0) + 1), a), {}), per_user: {} }
  for (const user of users) {
    const vectors = await tx(user, async () => (await c.query(`SELECT count(*)::int AS n FROM chat_message_embeddings`)).rows[0].n)
    const res = { vectors_visible_under_rls: vectors, exact: { ms: [], sessions: [] }, variants: {} }
    // warm-up (not recorded)
    await tx(user, async () => {
      for (let i = 0; i < 5; i++) await runSessionVectorSearch(c, false, user, qv[i])
    })
    const exactRows = []
    for (let i = 0; i < queries.length; i++) {
      await tx(user, async () => {
        const rows = await runSessionVectorSearch(c, false, user, qv[i])
        exactRows.push(rows.map((r) => r.id))
        res.exact.sessions.push(rows.length)
        res.exact.ms.push((await execMs(Q5_EXACT_SQL, [`[${qv[i].join(',')}]`, user, 0.3, 20])).ms)
      })
    }
    for (const v of variants) {
      const acc = { overlap: [], ms: [], rounds: [], hnsw_all_rounds: true, fewer_than_exact: 0 }
      for (let i = 0; i < queries.length * 2; i++) {
        // pass 1 (i < n) warms the cache and is not recorded; pass 2 is measured
        const warm = i < queries.length
        const qi = i % queries.length
        await tx(user, async () => {
          if (warm) return runSessionVectorSearch(c, true, user, qv[qi], v.opts)
          const calls = []
          const spy = { query: (sql, params) => (sql.includes('WITH nn AS') ? (calls.push([sql, params]), c.query(sql, params)) : c.query(sql, params)) }
          const rows = await runSessionVectorSearch(spy, true, user, qv[qi], v.opts)
          const exact = new Set(exactRows[qi])
          const got = new Set(rows.map((r) => r.id))
          acc.overlap.push(exact.size ? [...exact].filter((x) => got.has(x)).length / exact.size : 1)
          if (rows.length < exactRows[qi].length) acc.fewer_than_exact++
          acc.rounds.push(calls.length)
          let ms = 0
          for (const [sql, params] of calls) {
            const m = await execMs(sql, params)
            ms += m.ms
            if (!m.hnsw) acc.hnsw_all_rounds = false
          }
          acc.ms.push(ms)
        })
      }
      res.variants[v.name] = {
        top20_overlap: { mean: +mean(acc.overlap).toFixed(4), p5: +pct(acc.overlap, 5).toFixed(4), min: +Math.min(...acc.overlap).toFixed(4), queries_below_1: acc.overlap.filter((x) => x < 1).length },
        exec_ms: { p50: +pct(acc.ms, 50).toFixed(1), p95: +pct(acc.ms, 95).toFixed(1) },
        rounds: { mean: +mean(acc.rounds).toFixed(2), max: Math.max(...acc.rounds) },
        queries_with_fewer_sessions_than_exact: acc.fewer_than_exact,
        hnsw_in_every_round_plan: acc.hnsw_all_rounds,
      }
    }
    res.exact = { exec_ms: { p50: +pct(res.exact.ms, 50).toFixed(1), p95: +pct(res.exact.ms, 95).toFixed(1) }, sessions_returned_mean: +mean(res.exact.sessions).toFixed(1), sessions_returned_min: Math.min(...res.exact.sessions) }
    report.per_user[user] = res
    console.log(user, JSON.stringify({ exact: res.exact.exec_ms, shipped: res.variants[variants[0].name] }))
  }
  fs.writeFileSync(opt('report'), JSON.stringify(report, null, 1))
  await c.query('RESET ROLE')
  await c.end()
}

const cmd = process.argv[2]
if (cmd === 'embed') await cmdEmbed()
else if (cmd === 'load') await cmdLoad()
else if (cmd === 'run') await cmdRun()
else {
  console.error('usage: q5-ann.mjs embed|load|run (see the header)')
  process.exit(1)
}
