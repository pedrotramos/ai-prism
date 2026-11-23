import { useMemo } from 'react'
import type { ReactNode } from 'react'
import Logo from './Logo.tsx'
import * as Icon from './Icons.tsx'
import ProjectPicker from './welcome/ProjectPicker.tsx'
import { useT } from '../lib/i18n.tsx'
import { buildSuggestions, firstNameFromEmail, greetingKey, pickRecents, recencyBucket } from './welcome/suggestions.ts'

// Glyph per start card.
const ICONS: Record<string, typeof Icon.Sparkle> = {
  data: Icon.Database,
  artifact: Icon.Presentation,
  docs: Icon.FileText,
}

// First screen of every new chat: the greeting and lead line, an optional
// "start in a project" picker, the composer (centred), three start cards that
// prefill it, and the user's most recent chats.
//
// Props are optional so the screen degrades instead of breaking:
// - onPick(text): prefill the composer. Without it, no start cards are shown
//   (a button that does nothing would be a dead end).
// - email: greets by first name for first.last addresses.
// - projects + onStartInProject: show the project picker (both are needed).
// - composer: the composer node, rendered between the lead and the cards.
// - recents + onOpenRecent: the caller's recent chats (client-side, from the
//   sessions list); both are needed, nothing is shown otherwise.
// - enabledTools / toolPolicy / imageModels: still passed by the caller, no
//   longer read here (the three cards are fixed).
export interface WelcomeProps {
  onPick?: (text: string) => void
  email?: string
  enabledTools?: { kind: string }[]
  toolPolicy?: Record<string, boolean>
  imageModels?: unknown[]
  projects?: Array<{ id: number; name: string }>
  onStartInProject?: (projectId: number | null) => void
  composer?: ReactNode
  recents?: Array<{ id: number | string; title: string; updatedAt: string }>
  onOpenRecent?: (id: number | string) => void
}

type Translate = (key: string, vars?: Record<string, unknown>) => string

export default function Welcome({ onPick, email, projects, onStartInProject, composer, recents, onOpenRecent }: WelcomeProps) {
  // useT() comes from i18n.jsx (untyped JS), which infers a one-argument `t`
  const t = useT() as Translate
  const suggestions = useMemo(() => buildSuggestions(), [])
  const recent = useMemo(() => (onOpenRecent ? pickRecents(recents) : []), [recents, onOpenRecent])
  const name = firstNameFromEmail(email)
  const part = greetingKey()
  const greeting = name ? t(`welcome.greetingNamed.${part}`, { name }) : t(`welcome.greeting.${part}`)

  return (
    <div className="min-h-full flex flex-col px-4 sm:px-8 py-section animate-fade-in">
      <div className="w-full max-w-3xl m-auto">
        <div className="grid place-items-center w-11 h-11 rounded-panel bg-raised border border-[var(--border)] text-[var(--text)] mb-4">
          <Logo size={30} />
        </div>
        <h1 className="text-display font-semibold tracking-tight text-balance">{greeting}</h1>
        <p className="mt-1.5 text-body text-[var(--muted)] text-balance">{t('welcome.lead')}</p>

        {projects && onStartInProject && (
          <div className="mt-5">
            <ProjectPicker projects={projects} onStartInProject={onStartInProject} />
          </div>
        )}

        {composer && <div className="mt-3">{composer}</div>}

        {onPick && (
          <ul aria-label={t('welcome.suggestionsLabel')} className="mt-5 grid gap-2.5 grid-cols-1 sm:grid-cols-3">
            {suggestions.map((s) => (
              <li key={s.id} className="flex">
                <StartCard id={s.id} t={t} onPick={onPick} />
              </li>
            ))}
          </ul>
        )}

        {recent.length > 0 && (
          <section className="mt-8" aria-labelledby="welcome-recents">
            <h2 id="welcome-recents" className="mb-2.5 text-label font-medium text-[var(--muted)]">
              {t('welcome.recents.heading')}
            </h2>
            <ul aria-label={t('welcome.recents.label')} className="grid gap-2.5 grid-cols-1 sm:grid-cols-3">
              {recent.map((r) => (
                <li key={r.id} className="flex">
                  <button
                    type="button"
                    data-recent={r.id}
                    onClick={() => onOpenRecent!(r.id)}
                    className="w-full min-h-11 flex flex-col gap-1 rounded-card border border-[var(--border)] bg-raised hover:border-[var(--muted)] p-3 text-left transition-colors duration-fast"
                  >
                    <span className="text-body font-medium line-clamp-2">{r.title}</span>
                    <span className="text-caption text-[var(--muted)]">{t(`welcome.recents.${recencyBucket(r.updatedAt)}`)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}

interface StartCardProps {
  id: string
  t: Translate
  onPick: (text: string) => void
}

function StartCard({ id, t, onPick }: StartCardProps) {
  const Glyph = ICONS[id] || Icon.Sparkle
  return (
    <button
      type="button"
      data-suggestion={id}
      onClick={() => onPick(t(`welcome.suggestion.${id}.prompt`))}
      className="group w-full flex flex-row items-center sm:flex-col sm:items-start gap-3 sm:gap-2 rounded-panel border border-[var(--border)] bg-raised hover:border-[var(--muted)] p-3.5 min-h-11 sm:min-h-28 text-left transition-colors duration-fast"
    >
      <span aria-hidden className="grid place-items-center w-7 h-7 rounded-control bg-sunk text-[var(--muted)] group-hover:text-[var(--text)] transition-colors duration-fast">
        <Glyph size={16} />
      </span>
      <span className="text-body font-semibold text-[var(--text)]">{t(`welcome.suggestion.${id}.title`)}</span>
      {/* phones: icon and title only, so the three cards and the composer fit one screen */}
      <span className="hidden sm:block text-label text-[var(--muted)] leading-snug">{t(`welcome.suggestion.${id}.desc`)}</span>
    </button>
  )
}
