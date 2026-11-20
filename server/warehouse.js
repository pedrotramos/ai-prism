// Thin client for the Databricks SQL Statement Execution API, used to run
// Unity Catalog Functions on-behalf-of the signed-in user (same auth pattern
// as the AI Gateway and Lakebase: the user's own OAuth token, so every
// function call is scoped by their real Unity Catalog grants).
import { queryTagsFor } from './resourceTags.ts'

function host() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

export function warehouseId() {
  const id = process.env.SQL_WAREHOUSE_ID
  if (!id) throw new Error('SQL_WAREHOUSE_ID não configurado (necessário para executar tools).')
  return id
}

async function apiFetch(path, opts, token) {
  const res = await fetch(`${host()}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts?.headers || {}),
    },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.message || json?.error || `HTTP ${res.status}`
    throw new Error(`SQL Statement API: ${msg}`)
  }
  return json
}

// Statement execution is async server-side even with wait_timeout — poll until
// the statement leaves PENDING/RUNNING. Most tool calls finish well within the
// synchronous wait window (warehouse already warm), so polling rarely fires.
async function pollUntilDone(token, statementId, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const json = await apiFetch(`/api/2.0/sql/statements/${statementId}`, { method: 'GET' }, token)
    const state = json.status?.state
    if (state !== 'PENDING' && state !== 'RUNNING') return json
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('Tempo esgotado aguardando o SQL Warehouse.')
}

/**
 * Executes a SQL statement (optionally parameterized) against the configured
 * warehouse and returns { columns, rows } — rows as plain JS arrays matching
 * `columns` order. Throws on any non-SUCCEEDED terminal state.
 */
export async function execStatement(token, statement, parameters = [], opts = {}) {
  const body = {
    warehouse_id: opts.warehouseId || warehouseId(),
    statement,
    wait_timeout: '30s',
    // atribui o custo do statement ao app e às tags do operador (system.query.history)
    query_tags: queryTagsFor(),
    ...(parameters.length ? { parameters } : {}),
  }
  let json = await apiFetch('/api/2.0/sql/statements', { method: 'POST', body: JSON.stringify(body) }, token)

  if (json.status?.state === 'PENDING' || json.status?.state === 'RUNNING') {
    json = await pollUntilDone(token, json.statement_id, Date.now() + (opts.timeoutMs || 30000))
  }

  if (json.status?.state !== 'SUCCEEDED') {
    const msg = json.status?.error?.message || json.status?.state || 'falhou'
    throw new Error(msg)
  }

  const columns = (json.manifest?.schema?.columns || []).map((c) => c.name)
  const rows = json.result?.data_array || []
  return { columns, rows }
}
