// HNSW recall/latency bench of docs/performance.md §4.7. Source of truth for that query set.
//   PGHOST=... PGDATABASE=... PGUSER=... PGPASSWORD=... BENCH_DB_HOST=<same as PGHOST> \
//     node scripts/bench/hnsw-bench.mjs <label> [queries=50] [seed=4213] > out.json
// Run ONLY against a disposable test database built by scripts/bench/seed.sql: it refuses
// unless BENCH_DB_HOST names the host on purpose. BENCH_ROLE (default w213_bench) is the
// RLS-bound role of §2.1 (NOSUPERUSER NOBYPASSRLS, the app's grants, granted to you).
// Ground truth is INDEPENDENT of the database's distance code: every raw vector is
// fetched once (vector_send, binary float4) and the exact top-k is computed here in JS
// by cosine similarity. The SQL exact scan (index scans off) is reported only as a
// cross-check of that truth. Query set is deterministic: mulberry32(seed) picks the
// sessions and the perturbation. App-shaped queries (Q4, filtered top-k) run as the
// RLS-bound bench role with the caller's three settings; the whole-table top-k is an
// index characterization and runs as the connecting identity (recorded in `identity`).
import pg from 'pg'
if (!process.env.BENCH_DB_HOST || process.env.PGHOST !== process.env.BENCH_DB_HOST) {
  console.error('refusing: set BENCH_DB_HOST to the disposable test database host (same as PGHOST)'); process.exit(2)
}
const LABEL = process.argv[2] || 'run'
const NQ = Number(process.argv[3] || 50)
const SEED = Number(process.argv[4] || 4213)
const USER = 'carga-teste@example.com'
const ROLE = process.env.BENCH_ROLE || 'w213_bench'
const K = 10

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const rnd = mulberry32(SEED)
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] }
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length

const c = new pg.Client({ ssl: { rejectUnauthorized: false } })
await c.connect()
await c.query(`SET search_path = ai_prism, public`)
const asRole = async () => { await c.query(`SET ROLE ${ROLE}`); await c.query(`SELECT set_config('app.user_email',$1,false), set_config('app.is_admin','off',false), set_config('app.user_groups','["w213-analysts"]',false)`, [USER]) }
const asConnecting = async () => { await c.query(`RESET ROLE`); await c.query(`RESET app.user_email`); await c.query(`RESET app.user_groups`) }
const roleRow = async () => (await c.query(`SELECT current_user AS role, session_user, r.rolsuper, r.rolbypassrls, current_setting('app.user_email', true) AS user_email, current_setting('app.user_groups', true) AS user_groups FROM pg_roles r WHERE r.rolname = current_user`)).rows[0]

// ---- 1. raw vectors, once, as the connecting identity (sees every row) ----
await asConnecting()
const identity = { connecting: await roleRow() }
const sessRows = (await c.query(`SELECT id::int AS id, user_email, project_id IS NOT NULL AS in_project FROM chat_sessions`)).rows
const sessInfo = new Map(sessRows.map((r) => [r.id, r]))
const DIM = 1024
let n = 0
const total = (await c.query(`SELECT count(*)::int AS n FROM chat_message_embeddings`)).rows[0].n
const ids = new Float64Array(total), sids = new Int32Array(total), vecs = new Float32Array(total * DIM), norms = new Float32Array(total)
let last = 0
for (;;) {
  const r = await c.query(`SELECT message_id::bigint AS id, session_id::int AS sid, vector_send(embedding) AS b FROM chat_message_embeddings WHERE message_id > $1 ORDER BY message_id LIMIT 5000`, [last])
  if (!r.rows.length) break
  for (const row of r.rows) {
    const b = row.b; const dim = b.readInt16BE(0)
    if (dim !== DIM) throw new Error(`dim ${dim}`)
    let nn = 0
    for (let i = 0; i < DIM; i++) { const x = b.readFloatBE(4 + 4 * i); vecs[n * DIM + i] = x; nn += x * x }
    norms[n] = Math.sqrt(nn); ids[n] = Number(row.id); sids[n] = row.sid; n++
    last = row.id
  }
}
if (n !== total) throw new Error(`fetched ${n} of ${total}`)
const cosAt = (q, qn, j) => { let d = 0; const o = j * DIM; for (let i = 0; i < DIM; i++) d += q[i] * vecs[o + i]; return d / (qn * norms[j]) }
function exactTopK(q, accept, k = K) {
  let qn = 0; for (const x of q) qn += x * x; qn = Math.sqrt(qn)
  const best = [] // [sim, id]
  for (let j = 0; j < n; j++) {
    if (!accept(j)) continue
    const s = cosAt(q, qn, j)
    if (best.length < k) { best.push([s, ids[j]]); best.sort((a, b) => a[0] - b[0]) } else if (s > best[0][0]) { best[0] = [s, ids[j]]; best.sort((a, b) => a[0] - b[0]) }
  }
  return best.sort((a, b) => b[0] - a[0]).map((x) => String(x[1]))
}
// what the measured user may read: own personal sessions + the group-shared project
const visible = (j) => { const s = sessInfo.get(sids[j]); return s && (s.user_email === USER || s.in_project) }

