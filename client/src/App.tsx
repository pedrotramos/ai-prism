import { useCallback, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { speak, plainForSpeech } from './lib/speech.ts'
import { pushHash } from './lib/hashRouter.ts'
import { useT } from './lib/i18n.tsx'
import Shell from './app/Shell.tsx'
import type { ShellPersonal } from './app/Shell.tsx'
import { useToasts } from './app/Toasts.tsx'
import { useSettingsState } from './app/hooks/useSettingsState.ts'
import { useSessions } from './app/hooks/useSessions.ts'
import { useStudios } from './app/hooks/useStudios.ts'
import { useDeckFocus } from './app/hooks/useDeckFocus.ts'
import { useTurnStream } from './app/hooks/useTurnStream.ts'

// The app's state, wired together. Each concern lives in its own hook:
//   useToasts          notifications (friendly error copy, Details)
//   useSettingsState   identity, catalog, personal preferences, Settings dialog
//   useSessions        conversation list, open conversation, navigation, per-chat settings
//   useStudios         deck / spreadsheet / document Studios
//   useDeckFocus       sidebar rail, mobile drawer, deck focus layout
//   useTurnStream      the three turn routes and the actions built on them
// Layout lives in app/Shell.tsx; error containment in app/ErrorBoundary.tsx.
interface AppProps {
  uiLang: string
  setUiLang: Dispatch<SetStateAction<string>>
}

export default function App({ uiLang, setUiLang }: AppProps) {
  const t = useT()
  const toasts = useToasts()
  const { notifyError, pushToast } = toasts
  const cfg = useSettingsState({ notifyError })
  const s = useSessions({ notifyError, onSessionModel: cfg.setModel })
  const studios = useStudios({ currentId: s.currentId, navKey: s.navKey })
  const layout = useDeckFocus({ deckStudioId: studios.deckStudioId, navKey: s.navKey })
  const turn = useTurnStream({ s, cfg, studios, notifyError, pushToast, t, uiLang })
  const [voiceOpen, setVoiceOpen] = useState(false)

  useEffect(() => {
    s.boot(cfg.loadCatalog)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // "Create with Claude" from the Skills settings tab: close Settings, start a
  // fresh chat and pre-fill the composer with a prompt that starts a guided
  // skill-authoring conversation.
  const startSkillCreator = () => {
    if (s.streaming) return
    cfg.closeSettings()
    s.resetToNewChat()
    pushHash('#/chat')
    s.setInput(t('skillCreator.prompt'))
  }

  // stable across renders so memo(Message) can skip finished bubbles
  const speakText = useCallback((text: string) => speak(plainForSpeech(text), { lang: 'pt-BR' }), [])

  const personal: ShellPersonal = {
    theme: cfg.theme,
    setTheme: cfg.setTheme,
    uiLang,
    setUiLang,
    responseLang: cfg.responseLang,
    setResponseLang: cfg.setResponseLang,
    notify: cfg.notify,
    setNotify: cfg.setNotify,
    imageModel: cfg.imageModel,
    setImageModel: cfg.setImageModel,
    imageModels: cfg.imageModels,
    imageModelDefaultId: cfg.imageModelDefaultId,
  }

  return (
    <Shell
      s={s}
      cfg={cfg}
      turn={turn}
      studios={studios}
      layout={layout}
      toasts={toasts}
      voice={{ open: voiceOpen, setOpen: setVoiceOpen }}
      personal={personal}
      onCreateSkill={startSkillCreator}
      speakText={speakText}
    />
  )
}
