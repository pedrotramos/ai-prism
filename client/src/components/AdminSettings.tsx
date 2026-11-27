import { useEffect, useMemo, useRef, useState } from 'react'
import * as Icon from './Icons.tsx'
import Skeleton from './Skeleton.tsx'
import { useT } from '../lib/i18n.tsx'
import { getJSON, postJSON, del } from '../api.ts'
import { SaveStatus } from './SettingsControls.tsx'
import ExternalAssetOriginsAdminCard from './ExternalAssetOriginsAdminCard.tsx'

// Where the policies this page points to are configured. Plain documentation links: the client does not know
// the workspace host, so there is no deep link into a workspace page.
const GUARDRAILS_DOCS_URL = 'https://docs.databricks.com/aws/en/ai-gateway/overview-serving-endpoints'
const BUDGETS_DOCS_URL = 'https://docs.databricks.com/aws/en/admin/account-settings/budgets'

const initialsOf = (p: string) => (p.split('@')[0] || p).slice(0, 2).toUpperCase()

// useT()/useI18n() come from i18n.jsx (untyped JS), which infers a one-argument `t`.
type Translate = (key: string, vars?: Record<string, unknown>) => string

// Admin panel (rendered inside SettingsModal, only for admins): manages who
// else administers the app. Admins can also publish design systems for the
// whole org via the "Disponível para todos" toggle in the templates grid.
// The principal input suggests users/groups that already have CAN_USE or
// CAN_MANAGE on the app (permissions API via /api/admins/candidates).
interface AdminEntry {
  principal: string
  kind?: string
}

interface AdminsData {
  owner?: string | null
  admins: AdminEntry[]
  groupCheck?: string
}

