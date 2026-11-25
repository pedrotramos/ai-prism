import { useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import * as Icon from './Icons.tsx'
import { useT } from '../lib/i18n.tsx'
import { getJSON, putJSON } from '../api.ts'
import { priceSourceOf } from '../lib/dsSettings.ts'
import { Field, SaveStatus, Switch, inputCls } from './SettingsControls.tsx'
import { ProviderMark } from './ProviderMark.tsx'

// useT()/useI18n() come from i18n.jsx (untyped JS), which infers a one-argument `t`.
type Translate = (key: string, vars?: Record<string, unknown>) => string

// small up/down control built from the ChevronDown glyph (no dedicated arrow
// icon in the set); ChevronDown rotated 180° is an up-chevron.
interface ReorderBtnProps {
  dir: 'up' | 'down'
  disabled: boolean
  onClick: () => void
  title: string
}

function ReorderBtn({ dir, disabled, onClick, title }: ReorderBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="grid place-items-center w-6 h-6 rounded-md text-[var(--faint)] enabled:hover:text-[var(--text)] enabled:hover:bg-[var(--surface-3)] disabled:opacity-25 transition"
    >
      <Icon.ChevronDown size={14} className={dir === 'up' ? 'rotate-180' : ''} />
    </button>
  )
}

// The provider's mark on a neutral tile (decorative: the provider name sits next to it).
function ModelTile({ ep }: { ep: Pick<Endpoint, 'provider' | 'id'> }) {
  return (
    <span aria-hidden className="shrink-0 grid place-items-center w-8 h-8 rounded-badge bg-[var(--surface-3)] text-[var(--text)]">
      <ProviderMark model={ep} size={16} />
    </span>
  )
}

// One row of GET /api/admin/model-endpoints (the fields this tab reads or writes).
interface Endpoint {
  id: string
  displayName: string
  blurb: string
  provider: string
  modality?: string
  enabled: boolean
  sortOrder: number
  priceIn: number | null
  priceOut: number | null
  inferredPriceIn?: number | null
  inferredPriceOut?: number | null
  curated?: boolean
  discovered?: boolean
}

type PriceKey = 'priceIn' | 'priceOut'
type PriceFields = Partial<Record<PriceKey, string>>

// the edit buffer of an enabled row: prices are text while typing
interface RowEdit {
  displayName: string
  blurb: string
  priceIn: string
  priceOut: string
}

interface RowStatus {
  state: 'idle' | 'saving' | 'saved' | 'error'
  error?: string
}

type SavePatch = Partial<Pick<Endpoint, 'enabled' | 'displayName' | 'blurb' | 'priceIn' | 'priceOut'>>

interface ModelsAdminTabProps {
  open: boolean
  onModelsChanged?: () => void
}

const badgeCls = 'text-caption rounded-badge border px-1'

const DATABRICKS_PRICING_URL = 'https://www.databricks.com/product/pricing/foundation-model-serving'

