import { useCallback, useEffect, useRef, useState } from 'react'

// Which artifact Studio is open (deck, spreadsheet, document). A Studio is
// scoped to the conversation it was opened from: all three close when the
// user changes conversation (`navKey` from useSessions), and an open deck also
// closes once we learn it belongs to a different chat than the one on screen.
// the id of an open Studio's artifact (a deck may also be the literal 'streaming')
type StudioId = string | number

/** The deck being streamed live: slides arrive as HTML strings, in order. */
interface StreamingDeck {
  title?: string
  total?: number | null
  slides: (string | undefined)[]
  meta: { format: string }
  streaming: boolean
}

export function useStudios({ currentId, navKey }: { currentId: string | number | null; navKey: number }) {
  const [deckStudioId, setDeckStudioId] = useState<StudioId | null>(null)
  // which chat session the open deck belongs to (reported by DeckStudio)
  const [deckSessionId, setDeckSessionId] = useState<StudioId | null>(null)
  // pure-HTML deck engine: the deck being streamed live (before it persists and
  // gets a real deckId). Rendered by DeckStudio when deckStudioId === 'streaming'.
  const [streamingDeck, setStreamingDeck] = useState<StreamingDeck | null>(null)
  const [spreadsheetStudioId, setSpreadsheetStudioId] = useState<StudioId | null>(null)
  const [documentStudioId, setDocumentStudioId] = useState<StudioId | null>(null)

  const closeAll = () => {
    setDeckStudioId(null)
    setSpreadsheetStudioId(null)
    setDocumentStudioId(null)
  }

  // a Studio from the previous conversation must not carry over (skip mount). This is the backstop, not the guard: a studio
  // with unsaved work was already closed through its own prompt by useSessions' leave guard (Shell registers it) before
  // navKey moved, so only clean studios (or ones the user discarded) reach here.
  const firstNav = useRef(navKey)
  useEffect(() => {
    if (navKey !== firstNav.current) closeAll()
  }, [navKey])

  useEffect(() => {
    if (!deckStudioId) setDeckSessionId(null)
  }, [deckStudioId])

  // streaming decks have no persisted session yet — never force-close those
  useEffect(() => {
    if (!deckStudioId || deckStudioId === 'streaming' || deckSessionId == null) return
    if (currentId != null && String(currentId) !== String(deckSessionId)) {
      setDeckStudioId(null)
      setStreamingDeck(null)
    }
  }, [currentId, deckSessionId, deckStudioId])

  // stable across renders so memo(Message) can skip finished bubbles
  const openDeck = useCallback((id: StudioId | null) => setDeckStudioId(id), [])
  const openSpreadsheet = useCallback((id: StudioId | null) => setSpreadsheetStudioId(id), [])
  const openDocument = useCallback((id: StudioId | null) => setDocumentStudioId(id), [])
  const closeDeck = () => {
    setDeckStudioId(null)
    setStreamingDeck(null)
  }

  return {
    deckStudioId, setDeckStudioId, setDeckSessionId, streamingDeck, setStreamingDeck,
    spreadsheetStudioId, setSpreadsheetStudioId, documentStudioId, setDocumentStudioId,
    openDeck, openSpreadsheet, openDocument, closeDeck,
  }
}

export type StudiosState = ReturnType<typeof useStudios>
