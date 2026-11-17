import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { I18nProvider } from './lib/i18n.jsx'
import { startDbKeepAlive } from './lib/keepAlive.js'
import './index.css'

// The UI-language preference lives here (above App) so the whole tree — App
// included — renders under the I18nProvider and can call useT(). App receives
// uiLang + setUiLang as props and forwards the setter to Preferences.
function Root() {
  const [uiLang, setUiLang] = useState(() => localStorage.getItem('prism-ui-lang') || 'auto')
  useEffect(() => {
    localStorage.setItem('prism-ui-lang', uiLang)
    document.documentElement.setAttribute(
      'lang',
      uiLang === 'auto' ? navigator.language || 'pt-BR' : uiLang
    )
  }, [uiLang])
  // scale to zero: a visible tab keeps the Lakebase endpoint awake (lib/keepAlive.js)
  useEffect(() => startDbKeepAlive(), [])
  return (
    <I18nProvider uiLang={uiLang}>
      <App uiLang={uiLang} setUiLang={setUiLang} />
    </I18nProvider>
  )
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
