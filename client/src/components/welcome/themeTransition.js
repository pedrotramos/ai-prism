// Theme switch transition. The theme is applied by App as `data-theme` on
// <html>; this hook watches that attribute and, for one switch, adds the
// `theme-switching` class so colours cross-fade in 200 ms instead of flashing
// (themeTransition.css). Reduced motion: no class, instant switch.
//
// It observes the attribute rather than wrapping setTheme so it works for every
// path that changes the theme (Settings, the 'system' preference following the
// OS live) without App having to call it.
import { useEffect } from 'react'
import './themeTransition.css'

export const THEME_SWITCH_MS = 200

export function useThemeTransition() {
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined
    const root = document.documentElement
    let timer = null
    let last = root.getAttribute('data-theme')
    const reduce = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const obs = new MutationObserver(() => {
      const now = root.getAttribute('data-theme')
      if (now === last) return
      last = now
      if (reduce()) return
      root.classList.add('theme-switching')
      clearTimeout(timer)
      // a little longer than the transition so the last frame is not cut
      timer = setTimeout(() => root.classList.remove('theme-switching'), THEME_SWITCH_MS + 50)
    })
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      obs.disconnect()
      clearTimeout(timer)
      root.classList.remove('theme-switching')
    }
  }, [])
}
