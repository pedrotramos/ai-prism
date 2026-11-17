import { useCallback, useEffect, useState } from 'react'
import { getJSON } from '../../api.js'

// Who the user is, what the org enabled (models, file types, tool policy) and
// the personal preferences kept in localStorage (theme, response language,
// notifications, chat and image model), plus the Settings dialog's open state.
// The UI language lives above the I18nProvider (main.jsx) and is not here.

const stored = (key, fallback = '') => {
  try {
    return localStorage.getItem(key) || fallback
  } catch {
    return fallback
  }
}
const persist = (key, value) => {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

export function useSettingsState({ notifyError }) {
  const [theme, setTheme] = useState(() => stored('prism-theme', 'dark'))
  const [responseLang, setResponseLang] = useState(() => stored('prism-response-lang', 'auto'))
  const [notify, setNotify] = useState(() => stored('prism-notify') === '1')
  const [email, setEmail] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [models, setModels] = useState([])
  const [supportedExt, setSupportedExt] = useState([])
  const [mediaExt, setMediaExt] = useState([])
  const [model, setModel] = useState(() => stored('prism-model'))
  // image-generation model: '' means "use the org default" (resolved server-side)
  const [imageModel, setImageModel] = useState(() => stored('prism-image-model'))
  const [imageModels, setImageModels] = useState([])
  // which model the default image selection resolves to, so the UI can name it
  // explicitly instead of an opaque "Default"
  const [imageModelDefaultId, setImageModelDefaultId] = useState(null)
  // org tool policy ({ [toolKey]: boolean }); a missing key means enabled.
  const [toolPolicy, setToolPolicy] = useState({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState(null)

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

  const applyModels = (m) => {
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
    const [me, m] = await Promise.all([getJSON('/api/me'), getJSON('/api/models')])
    setEmail(me.email)
    setIsAdmin(!!me.isAdmin)
    applyModels(m)
    getJSON('/api/image-models')
      .then((im) => {
        setImageModels(im.models || [])
        setImageModelDefaultId(im.defaultId || null)
        // prefer the server-persisted selection; fall back to the local one
        if (im.selected) setImageModel(im.selected)
      })
      .catch(() => {})
    // absent keys mean enabled, so a failure leaves everything available
    getJSON('/api/tool-policy')
      .then((tp) => setToolPolicy(tp.policy || {}))
      .catch(() => {})
  }

  // refetch after an admin edits an endpoint in Settings, so the picker's
  // names/blurbs/availability update live instead of only after a reload
  const refreshModels = useCallback(async () => {
    try {
      const m = await getJSON('/api/models')
      applyModels(m)
      return m.models
    } catch (e) {
      notifyError(e)
      return []
    }
  }, [notifyError])

  const openSettings = (tab = null) => {
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
