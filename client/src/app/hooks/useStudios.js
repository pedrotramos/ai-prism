import { useCallback, useEffect, useRef, useState } from 'react'

// Which artifact Studio is open (deck, spreadsheet, document). A Studio is
// scoped to the conversation it was opened from: all three close when the
// user changes conversation (`navKey` from useSessions), and an open deck also
// closes once we learn it belongs to a different chat than the one on screen.
export function useStudios({ currentId, navKey }) {
  const [deckStudioId, setDeckStudioId] = useState(null)
  // which chat session the open deck belongs to (reported by DeckStudio)
  const [deckSessionId, setDeckSessionId] = useState(null)
  // pure-HTML deck engine: the deck being streamed live (before it persists and
  // gets a real deckId). Rendered by DeckStudio when deckStudioId === 'streaming'.
  const [streamingDeck, setStreamingDeck] = useState(null)
  const [spreadsheetStudioId, setSpreadsheetStudioId] = useState(null)
  const [documentStudioId, setDocumentStudioId] = useState(null)

  const closeAll = () => {
    setDeckStudioId(null)
    setSpreadsheetStudioId(null)
    setDocumentStudioId(null)
  }

  // a Studio from the previous conversation must not carry over (skip mount)
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
  const openDeck = useCallback((id) => setDeckStudioId(id), [])
  const openSpreadsheet = useCallback((id) => setSpreadsheetStudioId(id), [])
  const openDocument = useCallback((id) => setDocumentStudioId(id), [])
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