interface Candidate {
  principal: string
  kind?: string
  display?: string
  level?: string
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface AdminSettingsProps {
  open: boolean
}

export default function AdminSettings({ open }: AdminSettingsProps) {
  const t = useT() as Translate
  const [data, setData] = useState<AdminsData | null>(null)
  const [principal, setPrincipal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [inputFocused, setInputFocused] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // the suggestion list renders in-flow (inside the modal's scroll area, so it
  // can never be clipped) — bring it into view when it appears
  useEffect(() => {
    if (inputFocused) listRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [inputFocused])

  const load = async () => {
    try {
      setData(await getJSON<AdminsData>('/api/admins'))
    } catch {
      setData(null)
    }
  }

  useEffect(() => {
    if (!open) return
    load()
    getJSON<{ candidates?: Candidate[] }>('/api/admins/candidates')
      .then((r) => setCandidates(r.candidates || []))
      .catch(() => setCandidates([]))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // whether the typed principal is a user or a group is derived, never asked:
  // an exact candidate match wins; otherwise "@" means e-mail means user
  const inferKind = (p: string) =>
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
    const score = (c: Candidate) => {
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

  const add = async (value?: string) => {
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
      const code = (e as Error).message || ''
      setError(code === 'sem_acesso' ? t('admins.error.noAccess') : code || t('admins.error.add'))
      setSaveState('idle')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (p: string) => {
    if (busy) return
    setBusy(true)
    setSaveState('saving')
    try {
      await del(`/api/admins/${encodeURIComponent(p)}`)
      setData((d) => ({ ...(d as AdminsData), admins: (d as AdminsData).admins.filter((a) => a.principal !== p) }))
      setSaveState('saved')
    } catch (e) {
      setError((e as Error).message || t('admins.error.remove'))
      setSaveState('idle')
    } finally {
      setBusy(false)
    }
  }

  const chipCls = 'inline-flex items-center gap-1.5 max-w-full rounded-pill bg-[var(--surface-3)] pl-1 pr-2 min-h-7 text-label'
  const Avatar = ({ kind, name }: { kind?: string; name: string }) => (
    <span aria-hidden className="shrink-0 grid place-items-center w-5 h-5 rounded-pill bg-raised text-[var(--muted)] text-caption font-semibold">
      {kind === 'group' ? <Icon.Users size={11} /> : initialsOf(name)}
    </span>
  )

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-title font-semibold">{t('admins.title')}</h3>
        <p className="text-label text-[var(--muted)] mt-1 max-w-[62ch]">{t('admins.subtitle')}</p>
      </div>

      <section aria-labelledby="admins-section">
        <h4 id="admins-section" className="text-body font-semibold">
          {t('admins.section')}
        </h4>
        <p className="text-label text-[var(--muted)] mt-1 max-w-[62ch]">
          {data.owner ? t('admins.description', { owner: data.owner }) : t('admins.descriptionNoOwner')}
        </p>

        <div className="mt-3 flex items-start gap-2">
          <div className="flex-1 min-w-0">
            {/* the field is the list: people and groups are chips, the input sits after them */}
            <div
              onClick={() => inputRef.current?.focus()}
              className="flex flex-wrap items-center gap-1.5 rounded-card border border-[var(--border)] bg-raised p-2 focus-within:border-[var(--accent)]"
            >
              {/* The "owner" (APP_OWNER_EMAIL) is only shown when set. In a bundle
                  deploy it isn't wired into the runtime — the deployer is instead
                  seeded into app_admins and shows up in the list below — so an empty
                  owner row would read "proprietário ()". Hide it entirely then. */}
              {data.owner && (
                <span className={chipCls}>
                  <Avatar name={data.owner} />
                  <span className="truncate">{data.owner}</span>
                  <span className="text-caption text-[var(--muted)]">{t('admins.owner')}</span>
                </span>
              )}
              {data.admins.map((a) => (
                <span key={a.principal} className={chipCls}>
                  <Avatar kind={a.kind} name={a.principal} />
                  <span className="truncate">{a.principal}</span>
                  <span className="sr-only">{a.kind === 'group' ? t('admins.kind.group') : t('admins.kind.user')}</span>
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      remove(a.principal)
                    }}
                    className="grid place-items-center w-5 h-5 -mr-1 rounded-pill text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--danger)]"
                    title={t('admins.removeTitle')}
                    aria-label={`${t('admins.removeTitle')}: ${a.principal}`}
                  >
                    <Icon.Close size={11} />
                  </button>
                </span>
              ))}
              <input
                ref={inputRef}
                id="admins-principal"
                role="combobox"
                aria-expanded={inputFocused && suggestions.length > 0}
                aria-controls="admins-suggestions"
                aria-autocomplete="list"
                aria-label={t('admins.inputLabel')}
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                onKeyDown={(e) => e.key === 'Enter' && add()}
                placeholder={t('admins.inputPlaceholder')}
                title={principal.trim() ? (inferKind(principal) === 'group' ? t('admins.inferKind.group') : t('admins.inferKind.user')) : t('admins.inferKind.either')}
                // This is a principal-search field, not a credential. Password
                // managers (1Password/LastPass/Bitwarden/Dashlane) otherwise inject
                // their "fill" glyph and pop the vault — suppress all of them.
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                data-form-type="other"
                className="flex-1 min-w-40 bg-transparent px-1.5 py-1 text-label placeholder:text-[var(--faint)]"
              />
            </div>
            {inputFocused && suggestions.length > 0 && (
              // in-flow (not floating): pushes the content below instead of
              // overflowing the modal, so it's never clipped at the modal edge.
              // ~5 rows visible (each ≈40px), the rest scrolls; capped at 25.
              <div ref={listRef} id="admins-suggestions" className="mt-1 rounded-card border border-[var(--border)] bg-raised p-1 max-h-[212px] overflow-y-auto">
                <p className="px-2 py-1 text-caption uppercase tracking-wide text-[var(--muted)]">{t('admins.withAccess')}</p>
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
                    className="w-full flex items-center gap-2.5 text-left rounded-control px-2 py-1.5 hover:bg-[var(--surface-2)] transition"
                  >
                    <span className="shrink-0 w-6 h-6 rounded-pill bg-[var(--surface-3)] grid place-items-center text-[var(--muted)]">
                      {c.kind === 'group' ? <Icon.Users size={13} /> : <Icon.User size={13} />}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-label font-medium truncate">{c.display || c.principal}</span>
                      {c.display && <span className="block text-caption text-[var(--muted)] truncate">{c.principal}</span>}
                    </span>
                    <span className="shrink-0 text-caption uppercase text-[var(--muted)]">
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
            className="shrink-0 rounded-control bg-action text-on-action hover:opacity-90 disabled:opacity-40 text-label font-semibold px-3 min-h-11 transition duration-fast"
          >
            {t('admins.add')}
          </button>
        </div>
        <SaveStatus state={saveState} className="block mt-1.5" />
        {inferKind(principal) === 'group' && principal.trim() && data.groupCheck === 'unavailable' && (
          <p className="text-caption text-[var(--muted)] mt-1.5">{t('admins.groupCheckWarning')}</p>
        )}
        {error && (
          <p role="alert" className="text-label text-[var(--danger)] mt-1.5">
            {error}
          </p>
        )}
        <p className="text-caption text-[var(--muted)] mt-2 flex items-start gap-1.5 max-w-[62ch]">
          <Icon.Shield size={13} className="shrink-0 mt-0.5" />
          <span>{t('admins.accessNote')}</span>
        </p>
      </section>

      {/* Policies live in the AI Gateway and in Databricks: this app only points to them. */}
      <section aria-labelledby="admins-policies">
        <h4 id="admins-policies" className="text-body font-semibold mb-2">
          {t('admins.policies.title')}
        </h4>
        <ul className="rounded-card border border-[var(--border)] bg-raised divide-y divide-[var(--border-soft)]">
          {(
            [
              ['guardrails', GUARDRAILS_DOCS_URL],
              ['budgets', BUDGETS_DOCS_URL],
            ] as const
          ).map(([key, href]) => (
            <li key={key} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium">{t(`admins.policies.${key}.title`)}</span>
                <span className="block text-label text-[var(--muted)] mt-0.5">{t(`admins.policies.${key}.desc`)}</span>
              </span>
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 inline-flex items-center gap-1.5 rounded-control border border-[var(--border)] bg-raised hover:bg-[var(--surface-3)] text-label font-semibold px-3 min-h-9 transition duration-fast"
              >
                <Icon.Link size={13} /> {t(`admins.policies.${key}.open`)}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <ExternalAssetOriginsAdminCard />
    </div>
  )
}
