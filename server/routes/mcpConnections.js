import * as db from '../db.js'
import { embed, cosineSim } from '../llm.js'
import {
  searchExternalMcpConnections,
  probeMcpConnection,
  getHiddenMcpNames,
  admitMcpConnection,
  mcpAdmissionError,
  externalMcpUrl,
  isValidMcpConnectionName,
} from '../externalMcp.ts'
import { listMcpServerCached } from '../mcpClient.ts'
import { auth as realAuth } from '../middleware/auth.js'
import { ensureReady as realEnsureReady } from '../middleware/ensureReady.js'

// Ranks MCP connections against a natural-language query by embedding cosine
// similarity of "name — description". Connection embeddings are cached per
// process (the catalog changes rarely); only the query is embedded per call.
// On any embedding failure, degrades to substring filtering so search still
// works. Keeps items above a light relevance floor, best-first.
const mcpEmbedCache = new Map() // key `${name}\n${comment}` -> vector
async function rankMcpConnections(token, query, connections) {
  const substringFallback = () => {
    const ql = query.toLowerCase()
    return connections.filter(
      (c) => c.connectionName.toLowerCase().includes(ql) || (c.comment || '').toLowerCase().includes(ql)
    )
  }
  try {
    const passages = connections.map((c) => `${c.connectionName} — ${c.comment || 'sem descrição'}`)
    const missing = passages.filter((p) => !mcpEmbedCache.has(p))
    if (missing.length) {
      const vecs = await embed(token, missing)
      missing.forEach((p, i) => vecs[i] && mcpEmbedCache.set(p, vecs[i]))
    }
    // qwen3-embedding is instruction-tuned: queries take an Instruct/Query prefix
    const [qvec] = await embed(token, [
      `Instruct: Dada a intenção do usuário, recupere conexões MCP (ferramentas) relevantes.\nQuery: ${query}`,
    ])
    if (!qvec) return substringFallback()
    const scored = connections
      .map((c, i) => ({ c, score: cosineSim(qvec, mcpEmbedCache.get(passages[i])) }))
      .sort((a, b) => b.score - a.score)
    // Relative floor: keep items within a band of the top score, so a clearly
    // irrelevant tail drops off but near-ties survive. This adapts to the
    // embedding model's baseline similarity (qwen runs high) better than a
    // fixed threshold. Union in any substring match so a literal query never
    // loses an obvious hit to ranking.
    const top = scored[0]?.score || 0
    const ql = query.toLowerCase()
    const kept = scored.filter(
      (x) =>
        x.score >= top - 0.08 ||
        x.c.connectionName.toLowerCase().includes(ql) ||
        (x.c.comment || '').toLowerCase().includes(ql)
    )
    const out = (kept.length ? kept : scored).map((x) => x.c)
    return out.length ? out : substringFallback()
  } catch {
    return substringFallback()
  }
}

// `:name` is one connection name, already percent-decoded once by Express.
// Anything that would change the gateway URL's shape (`/`, `?`, `#`, a
// leftover `%`, dot segments...) is refused before auth with a 400; see
// isValidMcpConnectionName. Accepted names have no `%`, so no second decode.
function validConnectionName(req, res, next) {
  if (!isValidMcpConnectionName(req.params.name)) return res.status(400).json({ error: 'invalid_connection_name' })
  next()
}