// ---- 2. deterministic query set ----
const own = sessRows.filter((s) => s.user_email === USER && !s.in_project).map((s) => s.id).sort((a, b) => a - b)
const shared = sessRows.filter((s) => s.in_project).map((s) => s.id).sort((a, b) => a - b)
const pick = (arr, m) => { const a = [...arr]; const out = []; while (out.length < m && a.length) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]); return out }
const rowsOf = new Map(); for (let j = 0; j < n; j++) { if (!rowsOf.has(sids[j])) rowsOf.set(sids[j], []); rowsOf.get(sids[j]).push(j) }
function queryFor(sid) {
  const rows = rowsOf.get(sid).sort((a, b) => ids[a] - ids[b])
  const base = rows[Math.floor(rows.length / 3)]
  const q = new Float64Array(DIM); for (let i = 0; i < DIM; i++) q[i] = vecs[base * DIM + i] + (rnd() - 0.5) * 0.3
  return { sid, q, lit: `[${Array.from(q).join(',')}]`, rows }
}
const qsOwn = pick(own, NQ).map(queryFor)
const qsShared = pick(shared, Math.min(20, shared.length)).map(queryFor)

async function explainRun(sql, params) {
  const t0 = performance.now(); const r = await c.query(sql, params); const wall = performance.now() - t0
  const p = (await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0]
  return { ids: r.rows.map((x) => String(x.id)), wall, exec: p['Execution Time'], hnsw: /idx_msg_emb_hnsw/.test(JSON.stringify(p.Plan)) }
}
const recallOf = (truth, got) => { const g = new Set(got); return truth.length ? truth.filter((x) => g.has(x)).length / truth.length : 1 }

// ---- 3. Q4 as the app runs it (bench role, RLS, groups) vs JS truth ----
const Q4 = `WITH scoped AS (
  SELECT m.id, m.role, m.content, m.created_at, 1 - (e.embedding <=> $2::vector) AS similarity,
         ROW_NUMBER() OVER (ORDER BY m.id DESC) AS recency_rank
    FROM chat_message_embeddings e
    JOIN chat_messages m ON m.id = e.message_id
    JOIN chat_sessions s ON s.id = m.session_id
     AND ((s.project_id IS NULL AND s.user_email = $3) OR (s.project_id IS NOT NULL AND ai_prism.aip_project_rank(s.project_id) IS NOT NULL))
   WHERE e.session_id = $1 AND m.active = true)
SELECT id, role, content, similarity FROM scoped WHERE recency_rank > 6 AND similarity >= 0.35 ORDER BY similarity DESC LIMIT 6`
await asRole()
identity.bench = await roleRow()
if (identity.bench.rolsuper || identity.bench.rolbypassrls) throw new Error('bench role bypasses RLS')
const q4 = {}
for (const [name, qs] of [['own', qsOwn], ['group_shared', qsShared]]) {
  const acc = { recall: [], exec: [], wall: [], hnsw: 0, truthSize: [], emptyResults: 0 }
  for (const { sid, q, lit, rows } of qs) {
    let qn = 0; for (const x of q) qn += x * x; qn = Math.sqrt(qn)
    const recent = new Set(rows.slice(-6).map((j) => ids[j]))
    const truth = rows.filter((j) => !recent.has(ids[j])).map((j) => [cosAt(q, qn, j), String(ids[j])]).filter((x) => x[0] >= 0.35).sort((a, b) => b[0] - a[0]).slice(0, 6).map((x) => x[1])
    const t = await explainRun(Q4, [sid, lit, USER])
    acc.recall.push(recallOf(truth, t.ids)); acc.exec.push(t.exec); acc.wall.push(t.wall); acc.hnsw += t.hnsw ? 1 : 0; acc.truthSize.push(truth.length); acc.emptyResults += t.ids.length ? 0 : 1
  }
  q4[name] = acc
}

