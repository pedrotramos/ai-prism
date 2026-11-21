// Pure model helpers of the Deck Studio (no React, no DOM besides an optional
// Storage), unit-tested in deckStudioModel.test.js.

// Delete-slide undo (ux#29, AC-S1). The deleted slide and where it was live in
// sessionStorage per deck, so the Undo offer survives a reload of the tab; the
// deletion itself is autosaved like any edit, and Undo writes the slide back
// through the same autosave.
//
// Validity is tied to CONTENT IDENTITY, not the slide count: `afterHash` is the
// fingerprint of the deck as the server stored it after this tab's last write
// (updated on every successful save while the offer is open). A deck that loads
// with any other content — an edit in another tab, even one that keeps the
// count — drops the offer instead of restoring over newer work. `afterHash`
// stays null until the deletion itself has been saved: before that the server
// still has the slide and there is nothing to undo.
export const UNDO_TTL_MS = 30 * 60 * 1000

type DeckSlide = string | { html?: string | null; notes?: string | null; [key: string]: unknown } | null | undefined
interface DeckLike {
  id?: string | number
  title?: string | null
  slides?: DeckSlide[]
  audience?: unknown
  author?: unknown
  format?: string
  meta?: { format?: string }
}
interface UndoOffer {
  id?: string
  deckId: string | number
  index?: number
  slide?: unknown
  at: number
  n?: number
  afterHash?: string | null
}
type UndoStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const undoKey = (deckId: string | number) => `prism:deck-undo:${deckId}`

// cyrb53: a fast 53-bit string hash (no crypto needed: this guards against
// stale state, not an adversary)
function hash53(str: string) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/**
 * Fingerprint of a deck's persisted content: title, slides (html + notes, in
 * either the bare-string or {html, notes} form) and the audience/author meta.
 * Computed on the SERVER's copy (the PATCH response, or the GET on reload), so
 * the route's sanitizer normalising the HTML never makes a deck look changed.
 */
export function deckFingerprint(deck?: DeckLike | null) {
  if (!deck) return null
  const slides = (deck.slides || []).map((s) => (typeof s === 'string' ? [s, null] : [s?.html ?? null, s?.notes || null]))
  return hash53(JSON.stringify([deck.title ?? null, slides, deck.audience ?? null, deck.author ?? null]))
}

/** ms left before the offer expires (<= 0: expired). */
export function undoTimeLeft(u: { at: number } | null | undefined, now = Date.now()) {
  return u ? u.at + UNDO_TTL_MS - now : 0
}

/** The stored offer for `deck`, or null (and cleared) when stale, expired or never saved. */
export function readDeckUndo(deck: DeckLike | null | undefined, now = Date.now(), store: UndoStore | undefined = globalThis.sessionStorage) {
  const deckId = deck?.id
  if (!deckId || !store) return null
  try {
    const u = JSON.parse(store.getItem(undoKey(deckId)) || 'null')
    if (!u || u.slide == null || undoTimeLeft(u, now) <= 0 || !u.afterHash || u.afterHash !== deckFingerprint(deck)) {
      store.removeItem(undoKey(deckId))
      return null
    }
    return u
  } catch {
    return null
  }
}
export function writeDeckUndo(u: UndoOffer | null | undefined, store: UndoStore | undefined = globalThis.sessionStorage) {
  try {
    if (u) store?.setItem(undoKey(u.deckId), JSON.stringify(u))
  } catch {
    // storage full or blocked: the in-memory offer still works until reload
  }
}
export function clearDeckUndo(deckId: string | number, store: UndoStore | undefined = globalThis.sessionStorage) {
  try {
    store?.removeItem(undoKey(deckId))
  } catch {
    // ignore
  }
}
/** Pure: is this a pure-HTML deck (the only format the Studio edits)? */
export function isHtmlDeckShape(deck?: DeckLike | null) {
  if (!deck) return false
  if (deck.format === 'html' || deck.meta?.format === 'html') return true
  const first = deck.slides?.find(Boolean)
  return typeof first === 'string' || typeof first?.html === 'string'
}
/** Pure: the deck with `slide` put back at `index` (clamped). */
export function restoreSlide<T>(slides: T[], index: number, slide: T) {
  const out = [...slides]
  out.splice(Math.max(0, Math.min(index, out.length)), 0, slide)
  return out
}