// `deps` overrides the collaborators in tests (identity, DB, probe, admission);
// production passes nothing.
export default function registerMcpConnectionRoutes(app, deps = {}) {
  const {
    auth = realAuth,
    ensureReady = realEnsureReady,
    listUserMcpConnections = db.listUserMcpConnections,
    adoptUserMcpConnection = db.adoptUserMcpConnection,
    setUserMcpStatus = db.setUserMcpStatus,
    forgetUserMcpConnection = db.forgetUserMcpConnection,
    searchExternalMcpConnections: search = searchExternalMcpConnections,
    probeMcpConnection: probe = probeMcpConnection,
    getHiddenMcpNames: hiddenNames = getHiddenMcpNames,
    admitMcpConnection: admit = admitMcpConnection,
  } = deps
  // ---- external MCP connections (per-user adopt + auth status) -----------
  // The settings tab where the user browses the catalog, connects (one-time
  // OAuth consent via the managed proxy), and sees status. The tool picker then
  // shows adopted connections as on/off toggles (default on).
  app.get('/api/mcp/connections', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const q = (req.query.q || '').toString().trim()
      const [catalog, adopted] = await Promise.all([
        // pass the query so a typed fully-qualified name surfaces as a
        // "connect by name" candidate (validated OBO at connect time)
        search(req.token, req.email, q),
        listUserMcpConnections(req.email, req.token),
      ])
      const adoptedByName = new Map(adopted.map((a) => [a.connectionName, a]))
      // union: everything in the catalog, annotated with adoption + last status
      let connections = catalog.map((c) => {
        const a = adoptedByName.get(c.connectionName)
        return {
          connectionName: c.connectionName,
          displayName: c.displayName || '',
          comment: c.comment || a?.comment || '',
          ...(c.refused ? { refused: c.refused } : {}),
          adopted: !!a,
          status: a?.status || 'unknown',
          lastCheckedAt: a?.lastCheckedAt || null,
        }
      })
      // semantic search over name + description (item 3). Only when a query is
      // present; ranks by embedding cosine similarity, so "ferramentas de
      // git/código" surfaces "ah-github" even without a literal match. Falls back
      // to substring filtering if embeddings are unavailable.
      if (q) connections = await rankMcpConnections(req.token, q, connections)
      res.json({ connections })
      // fire-and-forget: warm the per-turn tool-listing cache for what this user
      // adopted (the picker/settings load this list just before chatting), so the
      // next turn doesn't pay a slow gateway listing on its TTFT. Warming opens
      // an MCP session (initialize + tools/list), so it runs only for a row that
      // isn't refused or saved as forbidden AND passes admission now (cached);
      // a refused shared-credential service is never contacted from here.
      for (const c of connections) {
        if (!c.adopted || c.refused || c.status === 'forbidden') continue
        admit(req.token, req.email, c.connectionName)
          .then((a) => (a.ok ? listMcpServerCached(externalMcpUrl(c.connectionName), req.token, req.email) : null))
          .catch(() => {})
      }
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Probe a connection's auth state now (on demand — used by the "Conectar" /
  // "Verificar" button). Persists the probed status if the connection is adopted.
  app.post('/api/mcp/connections/:name/probe', validConnectionName, auth, async (req, res) => {
    try {
      await ensureReady(req)
      const name = req.params.name
      // a saved connection is re-checked too: a service whose credential is
      // (now) shared or can't be verified is refused and marked, never probed
      const admission = await admit(req.token, req.email, name)
      if (!admission.ok) {
        try {
          await setUserMcpStatus(req.email, req.token, name, 'forbidden')
        } catch {}
        return res.status(403).json({ status: 'forbidden', ...mcpAdmissionError(admission.code) })
      }
      const result = await probe(req.token, name, { cacheKey: req.email })
      // remember the status for adopted connections (best-effort)
      try {
        await setUserMcpStatus(req.email, req.token, name, result.status)
      } catch {}
      res.json(result)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Adopt a connection (the user chose to use it). Probes status at adopt time so
  // the row lands with a real state; default-on in the tool picker follows from
  // being adopted.
  app.post('/api/mcp/connections/:name', validConnectionName, auth, async (req, res) => {
    try {
      await ensureReady(req)
      const name = req.params.name
      // an admin hid this service from the org catalog — not connectable by name either
      if ((await hiddenNames(req.email, req.token)).has(name)) {
        return res.status(403).json({ error: 'mcp_hidden_by_admin' })
      }
      // catalog entry or typed by name: the service must use a credential
      // scoped to the caller; shared / unverifiable → refused (fail closed)
      const admission = await admit(req.token, req.email, name)
      if (!admission.ok) return res.status(403).json(mcpAdmissionError(admission.code))
      const comment = typeof req.body?.comment === 'string' ? req.body.comment : ''
      const probed = await probe(req.token, name, { cacheKey: req.email }).catch(() => ({ status: 'unknown' }))
      await adoptUserMcpConnection(req.email, req.token, name, comment, probed.status)
      res.json({ ok: true, status: probed.status, loginUrl: probed.loginUrl || '' })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.delete('/api/mcp/connections/:name', validConnectionName, auth, async (req, res) => {
    try {
      await ensureReady(req)
      await forgetUserMcpConnection(req.email, req.token, req.params.name)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
}
