// Search for tools the user can attach to a chat (UC Functions, Genie
// Spaces, Vector Search indexes, external MCP connections).
import { searchUcFunctions } from '../tools.js'
import { searchGenieSpaces } from '../genie.js'
import { searchVectorIndexes } from '../vectorSearch.js'
import { searchExternalMcpConnections } from '../externalMcp.js'
import { auth } from '../middleware/auth.js'

export default function registerToolsSearchRoutes(app) {
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
      const results = await searchExternalMcpConnections(req.token, req.email, q)
      res.json({ results })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
}
