import { useEffect, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import {
  createRecognizer,
  dictationSupported,
  speak,
  stopSpeaking,
  plainForSpeech,
} from '../lib/speech.ts'
import { useT } from '../lib/i18n.jsx'

// Movie-style caption: a sliding window of the spoken text centered on the word
// currently being read (charIndex), with that word highlighted. Scrolls with the
// audio instead of showing a fixed truncation.
function Caption({ text, charIndex }) {
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

export default function VoiceOverlay({ open, onClose, onSend }) {
  const t = useT()
  const LABELS = {
    listening: t('voice.listening'),
    thinking: t('voice.thinking'),
    speaking: t('voice.speaking'),
    idle: t('voice.idle'),
  }
  const [status, setStatus] = useState('idle')
  const [transcript, setTranscript] = useState('')
  // `spoken` is the normalized prose actually sent to TTS (so charIndex aligns);
  // `charIndex` is how far the speech engine has read into it.
  const [spoken, setSpoken] = useState('')
  const [charIndex, setCharIndex] = useState(0)
  const recRef = useRef(null)
  const activeRef = useRef(false)
  const statusRef = useRef('idle')
  const boundaryRef = useRef(false) // did the engine ever fire onboundary?
  const fallbackRef = useRef(null)

  const set = (s) => {
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
    recRef.current = rec
    try {
      rec.start()
    } catch {}
  }

  const handleUtterance = async (text) => {
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
        onBoundary: (i) => {
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

  if (!open) return null

  const ring =
    status === 'speaking'
      ? 'from-blue-500 via-emerald-400 to-lava'
      : status === 'thinking'
        ? 'from-amber-400 to-lava'
        : 'from-lava to-orange-400'

  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg)]/95 backdrop-blur-xl flex flex-col items-center justify-center">
      <button
        onClick={onClose}
        className="absolute top-5 right-5 p-2.5 rounded-full hover:bg-[var(--surface-3)] text-[var(--muted)]"
      >
        <Icon.Close size={22} />
      </button>

      {!dictationSupported && (
        <p className="text-[var(--muted)] mb-6 max-w-sm text-center px-6">
          {t('voice.unsupported')}
        </p>
      )}

      <div className="relative grid place-items-center mb-10">
        <div
          className={`absolute w-56 h-56 rounded-full bg-gradient-to-br ${ring} opacity-20 blur-2xl ${
            status !== 'idle' ? 'animate-pulse' : ''
          }`}
        />
        <div
          className={`w-40 h-40 rounded-full bg-gradient-to-br ${ring} grid place-items-center shadow-2xl transition-transform ${
            status === 'listening' ? 'scale-105' : 'scale-100'
          }`}
        >
          <div className="w-36 h-36 rounded-full bg-[var(--bg)]/70 backdrop-blur grid place-items-center text-on-accent">
            <Icon.Waveform size={44} />
          </div>
        </div>
      </div>

      <div className="text-title font-semibold mb-2">{LABELS[status]}</div>
      <div className="min-h-12 max-w-lg text-center px-6 text-[var(--muted)]">
        {status === 'listening' && transcript}
        {status === 'speaking' && <Caption text={spoken} charIndex={charIndex} />}
      </div>

      <div className="flex items-center gap-3 mt-8">
        <button
          onClick={() => {
            stopSpeaking()
            startListening()
          }}
          className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] px-5 py-2.5 text-body font-medium"
        >
          <Icon.Mic size={16} /> {t('voice.speakAgain')}
        </button>
        <button
          onClick={onClose}
          className="flex items-center gap-2 rounded-full bg-[var(--accent)] hover:brightness-110 text-on-accent px-5 py-2.5 text-body font-semibold"
        >
          {t('voice.end')}
        </button>
      </div>
      <p className="absolute bottom-5 text-caption text-[var(--faint)]">
        {t('voice.footer')}
      </p>
    </div>
  )
}
