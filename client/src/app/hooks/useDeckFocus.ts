import { useEffect, useRef, useState } from 'react'

// Layout of the shell around an open deck: focus mode (the chat shrinks to a
// side column), the sidebar rail (collapsed by hand, or automatically while a
// deck is open) and the mobile drawer. The drawer closes on every change of
// conversation (`navKey`).
export function useDeckFocus({ deckStudioId, navKey }: { deckStudioId: string | number | null; navKey: number }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [manualSidebarCollapsed, setManualSidebarCollapsed] = useState(() => localStorage.getItem('prism-sidebar-collapsed') === '1')
  // focus mode: while a deck is open the chat shrinks to a narrow side column
  // and the Studio takes the rest of the row; toggleable from the Studio
  // header, remembered across sessions
  const [deckFocus, setDeckFocus] = useState(() => localStorage.getItem('prism-deck-focus') !== '0')
  // auto-collapses when a deck panel opens but stays re-openable: expanding the
  // rail while the Studio is up clears only this flag, never the user's
  // persisted manual preference
  const [deckAutoCollapsed, setDeckAutoCollapsed] = useState(false)
  // the Studio's manual HTML Edit mode hides the chat entirely (max canvas
  // room); cleared when Edit mode or the Studio closes
  const [deckEditFullscreen, setDeckEditFullscreen] = useState(false)

  useEffect(() => {
    setDeckAutoCollapsed(!!deckStudioId)
    if (!deckStudioId) setDeckEditFullscreen(false)
  }, [deckStudioId])
  useEffect(() => localStorage.setItem('prism-sidebar-collapsed', manualSidebarCollapsed ? '1' : '0'), [manualSidebarCollapsed])
  useEffect(() => localStorage.setItem('prism-deck-focus', deckFocus ? '1' : '0'), [deckFocus])

  const firstNav = useRef(navKey)
  useEffect(() => {
    if (navKey !== firstNav.current) setSidebarOpen(false)
  }, [navKey])

  const sidebarCollapsed = manualSidebarCollapsed || deckAutoCollapsed
  const toggleSidebarCollapse = () => {
    if (sidebarCollapsed) {
      setManualSidebarCollapsed(false)
      setDeckAutoCollapsed(false)
    } else if (deckStudioId) {
      setDeckAutoCollapsed(true)
    } else {
      setManualSidebarCollapsed(true)
    }
  }

  return {
    sidebarOpen, setSidebarOpen, sidebarCollapsed, toggleSidebarCollapse,
    deckFocus, toggleDeckFocus: () => setDeckFocus((f) => !f),
    deckEditFullscreen, setDeckEditFullscreen,
    // focus layout is on only while a deck is open
    focused: !!deckStudioId && deckFocus,
  }
}

export type DeckFocusState = ReturnType<typeof useDeckFocus>
