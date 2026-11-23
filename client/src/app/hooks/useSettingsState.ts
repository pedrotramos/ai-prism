import { useCallback, useEffect, useState } from 'react'
import { getJSON } from '../../api.ts'

// Who the user is, what the org enabled (models, file types, tool policy) and
// the personal preferences kept in localStorage (theme, response language,
// notifications, chat and image model), plus the Settings dialog's open state.
// The UI language lives above the I18nProvider (main.tsx) and is not here.

/** A model entry of GET /api/models, as far as the shell reads it (the server sends more). */
export interface CatalogModel {
  id: string
  label: string
  provider: string
  recommended?: boolean
  vision?: boolean
  tools?: boolean
  reasoning?: { levels?: string[]; [k: string]: unknown } | boolean | null
}

interface ImageModelsPayload {
  models?: unknown[]
  defaultId?: string | null
  selected?: string
}

const stored = (key: string, fallback: string = ''): string => {
  try {
    return localStorage.getItem(key) || fallback
  } catch {
    return fallback
  }
}
const persist = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

export function useSettingsState({ notifyError }: { notifyError: (err: unknown) => void }) {
  // 'dark' | 'light' | 'system' (anything else stored is applied as is)
  const [theme, setTheme] = useState(() => stored('prism-theme', 'system'))
  const [responseLang, setResponseLang] = useState(() => stored('prism-response-lang', 'auto'))
  const [notify, setNotify] = useState(() => stored('prism-notify') === '1')
  const [email, setEmail] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [models, setModels] = useState<CatalogModel[]>([])
  const [supportedExt, setSupportedExt] = useState<string[]>([])
  const [mediaExt, setMediaExt] = useState<string[]>([])
  const [model, setModel] = useState<string | undefined>(() => stored('prism-model'))
  // image-generation model: '' means "use the org default" (resolved server-side)
  const [imageModel, setImageModel] = useState(() => stored('prism-image-model'))
  // image-model entries: the shape belongs to PersonalTab, which lists them
  const [imageModels, setImageModels] = useState<unknown[]>([])
  // which model the default image selection resolves to, so the UI can name it
  // explicitly instead of an opaque "Default"
  const [imageModelDefaultId, setImageModelDefaultId] = useState<string | null>(null)
  // org tool policy ({ [toolKey]: boolean }); a missing key means enabled.
  const [toolPolicy, setToolPolicy] = useState<Record<string, boolean>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | null>(null)

  // theme: 'dark' | 'light' | 'system'. 'system' follows the OS preference live
  // (via matchMedia) so the app tracks a mid-session OS switch without a reload.
  useEffect(() => {
    persist('prism-theme', theme)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const resolved = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme
      document.documentElement.setAttribute('data-theme', resolved)
    }
    apply()
    if (theme === 'system') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [theme])
  // response language is sent with every turn as `responseLang`
  useEffect(() => persist('prism-response-lang', responseLang), [responseLang])
  useEffect(() => persist('prism-notify', notify ? '1' : '0'), [notify])
  useEffect(() => {
    if (model) persist('prism-model', model)
  }, [model])
  useEffect(() => persist('prism-image-model', imageModel || ''), [imageModel])

  const applyModels = (m: { models: CatalogModel[]; supported_extensions: string[]; media_extensions?: string[] }) => {
    setModels(m.models)
    setSupportedExt(m.supported_extensions)
    setMediaExt(m.media_extensions || [])
    // a saved preference can point at an endpoint that no longer exists in the
    // catalog (ids change as models are updated) — drop it so the UI doesn't
    // sit on a phantom id (which would silently fall back to MODELS[0]
    // server-side on every turn)
    setModel((prev) => (prev && m.models.some((x) => x.id === prev) ? prev : m.models[0]?.id))
  }

  // boot: /api/me and /api/models are independent — fetched in parallel so the
  // model picker isn't gated behind the identity round-trip. Throws on failure
  // (the caller shows it); image models and tool policy are best-effort.
  const loadCatalog = async () => {
    const [me, m] = await Promise.all([
      getJSON<{ email: string; isAdmin?: boolean }>('/api/me'),
      getJSON<Parameters<typeof applyModels>[0]>('/api/models'),
    ])
    setEmail(me.email)
    setIsAdmin(!!me.isAdmin)
    applyModels(m)
    getJSON<ImageModelsPayload>('/api/image-models')
      .then((im) => {
        setImageModels(im.models || [])
        setImageModelDefaultId(im.defaultId || null)
        // prefer the server-persisted selection; fall back to the local one
        if (im.selected) setImageModel(im.selected)
      })
      .catch(() => {})
    // absent keys mean enabled, so a failure leaves everything available
    getJSON<{ policy?: Record<string, boolean> }>('/api/tool-policy')
      .then((tp) => setToolPolicy(tp.policy || {}))
      .catch(() => {})
  }

  // refetch after an admin edits an endpoint in Settings, so the picker's
  // names/blurbs/availability update live instead of only after a reload
  const refreshModels = useCallback(async () => {
    try {
      const m = await getJSON<Parameters<typeof applyModels>[0]>('/api/models')
      applyModels(m)
      return m.models
    } catch (e) {
      notifyError(e)
      return [] as CatalogModel[]
    }
  }, [notifyError])

  const openSettings = (tab: string | null = null) => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }
  const closeSettings = () => {
    setSettingsOpen(false)
    setSettingsTab(null)
  }

  return {
    theme, setTheme, responseLang, setResponseLang, notify, setNotify, email, isAdmin,
    models, supportedExt, mediaExt, model, setModel, imageModel, setImageModel, imageModels, imageModelDefaultId,
    toolPolicy, settingsOpen, settingsTab, openSettings, closeSettings, loadCatalog, refreshModels,
  }
}

export type SettingsState = ReturnType<typeof useSettingsState>
