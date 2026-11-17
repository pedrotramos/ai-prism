import { useEffect, useId, useMemo, useState } from 'react'
import * as Icon from './Icons.jsx'
import Skeleton from './Skeleton.jsx'
import { relativeTime } from '../lib/date.js'
import { useT } from '../lib/i18n.jsx'

// Full conversation history: semantic search, sort, multi-select delete,
// inline rename. It replaces the chat column, so it is the page's <main>.
// Every control has a programmatic name (screen readers and voice control),
// row actions are reachable by keyboard and on touch (not hover-only), and
// both empty states end in an action instead of a dead end.

const touch = () => typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none)').matches

const rowAction =
  'shrink-0 grid place-items-center w-8 h-8 [@media(hover:none)]:w-11 [@media(hover:none)]:h-11 rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)] transition-colors duration-fast'

export default function HistoryPage({
  sessions,
  sessionsLoading,
  currentId,
  onSelect,
  onNew,
  onDelete,
  deletingId,
  onRename,
  onBack,
  onSearch,
  searchResults,
  searching,
}) {
  const t = useT()
  const titleId = useId()
  const searchId = useId()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('newest')
  const [selected, setSelected] = useState(() => new Set())
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState('')
  // a phone keyboard popping up on arrival would hide the list it came to see
  const [autoFocusSearch] = useState(() => !touch())

  useEffect(() => {
    const timer = setTimeout(() => onSearch(query.trim()), 350)
    return () => clearTimeout(timer)
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  const searchActive = query.trim().length > 0
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])

  const rows = useMemo(() => {
    if (searchActive) {
      return (searchResults || []).map((r) => {
        const full = byId.get(r.id)
        return full ? { ...full, score: r.score } : { id: r.id, title: r.title, score: r.score }
      })
    }
    return [...sessions].sort((a, b) => {
      const da = new Date(a.updated_at || a.created_at).getTime()
      const db = new Date(b.updated_at || b.created_at).getTime()
      return sort === 'oldest' ? da - db : db - da
    })
  }, [searchActive, searchResults, sessions, sort, byId])

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleSelectAll = () => {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))))
  }

  const startEdit = (sNode) => {
    setEditingId(sNode.id)
    setDraft(sNode.title)
  }
  const commitEdit = () => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }

  const deleteSelected = async () => {
    const ids = [...selected]
    setSelected(new Set())
    for (const id of ids) await onDelete(id)
  }

  const allSelected = rows.length > 0 && selected.size === rows.length

  return (
    <main aria-labelledby={titleId} className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <header className="shrink-0 flex items-center gap-2 px-3 md:px-6 h-14 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur">
        <button
          type="button"
          onClick={onBack}
          className="w-11 h-11 -ml-1 grid place-items-center rounded-control hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-[var(--text)] transition-colors duration-fast"
          aria-label={t('history.back')}
          title={t('history.back')}
        >
          <Icon.ChevronLeft size={20} />
        </button>
        <h1 id={titleId} className="font-bold text-title flex items-center gap-2">
          <Icon.History size={18} /> {t('sidebar.history')}
        </h1>
        <button
          type="button"
          onClick={onNew}
          className="ml-auto min-h-10 flex items-center gap-1.5 rounded-control bg-[var(--accent-strong)] text-[var(--on-accent)] hover:brightness-110 font-semibold text-body px-3.5 transition duration-fast"
        >
          <Icon.Plus size={16} /> {t('sidebar.newChat')}
        </button>
      </header>

      <div className="max-w-3xl w-full mx-auto px-4 md:px-6 pt-5 pb-2 flex flex-col gap-3 shrink-0">
        <div role="search" className="relative">
          <label htmlFor={searchId} className="sr-only">
            {t('history.searchLabel')}
          </label>
          <Icon.Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--faint)] pointer-events-none" />
          <input
            id={searchId}
            type="search"
            autoFocus={autoFocusSearch}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                setQuery('')
              }
            }}
            placeholder={t('history.searchPlaceholder')}
            className="w-full min-h-11 rounded-control bg-[var(--surface-2)] border border-[var(--border)] pl-10 pr-11 py-2.5 text-body outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)] [&::-webkit-search-cancel-button]:hidden"
          />
          {searchActive && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-8 h-8 grid place-items-center rounded-control text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
              aria-label={t('history.clearSearch')}
              title={t('history.clearSearch')}
            >
              <Icon.Close size={14} />
            </button>
          )}
        </div>

        {rows.length > 0 && (
          <div className="flex items-center gap-3 min-h-11">
            <label className="flex items-center gap-1 min-h-11 pr-2 text-label text-[var(--muted)] cursor-pointer select-none">
              <Checkbox checked={allSelected} onChange={toggleSelectAll} label={t('history.selectAll')} />
              {t('history.selectAll')}
            </label>

            {!searchActive && (
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                aria-label={t('history.sortLabel')}
                className="min-h-9 text-label rounded-control bg-[var(--surface-2)] border border-[var(--border)] px-2.5 outline-none focus:border-[var(--accent)]"
              >
                <option value="newest">{t('history.sortNewest')}</option>
                <option value="oldest">{t('history.sortOldest')}</option>
              </select>
            )}

            {selected.size > 0 && (
              <button
                type="button"
                onClick={deleteSelected}
                className="ml-auto min-h-9 flex items-center gap-1.5 text-label font-semibold text-[var(--danger)] hover:bg-[var(--danger-soft)] rounded-control px-2.5 transition-colors duration-fast"
              >
                <Icon.Trash size={13} />{' '}
                {t(selected.size > 1 ? 'history.deleteSelectedPlural' : 'history.deleteSelected', { n: selected.size })}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 md:px-6 pb-8">
          {sessionsLoading ? (
            <HistorySkeleton label={t('sidebar.loading')} />
          ) : searching ? (
            <p role="status" className="py-10 text-body text-[var(--muted)] text-center">
              {t('history.searching')}
            </p>
          ) : rows.length === 0 ? (
            searchActive ? (
              <EmptyState title={t('history.noResults')} hint={t('history.noResultsHint')}>
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="min-h-10 rounded-control border border-[var(--border)] px-3.5 text-body font-medium hover:bg-[var(--surface-2)] transition-colors duration-fast"
                >
                  {t('history.clearSearch')}
                </button>
              </EmptyState>
            ) : (
              <EmptyState title={t('history.emptyTitle')} hint={t('history.emptyHint')}>
                <button
                  type="button"
                  onClick={onNew}
                  className="min-h-10 inline-flex items-center gap-1.5 rounded-control bg-[var(--accent-strong)] text-[var(--on-accent)] px-3.5 text-body font-semibold hover:brightness-110 transition duration-fast"
                >
                  <Icon.Plus size={16} /> {t('sidebar.newChat')}
                </button>
              </EmptyState>
            )
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {rows.map((r) => {
                const active = r.id === currentId
                const isDeleting = r.id === deletingId
                const rt = r.updated_at ? relativeTime(r.updated_at) : null
                return (
                  <li
                    key={r.id}
                    className={`group flex items-center gap-2 py-1.5 px-1 rounded-control transition-colors duration-fast ${
                      active ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-2)]'
                    } ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    <Checkbox
                      checked={selected.has(r.id)}
                      onChange={() => toggleSelect(r.id)}
                      label={t('history.selectRow', { title: r.title })}
                    />

                    {editingId === r.id ? (
                      <input
                        autoFocus
                        aria-label={t('sidebar.rename')}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit()
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        className="flex-1 min-w-0 bg-transparent text-body px-0 py-1 outline-none border-b border-[var(--accent)]"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSelect(r.id)}
                        aria-current={active ? 'page' : undefined}
                        className="flex-1 min-w-0 min-h-10 flex items-center gap-3 text-left rounded-control"
                      >
                        <span className="text-body truncate" title={r.title}>
                          {r.title}
                        </span>

                        {r.attachment_names?.length > 0 && (
                          <span className="hidden sm:flex items-center gap-1 shrink-0">
                            {r.attachment_names.slice(0, 2).map((name) => (
                              <span
                                key={name}
                                className="flex items-center gap-1 text-caption text-[var(--muted)] bg-[var(--surface-3)] rounded-badge px-1.5 py-0.5 max-w-[9rem] truncate"
                                title={name}
                              >
                                <Icon.File size={10} className="shrink-0" />
                                {name}
                              </span>
                            ))}
                            {r.attachment_names.length > 2 && (
                              <span className="text-caption text-[var(--muted)]">+{r.attachment_names.length - 2}</span>
                            )}
                          </span>
                        )}
                      </button>
                    )}

                    {typeof r.score === 'number' && (
                      <span className="text-caption font-mono text-[var(--faint)] shrink-0">{Math.round(r.score * 100)}%</span>
                    )}

                    {rt && (
                      <time dateTime={r.updated_at} className="text-label text-[var(--faint)] shrink-0 w-20 text-right">
                        {t(rt.key, rt.vars)}
                      </time>
                    )}

                    <div className="flex items-center shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity duration-fast">
                      {isDeleting ? (
                        <span className="p-1.5" role="status" aria-label={t('sidebar.deleting')} title={t('sidebar.deleting')}>
                          <span className="block w-3.5 h-3.5 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => startEdit(r)}
                            className={rowAction}
                            aria-label={t('sidebar.renameChat', { title: r.title })}
                            title={t('sidebar.rename')}
                          >
                            <Icon.Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => onDelete(r.id)}
                            className={`${rowAction} hover:text-[var(--danger)]`}
                            aria-label={t('sidebar.deleteChat', { title: r.title })}
                            title={t('common.delete')}
                          >
                            <Icon.Trash size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </main>
  )
}

// Native checkbox, full-size and transparent over a drawn 16 px box: the hit
// area is the whole 32 px (44 px on touch) cell, the focus ring is drawn on the
// visible box, and the checked state uses the filled-CTA tokens.
function Checkbox({ checked, onChange, label }) {
  return (
    <span className="relative shrink-0 grid place-items-center w-8 h-8 [@media(hover:none)]:w-11 [@media(hover:none)]:h-11">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={label}
        className="peer absolute inset-0 m-0 w-full h-full opacity-0 cursor-pointer"
      />
      <span
        aria-hidden
        className="pointer-events-none grid place-items-center w-4 h-4 rounded border border-[var(--muted)] text-[var(--on-accent)] transition-colors duration-fast peer-checked:bg-[var(--accent-strong)] peer-checked:border-[var(--accent-strong)] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus-ring)] [&>svg]:opacity-0 peer-checked:[&>svg]:opacity-100"
      >
        <Icon.Check size={12} sw={3} />
      </span>
    </span>
  )
}

function EmptyState({ title, hint, children }) {
  return (
    <div className="py-section flex flex-col items-center text-center gap-2">
      <span aria-hidden className="grid place-items-center w-11 h-11 rounded-full bg-[var(--surface-2)] text-[var(--muted)]">
        <Icon.History size={20} />
      </span>
      <p className="mt-1 text-title font-semibold text-[var(--text)]">{title}</p>
      <p className="max-w-sm text-body text-[var(--muted)]">{hint}</p>
      <div className="mt-2 flex items-center gap-2">{children}</div>
    </div>
  )
}

// Same anatomy as a row (checkbox, title, time) so nothing jumps on arrival.
function HistorySkeleton({ label }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="divide-y divide-[var(--border)] animate-fade-in">
      {[72, 58, 84, 46, 66].map((w, i) => (
        // py-1.5 + a 40 px line = the real row (whose title button is min-h-10)
        <div key={i} className="flex items-center gap-2 py-1.5 px-1">
          <span className="grid place-items-center w-8 h-8">
            <Skeleton className="w-4 h-4" rounded="rounded" />
          </span>
          <div className="flex-1 min-w-0 h-10 flex items-center">
            <Skeleton className="h-3" rounded="rounded-full" style={{ width: `${w}%` }} />
          </div>
          <Skeleton className="h-2.5 w-14 mr-1" rounded="rounded-full" />
        </div>
      ))}
    </div>
  )
}
