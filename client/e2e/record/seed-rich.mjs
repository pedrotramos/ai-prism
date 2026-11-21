// Seeds a LOCAL Postgres (PG* env, default 127.0.0.1:55432/ai_prism) with the rich e2e threads.
// Adapted from the UX baseline harness (2026-11-17). Prints the session ids as JSON.
// Run `npm run local:seed` first (it needs the server up); never point it at a shared database.
import pg from 'pg'
import { readFileSync } from 'node:fs'
import { sanitizeSpreadsheet } from '../../../server/blocks.ts'
const W = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '')
const email = process.env.DATABRICKS_USER_EMAIL || 'e2e-user@example.com'
const c = new pg.Client({ host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 55432), database: process.env.PGDATABASE || 'ai_prism', user: process.env.PGUSER || 'ai_prism', password: process.env.PGPASSWORD || 'ai_prism' })
await c.connect()
const q = (s, p) => c.query(s, p)
await q('BEGIN')
await q(`DELETE FROM chat_sessions WHERE user_email=$1 AND title <> 'Ambiente local de demonstração'`, [email])
const MODEL = 'databricks-claude-sonnet-5-5'
async function session(title, ageHours) {
  const { rows: [s] } = await q(`INSERT INTO chat_sessions (user_email,title,model,created_at,updated_at) VALUES ($1,$2,$3, now()-($4||' hours')::interval, now()-($4||' hours')::interval) RETURNING id`, [email, title, MODEL, String(ageHours)])
  return s.id
}
async function msg(sid, role, content, extra = {}) {
  const { rows: [m] } = await q(`INSERT INTO chat_messages (session_id,role,content,model,blocks,reasoning,prompt_tokens,completion_tokens,attachments) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) RETURNING id`,
    [sid, role, content, role === 'assistant' ? MODEL : null, extra.blocks ? JSON.stringify(extra.blocks) : null, extra.reasoning || null, extra.pt || null, extra.ct || null, extra.attachments || null])
  return m.id
}
// 1) Rich analytics thread
const s1 = await session('Q3 revenue by region — analysis', 0.2)
await msg(s1, 'user', 'Compare Q3 revenue by region against Q2 and flag anything unusual. Then build a short deck and a spreadsheet for the exec review.', { attachments: JSON.stringify(['q3_targets.pdf', 'regional_pipeline.xlsx']) })
const content1 = `I'll pull the numbers from the governed sales tables first.

{{toolcall:call_genie_1}}

{{toolcall:call_uc_2}}

Q3 revenue grew **8.4% QoQ** overall, driven by LATAM and EMEA. North America was flat and APAC declined.

{{block:0}}

{{block:1}}

{{block:2}}

### What stands out
1. **APAC −6.1% QoQ** — concentrated in two enterprise accounts that delayed renewals.
2. **LATAM +21%** — the largest absolute gain; new logos in Brazil and Mexico.
3. North America is flat, but pipeline coverage for Q4 is 3.2×, so this looks like timing, not demand.

\`\`\`sql
SELECT region, quarter, SUM(revenue_usd) AS revenue
FROM main.sales.fct_revenue
WHERE fiscal_year = 2026 AND quarter IN ('Q2','Q3')
GROUP BY ALL
ORDER BY region, quarter;
\`\`\`

I also prepared the exec-review artifacts:

{{block:3}}

{{block:4}}

{{block:5}}`
const series = [
  { name: 'Q2', data: [{ label: 'North America', value: 41.2 }, { label: 'EMEA', value: 27.9 }, { label: 'LATAM', value: 12.4 }, { label: 'APAC', value: 18.1 }] },
  { name: 'Q3', data: [{ label: 'North America', value: 41.5 }, { label: 'EMEA', value: 30.6 }, { label: 'LATAM', value: 15.0 }, { label: 'APAC', value: 17.0 }] },
]
const slides = [
  `<section style="width:1280px;height:720px;background:#0B2026;color:#fff;font-family:Inter,system-ui;padding:96px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:flex-end"><div style="font-size:22px;color:#FF3621;font-weight:600;letter-spacing:.08em">EXEC REVIEW · Q3 FY26</div><h1 style="font-size:76px;margin:16px 0 0;line-height:1.05">Revenue grew 8.4% QoQ, led by LATAM and EMEA</h1></section>`,
  `<section style="width:1280px;height:720px;background:#F7F5F2;color:#0B2026;font-family:Inter,system-ui;padding:80px;box-sizing:border-box"><h2 style="font-size:44px;margin:0 0 40px">Where the growth came from</h2><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:24px">${[['North America','$41.5M','+0.7%'],['EMEA','$30.6M','+9.7%'],['LATAM','$15.0M','+21.0%'],['APAC','$17.0M','−6.1%']].map(([r,v,d])=>`<div style="background:#fff;border-radius:16px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08)"><div style="font-size:20px;color:#5A6B70">${r}</div><div style="font-size:48px;font-weight:700;margin-top:12px">${v}</div><div style="font-size:22px;margin-top:8px;color:${d.startsWith('−')?'#C4291C':'#1B7F4B'}">${d} QoQ</div></div>`).join('')}</div></section>`,
  `<section style="width:1280px;height:720px;background:#F7F5F2;color:#0B2026;font-family:Inter,system-ui;padding:80px;box-sizing:border-box"><h2 style="font-size:44px;margin:0 0 32px">Risks and next steps</h2><ul style="font-size:30px;line-height:1.6;margin:0;padding-left:32px"><li>APAC: recover two delayed enterprise renewals</li><li>NA: convert 3.2× Q4 pipeline coverage</li><li>LATAM: staff onboarding for new logos</li></ul></section>`,
]
const { rows: [deck] } = await q(`INSERT INTO chat_decks (session_id,user_email,title,slides,meta) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING id`, [s1, email, 'Q3 FY26 Exec Review', JSON.stringify(slides), JSON.stringify({ format: 'html' })])
const ssRaw = JSON.parse(readFileSync(W + '/scripts/fixtures/spreadsheet-financial.golden.json', 'utf8'))
const ss = sanitizeSpreadsheet(ssRaw)
const { rows: [sheet] } = await q(`INSERT INTO chat_spreadsheets (session_id,user_email,title,spec) VALUES ($1,$2,$3,$4::jsonb) RETURNING id`, [s1, email, ss.title, JSON.stringify(ss)])
const docMd = `# Q3 FY26 revenue memo\n\n## Summary\nRevenue grew **8.4% QoQ** to $104.1M.\n\n## By region\n| Region | Q2 | Q3 | QoQ |\n|---|---|---|---|\n| North America | 41.2 | 41.5 | +0.7% |\n| EMEA | 27.9 | 30.6 | +9.7% |\n| LATAM | 12.4 | 15.0 | +21.0% |\n| APAC | 18.1 | 17.0 | −6.1% |\n\n## Recommendations\n- Escalate APAC renewals to the regional VP.\n- Keep NA forecast unchanged.\n`
const { rows: [doc] } = await q(`INSERT INTO chat_documents (session_id,user_email,title,markdown) VALUES ($1,$2,$3,$4) RETURNING id`, [s1, email, 'Q3 FY26 revenue memo', docMd])
const blocks1 = [
  { type: 'chart', chartType: 'bar', title: 'Revenue by region, $M (Q2 vs Q3)', series, caption: 'Source: main.sales.fct_revenue' },
  { type: 'table', title: 'QoQ change by region', columns: ['Region', 'Q2 ($M)', 'Q3 ($M)', 'QoQ'], rows: [['North America', '41.2', '41.5', '+0.7%'], ['EMEA', '27.9', '30.6', '+9.7%'], ['LATAM', '12.4', '15.0', '+21.0%'], ['APAC', '18.1', '17.0', '−6.1%']] },
  { type: 'insight', kind: 'anomaly', title: 'APAC declined 6.1% QoQ', body: 'Two enterprise renewals (combined $1.4M) slipped from September to October.' },
  { type: 'deck-html', title: 'Q3 FY26 Exec Review', slides, deckId: String(deck.id) },
  { type: 'spreadsheet', ...ss, spreadsheetId: String(sheet.id) },
  { type: 'document', title: 'Q3 FY26 revenue memo', markdown: docMd, documentId: String(doc.id) },
]
const a1 = await msg(s1, 'assistant', content1, { blocks: blocks1, pt: 18234, ct: 2311, reasoning: 'The user wants a QoQ comparison. I should query the governed revenue table via Genie, then verify the region dimension in Unity Catalog before charting.' })
await q(`INSERT INTO chat_tool_calls (message_id,seq,tool_name,tool_label,arguments,result,status,duration_ms,call_id) VALUES
 ($1,0,'genie_one','Genie One','{"question":"Q3 vs Q2 revenue by region FY26"}','| region | Q2 | Q3 |\n|---|---|---|\n| North America | 41.2 | 41.5 |','ok',4210,'call_genie_1'),
 ($1,1,'uc_describe_table','Unity Catalog','{"table":"main.sales.fct_revenue"}','{"columns":["region","quarter","revenue_usd"]}','ok',612,'call_uc_2')`, [a1])
