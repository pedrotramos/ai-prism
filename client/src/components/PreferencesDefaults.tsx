import { useId, useState } from 'react'
import * as Icon from './Icons.tsx'
import { ProviderMark } from './ProviderMark.tsx'
import { useI18n } from '../lib/i18n.tsx'
import { ttsSupported, speak, stopSpeaking } from '../lib/speech.ts'
import { VOICE_RATES, readVoiceRate, writeVoiceRate } from '../lib/voicePrefs.ts'

type Translate = (key: string, vars?: Record<string, unknown>) => string

// Settings → Preferences: what a new chat starts with and how read-aloud sounds. The model is the app's current
// model (persisted in this browser, the one a new chat starts with); the tools line is read-only: it states what
// useSessions starts a new chat with, minus what the org's tool policy turned off.
const NEW_CHAT_TOOLS = ['genie-one', 'image-gen'] // keep in step with DEFAULT_TOOLS in app/hooks/useSessions.ts

// the sample is spoken in the language it is written in (read-aloud of answers itself is set in App.tsx)
const SAMPLE_LANG: Record<string, string> = { en: 'en-US', pt: 'pt-BR', es: 'es-ES' }

export interface PreferencesDefaultsProps {
  models: Array<{ id: string; label: string; provider?: string | null }>
  model?: string
  onModelChange: (id: string) => void
  toolPolicy?: Record<string, boolean>
}

export default function PreferencesDefaults({ models, model, onModelChange, toolPolicy = {} }: PreferencesDefaultsProps) {
  const { t: tr, locale } = useI18n()
  const t = tr as Translate
  const modelId = useId()
  const rateId = useId()
  const [rate, setRate] = useState(readVoiceRate)
  const selected = models.find((m) => m.id === model)
  const names: Record<string, string> = { 'genie-one': 'Genie One', 'image-gen': t('tools.imageGen') }
  const active = NEW_CHAT_TOOLS.filter((k) => toolPolicy[k] !== false).map((k) => names[k])

  return (
    <section aria-labelledby={`${modelId}-title`} className="space-y-1">
      <h3 id={`${modelId}-title`} className="text-title font-semibold">
        {t('personal.defaults.title')}
      </h3>
      <div className="divide-y divide-[var(--border)]">
        {models.length > 0 && (
          <div className="py-3">
            <label htmlFor={modelId} className="flex items-center gap-2 text-body font-medium">
              <Icon.Sparkle size={16} className="text-[var(--muted)] shrink-0" aria-hidden />
              {t('personal.defaults.model.title')}
            </label>
            <p id={`${modelId}-hint`} className="text-label text-[var(--muted)] mt-0.5">
              {t('personal.defaults.model.hint')}
            </p>
            <div className="relative mt-2 w-full sm:w-72">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]">
                <ProviderMark model={selected ?? { id: model ?? '' }} size={16} />
              </span>
              <select
                id={modelId}
                value={selected ? selected.id : ''}
                aria-describedby={`${modelId}-hint`}
                onChange={(e) => onModelChange(e.target.value)}
                className="w-full min-h-10 rounded-control border border-[var(--border)] bg-[var(--surface-2)] pl-9 pr-3 text-body focus:border-[var(--accent)]"
              >
                {!selected && <option value="">{t('personal.defaults.model.none')}</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        <div className="py-3">
          <div className="flex items-center gap-2 text-body font-medium">
            <Icon.Database size={16} className="text-[var(--muted)] shrink-0" aria-hidden />
            {t('personal.defaults.tools.title')}
          </div>
          <p className="text-label text-[var(--muted)] mt-0.5" data-defaults-tools>
            {active.length > 0 ? t('personal.defaults.tools.summary', { list: active.join(', ') }) : t('personal.defaults.tools.none')}
          </p>
        </div>
        {ttsSupported && (
          <div className="py-3">
            <label htmlFor={rateId} className="flex items-center gap-2 text-body font-medium">
              <Icon.Speaker size={16} className="text-[var(--muted)] shrink-0" aria-hidden />
              {t('personal.voice.title')}
            </label>
            <p id={`${rateId}-hint`} className="text-label text-[var(--muted)] mt-0.5">
              {t('personal.voice.hint')}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                id={rateId}
                value={String(rate)}
                aria-describedby={`${rateId}-hint`}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  setRate(next)
                  writeVoiceRate(next)
                }}
                className="min-h-10 rounded-control border border-[var(--border)] bg-[var(--surface-2)] px-3 text-body focus:border-[var(--accent)]"
              >
                {VOICE_RATES.map((r) => (
                  <option key={r} value={String(r)}>
                    {t('personal.voice.rate', { rate: String(r) })}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => (stopSpeaking(), speak(t('personal.voice.sample'), { lang: SAMPLE_LANG[locale] ?? 'en-US', rate }))}
                className="inline-flex items-center gap-1.5 min-h-10 px-3 rounded-control border border-[var(--border)] bg-[var(--surface)] text-label font-semibold hover:bg-[var(--surface-2)] transition duration-fast"
              >
                <Icon.Play size={14} aria-hidden /> {t('personal.voice.play')}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
