// Search for tools the user can attach to a chat (UC Functions, Genie
// Spaces, Vector Search indexes, external MCP connections).
import { authed } from './authed.ts'
import type { Express, RequestHandler } from 'express'
import { searchUcFunctions } from '../tools.js'
import { searchGenieSpaces } from '../genie.ts'
import { searchVectorIndexes } from '../vectorSearch.ts'
import { searchExternalMcpConnections } from '../externalMcp.ts'
import { auth as realAuth } from '../middleware/auth.ts'

interface ToolsSearchDeps {
  auth?: RequestHandler
  searchExternalMcpConnections?: typeof searchExternalMcpConnections
}

// `deps` overrides identity and the MCP search in tests; production passes nothing.
export default function registerToolsSearchRoutes(app: Express, deps: ToolsSearchDeps = {}) {
  const { auth = realAuth, searchExternalMcpConnections: searchMcp = searchExternalMcpConnections } = deps
  // search Unity Catalog Functions the user can attach as extra tools
  app.get('/api/tools/search', auth, async (req, res) => {
    try {
      const q = (req.query.q || '').toString().trim()
      const results = await searchUcFunctions(authed(req).token, q)
      res.json({ results })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // search Genie Spaces the user can attach as extra tools
  app.get('/api/tools/genie/search', auth, async (req, res) => {
    try {
      const q = (req.query.q || '').toString().trim()
      const results = await searchGenieSpaces(authed(req).token, authed(req).email, q)
      res.json({ results })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // search Vector Search indexes the user can attach as extra tools
  app.get('/api/tools/vector-search/search', auth, async (req, res) => {
    try {
      const q = (req.query.q || '').toString().trim()
      const results = await searchVectorIndexes(authed(req).token, authed(req).email, q)
      res.json({ results })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // search Unity Catalog connections registered as external MCP servers
  app.get('/api/tools/mcp/external/search', auth, async (req, res) => {
    try {
      const q = (req.query.q || '').toString().trim()
      // the picker enables a result directly on the session: a by-name service
      // refused by the credential admission (shared / unverifiable) is not offered
      const results = (await searchMcp(authed(req).token, authed(req).email, q)).filter((r: { refused?: unknown }) => !r.refused)
      res.json({ results })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })
}
