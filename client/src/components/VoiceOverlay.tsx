import { useEffect, useRef, useState } from 'react'
import * as Icon from './Icons.tsx'
import {
  createRecognizer,
  dictationSupported,
  speak,
  stopSpeaking,
  plainForSpeech,
} from '../lib/speech.ts'
import { useT } from '../lib/i18n.tsx'
import { ProviderMark } from './ProviderMark.tsx'

// Movie-style caption: a sliding window of the spoken text centered on the word
// currently being read (charIndex), with that word highlighted. Scrolls with the
// audio instead of showing a fixed truncation.
interface CaptionProps {
  text: string
  charIndex: number
}

function Caption({ text, charIndex }: CaptionProps) {
  if (!text) return null
  const WINDOW = 180
  const idx = Math.min(Math.max(charIndex, 0), text.length)
  // Window bounds, snapped to word edges so we never cut mid-word.
  let start = Math.max(0, idx - Math.floor(WINDOW / 3))
  if (start > 0) {
    const sp = text.indexOf(' ', start)
    start = sp === -1 ? start : sp + 1
  }
  let end = Math.min(text.length, start + WINDOW)
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end)
    end = sp > idx ? sp : end
  }
  // Split the visible slice into [before, current word, after].
  const wordEnd = text.indexOf(' ', idx)
  const curEnd = wordEnd === -1 || wordEnd > end ? end : wordEnd
  return (
    <span>
      {start > 0 && '… '}
      <span className="opacity-60">{text.slice(start, idx)}</span>
      <span className="text-[var(--text)] font-medium">{text.slice(idx, curEnd)}</span>
      <span className="opacity-60">{text.slice(curEnd, end)}</span>
      {end < text.length && ' …'}
    </span>
  )
}

type VoiceStatus = 'idle' | 'listening' | 'thinking' | 'speaking'

interface VoiceOverlayProps {
  open: boolean
  onClose: () => void
  onSend: (text: string) => Promise<string | null | undefined>
  /** The chat's model: its mark and name show in the hint line. */
  model?: { id?: string | null; label?: string | null; provider?: string | null } | null
}

type Translate = (key: string, vars?: Record<string, unknown>) => string

// The recognizer type exported by lib/speech.ts omits start()/stop(); this is the slice used here.
interface RecognizerControls {
  start(): void
  stop(): void
}

