// Editable cross-conversation memory (W2-4): the caller's own entries.
//
//   GET    /api/memory        { items, limits, categories, sensitiveCategories } | 403 memory_disabled
//   POST   /api/memory        { content, category?, sensitiveOptIn? } → 201 entry | 400 | 403 | 409 memory_duplicate | 409 memory_limit
//   PATCH  /api/memory/:id    { content?, category?, sensitiveOptIn? } → entry | 400 | 403 | 404 | 409
//   DELETE /api/memory/:id    204 | 404
//   DELETE /api/memory        "forget everything" → { deleted }
//
// Own rows only: every query runs under the caller's identity (RLS aip_owner on
// user_memories). The admin kill-switch (app_tool_policy key 'memory' = false)
// stops listing, creating and editing; DELETE keeps working, so a user can
// always erase what is stored. Registering these routes also installs the
// memory context provider and the post-turn extraction hook (server/memory.js).
// Memory content is personal data: nothing here logs it.
import { auth } from '../middleware/auth.ts'
import { MemoryError, createMemory, deleteAllMemories, deleteMemory, listMemories, updateMemory } from '../db/memory.js'
import { MEMORY_CATEGORIES, MEMORY_LIMITS, SENSITIVE_CATEGORIES, installMemory, noteForgetAll, validateMemoryInput } from '../memory.js'
import { logger } from '../log.js'

const STATUS = { disabled: [403, 'memory_disabled'], duplicate: [409, 'memory_duplicate'], limit: [409, 'memory_limit'] }

function fail(res, e, what) {
  if (e instanceof MemoryError && STATUS[e.code]) {
    const [status, error] = STATUS[e.code]
    return res.status(status).json({ error })
  }
  logger.warn(`${what} failed`, { err: e })
  res.status(500).json({ error: 'internal_error' })
}

export default function registerMemoryRoutes(app) {
  installMemory()

  app.get('/api/memory', auth, async (req, res) => {
    try {
      const { enabled, items } = await listMemories(req.email, req.token)
      if (!enabled) return res.status(403).json({ error: 'memory_disabled' })
      res.json({ items, limits: MEMORY_LIMITS, categories: MEMORY_CATEGORIES, sensitiveCategories: SENSITIVE_CATEGORIES })
    } catch (e) {
      fail(res, e, 'memory list')
    }
  })

  app.post('/api/memory', auth, async (req, res) => {
    const { value, error } = validateMemoryInput(req.body)
    if (error) return res.status(400).json({ error })
    try {
      res.status(201).json(await createMemory(req.email, req.token, value))
    } catch (e) {
      fail(res, e, 'memory create')
    }
  })

  app.patch('/api/memory/:id', auth, async (req, res) => {
    const { value, error } = validateMemoryInput(req.body, { partial: true })
    if (error) return res.status(400).json({ error })
    try {
      const saved = await updateMemory(req.email, req.token, req.params.id, value)
      if (!saved) return res.status(404).json({ error: 'not_found' })
      res.json(saved)
    } catch (e) {
      fail(res, e, 'memory update')
    }
  })

  app.delete('/api/memory/:id', auth, async (req, res) => {
    try {
      if (!(await deleteMemory(req.email, req.token, req.params.id))) return res.status(404).json({ error: 'not_found' })
      res.status(204).end()
    } catch (e) {
      fail(res, e, 'memory delete')
    }
  })

  app.delete('/api/memory', auth, async (req, res) => {
    try {
      // an extraction still running for this user must not write after this
      noteForgetAll(req.email)
      res.json({ deleted: await deleteAllMemories(req.email, req.token) })
    } catch (e) {
      fail(res, e, 'memory delete all')
    }
  })
}
