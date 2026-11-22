import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { pt, en, es } from './locales/index.ts'

// Minimal, dependency-free i18n. Strings live in flat key→string catalogs
// (locales/<lang>/<domain>.js); the UI reads them via the `t()` returned by
// useI18n(). Keys are dotted (e.g. 'sidebar.newChat'); a missing key falls back
// to the English catalog, then to pt (the source language, always complete),
// and finally to the key itself, so a not-yet-translated string still renders
// sensible text instead of blank.
//
// Interpolation: t('x.y', { name: 'Ana' }) replaces {name} in the template.
const CATALOGS: Record<string, Record<string, string>> = { pt, en, es }

// the translator the context hands out: `vars` fills {name} placeholders
type Translator = (key: string, vars?: Record<string, unknown>) => string

// English is the default language of the product and its documentation, so a
// browser language we do not ship (fr, de, ja, ...) gets the English UI rather
// than Portuguese, which most of those users cannot read.
export const FALLBACK_LOCALE = 'en'

const baseOf = (tag: string | null | undefined): string => String(tag || '').toLowerCase().split('-')[0] ?? ''
const browserLanguage = () => (typeof navigator !== 'undefined' && navigator.language) || ''

// The UI-language preference is 'auto' | 'pt-BR' | 'en' | 'es' (see PersonalTab).
// An explicit preference we ship wins; otherwise ('auto', or a stored value we
// no longer ship) the browser language decides, and anything we do not have a
// catalog for degrades to FALLBACK_LOCALE. `navLang` is injectable for tests.
export function resolveLocale(uiLang: string | null | undefined, navLang: string = browserLanguage()): string {
  if (uiLang && uiLang !== 'auto' && CATALOGS[baseOf(uiLang)]) return baseOf(uiLang)
  const base = baseOf(navLang)
  return CATALOGS[base] ? base : FALLBACK_LOCALE
}

// FALLBACK_LOCALE is a key of CATALOGS, so the `!` lookups below always hit
const lookup = (locale: string, key: string): string => (CATALOGS[locale] || CATALOGS[FALLBACK_LOCALE]!)[key] ?? CATALOGS[FALLBACK_LOCALE]![key] ?? pt[key] ?? key

function interpolate(str: string, vars?: Record<string, unknown>): string {
  if (!vars) return str
  return str.replace(/\{(\w+)\}/g, (m: string, k: string) => (k in vars ? String(vars[k]) : m))
}

const I18nContext = createContext<{ locale: string; t: Translator }>({ locale: FALLBACK_LOCALE, t: (k) => k })

interface I18nProviderProps {
  uiLang: string | null | undefined
  children?: ReactNode
}

export function I18nProvider({ uiLang, children }: I18nProviderProps) {
  const locale = resolveLocale(uiLang)
  const t = useMemo((): Translator => (key, vars) => interpolate(lookup(locale, key), vars), [locale])
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
export function translate(locale: string, key: string, vars?: Record<string, unknown>): string {
  return interpolate(lookup(locale, key), vars)
}