await q(`INSERT INTO usage_ledger (user_email,session_id,message_id,kind,model,prompt_tokens,completion_tokens,cost_usd) VALUES ($1,$2,$3,'chat',$4,18234,2311,0.0893)`, [email, s1, a1, MODEL])
// follow-up with deck questions (latest = interactive)
await msg(s1, 'user', 'Make a longer version of the deck for the board.')
await msg(s1, 'assistant', 'Before I build the board version, a few quick choices:\n\n{{block:0}}', { blocks: [{ type: 'deck-questions', intro: 'Answer what you can; I will assume sensible defaults for the rest.', questions: [
  { id: 'aud', label: 'Who is the audience?', type: 'single', options: ['Board of directors', 'Executive team', 'Regional leads'] },
  { id: 'len', label: 'How many slides?', type: 'single', options: ['5–7', '8–12', '13+'] },
  { id: 'inc', label: 'What should it include?', type: 'multi', options: ['Regional breakdown', 'Pipeline / forecast', 'Risks', 'Appendix with raw data'] },
  { id: 'note', label: 'Anything else to emphasize?', type: 'text' } ] }] })
// 2) Code-heavy thread
const s2 = await session('Fix flaky pytest in ingestion job', 3)
await msg(s2, 'user', 'My pytest for the ingestion job is flaky. It fails ~1 in 10 runs with a timeout. Here is the test.')
await msg(s2, 'assistant', "The flakiness comes from the test waiting on a real clock. Freeze time and await the queue instead:\n\n```python\nimport pytest\nfrom freezegun import freeze_time\n\n@freeze_time('2026-01-01')\ndef test_ingest_batches(queue):\n    job = IngestJob(queue, batch_size=100)\n    job.run_once()\n    assert queue.drained()\n```\n\n| Cause | Fix |\n|---|---|\n| real `time.sleep` | `freeze_time` |\n| shared queue between tests | function-scoped fixture |\n", { pt: 3120, ct: 410 })
// 3) error thread: unanswered user message
const s3 = await session('Draft customer onboarding email', 26)
await msg(s3, 'user', 'Draft a friendly onboarding email for new workspace users.')
// more history rows
const titles = [['Summarize Lakebase migration notes', 30], ['Vector search index sizing', 50], ['SLA dashboard requirements', 75], ['Translate release notes to Spanish', 100], ['Unity Catalog permissions model', 160], ['Churn model feature ideas', 200], ['Board meeting prep', 400], ['Forecast accuracy review', 800], ['Hiring plan Q1', 1200]]
for (const [t, h] of titles) { const sid = await session(t, h); await msg(sid, 'user', t + '?'); await msg(sid, 'assistant', 'Here is a short summary for **' + t + '**.') }
await q('COMMIT')
console.log(JSON.stringify({ s1, s2, s3, deck: deck.id, sheet: sheet.id, doc: doc.id }))
await c.end()
