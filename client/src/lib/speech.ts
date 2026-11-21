// Thin wrappers around the browser Web Speech API for dictation (speech->text)
// and TTS (text->speech). Works in Chrome/Edge; degrades gracefully elsewhere.

// lib.dom has no Web Speech recognition types: declare the slice this module uses.
interface RecognitionAlternative {
  transcript: string
}
interface RecognitionResult {
  isFinal: boolean
  [index: number]: RecognitionAlternative | undefined
}
interface RecognitionEvent {
  resultIndex: number
  results: { length: number; [index: number]: RecognitionResult | undefined }
}
interface Recognizer {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: RecognitionEvent) => void) | null
  onend: (() => void) | null
  onerror: ((e: unknown) => void) | null
}
type RecognizerCtor = new () => Recognizer
type SpeechWindow = Window & { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor }

const SR: RecognizerCtor | false | undefined =
  typeof window !== 'undefined' && ((window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition)

export const dictationSupported = !!SR
export const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

/**
 * Create a speech recognizer.
 * opts: { lang, continuous, interimResults, onResult, onFinal, onEnd, onError }
 *   onResult(text) — running transcript (interim + final)
 *   onFinal(text)  — a finalized utterance
 */
interface RecognizerOptions {
  lang?: string
  continuous?: boolean
  interimResults?: boolean
  onResult?: (text: string) => void
  onFinal?: (text: string) => void
  onEnd?: () => void
  onError?: (e: unknown) => void
}

export function createRecognizer(opts: RecognizerOptions = {}): Recognizer | null {
  if (!SR) return null
  const rec = new SR()
  rec.lang = opts.lang || 'pt-BR'
  rec.continuous = opts.continuous ?? true
  rec.interimResults = opts.interimResults ?? true

  rec.onresult = (e: RecognitionEvent) => {
    let interim = ''
    let final = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i]! // i < results.length: same access (and same throw on a malformed event) as before
      const t = res[0]!.transcript
      if (res.isFinal) final += t
      else interim += t
    }
    if (final && opts.onFinal) opts.onFinal(final.trim())
    if (opts.onResult) opts.onResult((final + interim).trim())
  }
  rec.onend = () => opts.onEnd && opts.onEnd()
  rec.onerror = (e: unknown) => opts.onError && opts.onError(e)
  return rec
}

let currentUtterance: SpeechSynthesisUtterance | null = null

// Picks the most natural available voice for a language. Cloud/"neural" voices
// (localService === false) sound markedly better than the built-in OS voices, so
// prefer those; among equals, prefer an exact lang match, then a same-language
// one. Some engines mark premium voices in the name ("Natural", "Enhanced").
function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices()
  if (!voices.length) return null
  const base = lang.slice(0, 2)
  const sameLang = voices.filter((v) => v.lang === lang)
  const sameBase = voices.filter((v) => v.lang?.startsWith(base))
  const pool = sameLang.length ? sameLang : sameBase
  if (!pool.length) return null
  const premium = /natural|neural|enhanced|premium|siri|google/i
  const score = (v: SpeechSynthesisVoice) =>
    (v.localService === false ? 2 : 0) + (premium.test(v.name || '') ? 1 : 0)
  return [...pool].sort((a, b) => score(b) - score(a))[0] as SpeechSynthesisVoice // pool is non-empty here
}

// Splits speaker-ready prose into sentence-ish chunks. Speaking sentence by
// sentence gives the engine natural pauses/prosody instead of one flat run-on,
// and keeps `onboundary` charIndex values anchored to a known offset per chunk.
function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]+(\s|$)|[^.!?…]+$/g)
  return parts ? parts.map((s: string) => s.trim()).filter(Boolean) : [text]
}

interface SpeakOptions {
  lang?: string
  rate?: number
  pitch?: number
  onStart?: () => void
  onBoundary?: (charIndex: number, charLength: number) => void
  onEnd?: () => void
}

export function speak(text: string, opts: SpeakOptions = {}): void {
  if (!ttsSupported || !text) return
  window.speechSynthesis.cancel()
  const lang = opts.lang || 'pt-BR'
  const voice = pickVoice(lang)

  const chunks = splitSentences(text)
  let base = 0 // char offset of the current chunk within the full text
  let started = false

  const speakChunk = (i: number): void => {
    const chunk = chunks[i]
    if (chunk === undefined) return
    const u = new SpeechSynthesisUtterance(chunk)
    u.lang = lang
    u.rate = opts.rate || 1.0
    u.pitch = opts.pitch || 1.0
    if (voice) u.voice = voice

    u.onstart = () => {
      if (!started) {
        started = true
        opts.onStart && opts.onStart()
      }
    }
    // Report progress against the FULL text (base + local index) so a caption can
    // track the spoken word across chunks.
    u.onboundary = (e) => opts.onBoundary && opts.onBoundary(base + (e.charIndex || 0), e.charLength || 0)
    u.onend = () => {
      base += chunk.length + 1 // +1 for the separator dropped by trim/split
      if (i + 1 < chunks.length) speakChunk(i + 1)
      else opts.onEnd && opts.onEnd()
    }
    currentUtterance = u
    window.speechSynthesis.speak(u)
  }
  speakChunk(0)
}

export function stopSpeaking(): void {
  if (ttsSupported) window.speechSynthesis.cancel()
  currentUtterance = null
}

// Strip markdown so TTS reads naturally.
export function plainForSpeech(md?: string | null): string {
  return (md || '')
    .replace(/```[\s\S]*?```/g, ' bloco de código. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>~|]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
