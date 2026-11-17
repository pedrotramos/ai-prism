import { createContext, useContext, useMemo } from 'react'
import { pt, en, es } from './locales/index.js'

// Minimal, dependency-free i18n. Strings live in flat key→string catalogs
// (locales/<lang>/<domain>.js, merged per language by locales/index.js); the
// UI reads them via the `t()` returned by useI18n(). Keys are dotted (e.g.
// 'sidebar.newChat'); a missing key falls back to the pt catalog (source language) and finally to the key itself, so a not-yet-
// translated string still renders sensible text instead of blank.
//
// Interpolation: t('x.y', { name: 'Ana' }) replaces {name} in the template.
const CATALOGS = { pt, en, es }

// The UI-language preference is 'auto' | 'pt-BR' | 'en' | 'es' (see PersonalTab).
// 'auto' resolves against the browser language; anything we don't have a
// catalog for degrades to pt (the source language, always complete).
export function resolveLocale(uiLang) {
  if (uiLang && uiLang !== 'auto') {
    const base = uiLang.toLowerCase().split('-')[0]
    if (CATALOGS[base]) return base
  }
  const nav = (typeof navigator !== 'undefined' && navigator.language) || 'pt'
  const base = nav.toLowerCase().split('-')[0]
  return CATALOGS[base] ? base : 'pt'
}

function interpolate(str, vars) {
  if (!vars) return str
  return str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

const I18nContext = createContext({ locale: 'pt', t: (k) => k })

export function I18nProvider({ uiLang, children }) {
  const locale = resolveLocale(uiLang)
  const t = useMemo(() => {
    const primary = CATALOGS[locale] || pt
    return (key, vars) => {
      const raw = primary[key] ?? pt[key] ?? key
      return interpolate(raw, vars)
    }
  }, [locale])
  const value = useMemo(() => ({ locale, t }), [locale, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  return useContext(I18nContext)
}

// Convenience hook when a component only needs the translator function.
export function useT() {
  return useContext(I18nContext).t
}

// Standalone helper for non-component modules (rare) — resolves against a given
// locale without the context. Kept for symmetry; prefer useT() in components.
export function translate(locale, key, vars) {
  const primary = CATALOGS[locale] || pt
  const raw = primary[key] ?? pt[key] ?? key
  return interpolate(raw, vars)
}
