import { useEffect, useMemo, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import Skeleton from './Skeleton.jsx'
import { useT } from '../lib/i18n.jsx'
import { getJSON, postJSON, del } from '../api.js'
import { SaveStatus } from './SettingsControls.jsx'

// Admin panel (rendered inside SettingsModal, only for admins): manages who
// else administers the app. Admins can also publish design systems for the
// whole org via the "Disponível para todos" toggle in the templates grid.
// The principal input suggests users/groups that already have CAN_USE or
// CAN_MANAGE on the app (permissions API via /api/admins/candidates).
export default function AdminSettings({ open }) {
  const t = useT()
  const [data, setData] = useState(null) // { owner, admins, groupCheck }
  const [principal, setPrincipal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saveState, setSaveState] = useState('idle')
  const [candidates, setCandidates] = useState([])
  const [inputFocused, setInputFocused] = useState(false)
  const listRef = useRef(null)

  // the suggestion list renders in-flow (inside the modal's scroll area, so it
  // can never be clipped) — bring it into view when it appears
  useEffect(() => {
    if (inputFocused) listRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [inputFocused])

  const load = async () => {
    try {
      setData(await getJSON('/api/admins'))
    } catch {
      setData(null)
    }
  }

  useEffect(() => {
    if (!open) return
    load()
    getJSON('/api/admins/candidates')
      .then((r) => setCandidates(r.candidates || []))
      .catch(() => setCandidates([]))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // whether the typed principal is a user or a group is derived, never asked:
  // an exact candidate match wins; otherwise "@" means e-mail means user
  const inferKind = (p) =>
    candidates.find((c) => c.principal.toLowerCase() === p.trim().toLowerCase())?.kind ||
    (p.includes('@') ? 'user' : 'group')

  // ranked by how likely each candidate is given the input: prefix match on
  // principal > prefix on display name > substring; capped at 25, the list
  // itself shows ~5 rows and scrolls
  const suggestions = useMemo(() => {
    if (!data) return []
    const q = principal.trim().toLowerCase()
    const taken = new Set(
      [data.owner, ...data.admins.map((a) => a.principal)].map((p) => (p || '').toLowerCase())
    )
    const score = (c) => {
      const p = c.principal.toLowerCase()
      const d = (c.display || '').toLowerCase()
      if (!q) return 1
      if (p.startsWith(q) || d.split(/\s+/).some((w) => w.startsWith(q))) return 3
      if (d.startsWith(q)) return 3
      if (p.includes(q) || d.includes(q)) return 2
      return 0
    }
    return candidates
      .map((c) => ({ c, s: score(c) }))
      .filter(({ c, s }) => s > 0 && !taken.has(c.principal.toLowerCase()))
      .sort((a, b) => b.s - a.s || a.c.principal.localeCompare(b.c.principal))
      .slice(0, 25)
      .map(({ c }) => c)
  }, [candidates, principal, data])

  // First load: show a shimmer skeleton instead of a blank panel while
  // /api/admins resolves.
  if (!data)
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-64" />
        <Skeleton className="h-9 w-full mt-3" rounded="rounded-lg" />
        <Skeleton className="h-9 w-full" rounded="rounded-lg" />
      </div>
    )

  const add = async (value) => {
    const p = (value ?? principal).trim()
    if (!p || busy) return
    setBusy(true)
    setError('')
    setSaveState('saving')
    try {
      await postJSON('/api/admins', { principal: p, kind: inferKind(p) })
      setPrincipal('')
      await load()
      setSaveState('saved')
    } catch (e) {
      const code = e.message || ''
      setError(code === 'sem_acesso' ? t('admins.error.noAccess') : code || t('admins.error.add'))
      setSaveState('idle')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (p) => {
    if (busy) return
    setBusy(true)
    setSaveState('saving')
    try {
      await del(`/api/admins/${encodeURIComponent(p)}`)
      setData((d) => ({ ...d, admins: d.admins.filter((a) => a.principal !== p) }))
      setSaveState('saved')
    } catch (e) {
      setError(e.message || t('admins.error.remove'))
      setSaveState('idle')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h3 className="text-title font-semibold flex items-center gap-2">
        <Icon.Shield size={16} /> {t('admins.title')}
      </h3>
      <p className="text-label text-[var(--muted)] mt-1">
        {data.owner ? t('admins.description', { owner: data.owner }) : t('admins.descriptionNoOwner')}
      </p>
      <p className="text-label text-[var(--muted)] mt-1.5 flex items-start gap-1.5">
        <Icon.Shield size={13} className="shrink-0 mt-0.5 opacity-70" />
        <span>{t('admins.accessNote')}</span>
      </p>

      <div className="mt-3 space-y-1.5">
        {/* The "owner" (APP_OWNER_EMAIL) is only shown when set. In a bundle
            deploy it isn't wired into the runtime — the deployer is instead
            seeded into app_admins and shows up in the list below — so an empty
            owner row would read "proprietário ()". Hide it entirely then. */}
        {data.owner && (
          <div className="flex items-center gap-2 text-label rounded-lg border border-[var(--border)] px-3 py-2">
            <Icon.Check size={13} className="text-[var(--accent)] shrink-0" />
            <span className="flex-1 truncate font-medium">{data.owner}</span>
            <span className="text-[var(--faint)]">{t('admins.owner')}</span>
          </div>
        )}
        {data.admins.map((a) => (
          <div key={a.principal} className="flex items-center gap-2 text-label rounded-lg border border-[var(--border)] px-3 py-2">
            {a.kind === 'group' ? (
              <Icon.Users size={13} className="shrink-0 text-[var(--muted)]" />
            ) : (
              <Icon.User size={13} className="shrink-0 text-[var(--muted)]" />
            )}
            <span className="flex-1 truncate font-medium">{a.principal}</span>
            <span className="text-[var(--faint)]">{a.kind === 'group' ? t('admins.kind.group') : t('admins.kind.user')}</span>
            <button
              type="button"
              onClick={() => remove(a.principal)}
              className="grid place-items-center w-7 h-7 rounded-md hover:bg-[var(--surface-3)] hover:text-[var(--danger)] text-[var(--muted)]"
              title={t('admins.removeTitle')}
              aria-label={`${t('admins.removeTitle')}: ${a.principal}`}
            >
              <Icon.Trash size={12} />
            </button>
          </div>
        ))}
      </div>

      {/* items-start: the button stays glued to the input row even when the
          in-flow suggestion list grows the column below it */}
      <label htmlFor="admins-principal" className="block text-label font-medium text-[var(--muted)] mt-4 mb-1">
        {t('admins.inputLabel')}
      </label>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="relative">
            {/* inferred-kind adornment: the app already knows whether the typed
                principal is a user or a group — no select needed */}
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" title={principal.trim() ? (inferKind(principal) === 'group' ? t('admins.inferKind.group') : t('admins.inferKind.user')) : t('admins.inferKind.either')}>
              {!principal.trim() ? (
                <Icon.User size={13} />
              ) : inferKind(principal) === 'group' ? (
                <Icon.Users size={13} />
              ) : (
                <Icon.User size={13} />
              )}
            </span>
            <input
              id="admins-principal"
              role="combobox"
              aria-expanded={inputFocused && suggestions.length > 0}
              aria-controls="admins-suggestions"
              aria-autocomplete="list"
              value={principal}
              onChange={(e) => setPrincipal(e.target.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder={t('admins.inputPlaceholder')}
              // This is a principal-search field, not a credential. Password
              // managers (1Password/LastPass/Bitwarden/Dashlane) otherwise inject
              // their "fill" glyph and pop the vault — suppress all of them.
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              data-form-type="other"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] pl-8 pr-3 py-2 text-label focus:border-[var(--accent)]"
            />
          </div>
          {inputFocused && suggestions.length > 0 && (
            // in-flow (not floating): pushes the content below instead of
            // overflowing the modal, so it's never clipped at the modal edge.
            // ~5 rows visible (each ≈40px), the rest scrolls; capped at 25.
            <div ref={listRef} id="admins-suggestions" className="mt-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 max-h-[212px] overflow-y-auto">
              <p className="px-2 py-1 text-caption uppercase tracking-wide text-[var(--faint)]">
                {t('admins.withAccess')}
              </p>
              {suggestions.map((c) => (
                <button
                  key={`${c.kind}:${c.principal}`}
                  // onMouseDown: fires before the input's blur closes the list
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setInputFocused(false)
                    setPrincipal(c.principal)
                    add(c.principal)
                  }}
                  className="w-full flex items-center gap-2.5 text-left rounded-lg px-2 py-1.5 hover:bg-[var(--surface-2)] transition"
                >
                  <span className="shrink-0 w-6 h-6 rounded-full bg-[var(--surface-3)] grid place-items-center text-[var(--muted)]">
                    {c.kind === 'group' ? <Icon.Users size={13} /> : <Icon.User size={13} />}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-label font-medium truncate">{c.display || c.principal}</span>
                    {c.display && <span className="block text-caption text-[var(--faint)] truncate">{c.principal}</span>}
                  </span>
                  <span className="shrink-0 text-caption uppercase text-[var(--faint)]">
                    {c.level === 'CAN_MANAGE' ? t('admins.level.manage') : t('admins.level.use')}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => add()}
          disabled={!principal.trim() || busy}
          className="rounded-lg bg-[var(--surface-3)] hover:brightness-110 disabled:opacity-40 text-label font-semibold px-3 min-h-9"
        >
          {t('admins.add')}
        </button>
      </div>
      <SaveStatus state={saveState} className="block mt-1.5" />
      {inferKind(principal) === 'group' && principal.trim() && data.groupCheck === 'unavailable' && (
        <p className="text-caption text-[var(--faint)] mt-1.5">
          {t('admins.groupCheckWarning')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-label text-[var(--danger)] mt-1.5">
          {error}
        </p>
      )}
    </div>
  )
}
