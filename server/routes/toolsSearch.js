// Search for tools the user can attach to a chat (UC Functions, Genie
// Spaces, Vector Search indexes, external MCP connections).
import { searchUcFunctions } from '../tools.js'
import { searchGenieSpaces } from '../genie.ts'
import { searchVectorIndexes } from '../vectorSearch.ts'
import { searchExternalMcpConnections } from '../externalMcp.ts'
import { auth as realAuth } from '../middleware/auth.js'

// `deps` overrides identity and the MCP search in tests; production passes nothing.
export default function registerToolsSearchRoutes(app, deps = {}) {
  const { auth = realAuth, searchExternalMcpConnections: searchMcp = searchExternalMcpConnections } = deps
  // search Unity Catalog Functions the user can attach as extra tools
  app.get('/api/tools/search', auth, async (req, res) => {
    try {
      const q = (req.query.q || '').toString().trim()
      const results = await searchUcFunctions(req.token, q)
      res.json({ results })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // search Genie Spaces the user can attach as extra tools
  app.get('/api/tools/genie/search', auth, async (req, res) => {
    try {
      const q = (req.query.q || '').toString().trim()
      const results = await searchGenieSpaces(req.token, req.email, q)
      res.json({ results })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // search Vector Search indexes the user can attach as extra tools
  app.get('/api/tools/vector-search/search', auth, async (req, res) => {
    try {
      const q = (req.query.q || '').toString().trim()
      const results = await searchVectorIndexes(req.token, req.email, q)
      res.json({ results })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // search Unity Catalog connections registered as external MCP servers
  app.get('/api/tools/mcp/external/search', auth, async (req, res) => {
    try {
      const q = (req.query.q || '').toString().trim()
      // the picker enables a result directly on the session: a by-name service
      // refused by the credential admission (shared / unverifiable) is not offered
      const results = (await searchMcp(req.token, req.email, q)).filter((r) => !r.refused)
      res.json({ results })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
}
