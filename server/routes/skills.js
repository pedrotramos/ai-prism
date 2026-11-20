import JSZip from 'jszip'
import { listSkills, getSkill, upsertSkill, deleteSkill, setSkillEmbedding } from '../db.js'
import { isAdmin } from '../authz.ts'
import { embed } from '../llm.js'
import { rebindUsageScope } from '../usage.ts'
import { SYSTEM_SKILLS } from '../blocks.js'
import { invalidateSkills } from '../skills.ts'
import { auth } from '../middleware/auth.ts'
import { ensureReady } from '../middleware/ensureReady.ts'
import { skillUpload, fixFilename } from '../middleware/index.ts'

// ---- authored skills -----------------------------------------------------
// A skill = a named capability whose `body` is injected into the system prompt
// only when a turn is routed to it (see server/skills.js). Users CRUD their own
// (scope 'user'); admins additionally CRUD 'global' skills for the whole org.
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

// Parses a SKILL.md-style document: optional YAML frontmatter (name,
// description) + markdown body. Minimal YAML (key: value) — no dependency.
function parseSkillMarkdown(text) {
  const out = { name: '', description: '', body: String(text || '').trim() }
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(String(text || ''))
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line.trim())
      if (!kv) continue
      const key = kv[1].toLowerCase()
      let val = kv[2].trim().replace(/^["']|["']$/g, '')
      if (key === 'name') out.name = val
      else if (key === 'description') out.description = val
      else if (key === 'title') out.title = val
    }
    out.body = m[2].trim()
  }
  return out
}

// Persist a skill and (re)compute its routing embedding right away, so the
// first turn that could use it doesn't pay the embedding cost. Best-effort on
// the embedding — the router backfills it lazily if this fails.
// `admin` is true only when the handler checked authz.isAdmin for a global skill.
async function saveSkillWithEmbedding(req, skill, { admin = false } = {}) {
  let id
  try {
    id = await upsertSkill(req.email, req.token, skill, { admin })
  } catch (e) {
    // the partial unique indexes on (name) enforce one skill-name per scope;
    // surface a clean conflict instead of the raw Postgres constraint error
    if (/unique constraint|duplicate key/i.test(e.message || '')) {
      const err = new Error(`já existe uma skill chamada "${skill.name}" neste escopo`)
      err.status = 409
      throw err
    }
    throw e
  }
  invalidateSkills(req.email)
  if (id) {
    try {
      const [vec] = await embed(req.token, [`${skill.title} — ${skill.description}`])
      if (vec) await setSkillEmbedding(req.email, req.token, id, vec, { admin })
    } catch {}
  }
  return id
}

// create or update. `scope: 'global'` requires admin.
async function writeSkillHandler(req, res) {
  try {
    await ensureReady(req)
    const b = req.body || {}
    const scope = b.scope === 'global' ? 'global' : 'user'
    if (scope === 'global' && !(await isAdmin(req.email, req.token))) {
      return res.status(403).json({ error: 'apenas administradores podem editar skills globais' })
    }
    const title = (b.title || '').trim()
    const description = (b.description || '').trim()
    const body = (b.body || '').trim()
    if (!title || !description || !body) {
      return res.status(400).json({ error: 'título, descrição e instruções são obrigatórios' })
    }
    const name = slugify(b.name || title)
    const triggers = Array.isArray(b.triggers)
      ? b.triggers.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
      : []
    const id = await saveSkillWithEmbedding(req, {
      id: b.id || null,
      scope,
      name,
      title: title.slice(0, 120),
      description: description.slice(0, 400),
      body: body.slice(0, 20000),
      triggers,
      source: b.source || 'write',
      enabled: b.enabled !== false,
    }, { admin: scope === 'global' }) // global ⇒ the isAdmin check above passed
    if (!id) return res.status(404).json({ error: 'skill não encontrada ou sem permissão' })
    res.json({ ok: true, id })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
}

export default function registerSkillRoutes(app) {
  app.get('/api/skills', auth, async (req, res) => {
    try {
      await ensureReady(req)
      // list view doesn't need the (large) bodies/embeddings
      const authored = await listSkills(req.email, req.token, { includeBody: false })
      // prepend the built-in capabilities as read-only "system" skills so every
      // deployment shows deck/spreadsheet/chart generation in the tab out of the
      // box — no seeding, no DB rows; their bodies live in code (blocks.js).
      const system = SYSTEM_SKILLS.map((s) => ({
        id: `system:${s.name}`,
        scope: 'system',
        name: s.name,
        title: s.title,
        description: s.description,
        enabled: true,
        readOnly: true,
      }))
      res.json({ skills: [...system, ...authored], isAdmin: await isAdmin(req.email, req.token) })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.get('/api/skills/:id', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const skill = await getSkill(req.email, req.token, req.params.id)
      if (!skill) return res.status(404).json({ error: 'skill não encontrada' })
      res.json({ skill })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.post('/api/skills', auth, writeSkillHandler)
  app.put('/api/skills/:id', auth, (req, res) => {
    req.body = { ...(req.body || {}), id: req.params.id }
    return writeSkillHandler(req, res)
  })

  // upload a SKILL.md (YAML frontmatter) or a .zip/.skill bundle containing one
  app.post('/api/skills/upload', auth, skillUpload.single('file'), rebindUsageScope, async (req, res) => {
    try {
      await ensureReady(req)
      if (!req.file) return res.status(400).json({ error: 'nenhum arquivo enviado' })
      const scope = req.body?.scope === 'global' ? 'global' : 'user'
      if (scope === 'global' && !(await isAdmin(req.email, req.token))) {
        return res.status(403).json({ error: 'apenas administradores podem criar skills globais' })
      }
      const fname = fixFilename(req.file.originalname || '')
      let mdText = ''
      if (/\.(zip|skill)$/i.test(fname)) {
        const zip = await JSZip.loadAsync(req.file.buffer)
        // find a SKILL.md anywhere in the bundle (case-insensitive)
        const entry = Object.keys(zip.files).find((p) => /(^|\/)SKILL\.md$/i.test(p))
        if (!entry) return res.status(400).json({ error: 'o .zip/.skill precisa conter um arquivo SKILL.md' })
        mdText = await zip.files[entry].async('string')
      } else if (/\.(md|markdown|txt)$/i.test(fname)) {
        mdText = req.file.buffer.toString('utf8')
      } else {
        return res.status(400).json({ error: 'formato não suportado — envie um .md ou um .zip/.skill com SKILL.md' })
      }
      const parsed = parseSkillMarkdown(mdText)
      const title = (parsed.title || parsed.name || fname.replace(/\.[^.]+$/, '')).trim()
      const description = parsed.description.trim()
      const body = parsed.body.trim()
      if (!description || !body) {
        return res.status(400).json({ error: 'o SKILL.md precisa de "description" no YAML e um corpo de instruções' })
      }
      const id = await saveSkillWithEmbedding(req, {
        scope,
        name: slugify(parsed.name || title),
        title: title.slice(0, 120),
        description: description.slice(0, 400),
        body: body.slice(0, 20000),
        triggers: [],
        source: 'upload',
        enabled: true,
      }, { admin: scope === 'global' }) // global ⇒ the isAdmin check above passed
      res.json({ ok: true, id })
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message })
    }
  })

  app.delete('/api/skills/:id', auth, async (req, res) => {
    try {
      await ensureReady(req)
      const ok = await deleteSkill(req.email, req.token, req.params.id, {
        allowGlobal: await isAdmin(req.email, req.token),
      })
      invalidateSkills(req.email)
      if (!ok) return res.status(404).json({ error: 'skill não encontrada ou sem permissão' })
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
}
