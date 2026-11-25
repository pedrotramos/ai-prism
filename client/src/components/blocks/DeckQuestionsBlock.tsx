import { useState, useMemo } from 'react'
import type { KeyboardEvent } from 'react'
import * as Icon from '../Icons.tsx'
import { useT } from '../../lib/i18n.tsx'
import BlockFrame from './BlockFrame.tsx'

// The clarifying-questions step of the deck flow (see DECK_POLICY in
// server/blocks.js). The model authors the questions fresh per request, so this
// only renders whatever shape shows up.
//
// Answers are PERSISTED into the block once submitted (block.answers), so the
// box shows the history on reload and can be re-opened for editing. Editing +
// re-submitting regenerates the follow-up turn (via App's onSubmitAnswers,
// which reuses the message edit+regenerate flow). Fresh (unanswered) + latest =
// interactive; answered = filled read-only with an "Editar respostas" button.
type Answer = string | string[]

interface Question {
  id: string
  type?: string
  label: string
  description?: string
  options?: string[]
}

interface DeckQuestionsBlockProps {
  block: { questions?: Question[]; answers?: Record<string, Answer> | null; intro?: string }
  msgId?: string | number
  isLatest?: boolean
  onSubmitAnswers?: (text: string, meta: { msgId?: string | number; answers: Record<string, Answer>; isEdit: boolean }) => Promise<unknown> | unknown
}