export default function VoiceOverlay({ open, onClose, onSend, model }: VoiceOverlayProps) {
  // useT() comes from i18n.jsx (untyped JS), which infers a one-argument `t`
  const t = useT() as Translate
  const LABELS: Record<VoiceStatus, string> = {
    listening: t('voice.listening'),
    thinking: t('voice.thinking'),
    speaking: t('voice.speaking'),
    idle: t('voice.idle'),
  }
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [transcript, setTranscript] = useState('')
  // `spoken` is the normalized prose actually sent to TTS (so charIndex aligns);
  // `charIndex` is how far the speech engine has read into it.
  const [spoken, setSpoken] = useState('')
  const [charIndex, setCharIndex] = useState(0)
  const recRef = useRef<RecognizerControls | null>(null)
  const activeRef = useRef(false)
  const statusRef = useRef<VoiceStatus>('idle')
  const boundaryRef = useRef(false) // did the engine ever fire onboundary?
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const set = (s: VoiceStatus) => {
    statusRef.current = s
    setStatus(s)
  }

  const startListening = () => {
    if (!activeRef.current) return
    setTranscript('')
    set('listening')
    const rec = createRecognizer({
      lang: 'pt-BR',
      continuous: false,
      interimResults: true,
      onResult: setTranscript,
      onFinal: handleUtterance,
      onEnd: () => {
        if (activeRef.current && statusRef.current === 'listening') startListening()
      },
      onError: () => {},
    })
    if (!rec) return
    const ctl = rec as unknown as RecognizerControls // see RecognizerControls
    recRef.current = ctl
    try {
      ctl.start()
    } catch {}
  }

  const handleUtterance = async (text: string) => {
    if (!text || !text.trim() || !activeRef.current) return
    try {
      recRef.current?.stop()
    } catch {}
    set('thinking')
    try {
      const ans = await onSend(text)
      if (!activeRef.current) return
      const prose = plainForSpeech(ans)
      setSpoken(prose)
      setCharIndex(0)
      boundaryRef.current = false
      set('speaking')
      speak(prose, {
        lang: 'pt-BR',
        onStart: () => {
          // If the engine never emits word boundaries (e.g. Safari), advance the
          // caption on a timer so it still scrolls like a subtitle instead of
          // freezing. ~0.9 rate ⇒ roughly 14 chars/s of Portuguese prose.
          clearTimeout(fallbackRef.current)
          const tick = () => {
            if (!activeRef.current || boundaryRef.current) return
            setCharIndex((c) => Math.min(c + 14, prose.length))
            fallbackRef.current = setTimeout(tick, 1000)
          }
          fallbackRef.current = setTimeout(tick, 1000)
        },
        onBoundary: (i: number) => {
          boundaryRef.current = true
          clearTimeout(fallbackRef.current)
          setCharIndex(i)
        },
        onEnd: () => {
          clearTimeout(fallbackRef.current)
          if (activeRef.current) startListening()
        },
      })
    } catch {
      if (activeRef.current) startListening()
    }
  }

  useEffect(() => {
    if (open) {
      activeRef.current = true
      setSpoken('')
      setCharIndex(0)
      setTranscript('')
      startListening()
    } else {
      activeRef.current = false
      clearTimeout(fallbackRef.current)
      try {
        recRef.current?.stop()
      } catch {}
      stopSpeaking()
      set('idle')
    }
    return () => {
      activeRef.current = false
      clearTimeout(fallbackRef.current)
      try {
        recRef.current?.stop()
      } catch {}
      stopSpeaking()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // dialog behaviour: focus moves in, Tab stays inside, Escape ends, focus returns to the opener
  useEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const f = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') || [])]
      if (!f.length) return
      const first = f[0]!
      const last = f[f.length - 1]!
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus())
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus())
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      returnFocusRef.current?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const modelName = model?.label || model?.id || ''

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('voice.dialog')}
      className="fixed inset-0 z-fullscreen bg-[var(--bg)]/95 backdrop-blur-xl flex flex-col items-center justify-center"
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label={t('voice.close')}
        title={t('voice.close')}
        className="absolute top-5 right-5 grid place-items-center min-w-11 min-h-11 rounded-full hover:bg-[var(--surface-3)] text-[var(--muted)]"
      >
        <Icon.Close size={22} />
      </button>

      {!dictationSupported && (
        <p className="text-[var(--muted)] mb-6 max-w-sm text-center px-6">
          {t('voice.unsupported')}
        </p>
      )}

      {/* the orb: the spectrum is for AI activity, so it only turns while a turn is in progress */}
      <div className="relative grid place-items-center mb-10" aria-hidden>
        <div
          className={`absolute w-56 h-56 rounded-full bg-spectrum-conic opacity-20 blur-2xl ${status !== 'idle' ? 'motion-safe:animate-pulse' : ''}`}
        />
        <div
          className={`w-40 h-40 rounded-full bg-spectrum-conic grid place-items-center shadow-overlay transition-transform motion-reduce:transition-none ${
            status === 'listening' ? 'scale-105' : 'scale-100'
          } ${status === 'thinking' ? 'motion-safe:animate-spin [animation-duration:3s]' : ''}`}
        >
          <div className="w-36 h-36 rounded-full bg-raised grid place-items-center text-fg">
            <Icon.Waveform size={44} />
          </div>
        </div>
      </div>

      <div role="status" aria-live="polite" className="text-title font-semibold mb-2">{LABELS[status]}</div>
      <div className="min-h-12 max-w-lg text-center px-6 text-[var(--muted)]">
        {status === 'listening' && transcript}
        {status === 'speaking' && <Caption text={spoken} charIndex={charIndex} />}
      </div>

      <div className="flex items-center gap-3 mt-8">
        <button
          type="button"
          onClick={() => {
            stopSpeaking()
            startListening()
          }}
          className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-raised hover:bg-sunk min-h-11 px-5 py-2.5 text-body font-medium"
        >
          <Icon.Mic size={16} /> {t('voice.speakAgain')}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-2 rounded-full bg-action text-on-action hover:brightness-110 min-h-11 px-5 py-2.5 text-body font-semibold"
        >
          {t('voice.end')}
        </button>
      </div>
      <p className="absolute bottom-5 px-6 text-center text-caption text-[var(--muted)] flex items-center justify-center gap-1.5">
        {model && modelName && (
          <>
            <ProviderMark model={model} size={14} className="shrink-0" />
            <span>{t('voice.model', { name: modelName })}</span>
            <span aria-hidden>·</span>
          </>
        )}
        <span>{t('voice.footer')}</span>
      </p>
    </div>
  )
}
