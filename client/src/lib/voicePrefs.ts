// Read-aloud preferences kept in this browser (Settings → Preferences): the speaking speed. The voice itself is
// picked by lib/speech.ts from the language, so it is not stored here. Anything stored that is not one of the
// offered speeds reads as 1×, so a stale or edited value can never reach speechSynthesis.
export const READ_ALOUD_LANG = 'pt-BR'
export const VOICE_RATES = [0.8, 1, 1.25, 1.5] as const
export const VOICE_RATE_KEY = 'prism-voice-rate'

export function parseRate(raw: unknown): number {
  const n = Number(raw)
  return (VOICE_RATES as readonly number[]).includes(n) ? n : 1
}

export function readVoiceRate(): number {
  try {
    return parseRate(localStorage.getItem(VOICE_RATE_KEY))
  } catch {
    return 1
  }
}

export function writeVoiceRate(rate: number): void {
  try {
    localStorage.setItem(VOICE_RATE_KEY, String(parseRate(rate)))
  } catch {
    // storage blocked: the choice lasts for this session only
  }
}
