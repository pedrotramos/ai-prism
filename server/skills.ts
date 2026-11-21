// Authored-skill routing (progressive disclosure, Fase 2). A skill is a named
// capability whose detailed `body` is injected into the system prompt ONLY when
// a turn is routed to it — so a trivial turn never pays for capabilities it
// won't use, and admins/users can add capabilities as data (no code change).
//
// The system capabilities (deck/spreadsheet/chart) still live in blocks.js and
// are routed by detectCapabilities; THIS module handles the DB-backed authored
// skills. Two routes, cheap-first:
//   1. lexical  — a skill's declared `triggers` (or its name) appears in the turn
//   2. semantic — cosine similarity of the turn vs each skill's "title —
//      description" embedding, above a floor (reuses embed/cosineSim, same infra
//      as the MCP search). Only runs for skills the lexical pass didn't already
//      pick, and only when there ARE authored skills, so the common case (no
//      user skills) costs nothing.
import { embed, cosineSim } from './llm.js'
import { listSkills, setSkillEmbedding } from './db.ts'
import { logger } from './log.ts'
import { isAdmin } from './authz.ts'

// The skill row fields this module reads (db.js listSkills). `embedding` is
// filled in lazily by ensureEmbeddings.
interface Skill {
  id: string | number
  scope: string
  name: string
  title: string
  description: string
  body?: string
  triggers?: string[] | null
  embedding?: number[] | null
  enabled?: boolean
}
// What the embedding backfill needs from a skill.
type EmbeddableSkill = Pick<Skill, 'id' | 'scope' | 'title' | 'description' | 'embedding'>
interface SkillReq {
  email: string
  token: string
}
interface EnsureDeps {
  embed?: (token: string, texts: string[]) => Promise<(number[] | null | undefined)[]>
  setSkillEmbedding?: (email: string, token: string, id: Skill['id'], vec: number[], opts: { admin: boolean }) => Promise<unknown>
  isAdmin?: (email: string, token?: string | null) => Promise<boolean>
}

// short per-user cache of the (small) skill list so we don't hit the DB on every
// turn; invalidated by TTL and by explicit bump on write (see invalidateSkills)
const SKILLS_TTL_MS = 30 * 1000
const cache = new Map<string, { ts: number; skills: Skill[] }>() // email -> { ts, skills }

export function invalidateSkills(email?: string | null): void {
  if (email) cache.delete(email)
  else cache.clear()
}

async function loadSkills(req: SkillReq): Promise<Skill[]> {
  const hit = cache.get(req.email)
  if (hit && Date.now() - hit.ts < SKILLS_TTL_MS) return hit.skills
  let skills: Skill[] = []
  try {
    skills = (await listSkills(req.email, req.token)).filter((s: Skill) => s.enabled)
  } catch (e) {
    logger.warn('skills: load failed', { err: e })
    skills = hit?.skills || []
  }
  cache.set(req.email, { ts: Date.now(), skills })
  return skills
}

const norm = (s: unknown): string => String(s || '').toLowerCase()

// lexical hit: any declared trigger (or the skill name, spaces/hyphens folded)
// appears as a substring of the turn text
function lexicalHit(skill: Skill, text: unknown): boolean {
  const t = norm(text)
  const words = [skill.name, skill.name.replace(/[-_]/g, ' '), ...(skill.triggers || [])]
  return words.some((w) => w && t.includes(norm(w)))
}

// Ensures each skill has an embedding of "title — description", computing and
// persisting any that are missing (skills are re-embedded lazily after an edit,
// which nulls the column). Best-effort: a skill that can't be embedded simply
// won't participate in the semantic route this turn.
//
// Global skills (W2-1, row-level security): only an admin request may write a
// global row, so a non-admin's UPDATE of the embedding would match 0 rows. Their
// vectors are kept in a process-wide memo (keyed by id + embedded text, so an
// edit re-embeds) and persisted only when the caller is an admin: a missing global
// embedding costs one embedding call per process, not one per turn.
const globalVectors = new Map<string, number[]>() // `${id}\n${text}` -> vector
const embedText = (s: EmbeddableSkill): string => `${s.title} — ${s.description}`
const memoKey = (s: EmbeddableSkill): string => `${s.id}\n${embedText(s)}`

export function resetGlobalSkillVectors(): void {
  globalVectors.clear()
}

