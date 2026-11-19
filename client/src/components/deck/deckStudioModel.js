// Pure model helpers of the Deck Studio (no React, no DOM besides an optional
// Storage), unit-tested in deckStudioModel.test.js.

// Delete-slide undo (ux#29, AC-S1). The deleted slide and where it was live in
// sessionStorage per deck, so the Undo offer survives a reload of the tab; the
// deletion itself is autosaved like any edit, and Undo writes the slide back
// through the same autosave. `after` is the slide count right after deleting:
// if the deck loads with another count it changed elsewhere and the offer is
// dropped rather than inserting into a different deck.
const UNDO_TTL_MS = 30 * 60 * 1000
const undoKey = (deckId) => `prism:deck-undo:${deckId}`
export function readDeckUndo(deckId, slideCount, now = Date.now(), store = globalThis.sessionStorage) {
  if (!deckId || !store) return null
  try {
    const u = JSON.parse(store.getItem(undoKey(deckId)) || 'null')
    if (!u || now - u.at > UNDO_TTL_MS || u.after !== slideCount || u.slide == null) {
      store.removeItem(undoKey(deckId))
      return null
    }
    return u
  } catch {
    return null
  }
}
export function writeDeckUndo(u, store = globalThis.sessionStorage) {
  try {
    if (u) store?.setItem(undoKey(u.deckId), JSON.stringify(u))
  } catch {
    // storage full or blocked: the in-memory offer still works until reload
  }
}
export function clearDeckUndo(deckId, store = globalThis.sessionStorage) {
  try {
    store?.removeItem(undoKey(deckId))
  } catch {
    // ignore
  }
}
/** Pure: is this a pure-HTML deck (the only format the Studio edits)? */
export function isHtmlDeckShape(deck) {
  if (!deck) return false
  if (deck.format === 'html' || deck.meta?.format === 'html') return true
  const first = deck.slides?.find(Boolean)
  return typeof first === 'string' || typeof first?.html === 'string'
}
/** Pure: the deck with `slide` put back at `index` (clamped). */
export function restoreSlide(slides, index, slide) {
  const out = [...slides]
  out.splice(Math.max(0, Math.min(index, out.length)), 0, slide)
  return out
}
