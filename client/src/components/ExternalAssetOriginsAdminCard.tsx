import { useEffect, useState } from 'react'
import * as Icon from './Icons.tsx'
import { useT } from '../lib/i18n.tsx'
import { SaveStatus } from './SettingsControls.tsx'
import { EgressSaveError, fetchEgressSettings, saveEgressOrigins, validateOriginInput } from '../lib/egressAdminApi.ts'
import type { EgressSettings } from '../lib/egressAdminApi.ts'

type Translate = (key: string, vars?: Record<string, unknown>) => string
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

// Admin card (Administrators tab): the allowlist of remote origins that images, fonts and stylesheets may load from
// (md-exfil, decision D42). The env floor and the mode are read-only here; the list is what the admin saved.
export default function ExternalAssetOriginsAdminCard() {
  const t = useT() as Translate
  const [data, setData] = useState<EgressSettings | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [list, setList] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [problem, setProblem] = useState('')
  const [state, setState] = useState<SaveState>('idle')
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let live = true
    fetchEgressSettings().then(
      (s) => {
        if (!live) return
        setData(s)
        setList(s.origins)
      },
      () => live && setLoadFailed(true)
    )
    return () => {
      live = false
    }
  }, [])

  const add = () => {
    const raw = input.trim()
    if (!raw) return
    const v = validateOriginInput(raw, typeof location === 'undefined' ? undefined : location.host)
    if (!v.ok) {
      setProblem(t('egress.invalid', { value: raw }))
      return
    }
    setProblem('')
    setInput('')
    if (!list.includes(v.origin)) {
      setList([...list, v.origin])
      setDirty(true)
      setState('idle')
    }
  }

  const remove = (o: string) => {
    setList(list.filter((x) => x !== o))
    setProblem('')
    setDirty(true)
    setState('idle')
  }

  const save = async () => {
    setState('saving')
    setProblem('')
    try {
      const s = await saveEgressOrigins(list)
      setData(s)
      setList(s.origins)
      setDirty(false)
      setState('saved')
    } catch (e) {
      const rejected = e instanceof EgressSaveError ? e.rejected : []
      setProblem(rejected.length ? t('egress.rejected', { list: rejected.join(', ') }) : t('egress.saveFailed'))
      setState('idle')
    }
  }

  const chipCls = 'inline-flex items-center gap-1.5 max-w-full rounded-pill bg-[var(--surface-3)] pl-2.5 pr-1 min-h-7 text-label'

  return (
    <section aria-labelledby="egress-origins-title" data-testid="egress-origins-admin-card">
      <h4 id="egress-origins-title" className="text-body font-semibold">
        {t('egress.title')}
      </h4>
      <p className="text-label text-[var(--muted)] mt-1 max-w-[62ch]">{t('egress.desc')}</p>
      <p className="text-caption text-[var(--muted)] mt-2 flex items-start gap-1.5 max-w-[62ch]">
        <Icon.AlertTriangle size={13} className="shrink-0 mt-0.5 text-[var(--warning)]" aria-hidden />
        <span>{t('egress.warning')}</span>
      </p>
      <p className="text-caption text-[var(--muted)] mt-1.5 max-w-[62ch]">{t('egress.timing')}</p>

      {loadFailed && (
        <p role="alert" className="text-label text-[var(--danger)] mt-2">
          {t('egress.loadFailed')}
        </p>
      )}

      {data && (
        <>
          <p data-testid="egress-mode" className="text-label mt-3">
            {t('egress.mode', { mode: t(`egress.mode.${data.mode === 'report' ? 'report' : 'enforce'}`) })}
          </p>

          <div className="mt-3">
            <p className="text-caption uppercase tracking-wide text-[var(--muted)]">{t('egress.floor')}</p>
            {data.envOrigins.length ? (
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {data.envOrigins.map((o) => (
                  <li key={o} className="inline-flex items-center rounded-pill bg-[var(--surface-3)] px-2.5 min-h-7 text-label text-[var(--muted)]">
                    {o}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-label text-[var(--muted)] mt-1">{t('egress.floorEmpty')}</p>
            )}
          </div>

          <div className="mt-3">
            <p className="text-caption uppercase tracking-wide text-[var(--muted)]">{t('egress.listLabel')}</p>
            {list.length ? (
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {list.map((o) => (
                  <li key={o} className={chipCls}>
                    <span className="truncate">{o}</span>
                    <button
                      type="button"
                      onClick={() => remove(o)}
                      className="grid place-items-center w-5 h-5 rounded-pill text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--danger)]"
                      title={t('egress.remove')}
                      aria-label={`${t('egress.remove')}: ${o}`}
                    >
                      <Icon.Close size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-label text-[var(--muted)] mt-1">{t('egress.empty')}</p>
            )}
          </div>

          <div className="mt-3 flex items-start gap-2">
            <input
              id="egress-origin-input"
              aria-label={t('egress.inputLabel')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  add()
                }
              }}
              placeholder={t('egress.placeholder')}
              autoComplete="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              data-form-type="other"
              className="flex-1 min-w-40 rounded-card border border-[var(--border)] bg-raised px-3 min-h-11 text-label placeholder:text-[var(--faint)] focus-within:border-[var(--accent)]"
            />
            <button
              type="button"
              onClick={add}
              disabled={!input.trim()}
              className="shrink-0 rounded-control border border-[var(--border)] bg-raised hover:bg-[var(--surface-3)] disabled:opacity-40 text-label font-semibold px-3 min-h-11 transition duration-fast"
            >
              {t('egress.add')}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || state === 'saving'}
              className="shrink-0 rounded-control bg-action text-on-action hover:opacity-90 disabled:opacity-40 text-label font-semibold px-3 min-h-11 transition duration-fast"
            >
              {t('egress.save')}
            </button>
          </div>
          <SaveStatus state={state} className="block mt-1.5" />
          {problem && (
            <p role="alert" className="text-label text-[var(--danger)] mt-1.5 break-words">
              {problem}
            </p>
          )}
        </>
      )}
    </section>
  )
}
