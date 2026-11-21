// Tiny platform helper so keyboard-shortcut hints match the user's OS: ⌘ on
// Mac, Ctrl elsewhere (Windows/Linux). The behaviour itself already accepts
// both metaKey and ctrlKey — this is purely about what glyph we SHOW.
export const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '')

// modifier symbol/word for hints — "⌘" on Mac, "Ctrl" otherwise
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl'

// full "apply/submit" chord label: "⌘↵" on Mac, "Ctrl+Enter" elsewhere
export const SUBMIT_CHORD = IS_MAC ? '⌘↵' : 'Ctrl+Enter'

// join a modifier with a key for a hint, e.g. modChord('C') → "⌘C" / "Ctrl+C"
export function modChord(key: string): string {
  return IS_MAC ? `⌘${key}` : `Ctrl+${key}`
}