export default function DeckQuestionsBlock({ block, msgId, isLatest, onSubmitAnswers }: DeckQuestionsBlockProps) {
  const t = useT()
  const questions = block.questions || []
  const persisted = block.answers || null

  // seed local edit state from persisted answers (so editing starts filled)
  const seed = useMemo(() => {
    const answers: Record<string, Answer> = {}
    const custom: Record<string, string> = {}
    if (persisted) {
      for (const q of questions) {
        const v = persisted[q.id]
        if (v == null) continue
        if (q.type === 'multi') {
          const picked: string[] = Array.isArray(v) ? v : [v]
          // options that aren't in the known set become the "Outros" text
          const known = picked.filter((p) => (q.options || []).includes(p))
          const extra = picked.filter((p) => !(q.options || []).includes(p))
          answers[q.id] = known
          if (extra.length) custom[q.id] = extra.join(', ')
        } else if (q.type === 'text') {
          answers[q.id] = v
        } else {
          if ((q.options || []).includes(v as string)) answers[q.id] = v
          else custom[q.id] = v as string
        }
      }
    }
    return { answers, custom }
  }, [persisted, questions])

  const [answers, setAnswers] = useState(seed.answers)
  const [customText, setCustomText] = useState(seed.custom)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  // interactive when: fresh unanswered latest message, OR the user clicked edit
  const interactive = (!persisted && isLatest) || editing

  const setSingle = (qid: string, value: string) => setAnswers((a) => ({ ...a, [qid]: value }))
  const setText = (qid: string, value: string) => setAnswers((a) => ({ ...a, [qid]: value }))
  const setCustom = (qid: string, value: string) => setCustomText((c) => ({ ...c, [qid]: value }))
  const toggleMulti = (qid: string, value: string) =>
    setAnswers((a) => {
      const cur = new Set<string>((a[qid] as string[] | undefined) || [])
      if (cur.has(value)) cur.delete(value)
      else cur.add(value)
      return { ...a, [qid]: Array.from(cur) }
    })

  // builds { answersMap, text } from the current inputs — answersMap persists
  // into the block; text is the follow-up user message the model reads.
  const collect = () => {
    const answersMap: Record<string, Answer> = {}
    const lines = questions.map((q) => {
      const custom = (customText[q.id] || '').trim()
      let value: string
      if (q.type === 'multi') {
        const picked = (answers[q.id] as string[] | undefined) || []
        const all = custom ? [...picked, custom] : picked
        if (all.length) answersMap[q.id] = all
        value = all.length ? all.join(', ') : t('deckQuestions.notSpecified')
      } else if (q.type === 'text') {
        const v = ((answers[q.id] as string | undefined) || '').trim()
        if (v) answersMap[q.id] = v
        value = v || t('deckQuestions.notSpecified')
      } else {
        const v = custom || (answers[q.id] as string | undefined) || ''
        if (v) answersMap[q.id] = v
        value = v || t('deckQuestions.notSpecified')
      }
      return `- ${q.label}: ${value}`
    })
    return { answersMap, text: `${t('deckQuestions.answeredHeading')}\n${lines.join('\n')}` }
  }

  const submit = async () => {
    if (busy) return
    setBusy(true)
    const { answersMap, text } = collect()
    const wasEditing = editing
    try {
      await onSubmitAnswers?.(text, { msgId, answers: answersMap, isEdit: wasEditing })
    } finally {
      setBusy(false)
      setEditing(false)
    }
  }

  // read-only value renderer for the answered state
  const answeredValue = (q: Question) => {
    const v = persisted?.[q.id]
    if (v == null) return <span className="text-[var(--faint)] italic">{t('deckQuestions.notSpecified')}</span>
    return Array.isArray(v) ? v.join(', ') : v
  }

  const answered = !!persisted && !editing

  // Single choice is a radio group (arrows move and select, one tab stop);
  // multiple choice is a set of checkboxes (each one tabbable, Space toggles).
  // Enter and Space work on every chip because each one is a real button.
  const pickByArrow = (e: KeyboardEvent<HTMLButtonElement>, q: Question, i: number) => {
    const opts = q.options || []
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % opts.length : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + opts.length) % opts.length : -1
    if (next < 0) return
    e.preventDefault()
    setSingle(q.id, opts[next]!)
    const sib = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]
    sib?.focus()
  }

  const heading = answered ? t('deckQuestions.answered') : interactive ? t('deckQuestions.aboutDeck') : t('deckQuestions.title')

  return (
    <BlockFrame
      block="deck-questions"
      title={
        <span className="flex items-center gap-2">
          <Icon.Presentation size={16} className="text-accent shrink-0" />
          <span>{heading}</span>
          {answered && <Icon.Check size={14} className="text-accent shrink-0" />}
        </span>
      }
      subtitle={block.intro}
      actions={
        answered && !isLatest && onSubmitAnswers ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="tap-target ml-auto flex items-center gap-1 rounded-control px-2 text-label text-muted hover:text-accent-text hover:bg-surface-3 transition-colors duration-fast"
            title={t('deckQuestions.editAnswersTitle')}
          >
            <Icon.Pencil size={12} /> {t('deckQuestions.editAnswers')}
          </button>
        ) : undefined
      }
    >
      <div className="px-4 pt-2 pb-4 space-y-4">
        {/* answered read-only summary */}
        {answered ? (
          <div className="space-y-2.5">
            {questions.map((q) => (
              <div key={q.id} className="text-body">
                <div className="font-medium">{q.label}</div>
                <div className="text-muted mt-0.5">{answeredValue(q)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            {questions.map((q) => {
              const labelId = `dq-${String(msgId ?? 'm')}-${q.id}`
              const multi = q.type === 'multi'
              const overridden = q.type === 'single' && !!(customText[q.id] || '').trim()
              const opts = q.options || []
              const selected = multi ? ((answers[q.id] as string[] | undefined) || []) : []
              const current = !multi && !overridden ? (answers[q.id] as string | undefined) : undefined
              return (
                <div key={q.id}>
                  <div id={labelId} className="text-body font-medium">
                    {q.label}
                  </div>
                  {q.description && <div className="text-label text-faint mt-0.5">{q.description}</div>}

                  {q.type !== 'text' && (
                    <div role={multi ? 'group' : 'radiogroup'} aria-labelledby={labelId} className="flex flex-wrap gap-2 mt-2">
                      {opts.map((opt, i) => {
                        const active = multi ? selected.includes(opt) : current === opt
                        // one tab stop per radio group: the chosen chip, else the first
                        const stop = multi || current === opt || (current == null && i === 0)
                        return (
                          <button
                            key={opt}
                            type="button"
                            role={multi ? 'checkbox' : 'radio'}
                            aria-checked={active}
                            disabled={!interactive}
                            tabIndex={stop ? 0 : -1}
                            onKeyDown={multi ? undefined : (e) => pickByArrow(e, q, i)}
                            onClick={() => (multi ? toggleMulti(q.id, opt) : setSingle(q.id, opt))}
                            className={`tap-target inline-flex items-center gap-1.5 text-label rounded-control border px-3 transition-colors duration-fast disabled:cursor-default ${
                              active
                                ? 'border-accent bg-accent-soft text-accent-text font-medium'
                                : interactive
                                  ? 'border-border bg-raised text-fg hover:bg-surface-3'
                                  : 'border-border text-muted opacity-60'
                            }`}
                          >
                            {active && <Icon.Check size={13} className="shrink-0" />}
                            {opt}
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {q.type !== 'text' && interactive && (
                    <div className="mt-2 flex items-center gap-1.5">
                      <span
                        className={`text-caption font-medium rounded-control border px-2 py-0.5 shrink-0 transition-colors duration-fast ${
                          (customText[q.id] || '').trim() ? 'border-accent bg-accent-soft text-accent-text' : 'border-border text-faint'
                        }`}
                      >
                        {t('deckQuestions.others')}
                      </span>
                      <input
                        value={customText[q.id] || ''}
                        onChange={(e) => setCustom(q.id, e.target.value)}
                        aria-label={`${q.label}: ${t('deckQuestions.others')}`}
                        placeholder={multi ? t('deckQuestions.addOwnOption') : t('deckQuestions.writeOwnAnswer')}
                        className="tap-target flex-1 text-label rounded-control border border-border bg-surface px-2.5 focus:border-accent placeholder:text-faint"
                      />
                    </div>
                  )}

                  {q.type === 'text' && (
                    <textarea
                      value={(answers[q.id] as string | undefined) || ''}
                      onChange={(e) => setText(q.id, e.target.value)}
                      disabled={!interactive}
                      rows={2}
                      aria-label={q.label}
                      placeholder={interactive ? t('deckQuestions.yourAnswer') : ''}
                      className="mt-2 w-full text-body rounded-control border border-border bg-surface px-2.5 py-1.5 focus:border-accent resize-none disabled:opacity-50"
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {interactive && (
          <div className="flex gap-2">
            {editing && (
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={busy}
                className="tap-target rounded-control border border-border bg-raised hover:bg-surface-3 text-body px-4 transition-colors duration-fast disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="tap-target flex-1 flex items-center justify-center gap-2 rounded-control bg-action hover:opacity-90 text-on-action font-semibold text-body transition duration-fast disabled:bg-disabled disabled:text-disabled-text disabled:hover:opacity-100"
            >
              {busy ? t('deckQuestions.sending') : editing ? t('deckQuestions.saveAndRegenerate') : t('deckQuestions.continue')}
            </button>
          </div>
        )}
      </div>
    </BlockFrame>
  )
}
