import { useState, useMemo } from 'react'
import * as Icon from '../Icons.jsx'
import { useT } from '../../lib/i18n.jsx'

// The clarifying-questions step of the deck flow (see DECK_POLICY in
// server/blocks.js). The model authors the questions fresh per request, so this
// only renders whatever shape shows up.
//
// Answers are PERSISTED into the block once submitted (block.answers), so the
// box shows the history on reload and can be re-opened for editing. Editing +
// re-submitting regenerates the follow-up turn (via App's onSubmitAnswers,
// which reuses the message edit+regenerate flow). Fresh (unanswered) + latest =
// interactive; answered = filled read-only with an "Editar respostas" button.
export default function DeckQuestionsBlock({ block, msgId, isLatest, onSubmitAnswers }) {
  const t = useT()
  const questions = block.questions || []
  const persisted = block.answers || null

  // seed local edit state from persisted answers (so editing starts filled)
  const seed = useMemo(() => {
    const answers = {}
    const custom = {}
    if (persisted) {
      for (const q of questions) {
        const v = persisted[q.id]
        if (v == null) continue
        if (q.type === 'multi') {
          const picked = Array.isArray(v) ? v : [v]
          // options that aren't in the known set become the "Outros" text
          const known = picked.filter((p) => (q.options || []).includes(p))
          const extra = picked.filter((p) => !(q.options || []).includes(p))
          answers[q.id] = known
          if (extra.length) custom[q.id] = extra.join(', ')
        } else if (q.type === 'text') {
          answers[q.id] = v
        } else {
          if ((q.options || []).includes(v)) answers[q.id] = v
          else custom[q.id] = v
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

  const setSingle = (qid, value) => setAnswers((a) => ({ ...a, [qid]: value }))
  const setText = (qid, value) => setAnswers((a) => ({ ...a, [qid]: value }))
  const setCustom = (qid, value) => setCustomText((c) => ({ ...c, [qid]: value }))
  const toggleMulti = (qid, value) =>
    setAnswers((a) => {
      const cur = new Set(a[qid] || [])
      if (cur.has(value)) cur.delete(value)
      else cur.add(value)
      return { ...a, [qid]: Array.from(cur) }
    })

  // builds { answersMap, text } from the current inputs — answersMap persists
  // into the block; text is the follow-up user message the model reads.
  const collect = () => {
    const answersMap = {}
    const lines = questions.map((q) => {
      const custom = (customText[q.id] || '').trim()
      let value
      if (q.type === 'multi') {
        const picked = answers[q.id] || []
        const all = custom ? [...picked, custom] : picked
        if (all.length) answersMap[q.id] = all
        value = all.length ? all.join(', ') : t('deckQuestions.notSpecified')
      } else if (q.type === 'text') {
        const v = (answers[q.id] || '').trim()
        if (v) answersMap[q.id] = v
        value = v || t('deckQuestions.notSpecified')
      } else {
        const v = custom || answers[q.id] || ''
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
  const answeredValue = (q) => {
    const v = persisted?.[q.id]
    if (v == null) return <span className="text-[var(--faint)] italic">{t('deckQuestions.notSpecified')}</span>
    return Array.isArray(v) ? v.join(', ') : v
  }

  const answered = !!persisted && !editing

  return (
    <div data-block="deck-questions" className="rounded-card border border-border bg-surface-2 p-4 my-3 space-y-4">
      <div className="flex items-center gap-2 text-body font-semibold">
        <Icon.Presentation size={16} className="text-[var(--accent)]" />
        <span>{answered ? t('deckQuestions.answered') : interactive ? t('deckQuestions.aboutDeck') : t('deckQuestions.title')}</span>
        {answered && <Icon.Check size={14} className="text-[var(--accent)]" />}
        {answered && !isLatest && onSubmitAnswers && (
          <button
            onClick={() => setEditing(true)}
            className="tap-target ml-auto flex items-center gap-1 rounded-control px-2 text-label text-muted hover:text-accent-text hover:bg-surface-3 transition-colors duration-fast"
            title={t('deckQuestions.editAnswersTitle')}
          >
            <Icon.Pencil size={12} /> {t('deckQuestions.editAnswers')}
          </button>
        )}
      </div>

      {block.intro && <p className="text-body text-[var(--muted)] -mt-2">{block.intro}</p>}

      {/* answered read-only summary */}
      {answered ? (
        <div className="space-y-2.5">
          {questions.map((q) => (
            <div key={q.id} className="text-body">
              <div className="font-medium">{q.label}</div>
              <div className="text-[var(--muted)] mt-0.5">{answeredValue(q)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {questions.map((q) => (
            <div key={q.id}>
              <div className="text-body font-medium">{q.label}</div>
              {q.description && <div className="text-label text-[var(--faint)] mt-0.5">{q.description}</div>}

              {q.type !== 'text' && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {(q.options || []).map((opt) => {
                    const overridden = q.type === 'single' && (customText[q.id] || '').trim()
                    const active =
                      (q.type === 'multi' ? (answers[q.id] || []).includes(opt) : answers[q.id] === opt) &&
                      !overridden
                    return (
                      <button
                        key={opt}
                        type="button"
                        disabled={!interactive}
                        aria-pressed={active}
                        onClick={() => (q.type === 'multi' ? toggleMulti(q.id, opt) : setSingle(q.id, opt))}
                        className={`tap-target text-label rounded-pill border px-3 transition-colors duration-fast disabled:cursor-default ${
                          active
                            ? 'border-accent bg-accent-soft text-accent-text font-medium'
                            : interactive
                            ? 'border-border hover:bg-surface-3'
                            : 'border-border opacity-50'
                        }`}
                      >
                        {opt}
                      </button>
                    )
                  })}
                </div>
              )}

              {q.type !== 'text' && interactive && (
                <div className="mt-2 flex items-center gap-1.5">
                  <span
                    className={`text-caption font-medium rounded-pill border px-2 py-0.5 shrink-0 transition-colors duration-fast ${
                      (customText[q.id] || '').trim()
                        ? 'border-accent bg-accent-soft text-accent-text'
                        : 'border-border text-faint'
                    }`}
                  >
                    {t('deckQuestions.others')}
                  </span>
                  <input
                    value={customText[q.id] || ''}
                    onChange={(e) => setCustom(q.id, e.target.value)}
                    aria-label={`${q.label}: ${t('deckQuestions.others')}`}
                    placeholder={
                      q.type === 'multi' ? t('deckQuestions.addOwnOption') : t('deckQuestions.writeOwnAnswer')
                    }
                    className="tap-target flex-1 text-label rounded-control border border-border bg-surface px-2.5 focus:border-accent placeholder:text-faint"
                  />
                </div>
              )}

              {q.type === 'text' && (
                <textarea
                  value={answers[q.id] || ''}
                  onChange={(e) => setText(q.id, e.target.value)}
                  disabled={!interactive}
                  rows={2}
                  aria-label={q.label}
                  placeholder={interactive ? t('deckQuestions.yourAnswer') : ''}
                  className="mt-2 w-full text-body rounded-control border border-border bg-surface px-2.5 py-1.5 focus:border-accent resize-none disabled:opacity-50"
                />
              )}
            </div>
          ))}
        </div>
      )}

      {interactive && (
        <div className="flex gap-2">
          {editing && (
            <button
              onClick={() => setEditing(false)}
              disabled={busy}
              className="tap-target rounded-control border border-border hover:bg-surface-3 text-body px-4 transition-colors duration-fast disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
          )}
          <button
            onClick={submit}
            disabled={busy}
            className="tap-target flex-1 flex items-center justify-center gap-2 rounded-control bg-accent-strong hover:brightness-110 text-on-accent font-semibold text-body transition duration-fast disabled:bg-disabled disabled:text-disabled-text disabled:hover:brightness-100"
          >
            {busy ? t('deckQuestions.sending') : editing ? t('deckQuestions.saveAndRegenerate') : t('deckQuestions.continue')}
          </button>
        </div>
      )}
    </div>
  )
}