// Admin tab: the org's LLM catalog. The DEFAULT set (curated families: Claude,
// Gemini, GPT, Qwen, GPT-OSS, GLM, Llama) is enabled out of the box with known
// prices. Admins remove any they don't want and ADD more from the discovered
// endpoints — a non-curated endpoint requires input/output token costs before
// it can be added (so its cost estimate is never blank). Only enabled endpoints
// reach users via GET /api/models.
export default function ModelsAdminTab({ open, onModelsChanged }: ModelsAdminTabProps) {
  const t = useT() as Translate
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null)
  const [error, setError] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, RowEdit>>({}) // per-endpoint edit buffer (enabled rows)
  const [addOpen, setAddOpen] = useState(false)
  const [query, setQuery] = useState('') // search within the "Add model" picker
  const [addDraft, setAddDraft] = useState<Record<string, PriceFields | undefined>>({}) // { [id]: { priceIn, priceOut } }
  const [addErrors, setAddErrors] = useState<Record<string, PriceFields | undefined>>({}) // { [id]: { priceIn, priceOut } } field-level messages
  const [recommended, setRecommended] = useState<string[]>([]) // curated defaults missing from this org's catalog
  const [expanded, setExpanded] = useState<string | null>(null) // the one enabled row open for editing
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({}) // { [id]: { state, error } } explicit saved / error
  const [kept, setKept] = useState<Set<string>>(() => new Set()) // models switched off in this visit stay listed, so the switch can undo it
  const [recOpen, setRecOpen] = useState(false)

  const load = async () => {
    try {
      const r = await getJSON<{ endpoints?: Endpoint[]; recommended?: string[] }>('/api/admin/model-endpoints')
      setEndpoints(r.endpoints || [])
      setRecommended(r.recommended || [])
      setError('')
    } catch (e) {
      setError((e as Error).message)
      setEndpoints([])
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const editOf = (ep: Endpoint): RowEdit =>
    edits[ep.id] || {
      displayName: ep.displayName,
      blurb: ep.blurb,
      priceIn: ep.priceIn == null ? '' : String(ep.priceIn),
      priceOut: ep.priceOut == null ? '' : String(ep.priceOut),
    }

  const parsePrice = (s: unknown): number | null => {
    if (s == null || String(s).trim() === '') return null
    const n = Number(String(s).replace(',', '.'))
    return isFinite(n) && n >= 0 ? n : null
  }

  // inline validation (Postel: accept "1,5" as 1.5, reject what can't be a price)
  const priceError = (v: unknown): string => {
    if (v == null || String(v).trim() === '') return ''
    const n = Number(String(v).replace(',', '.'))
    return isFinite(n) && n >= 0 ? '' : t('models.err.price')
  }
  const rowErrors = (ep: Endpoint) => {
    const e = editOf(ep)
    return { priceIn: priceError(e.priceIn), priceOut: priceError(e.priceOut) }
  }

  // save from an edited row: only when every field is valid
  const saveRow = (ep: Endpoint) => {
    const errs = rowErrors(ep)
    if (errs.priceIn || errs.priceOut) return
    save(ep, {}, { row: true })
  }

  const save = async (ep: Endpoint, patch: SavePatch, { row = false } = {}): Promise<boolean> => {
    const current = editOf(ep)
    const body = {
      enabled: patch.enabled ?? ep.enabled,
      displayName: patch.displayName ?? current.displayName,
      blurb: patch.blurb ?? current.blurb,
      sortOrder: ep.sortOrder,
      priceIn: patch.priceIn !== undefined ? patch.priceIn : parsePrice(current.priceIn),
      priceOut: patch.priceOut !== undefined ? patch.priceOut : parsePrice(current.priceOut),
    }
    setSavingId(ep.id)
    if (row) setRowStatus((m) => ({ ...m, [ep.id]: { state: 'saving' } }))
    try {
      await putJSON(`/api/admin/model-endpoints/${encodeURIComponent(ep.id)}`, body)
      setEndpoints((list) => (list as Endpoint[]).map((x) => (x.id === ep.id ? { ...x, ...body } : x)))
      onModelsChanged?.()
      setError('')
      if (row) setRowStatus((m) => ({ ...m, [ep.id]: { state: 'saved' } }))
      return true
    } catch (e) {
      if (row) setRowStatus((m) => ({ ...m, [ep.id]: { state: 'error', error: (e as Error).message } }))
      else setError((e as Error).message)
      return false
    } finally {
      setSavingId(null)
    }
  }

  // Add an available endpoint. Curated endpoints carry a known price
  // (inferredPrice*) → one click. A non-curated endpoint REQUIRES in/out costs
  // first. Image models are priced per-image, so no cost gate applies.
  // Only a price the admin TYPED is stored; a curated one stays null in the
  // override so it keeps following the curated list (price fixes propagate).
  const addModel = async (ep: Endpoint) => {
    const draft = addDraft[ep.id] || {}
    const pin = parsePrice(draft.priceIn)
    const pout = parsePrice(draft.priceOut)
    if (ep.modality !== 'image') {
      // each cost field gets its own message: a malformed value, or a missing
      // one when there is no curated price to fall back to
      const fieldError = (raw: unknown, parsed: number | null, inferred: number | null | undefined) =>
        priceError(raw) || ((parsed ?? inferred) == null ? t('models.err.costRequired') : '')
      const errs = {
        priceIn: fieldError(draft.priceIn, pin, ep.inferredPriceIn),
        priceOut: fieldError(draft.priceOut, pout, ep.inferredPriceOut),
      }
      if (errs.priceIn || errs.priceOut) {
        setAddErrors((m) => ({ ...m, [ep.id]: errs }))
        setError(t('models.addNeedsCost'))
        return
      }
    }
    setAddErrors((m) => ({ ...m, [ep.id]: undefined }))
    const ok = await save({ ...ep, enabled: false }, { enabled: true, priceIn: pin, priceOut: pout })
    // a failed save keeps what the admin typed so they can retry
    if (!ok) return
    setAddDraft((m) => ({ ...m, [ep.id]: undefined }))
    setRecommended((ids) => ids.filter((x) => x !== ep.id))
  }

  // one-click "recomendados": sequential so each save lands before the next
  const addAllRecommended = async (list: Endpoint[]) => {
    for (const ep of list) await addModel(ep)
  }

  // The "Active" switch. Off keeps the row on screen (so a slip is one click to undo); the model then
  // leaves the picker for everyone, exactly like the old remove button did.
  const setActive = async (ep: Endpoint, next: boolean) => {
    const ok = await save(ep, { enabled: next }, { row: true })
    if (!ok) return
    setKept((k) => {
      const n = new Set(k)
      if (next) n.delete(ep.id)
      else n.add(ep.id)
      return n
    })
  }

  // Reorder enabled models. Index 0 is first in the picker AND the default model
  // for new chats. Optimistically reorder the local list, then persist the new
  // order (a single PUT that assigns sequential sort_order server-side).
  const move = async (id: string, delta: number) => {
    const enabledIds = (endpoints as Endpoint[]).filter((e) => e.enabled).map((e) => e.id)
    const from = enabledIds.indexOf(id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= enabledIds.length) return
    const reordered = [...enabledIds]
    ;[reordered[from], reordered[to]] = [reordered[to] as string, reordered[from] as string] // both indexes checked above
    // reflect immediately: sort the local endpoints so enabled ones follow
    // `reordered` and disabled ones keep their place after.
    const rank = new Map(reordered.map((x, i) => [x, i]))
    setEndpoints((list) =>
      [...(list as Endpoint[])].sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
        if (a.enabled && b.enabled) return (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)
        return 0
      })
    )
    try {
      await putJSON('/api/admin/model-endpoints-order', { order: reordered })
      onModelsChanged?.()
      setError('')
    } catch (e) {
      setError((e as Error).message)
      load() // resync on failure
    }
  }

  if (endpoints === null) {
    return <div className="text-body text-[var(--muted)]">{t('models.loading')}</div>
  }

  const enabled = endpoints.filter((e) => e.enabled)
  const shown = endpoints.filter((e) => e.enabled || kept.has(e.id))
  const chatModels = enabled.filter((x) => x.modality !== 'image')
  const q = query.trim().toLowerCase()
  const available = endpoints
    .filter((e) => !e.enabled && !kept.has(e.id))
    .filter((e) => !q || (e.displayName || '').toLowerCase().includes(q) || (e.id || '').toLowerCase().includes(q))
  // only endpoints this workspace actually serves — recommending one the
  // gateway doesn't have would put a broken model in the picker
  // (kept in the server's curated order, so the best default comes first)
  const byId = new Map(endpoints.map((e) => [e.id, e]))
  const recommendedList = recommended.map((id) => byId.get(id)).filter((e): e is Endpoint => !!(e && !e.enabled && e.discovered))

  const inkBtn =
    'shrink-0 inline-flex items-center gap-1.5 rounded-control bg-action text-on-action hover:opacity-90 disabled:opacity-50 text-label font-semibold px-3 min-h-9 transition duration-fast'
  const quietBtn =
    'shrink-0 inline-flex items-center gap-1.5 rounded-control border border-[var(--border)] bg-raised hover:bg-[var(--surface-3)] disabled:opacity-50 text-label font-semibold px-3 min-h-9 transition duration-fast'

  const priceBadge = (ep: Endpoint) => {
    const src = priceSourceOf(ep)
    if (src === 'none') return <span className="text-caption text-[var(--faint)]">—</span>
    return (
      <span className={`${badgeCls} border-transparent ${src === 'negotiated' ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'bg-[var(--surface-3)] text-[var(--muted)]'}`}>
        {t(src === 'negotiated' ? 'models.price.negotiated' : 'models.price.list')}
      </span>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-title font-semibold">{t('settings.tab.models')}</h3>
        <p className="text-label text-[var(--muted)] mt-1 max-w-[62ch]">{t('models.subtitle')}</p>
      </div>

      {error && (
        <p role="alert" className="text-label text-[var(--danger)]">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-expanded={addOpen} onClick={() => setAddOpen((o) => !o)} className={inkBtn}>
          <Icon.Plus size={14} /> {t('models.addModel')}
        </button>
        {recommendedList.length > 0 && (
          <button type="button" aria-expanded={recOpen} onClick={() => setRecOpen((o) => !o)} className={quietBtn}>
            {t('models.recommended.title')}
            <span className="rounded-badge bg-[var(--accent-soft)] px-1.5 text-caption font-semibold text-[var(--accent-text)]">
              {t('models.recommended.count', { n: recommendedList.length })}
            </span>
          </button>
        )}
      </div>

      {/* ---- Add model ---- */}
      {addOpen && (
        <div className="rounded-card border border-[var(--border)] bg-raised p-2 space-y-1.5">
          <div className="relative mb-1">
            <Icon.Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              type="search"
              placeholder={t('models.searchPlaceholder')}
              aria-label={t('models.searchPlaceholder')}
              className={`${inputCls} pl-8`}
            />
          </div>
          {available.length === 0 && <p className="px-2 py-3 text-label text-[var(--muted)] text-center">{t('models.noneToAdd')}</p>}
          {available.map((ep) => {
            const draft = addDraft[ep.id] || {}
            const isImage = ep.modality === 'image'
            const hasKnownPrice = ep.inferredPriceIn != null && ep.inferredPriceOut != null
            // a non-curated, non-image endpoint needs costs entered before adding
            const needsCost = !isImage && !hasKnownPrice
            return (
              <div key={ep.id} className="rounded-control border border-[var(--border)] p-2.5">
                <div className="flex items-center gap-2.5">
                  <ModelTile ep={ep} />
                  <div className="flex-1 min-w-0">
                    <div className="text-body font-medium truncate flex items-center gap-2">
                      {ep.displayName}
                      {ep.curated && <span className={`${badgeCls} border-[var(--border)] text-[var(--muted)]`}>{t('models.badge.curated')}</span>}
                      {ep.discovered && !ep.curated && (
                        <span className={`${badgeCls} border-transparent bg-[var(--accent-soft)] text-[var(--accent-text)]`}>{t('models.badge.new')}</span>
                      )}
                      {isImage && <span className={`${badgeCls} border-[var(--border)] text-[var(--muted)]`}>{t('models.badge.image')}</span>}
                    </div>
                    <div className="text-caption text-[var(--muted)] font-mono truncate">{ep.id}</div>
                  </div>
                  <button type="button" onClick={() => addModel(ep)} disabled={savingId === ep.id} className={inkBtn}>
                    <Icon.Plus size={13} /> {t('models.add')}
                  </button>
                </div>
                {/* cost inputs required for a non-curated endpoint */}
                {needsCost && (
                  <div className="mt-2 pl-10 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {(['priceIn', 'priceOut'] as const).map((k) => (
                      <Field key={k} label={t(k === 'priceIn' ? 'models.priceIn' : 'models.priceOut')} error={addErrors[ep.id]?.[k]}>
                        {(p) => (
                          <input
                            {...p}
                            inputMode="decimal"
                            value={draft[k] || ''}
                            onChange={(ev) => {
                              const v = ev.target.value
                              setAddDraft((m) => ({ ...m, [ep.id]: { ...(m[ep.id] || {}), [k]: v } }))
                              // typing clears that field's error; the other stays until fixed
                              setAddErrors((m) => (m[ep.id]?.[k] ? { ...m, [ep.id]: { ...m[ep.id], [k]: '' } } : m))
                            }}
                            aria-label={t(k === 'priceIn' ? 'models.priceInNamed' : 'models.priceOutNamed', { name: ep.displayName })}
                            className={inputCls}
                          />
                        )}
                      </Field>
                    ))}
                    <div className="sm:col-span-2 text-caption text-[var(--accent-text)] leading-relaxed">
                      {t('models.addNeedsCost')}{' '}
                      <a href={DATABRICKS_PRICING_URL} target="_blank" rel="noreferrer" className="underline">
                        {t('models.priceLink')}
                      </a>.
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ---- Recommended: curated defaults this org doesn't have yet ---- */}
      {recOpen && recommendedList.length > 0 && (
        <div className="rounded-card border border-[var(--border)] bg-raised p-3 space-y-2">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-body font-semibold">{t('models.recommended.title')}</div>
              <p className="text-caption text-[var(--muted)] leading-relaxed">{t('models.recommended.subtitle')}</p>
            </div>
            <button type="button" onClick={() => addAllRecommended(recommendedList)} disabled={!!savingId} className={quietBtn}>
              {t('models.recommended.addAll')}
            </button>
          </div>
          {recommendedList.map((ep) => (
            <div key={ep.id} className="flex items-center gap-2.5 rounded-control border border-[var(--border)] px-2.5 py-2">
              <ModelTile ep={ep} />
              <div className="flex-1 min-w-0">
                <div className="text-body font-medium truncate">{ep.displayName}</div>
                <div className="text-caption text-[var(--muted)] truncate">
                  {ep.blurb}
                  {ep.inferredPriceIn != null && ` · $${ep.inferredPriceIn} / $${ep.inferredPriceOut} ${t('models.perMillion')}`}
                </div>
              </div>
              <button type="button" onClick={() => addModel(ep)} disabled={savingId === ep.id} className={inkBtn}>
                <Icon.Plus size={13} /> {t('models.add')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ---- The catalog: one row per model, expand one to edit (the list stays
           scannable; details only on demand) ---- */}
      <div className="rounded-card border border-[var(--border)] bg-raised overflow-hidden">
        {shown.length === 0 && <div className="text-label text-[var(--muted)] py-6 text-center">{t('models.noneEnabled')}</div>}
        {shown.length > 0 && (
          <div
            aria-hidden
            className="hidden sm:grid grid-cols-[3.5rem_minmax(0,1fr)_9rem_6rem] items-center gap-x-3 px-3 py-2 border-b border-[var(--border)] text-caption font-medium text-[var(--muted)]"
          >
            <span />
            <span>{t('models.col.model')}</span>
            <span>{t('models.col.price')}</span>
            <span className="text-right">{t('models.col.active')}</span>
          </div>
        )}
        {enabled.length > 1 && <p className="px-3 pt-2 text-caption text-[var(--muted)]">{t('models.reorderHint')}</p>}
        <ul aria-label={t('models.enabledList')} className="divide-y divide-[var(--border-soft)]">
          {shown.map((ep) => {
            const enabledIdx = enabled.findIndex((x) => x.id === ep.id)
            const e = editOf(ep)
            const errs = rowErrors(ep)
            const open = expanded === ep.id
            const panelId = `model-row-${ep.id.replace(/[^\w-]/g, '_')}`
            const status = rowStatus[ep.id] || { state: 'idle' }
            // chat models only: the first one is the default for new chats. Image
            // models live in a separate picker, so they don't get the badge.
            const isDefaultChat = ep.modality !== 'image' && chatModels[0]?.id === ep.id
            const setField = (k: keyof RowEdit) => (ev: ChangeEvent<HTMLInputElement>) => setEdits((m) => ({ ...m, [ep.id]: { ...editOf(ep), [k]: ev.target.value } }))
            return (
              <li key={ep.id} className={`transition duration-fast ${open ? 'bg-sunk' : ''} ${ep.enabled ? '' : 'opacity-70'}`}>
                <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] sm:grid-cols-[3.5rem_minmax(0,1fr)_9rem_6rem] items-center gap-x-3 px-3 py-2">
                  <div className="flex items-center gap-0.5">
                    <ReorderBtn dir="up" disabled={!ep.enabled || enabledIdx === 0} onClick={() => move(ep.id, -1)} title={t('models.moveUpNamed', { name: ep.displayName })} />
                    <ReorderBtn dir="down" disabled={!ep.enabled || enabledIdx === enabled.length - 1} onClick={() => move(ep.id, 1)} title={t('models.moveDownNamed', { name: ep.displayName })} />
                  </div>
                  <div className="flex items-center gap-2.5 min-w-0">
                    <ModelTile ep={ep} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                        {/* the toggle's visible text is just the name, so its accessible
                            name ("Edit <name>") contains it (WCAG 2.5.3) */}
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={panelId}
                          aria-label={t('models.editNamed', { name: ep.displayName })}
                          onClick={() => setExpanded(open ? null : ep.id)}
                          className="max-w-full min-w-0 inline-flex items-center gap-1.5 min-h-7 rounded-control px-1.5 -ml-1.5 text-left text-body font-medium hover:bg-[var(--surface-3)] transition duration-fast"
                        >
                          <span className="truncate">{ep.displayName}</span>
                          <Icon.ChevronRight size={14} className={`shrink-0 text-[var(--muted)] transition-transform duration-fast ${open ? 'rotate-90' : ''}`} />
                        </button>
                        {isDefaultChat && (
                          <span className={`${badgeCls} shrink-0 border-transparent bg-[var(--accent-soft)] text-[var(--accent-text)]`}>{t('models.badge.default')}</span>
                        )}
                        {ep.modality === 'image' && (
                          <span className={`${badgeCls} shrink-0 text-[var(--muted)] border-[var(--border)]`}>{t('models.badge.image')}</span>
                        )}
                      </div>
                      <div className="text-caption text-[var(--muted)] truncate">
                        {ep.provider} · <span className="font-mono">{ep.id}</span>
                      </div>
                      <div className="sm:hidden mt-0.5">{priceBadge(ep)}</div>
                    </div>
                  </div>
                  <div className="hidden sm:block">{priceBadge(ep)}</div>
                  <div className="flex items-center justify-end gap-2">
                    <SaveStatus state={status.state} error={status.error} className="shrink-0 max-w-28" />
                    <Switch checked={ep.enabled} onChange={(next) => setActive(ep, next)} label={t('models.activeNamed', { name: ep.displayName })} disabled={savingId === ep.id} />
                  </div>
                </div>

                {open && (
                  <div id={panelId} className="px-4 pb-3 pt-3 space-y-3 border-t border-[var(--border-soft)]">
                    <Field label={t('models.displayName')}>
                      {(p) => (
                        <input {...p} value={e.displayName} onChange={setField('displayName')} onBlur={() => saveRow(ep)} placeholder={t('models.displayNamePlaceholder')} className={inputCls} />
                      )}
                    </Field>
                    <Field label={t('models.blurb')}>
                      {(p) => (
                        <input {...p} value={e.blurb} onChange={setField('blurb')} onBlur={() => saveRow(ep)} placeholder={t('models.blurbPlaceholder')} className={inputCls} />
                      )}
                    </Field>
                    {/* chat models carry token prices; image cost is per-image (no field) */}
                    {ep.modality !== 'image' && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field label={t('models.priceIn')} error={errs.priceIn}>
                          {(p) => (
                            <input {...p} inputMode="decimal" value={e.priceIn} onChange={setField('priceIn')} onBlur={() => saveRow(ep)} placeholder={ep.inferredPriceIn != null ? String(ep.inferredPriceIn) : '—'} className={inputCls} />
                          )}
                        </Field>
                        <Field label={t('models.priceOut')} error={errs.priceOut}>
                          {(p) => (
                            <input {...p} inputMode="decimal" value={e.priceOut} onChange={setField('priceOut')} onBlur={() => saveRow(ep)} placeholder={ep.inferredPriceOut != null ? String(ep.inferredPriceOut) : '—'} className={inputCls} />
                          )}
                        </Field>
                        <p className="sm:col-span-2 text-caption text-[var(--muted)]">
                          {ep.curated && t('models.priceCuratedHint')}{' '}
                          {t('models.priceHint')}{' '}
                          <a href={DATABRICKS_PRICING_URL} target="_blank" rel="noreferrer" className="underline text-[var(--link)]">
                            {t('models.priceLink')}
                          </a>.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
