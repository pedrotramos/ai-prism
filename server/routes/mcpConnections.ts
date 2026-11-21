import { authed } from './authed.ts'
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express'
import * as db from '../db.ts'
import { embed, cosineSim } from '../llm.ts'
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
import { auth as realAuth } from '../middleware/auth.ts'
import { ensureReady as realEnsureReady } from '../middleware/ensureReady.ts'

// Ranks MCP connections against a natural-language query by embedding cosine
// similarity of "name — description". Connection embeddings are cached per
// process (the catalog changes rarely); only the query is embedded per call.
// On any embedding failure, degrades to substring filtering so search still
// works. Keeps items above a light relevance floor, best-first.
interface RankedConnection {
  connectionName: string
  comment?: string
}

const mcpEmbedCache = new Map() // key `${name}\n${comment}` -> vector
async function rankMcpConnections<T extends RankedConnection>(token: string, query: string, connections: T[]): Promise<T[]> {
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
      missing.forEach((p: string, i: number) => vecs[i] && mcpEmbedCache.set(p, vecs[i]))
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
function validConnectionName(req: Request, res: Response, next: NextFunction) {
  if (!isValidMcpConnectionName((req.params.name as string))) return res.status(400).json({ error: 'invalid_connection_name' })
  next()
}

// `deps` overrides the collaborators in tests (identity, DB, probe, admission);
// production passes nothing.
// a row of db.js listUserMcpConnections (untyped JS)
interface AdoptedRow {
  connectionName: string
  comment?: string
  status?: string
  lastCheckedAt?: unknown
}

interface McpConnectionRouteDeps {
  auth?: RequestHandler
  ensureReady?: typeof realEnsureReady
  listUserMcpConnections?: typeof db.listUserMcpConnections
  adoptUserMcpConnection?: typeof db.adoptUserMcpConnection
  setUserMcpStatus?: typeof db.setUserMcpStatus
  forgetUserMcpConnection?: typeof db.forgetUserMcpConnection
  searchExternalMcpConnections?: typeof searchExternalMcpConnections
  probeMcpConnection?: typeof probeMcpConnection
  getHiddenMcpNames?: typeof getHiddenMcpNames
  admitMcpConnection?: typeof admitMcpConnection
}

export default function registerMcpConnectionRoutes(app: Express, deps: McpConnectionRouteDeps = {}) {
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
      await ensureReady(authed(req))
      const q = (req.query.q || '').toString().trim()
      const [catalog, adopted] = await Promise.all([
        // pass the query so a typed fully-qualified name surfaces as a
        // "connect by name" candidate (validated OBO at connect time)
        search(authed(req).token, authed(req).email, q),
        listUserMcpConnections(authed(req).email, authed(req).token),
      ])
      const adoptedByName = new Map((adopted as AdoptedRow[]).map((a) => [a.connectionName, a]))
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
      if (q) connections = await rankMcpConnections(authed(req).token, q, connections)
      res.json({ connections })
      // fire-and-forget: warm the per-turn tool-listing cache for what this user
      // adopted (the picker/settings load this list just before chatting), so the
      // next turn doesn't pay a slow gateway listing on its TTFT. Warming opens
      // an MCP session (initialize + tools/list), so it runs only for a row that
      // isn't refused or saved as forbidden AND passes admission now (cached);
      // a refused shared-credential service is never contacted from here.
      for (const c of connections) {
        if (!c.adopted || c.refused || c.status === 'forbidden') continue
        admit(authed(req).token, authed(req).email, c.connectionName)
          .then((a) => (a.ok ? listMcpServerCached(externalMcpUrl(c.connectionName), authed(req).token, authed(req).email) : null))
          .catch(() => {})
      }
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // Probe a connection's auth state now (on demand — used by the "Conectar" /
  // "Verificar" button). Persists the probed status if the connection is adopted.
  app.post('/api/mcp/connections/:name/probe', validConnectionName, auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const name = (req.params.name as string)
      // a saved connection is re-checked too: a service whose credential is
      // (now) shared or can't be verified is refused and marked, never probed
      const admission = await admit(authed(req).token, authed(req).email, name)
      if (!admission.ok) {
        try {
          await setUserMcpStatus(authed(req).email, authed(req).token, name, 'forbidden')
        } catch {}
        return res.status(403).json({ status: 'forbidden', ...mcpAdmissionError(admission.code) })
      }
      const result = await probe(authed(req).token, name, { cacheKey: authed(req).email })
      // remember the status for adopted connections (best-effort)
      try {
        await setUserMcpStatus(authed(req).email, authed(req).token, name, result.status)
      } catch {}
      res.json(result)
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // Adopt a connection (the user chose to use it). Probes status at adopt time so
  // the row lands with a real state; default-on in the tool picker follows from
  // being adopted.
  app.post('/api/mcp/connections/:name', validConnectionName, auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      const name = (req.params.name as string)
      // an admin hid this service from the org catalog — not connectable by name either
      if ((await hiddenNames(authed(req).email, authed(req).token)).has(name)) {
        return res.status(403).json({ error: 'mcp_hidden_by_admin' })
      }
      // catalog entry or typed by name: the service must use a credential
      // scoped to the caller; shared / unverifiable → refused (fail closed)
      const admission = await admit(authed(req).token, authed(req).email, name)
      if (!admission.ok) return res.status(403).json(mcpAdmissionError(admission.code))
      const comment = typeof req.body?.comment === 'string' ? req.body.comment : ''
      const probed = await probe(authed(req).token, name, { cacheKey: authed(req).email }).catch((): { status: string; loginUrl?: string } => ({ status: 'unknown' }))
      await adoptUserMcpConnection(authed(req).email, authed(req).token, name, comment, probed.status)
      res.json({ ok: true, status: probed.status, loginUrl: probed.loginUrl || '' })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.delete('/api/mcp/connections/:name', validConnectionName, auth, async (req, res) => {
    try {
      await ensureReady(authed(req))
      await forgetUserMcpConnection(authed(req).email, authed(req).token, (req.params.name as string))
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })
}
