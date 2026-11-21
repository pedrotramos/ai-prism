// Shared helpers of the artifact "tweak" routes (decks, spreadsheets, documents).
import { listMessages } from '../db.ts'

// Natural-language "tweak": the Studio sends an instruction (optionally
// scoped to a clicked element — see SelBox in DeckSlidePreview.jsx) and the
// model returns the revised slide/deck JSON, revalidated by the exact same
// sanitizers as generation, then persisted. Small, synchronous, non-streaming:
// a tweak is one focused edit, not a chat turn.
export const TWEAK_MAX_TOKENS = 16384

// Robust JSON extraction from a model reply: tolerates a prose preamble/note,
// markdown fences placed anywhere, and trailing text by scanning for the first
// balanced {...} or [...] (respecting string literals + escapes). Returns null
// only when there is genuinely no JSON value to recover. Far more forgiving
// than a leading/trailing fence strip, which broke whenever the model added
// any surrounding prose.
export function extractJson(text: unknown): unknown {
  if (typeof text !== 'string') return null
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    // fall through to balanced-scan
  }
  const pairs: [string, string][] = [['{', '}'], ['[', ']']]
  for (const [open, close] of pairs) {
    const start = cleaned.indexOf(open)
    if (start < 0) continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i]!
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
      } else if (ch === '"') inStr = true
      else if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return null
}

// Instruction appended to the deck-tweak system prompt when the user attached
// image(s). The model DECIDES per attachment whether it's an ASSET to place in
// the slide or just visual REFERENCE — we don't force a rule (an inspiration
// image must not get dumped onto the slide). When it inserts one, it emits a
// `<img data-attach="N">` marker (N = 1-based attachment index) and we splice
// the real bytes in afterwards, so the exact file (incl. SVG, kept vector) lands
// — never a redrawn approximation.
export function imageAttachInstruction(images: readonly unknown[]): string {
  const n = images.length
  return (
    ` O usuário anexou ${n === 1 ? 'uma imagem' : `${n} imagens`} (numeradas de 1 a ${n}, na ordem enviada). ` +
    'DECIDA o papel de cada uma pela instrução e pelo contexto: ' +
    '(a) se é um ATIVO para COLOCAR no slide (um logo, uma foto, um ícone que o usuário quer usar), ' +
    'insira-a com um marcador `<img data-attach="N">` (N = número da imagem) posicionando e ' +
    'dimensionando da melhor forma no layout (use style inline com left/top/width/height ou as classes/flex do slide; ' +
    'prefira `object-fit:contain` para não deformar). NÃO redesenhe a imagem em SVG/CSS nem invente um placeholder — ' +
    'use o marcador e nós inserimos o arquivo real. ' +
    '(b) se é apenas REFERÊNCIA visual/inspiração (paleta, estilo, layout a imitar), NÃO a insira — só use como guia. ' +
    'Na dúvida entre inserir ou não, prefira tratar como referência.'
  )
}

// Compact digest of the conversation a deck came from, for grounding an AI
// tweak (task #45). Plain-text roles only, tool traces and block payloads
// dropped, capped so it stays token-affordable. Returns '' when there's no
// session or nothing usable. Never throws to the caller — grounding is
// best-effort.
export async function buildTweakChatContext(req: { email: string; token: string }, sessionId: number | string | null | undefined): Promise<string> {
  if (!sessionId) return ''
  const msgs = await listMessages(req.email, req.token, sessionId)
  if (!msgs?.length) return ''
  const parts = []
  for (const m of msgs) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = String(m.content || '')
      .replace(/\{\{block:\d+\}\}/g, '')      // block placeholders
      .replace(/\{\{toolcall:[^}]+\}\}/g, '') // inline tool-call markers
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    parts.push(`${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${text.slice(0, 1200)}`)
  }
  if (!parts.length) return ''
  // keep the most recent exchanges (the deck's subject + latest refinements)
  let digest = parts.slice(-16).join('\n')
  if (digest.length > 6000) digest = digest.slice(-6000)
  return digest
}