// ---- 4. direct HNSW top-10 vs JS truth ----
const GLOBAL = `SELECT message_id::text AS id FROM chat_message_embeddings ORDER BY embedding <=> $1::vector LIMIT ${K}`
const FILTERED = `SELECT e.message_id::text AS id FROM chat_message_embeddings e ORDER BY e.embedding <=> $1::vector LIMIT ${K}` // RLS restricts rows to what the user can read
const direct = {}
for (const [name, sql, role, accept] of [['global_no_rls', GLOBAL, 'connecting', () => true], ['user_visible_rls', FILTERED, 'bench', visible]]) {
  if (role === 'bench') await asRole(); else await asConnecting()
  const truths = qsOwn.map(({ q }) => exactTopK(q, accept))
  // SQL exact scan, cross-check only
  await c.query('SET enable_indexscan = off')
  const sqlExact = []; for (const { lit } of qsOwn) sqlExact.push(await explainRun(sql, [lit]))
  await c.query('RESET enable_indexscan')
  const agree = sqlExact.map((s, i) => recallOf(truths[i], s.ids))
  direct[name] = { identity: role, sql_exact_vs_js_truth_mean: +mean(agree).toFixed(4), sql_exact_exec_p50: +pct(sqlExact.map((s) => s.exec), 50).toFixed(2), sql_exact_exec_p95: +pct(sqlExact.map((s) => s.exec), 95).toFixed(2), configs: {} }
  const cfgs = role === 'bench' ? [[40, 'off'], [100, 'off'], [40, 'relaxed_order'], [400, 'relaxed_order']] : [[40, 'off'], [100, 'off'], [200, 'off'], [400, 'off']]
  for (const [ef, iter] of cfgs) {
    await c.query(`SET hnsw.ef_search = ${ef}`); await c.query(`SET hnsw.iterative_scan = ${iter}`)
    const rec = [], ex = []; let used = 0, short = 0
    for (let i = 0; i < qsOwn.length; i++) { const t = await explainRun(sql, [qsOwn[i].lit]); rec.push(recallOf(truths[i], t.ids)); ex.push(t.exec); used += t.hnsw ? 1 : 0; short += t.ids.length < K ? 1 : 0 }
    await c.query('RESET hnsw.ef_search'); await c.query('RESET hnsw.iterative_scan')
    direct[name].configs[`ef${ef}_${iter}`] = { recall_mean: +mean(rec).toFixed(4), recall_min: +Math.min(...rec).toFixed(2), zero_recall: rec.filter((r) => r === 0).length, below_0_9: rec.filter((r) => r < 0.9).length, exec_p50: +pct(ex, 50).toFixed(2), exec_p95: +pct(ex, 95).toFixed(2), uses_hnsw: used, short_results: short }
  }
}
await c.end()
const sumQ4 = (a) => ({ queries: a.recall.length, recall_mean: +mean(a.recall).toFixed(4), recall_min: +Math.min(...a.recall).toFixed(3), exec_p50: +pct(a.exec, 50).toFixed(2), exec_p95: +pct(a.exec, 95).toFixed(2), wall_p50: +pct(a.wall, 50).toFixed(1), uses_hnsw: a.hnsw, truth_size_mean: +mean(a.truthSize).toFixed(2), empty_results: a.emptyResults })
console.log(JSON.stringify({ label: LABEL, seed: SEED, k: K, volume: { embeddings: n, sessions: sessRows.length, own_sessions: own.length, group_shared_sessions: shared.length }, identity, q4: { own: sumQ4(q4.own), group_shared: sumQ4(q4.group_shared) }, direct }, null, 2))
