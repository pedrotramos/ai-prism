import { useEffect, useState } from 'react'
import * as Icon from '../Icons.tsx'
import HtmlSlideFrame from '../deck/HtmlSlideFrame.jsx'
import ArtifactCard from './ArtifactCard.tsx'
import { getJSON } from '../../api.ts'
import { useT } from '../../lib/i18n.jsx'
import type { TFn } from '../../lib/tFn.ts'

type SlideLike = string | { html?: string } | null

interface DeckBlockProps {
  block: { type?: string; deckId?: string | number | null; title?: string; slides?: SlideLike[] }
  onOpenDeck?: (id: string | number | null | undefined) => void
}

interface LiveDeck {
  title?: string
  slides?: SlideLike[]
  meta?: { format?: string }
}

export default function DeckBlock({ block, onOpenDeck }: DeckBlockProps) {
  const t: TFn = useT()
  const [template, setTemplate] = useState<unknown>(null)
  // block.slides is a snapshot frozen when the deck was generated; the studio
  // edits the persisted deck (/api/decks/:id) without touching it. Fetch the
  // live deck by id so the card mirrors the current state, and re-fetch when the
  // studio broadcasts a save. Fall back to the snapshot while loading / on error.
  const [liveDeck, setLiveDeck] = useState<LiveDeck | null>(null)

  useEffect(() => {
    getJSON<{ template?: unknown }>('/api/deck-templates/selected')
      .then((r) => setTemplate(r.template || null))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!block.deckId) return
    let alive = true
    const load = () =>
      getJSON<{ deck?: LiveDeck }>(`/api/decks/${block.deckId}`)
        .then((d) => {
          if (alive) setLiveDeck(d?.deck || null)
        })
        .catch(() => {})
    load()
    const onSaved = (e: Event) => {
      if ((e as CustomEvent<{ deckId?: unknown }>).detail?.deckId === block.deckId) load()
    }
    window.addEventListener('prism:deck-saved', onSaved)
    return () => {
      alive = false
      window.removeEventListener('prism:deck-saved', onSaved)
    }
  }, [block.deckId])

  const slides: SlideLike[] = liveDeck?.slides || block.slides || []
  const title = liveDeck?.title || block.title
  const slideCount = slides.length
  const preview = slides.slice(0, 3)
  // Legacy decks (old semantic-tree engine, removed) have slides that are objects
  // without an `html` field — the HTML preview would render blank. Detect and
  // show a notice instead so an old card doesn't look broken.
  const isHtml =
    block.type === 'deck-html' ||
    liveDeck?.meta?.format === 'html' ||
    slides.every((s) => typeof s === 'string' || (s && typeof s === 'object' && typeof s.html === 'string'))

  const meta = t('deckBlock.slideCount', {
    count: slideCount,
    slide: slideCount !== 1 ? t('deckBlock.slidePlural') : t('deckBlock.slideSingular'),
  })

  return (
    <ArtifactCard
      kind="deck"
      icon={<Icon.Presentation size={18} />}
      title={title}
      meta={meta}
      primary={
        isHtml
          ? {
              icon: <Icon.Presentation size={15} />,
              label: t('deckBlock.openStudio'),
              onClick: () => onOpenDeck?.(block.deckId),
              disabled: !block.deckId,
            }
          : null
      }
    >
      {isHtml ? (
        <div className="grid grid-cols-3 gap-2">
          {preview.map((s, i) => (
            <HtmlSlideFrame key={i} html={typeof s === 'string' ? s : s?.html} template={template} title={`${title} — ${i + 1}`} className="rounded-badge" />
          ))}
        </div>
      ) : (
        <p className="text-label text-muted">{t('deckBlock.legacy')}</p>
      )}
    </ArtifactCard>
  )
}
