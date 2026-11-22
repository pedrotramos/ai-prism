import { useId, useMemo } from 'react'
import Logo from './Logo.tsx'
import * as Icon from './Icons.tsx'
import { useT } from '../lib/i18n.jsx'
import { buildSuggestions, firstNameFromEmail, greetingKey, welcomeCapabilities } from './welcome/suggestions.ts'

// Glyph per starter id; an unknown id falls back to Icon.Sparkle.
const ICONS: Record<string, typeof Icon.Sparkle> = {
  data: Icon.Database,
  deck: Icon.Presentation,
  sheet: Icon.SpreadsheetFile,
  doc: Icon.FileText,
  image: Icon.Image,
  write: Icon.Pencil,
}

// First screen of every new chat: a greeting and a short list of starters that
// prefill the composer (the user finishes the sentence and sends). Which
// starters appear follows what this installation can actually do
// (welcome/suggestions.js); exactly one is the primary action.
//
// Props are optional so the screen degrades instead of breaking:
// - onPick(text): prefill the composer. Without it, no starters are shown
//   (a button that does nothing would be a dead end).
// - email: greets by first name for first.last addresses.
// - enabledTools / toolPolicy / imageModels: the same state the header pickers
//   use; they decide whether the data and image starters appear.
interface WelcomeProps {
  onPick?: (text: string) => void
  email?: string
  enabledTools?: { kind: string }[]
  toolPolicy?: Record<string, boolean>
  imageModels?: unknown[]
}

type Translate = (key: string, vars?: Record<string, unknown>) => string

export default function Welcome({ onPick, email, enabledTools, toolPolicy, imageModels }: WelcomeProps) {
  // useT() comes from i18n.jsx (untyped JS), which infers a one-argument `t`
  const t = useT() as Translate
  const hintId = useId()
  const caps = useMemo(
    () => welcomeCapabilities({ enabledTools, toolPolicy, imageModels }),
    [enabledTools, toolPolicy, imageModels]
  )
  const suggestions = useMemo(() => buildSuggestions(caps), [caps])
  const name = firstNameFromEmail(email)
  const part = greetingKey()
  const greeting = name ? t(`welcome.greetingNamed.${part}`, { name }) : t(`welcome.greeting.${part}`)
  // buildSuggestions always returns at least four starters, so `primary` is defined
  const [primary, ...rest] = suggestions

  return (
    <div className="min-h-full flex flex-col items-center justify-center px-4 py-section animate-fade-in">
      <div className="w-full max-w-2xl">
        <div className="flex flex-col items-center text-center">
          <Logo size={44} />
          <h1 className="mt-4 text-display font-extrabold tracking-tight text-balance">{greeting}</h1>
          <p className="mt-2 max-w-md text-body text-[var(--muted)] text-balance">{t('welcome.subtitle')}</p>
        </div>

        {onPick && (
          <div className="mt-8">
            <ul aria-label={t('welcome.suggestionsLabel')} aria-describedby={hintId} className="grid gap-in-group sm:grid-cols-2">
              <li className="sm:col-span-2">
                <Starter s={primary!} t={t} onPick={onPick} primary />
              </li>
              {rest.map((s, i) => (
                // an odd count would leave the last starter alone on its row
                <li key={s.id} className={rest.length % 2 && i === rest.length - 1 ? 'sm:col-span-2' : undefined}>
                  <Starter s={s} t={t} onPick={onPick} />
                </li>
              ))}
            </ul>
            <p id={hintId} className="mt-3 text-center text-caption text-[var(--faint)]">
              {t('welcome.prefillHint')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

interface StarterProps {
  s: { id: string }
  t: Translate
  onPick: (text: string) => void
  primary?: boolean
}

function Starter({ s, t, onPick, primary = false }: StarterProps) {
  const Glyph = ICONS[s.id] || Icon.Sparkle
  return (
    <button
      type="button"
      data-suggestion={s.id}
      data-primary={primary ? 'true' : undefined}
      onClick={() => onPick(t(`welcome.suggestion.${s.id}.prompt`))}
      className={`group w-full min-h-12 sm:min-h-14 flex items-center gap-3 rounded-card border px-3 sm:px-4 py-2 sm:py-3 text-left transition-colors duration-fast ${
        primary
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] hover:bg-[var(--surface-2)]'
          : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] hover:border-[var(--muted)]'
      }`}
    >
      <span
        aria-hidden
        className={`shrink-0 grid place-items-center w-9 h-9 rounded-control ${
          primary ? 'bg-[var(--accent-strong)] text-[var(--on-accent)]' : 'bg-[var(--surface-3)] text-[var(--muted)] group-hover:text-[var(--text)]'
        }`}
      >
        <Glyph size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-semibold text-[var(--text)]">{t(`welcome.suggestion.${s.id}.title`)}</span>
        {/* phones: title only, so six starters still fit above the composer */}
        <span className="hidden sm:block text-label text-[var(--muted)]">{t(`welcome.suggestion.${s.id}.desc`)}</span>
      </span>
      <Icon.ChevronRight size={16} aria-hidden className="shrink-0 text-[var(--faint)] group-hover:text-[var(--text)] transition-colors duration-fast" />
    </button>
  )
}
