import { useEffect, useState } from 'react'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import { getJSON, putJSON } from '../api.js'

// small up/down control built from the ChevronDown glyph (no dedicated arrow
// icon in the set); ChevronDown rotated 180° is an up-chevron.
function ReorderBtn({ dir, disabled, onClick, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="p-1 rounded-md text-[var(--faint)] enabled:hover:text-[var(--text)] enabled:hover:bg-[var(--surface-3)] disabled:opacity-25 transition"
    >
      <Icon.ChevronDown size={14} className={dir === 'up' ? 'rotate-180' : ''} />
    </button>
  )
}

const PROVIDER_DOT = {
  Anthropic: '#d97757',
  OpenAI: '#10a37f',
  'OpenAI (OSS)': '#10a37f',
  Google: '#4285f4',
  Meta: '#0668e1',
  'Zhipu AI': '#7c3aed',
  Alibaba: '#ff6a00',
  Outros: '#888',
}

const DATABRICKS_PRICING_URL = 'https://www.databricks.com/product/pricing/foundation-model-serving'

// Admin tab: the org's LLM catalog. The DEFAULT set (curated families: Claude,
// Gemini, GPT, Qwen, GPT-OSS, GLM, Llama) is enabled out of the box with known
// prices. Admins remove any they don't want and ADD more from the discovered
// endpoints — a non-curated endpoint requires input/output token costs before
// it can be added (so its cost estimate is never blank). Only enabled endpoints
// reach users via GET /api/models.
export default function ModelsAdminTab({ open, onModelsChanged }) {
  const t = useT()
  const [endpoints, setEndpoints] = useState(null)
  const [error, setError] = useState('')
  const [savingId, setSavingId] = useState(null)
  const [edits, setEdits] = useState({}) // per-endpoint edit buffer (enabled rows)
  const [addOpen, setAddOpen] = useState(false)
  const [query, setQuery] = useState('') // search within the "Add model" picker
  const [addDraft, setAddDraft] = useState({}) // { [id]: { priceIn, priceOut } }
  const [recommended, setRecommended] = useState([]) // curated defaults missing from this org's catalog

  const load = async () => {
    try {
      const r = await getJSON('/api/admin/model-endpoints')
      setEndpoints(r.endpoints || [])
      setRecommended(r.recommended || [])
      setError('')
    } catch (e) {
      setError(e.message)
      setEndpoints([])
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const editOf = (ep) =>
    edits[ep.id] || {
      displayName: ep.displayName,
      blurb: ep.blurb,
      priceIn: ep.priceIn == null ? '' : String(ep.priceIn),
      priceOut: ep.priceOut == null ? '' : String(ep.priceOut),
    }

  const parsePrice = (s) => {
    if (s == null || String(s).trim() === '') return null
    const n = Number(s)
    return isFinite(n) && n >= 0 ? n : null
  }

  const save = async (ep, patch) => {
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
    try {
      await putJSON(`/api/admin/model-endpoints/${encodeURIComponent(ep.id)}`, body)
      setEndpoints((list) => list.map((x) => (x.id === ep.id ? { ...x, ...body } : x)))
      onModelsChanged?.()
      setError('')
    } catch (e) {
      setError(e.message)
    } finally {
      setSavingId(null)
    }
  }

  // Add an available endpoint. Curated endpoints carry a known price
  // (inferredPrice*) → one click. A non-curated endpoint REQUIRES in/out costs
  // first. Image models are priced per-image, so no cost gate applies.
  // Only a price the admin TYPED is stored; a curated one stays null in the
  // override so it keeps following the curated list (price fixes propagate).
  const addModel = async (ep) => {
    const draft = addDraft[ep.id] || {}
    const pin = parsePrice(draft.priceIn)
    const pout = parsePrice(draft.priceOut)
    if (ep.modality !== 'image' && ((pin ?? ep.inferredPriceIn) == null || (pout ?? ep.inferredPriceOut) == null)) {
      setError(t('models.addNeedsCost'))
      return
    }
    await save({ ...ep, enabled: false }, { enabled: true, priceIn: pin, priceOut: pout })
    setAddDraft((m) => ({ ...m, [ep.id]: undefined }))
    setRecommended((ids) => ids.filter((x) => x !== ep.id))
  }

  // one-click "recomendados": sequential so each save lands before the next
  const addAllRecommended = async (list) => {
    for (const ep of list) await addModel(ep)
  }

  const removeModel = (ep) => save(ep, { enabled: false })

  // Reorder enabled models. Index 0 is first in the picker AND the default model
  // for new chats. Optimistically reorder the local list, then persist the new
  // order (a single PUT that assigns sequential sort_order server-side).
  const move = async (id, delta) => {
    const enabledIds = endpoints.filter((e) => e.enabled).map((e) => e.id)
    const from = enabledIds.indexOf(id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= enabledIds.length) return
    const reordered = [...enabledIds]
    ;[reordered[from], reordered[to]] = [reordered[to], reordered[from]]
    // reflect immediately: sort the local endpoints so enabled ones follow
    // `reordered` and disabled ones keep their place after.
    const rank = new Map(reordered.map((x, i) => [x, i]))
    setEndpoints((list) =>
      [...list].sort((a, b) => {
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
      setError(e.message)
      load() // resync on failure
    }
  }

  if (endpoints === null) {
    return <div className="text-sm text-[var(--muted)]">{t('models.loading')}</div>
  }

  const enabled = endpoints.filter((e) => e.enabled)
  const q = query.trim().toLowerCase()
  const available = endpoints
    .filter((e) => !e.enabled)
    .filter((e) => !q || (e.displayName || '').toLowerCase().includes(q) || (e.id || '').toLowerCase().includes(q))
  // only endpoints this workspace actually serves — recommending one the
  // gateway doesn't have would put a broken model in the picker
  // (kept in the server's curated order, so the best default comes first)
  const byId = new Map(endpoints.map((e) => [e.id, e]))
  const recommendedList = recommended.map((id) => byId.get(id)).filter((e) => e && !e.enabled && e.discovered)

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold flex items-center gap-2">
          <Icon.Wrench size={16} /> {t('settings.tab.models')}
        </h3>
        <p className="text-xs text-[var(--muted)] mt-0.5">{t('models.subtitle')}</p>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      {/* ---- Enabled models (the org catalog) ---- */}
      <div className="space-y-2">
        {enabled.length === 0 && (
          <div className="text-xs text-[var(--faint)] py-4 text-center">{t('models.noneEnabled')}</div>
        )}
        {enabled.length > 1 && (
          <p className="text-[11px] text-[var(--faint)] leading-relaxed">{t('models.reorderHint')}</p>
        )}
        {enabled.map((ep, idx) => {
          const e = editOf(ep)
          const dot = PROVIDER_DOT[ep.provider] || PROVIDER_DOT.Outros
          // chat models only: the first one is the default for new chats. Image
          // models live in a separate picker, so they don't get the badge.
          const chatModels = enabled.filter((x) => x.modality !== 'image')
          const isDefaultChat = ep.modality !== 'image' && chatModels[0]?.id === ep.id
          return (
            <div key={ep.id} className="rounded-xl border border-[var(--accent)]/40 bg-[var(--accent-soft)]/30 p-3">
              <div className="flex items-center gap-3">
                {/* reorder controls */}
                <div className="flex flex-col -my-1 shrink-0">
                  <ReorderBtn dir="up" disabled={idx === 0} onClick={() => move(ep.id, -1)} title={t('models.moveUp')} />
                  <ReorderBtn dir="down" disabled={idx === enabled.length - 1} onClick={() => move(ep.id, 1)} title={t('models.moveDown')} />
                </div>
                <span className="block w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate flex items-center gap-2">
                    {ep.displayName}
                    {isDefaultChat && (
                      <span className="text-[10px] text-[var(--accent)] border border-[var(--accent)]/40 rounded px-1">
                        {t('models.badge.default')}
                      </span>
                    )}
                    {ep.modality === 'image' && (
                      <span className="text-[10px] text-[var(--faint)] border border-[var(--border)] rounded px-1">
                        {t('models.badge.image')}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-[var(--faint)] font-mono truncate">{ep.id}</div>
                </div>
                {savingId === ep.id && <span className="text-[11px] text-[var(--faint)]">{t('common.saving')}</span>}
                <button
                  onClick={() => removeModel(ep)}
                  className="shrink-0 p-1.5 rounded-lg text-[var(--faint)] hover:text-red-400 hover:bg-[var(--surface-3)] transition"
                  title={t('models.remove')}
                >
                  <Icon.Trash size={15} />
                </button>
              </div>

              <div className="mt-3 pl-5 space-y-2">
                <div>
                  <label className="text-[11px] text-[var(--muted)]">{t('models.displayName')}</label>
                  <input
                    value={e.displayName}
                    onChange={(ev) => setEdits((m) => ({ ...m, [ep.id]: { ...editOf(ep), displayName: ev.target.value } }))}
                    onBlur={() => save(ep, {})}
                    placeholder={t('models.displayNamePlaceholder')}
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-[var(--muted)]">{t('models.blurb')}</label>
                  <input
                    value={e.blurb}
                    onChange={(ev) => setEdits((m) => ({ ...m, [ep.id]: { ...editOf(ep), blurb: ev.target.value } }))}
                    onBlur={() => save(ep, {})}
                    placeholder={t('models.blurbPlaceholder')}
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
                  />
                </div>
                {/* chat models carry token prices; image cost is per-image (no field) */}
                {ep.modality !== 'image' && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] text-[var(--muted)]">{t('models.priceIn')}</label>
                      <input
                        type="number" min="0" step="0.01" inputMode="decimal"
                        value={e.priceIn}
                        onChange={(ev) => setEdits((m) => ({ ...m, [ep.id]: { ...editOf(ep), priceIn: ev.target.value } }))}
                        onBlur={() => save(ep, {})}
                        placeholder={ep.inferredPriceIn != null ? String(ep.inferredPriceIn) : '—'}
                        className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-[var(--muted)]">{t('models.priceOut')}</label>
                      <input
                        type="number" min="0" step="0.01" inputMode="decimal"
                        value={e.priceOut}
                        onChange={(ev) => setEdits((m) => ({ ...m, [ep.id]: { ...editOf(ep), priceOut: ev.target.value } }))}
                        onBlur={() => save(ep, {})}
                        placeholder={ep.inferredPriceOut != null ? String(ep.inferredPriceOut) : '—'}
                        className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                    <div className="col-span-2 text-[10.5px] text-[var(--faint)] leading-relaxed">
                      {ep.curated && t('models.priceCuratedHint')}{' '}
                      {t('models.priceHint')}{' '}
                      <a href={DATABRICKS_PRICING_URL} target="_blank" rel="noreferrer" className="underline hover:text-[var(--accent)]">
                        {t('models.priceLink')}
                      </a>.
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* ---- Recommended: curated defaults this org doesn't have yet ---- */}
      {recommendedList.length > 0 && (
        <div className="rounded-xl border border-[var(--accent)]/40 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <Icon.Sparkle size={15} className="text-[var(--accent)] mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">{t('models.recommended.title')}</div>
              <p className="text-[11px] text-[var(--muted)] leading-relaxed">{t('models.recommended.subtitle')}</p>
            </div>
            <button
              onClick={() => addAllRecommended(recommendedList)}
              disabled={!!savingId}
              className="shrink-0 rounded-lg border border-[var(--accent)]/50 text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-50 text-xs font-semibold px-2.5 py-1.5 transition"
            >
              {t('models.recommended.addAll')}
            </button>
          </div>
          {recommendedList.map((ep) => (
            <div key={ep.id} className="flex items-center gap-2.5 rounded-lg border border-[var(--border)] px-2.5 py-2">
              <span className="block w-2 h-2 rounded-full shrink-0" style={{ background: PROVIDER_DOT[ep.provider] || PROVIDER_DOT.Outros }} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{ep.displayName}</div>
                <div className="text-[11px] text-[var(--faint)] truncate">
                  {ep.blurb}
                  {ep.inferredPriceIn != null && ` · $${ep.inferredPriceIn} / $${ep.inferredPriceOut} ${t('models.perMillion')}`}
                </div>
              </div>
              <button
                onClick={() => addModel(ep)}
                disabled={savingId === ep.id}
                className="shrink-0 flex items-center gap-1 rounded-lg bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white text-xs font-semibold px-2.5 py-1.5 transition"
              >
                <Icon.Plus size={13} /> {t('models.add')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ---- Add model ---- */}
      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <button
          onClick={() => setAddOpen((o) => !o)}
          className="w-full flex items-center gap-2 px-3 py-2.5 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] transition text-left"
        >
          <Icon.Plus size={15} className="text-[var(--accent)]" />
          <span className="text-sm font-semibold flex-1">{t('models.addModel')}</span>
          <Icon.ChevronRight size={14} className={`text-[var(--faint)] transition-transform ${addOpen ? 'rotate-90' : ''}`} />
        </button>

        {addOpen && (
          <div className="p-2 space-y-1.5">
            <div className="relative mb-1">
              <Icon.Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('models.searchPlaceholder')}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] pl-8 pr-3 py-1.5 text-sm outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
              />
            </div>
            {available.length === 0 && (
              <p className="px-2 py-3 text-xs text-[var(--faint)] text-center">{t('models.noneToAdd')}</p>
            )}
            {available.map((ep) => {
              const dot = PROVIDER_DOT[ep.provider] || PROVIDER_DOT.Outros
              const draft = addDraft[ep.id] || {}
              const isImage = ep.modality === 'image'
              const hasKnownPrice = ep.inferredPriceIn != null && ep.inferredPriceOut != null
              // a non-curated, non-image endpoint needs costs entered before adding
              const needsCost = !isImage && !hasKnownPrice
              return (
                <div key={ep.id} className="rounded-lg border border-[var(--border)] p-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="block w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate flex items-center gap-2">
                        {ep.displayName}
                        {ep.curated && (
                          <span className="text-[10px] text-[var(--faint)] border border-[var(--border)] rounded px-1">
                            {t('models.badge.curated')}
                          </span>
                        )}
                        {ep.discovered && !ep.curated && (
                          <span className="text-[10px] text-[var(--accent)] border border-[var(--accent)]/40 rounded px-1">
                            {t('models.badge.new')}
                          </span>
                        )}
                        {isImage && (
                          <span className="text-[10px] text-[var(--faint)] border border-[var(--border)] rounded px-1">
                            {t('models.badge.image')}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-[var(--faint)] font-mono truncate">{ep.id}</div>
                    </div>
                    <button
                      onClick={() => addModel(ep)}
                      disabled={savingId === ep.id}
                      className="shrink-0 flex items-center gap-1 rounded-lg bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white text-xs font-semibold px-2.5 py-1.5 transition"
                    >
                      <Icon.Plus size={13} /> {t('models.add')}
                    </button>
                  </div>
                  {/* cost inputs required for a non-curated endpoint */}
                  {needsCost && (
                    <div className="mt-2 pl-4.5 grid grid-cols-2 gap-2">
                      <input
                        type="number" min="0" step="0.01" inputMode="decimal"
                        value={draft.priceIn || ''}
                        onChange={(ev) => setAddDraft((m) => ({ ...m, [ep.id]: { ...draft, priceIn: ev.target.value } }))}
                        placeholder={t('models.priceIn')}
                        className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
                      />
                      <input
                        type="number" min="0" step="0.01" inputMode="decimal"
                        value={draft.priceOut || ''}
                        onChange={(ev) => setAddDraft((m) => ({ ...m, [ep.id]: { ...draft, priceOut: ev.target.value } }))}
                        placeholder={t('models.priceOut')}
                        className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
                      />
                      <div className="col-span-2 text-[10.5px] text-[var(--accent)] leading-relaxed">
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
      </div>
    </div>
  )
}
