// Share leaves the chat for the project, so every open studio that holds unsaved work has to be closed first, through
// ITS OWN Save / Discard / Cancel prompt, before anything moves (attach, Move dialog, navigation). Cancel anywhere means
// nothing moves and the draft stays. The studios own their prompts and report the outcome as a value; this file is the
// contract between them and the Shell (design-guarded-close.md, ADR-1).

export type StudioKind = 'doc' | 'deck' | 'sheet'
export type CloseOutcome = 'closed' | 'cancelled'

export interface StudioCloseHandle {
  /** a live read of the studio's own state, never of the DOM */
  hasUnsavedWork(): boolean
  /**
   * Closes the studio through its own prompt. Resolves once and never rejects. 'closed' only right before the studio calls
   * its onClose; anything else is 'cancelled', and so is a studio that unmounts or changes document under the prompt:
   * an unknown outcome is never success.
   */
  requestClose(): Promise<CloseOutcome>
}

/** The order the studios are asked in: the document first (the only one that is usually dirty), then deck and spreadsheet. */
export const CLOSE_ORDER: readonly StudioKind[] = ['doc', 'deck', 'sheet']

/**
 * Closes, one at a time and in CLOSE_ORDER, every studio that holds unsaved work. A clean studio is not touched (it stays
 * open under the Move dialog, as before). Resolves false at the first studio that does not answer 'closed': the ones
 * after it are never asked, and the Share is abandoned.
 */
export async function closeUnsavedStudios(handles: Record<StudioKind, { current: StudioCloseHandle | null }>): Promise<boolean> {
  for (const kind of CLOSE_ORDER) {
    const handle = handles[kind].current
    if (!handle?.hasUnsavedWork()) continue
    if ((await handle.requestClose()) !== 'closed') return false
  }
  return true
}