export async function ensureEmbeddings(req: SkillReq, skills: EmbeddableSkill[], deps: EnsureDeps = {}): Promise<void> {
  const { embed: embedFn = embed, setSkillEmbedding: persist = setSkillEmbedding, isAdmin: adminCheck = isAdmin } = deps
  for (const s of skills) {
    if (s.scope === 'global' && !(Array.isArray(s.embedding) && s.embedding.length) && globalVectors.has(memoKey(s))) {
      s.embedding = globalVectors.get(memoKey(s)) as number[]
    }
  }
  const missing = skills.filter((s) => !Array.isArray(s.embedding) || !s.embedding.length)
  if (!missing.length) return
  try {
    const vecs = await embedFn(
      req.token,
      missing.map((s) => embedText(s))
    )
    const anyGlobal = missing.some((s, i) => vecs[i] && s.scope === 'global')
    const admin = anyGlobal ? (await adminCheck(req.email, req.token).catch(() => false)) === true : false
    await Promise.all(
      missing.map((s, i) => {
        if (!vecs[i]) return null
        s.embedding = vecs[i]
        if (s.scope === 'global') {
          globalVectors.set(memoKey(s), vecs[i])
          if (!admin) return null
        }
        return persist(req.email, req.token, s.id, vecs[i], { admin: s.scope === 'global' && admin }).catch(() => {})
      })
    )
  } catch (e) {
    logger.warn('skills: embedding backfill failed', { err: e })
  }
}

const SEMANTIC_FLOOR = 0.45 // qwen3-embedding runs high; this keeps only clear matches
const MAX_SKILLS_PER_TURN = 3 // guard prompt size + caching churn

// Routes a turn to zero or more authored skills. `forced` is an array of skill
// ids the user explicitly pinned (escape hatch) — always included. Returns the
// selected skill objects (with body), most-relevant first, capped.
// `semantic`: false, or an async () => boolean, turns the embedding pass off (a temporary chat
// (W3-6) never sends its prompt to the embedding service: lexical hits and pins still apply).
export async function routeSkills(
  req: SkillReq,
  userText: unknown,
  { forced = [], semantic = true }: { forced?: (string | number)[] | null; semantic?: boolean | (() => boolean | Promise<boolean>) } = {}
): Promise<Skill[]> {
  const all = await loadSkills(req)
  if (!all.length) return []
  const forcedSet = new Set((forced || []).map(String))
  const selected = new Map<string, Skill>() // id -> skill

  for (const s of all) if (forcedSet.has(String(s.id))) selected.set(String(s.id), s)
  for (const s of all) if (!selected.has(String(s.id)) && lexicalHit(s, userText)) selected.set(String(s.id), s)

  // semantic pass over the rest, only if the turn has real content
  const remaining = all.filter((s) => !selected.has(String(s.id)))
  const text = String(userText || '').trim()
  const allowSemantic = remaining.length && text.length > 3 ? (typeof semantic === 'function' ? await semantic() : semantic) : false
  if (allowSemantic) {
    await ensureEmbeddings(req, remaining)
    const usable = remaining.filter((s) => Array.isArray(s.embedding) && s.embedding.length)
    if (usable.length) {
      try {
        const [qvec] = await embed(req.token, [
          `Instruct: Dada a intenção do usuário, recupere as skills (capacidades) relevantes.\nQuery: ${text}`,
        ])
        if (qvec) {
          usable
            .map((s) => ({ s, score: cosineSim(qvec, s.embedding) }))
            .filter((x) => x.score >= SEMANTIC_FLOOR)
            .sort((a, b) => b.score - a.score)
            .forEach((x) => selected.set(String(x.s.id), x.s))
        }
      } catch (e) {
        logger.warn('skills: semantic route failed', { err: e })
      }
    }
  }

  // stable order (forced/lexical first by original list order) then cap
  const out = all.filter((s) => selected.has(String(s.id)))
  return out.slice(0, MAX_SKILLS_PER_TURN)
}

// Renders selected skills into a single system message. Ordered by the caller;
// kept byte-stable per skill so the prompt-cache prefix only changes when the
// SET of skills changes, not per turn.
export function renderSkillsInstruction(skills: Skill[] | null | undefined): string {
  if (!skills?.length) return ''
  const parts = skills.map(
    (s) => `## Skill: ${s.title}\n(${s.description})\n\n${s.body}`
  )
  return (
    '\n\nCapacidades adicionais (skills) ativadas para este pedido — siga as instruções ' +
    'abaixo quando forem pertinentes ao que o usuário pediu:\n\n' +
    parts.join('\n\n---\n\n')
  )
}
