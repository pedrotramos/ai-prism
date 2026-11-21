import { useEffect, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import DeckTemplateInspector from './DeckTemplateInspector.jsx'
import { getJSON, postJSON, patchJSON, del } from '../api.ts'
import { EMPTY_TEMPLATE, extractFromFiles, mergeTemplate, stripExt, rasterizeToPng } from '../lib/pptxMining.ts'
import { useT } from '../lib/i18n.tsx'
import { DS_FALLBACK } from '../lib/dsDefaults.ts'

const FONT_SUGGESTIONS = [
  'DM Sans', 'Georgia', 'Helvetica', 'Arial', 'Calibri', 'Verdana', 'Times New Roman', 'Garamond', 'Trebuchet MS', 'Barlow',
]


const KIND_KEYS = ['icon', 'image', 'watermark']
const kindLabel = (t, k) => t(`templates.kind.${KIND_KEYS.includes(k) ? k : 'icon'}`)

function isValidHex(v) {
  return /^#[0-9a-fA-F]{6}$/.test(v || '')
}

// Mined labels are often useless for steering the model ("Imagem 12",
// "Gráfico 37", empty) — those are the ones worth sending to the vision
// labeler; a human-written or already-descriptive label is never overwritten.
function isGenericLabel(label) {
  return !label || /^(imagem|image|picture|gr[aá]fico|graphic|icon|[ií]cone|shape|forma|logo)?[\s_-]*\d*$/i.test(label.trim())
}

// "Relatório da importação" — what the classifier decided for this import:
// counts of what entered, what was ignored (and why) and which files fell
// into the generic-'image' catch-all (the usual sign of a misnamed asset,
// reclassifiable one click away in the asset editor).
function ImportReportPanel({ report }) {
  const t = useT()
  if (!report) return null
  const c = report.counts || {}
  const parts = [
    c.icon ? t(c.icon > 1 ? 'templates.report.iconMany' : 'templates.report.iconOne', { n: c.icon }) : null,
    c.lockup ? t(c.lockup > 1 ? 'templates.report.lockupMany' : 'templates.report.lockupOne', { n: c.lockup }) : null,
    c.illustration ? t(c.illustration > 1 ? 'templates.report.illustrationMany' : 'templates.report.illustrationOne', { n: c.illustration }) : null,
    c.background ? t(c.background > 1 ? 'templates.report.backgroundMany' : 'templates.report.backgroundOne', { n: c.background }) : null,
    c.image ? t('templates.report.image', { n: c.image }) : null,
    report.paletteCount ? t('templates.report.colorTokens', { n: report.paletteCount }) : null,
    report.fontCount ? t(report.fontCount > 1 ? 'templates.report.fontMany' : 'templates.report.fontOne', { n: report.fontCount }) : null,
    report.cardCount ? t(report.cardCount > 1 ? 'templates.report.cardMany' : 'templates.report.cardOne', { n: report.cardCount }) : null,
    report.readmeFound ? t('templates.report.brandGuide') : null,
  ].filter(Boolean)
  const skipped = [
    ...(report.skippedAssets || []),
    ...(report.fontsSkipped || []),
    ...(report.cardsSkipped || []),
  ]
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 space-y-1.5">
      <div className="text-label font-semibold flex items-center gap-1.5">
        <Icon.FileText size={13} /> {t('templates.report.title')}
      </div>
      {parts.length > 0 && <p className="text-caption text-[var(--muted)]">{parts.join(' · ')}</p>}
      {!report.manifestFound && (
        <p className="text-caption text-[var(--faint)]">
          {t('templates.report.noManifestBefore')} <code>_ds_manifest.json</code>
          {report.manifestError ? ` (${report.manifestError})` : ''}{t('templates.report.noManifestAfter')}
        </p>
      )}
      {report.catchAllImages?.length > 0 && (
        <p className="text-caption text-[var(--faint)]">
          {t('templates.report.catchAll', { n: report.catchAllImages.length })}{' '}
          <span className="font-mono">{report.catchAllImages.slice(0, 8).join(', ')}</span>
          {report.catchAllImages.length > 8 ? '…' : ''}
        </p>
      )}
      {skipped.length > 0 && (
        <details className="text-caption text-[var(--faint)]">
          <summary className="cursor-pointer">{t('templates.report.skipped', { n: skipped.length })}</summary>
          <ul className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
            {skipped.slice(0, 40).map((s, i) => (
              <li key={i} className="font-mono truncate">
                {s.path.split('/').pop()} <span className="font-sans">— {s.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function TemplateForm({ initial, onCancel, onSave, saving, onCreateNew }) {
  const t = useT()
  const [tpl, setTpl] = useState(initial)
  const [selectedAsset, setSelectedAsset] = useState(null) // asset id being edited
  const [enriching, setEnriching] = useState(false)
  const [enrichError, setEnrichError] = useState('')
  const [labeling, setLabeling] = useState(false)

  // assets/diagrams still carrying a generic mined label ("Imagem 3", empty)
  const unlabeled = (tpl.iconAssets || []).filter((a) => isGenericLabel(a.label))
  const unlabeledDiagrams = (tpl.minedStyle?.diagrams || []).filter((d) => isGenericLabel(d.label))

  // Vision labeling (server route /api/deck-templates/label-assets): sends
  // 128px thumbnails, merges the returned semantic labels into the draft.
  const onLabelAssets = async () => {
    setEnrichError('')
    setLabeling(true)
    try {
      const assets = []
      for (const a of unlabeled.slice(0, 40)) {
        try {
          assets.push({ id: a.id, kind: a.kind || 'icon', dataUrl: await rasterizeToPng(a.dataUrl) })
        } catch {
          // un-rasterizable asset — skip it
        }
      }
      const diagrams = unlabeledDiagrams.slice(0, 8).map((d) => ({
        id: d.id,
        texts: (d.shapes || []).map((s) => s.text).filter(Boolean).slice(0, 20),
      }))
      const r = await postJSON('/api/deck-templates/label-assets', { assets, diagrams })
      const labels = r.labels || {}
      if (Object.keys(labels).length) {
        setTpl((t) => ({
          ...t,
          iconAssets: (t.iconAssets || []).map((a) => (labels[a.id] ? { ...a, label: labels[a.id] } : a)),
          minedStyle: t.minedStyle
            ? {
                ...t.minedStyle,
                diagrams: (t.minedStyle.diagrams || []).map((d) => (labels[d.id] ? { ...d, label: labels[d.id] } : d)),
              }
            : t.minedStyle,
        }))
      }
    } catch (e) {
      setEnrichError(e.message || t('templates.errLabelAssets'))
    } finally {
      setLabeling(false)
    }
  }

  const onLogoFile = (file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setTpl((t) => ({ ...t, logoDataUrl: reader.result }))
    reader.readAsDataURL(file)
  }

  // Feeds MORE source files into this design system (another .pptx, loose
  // icon/logo images…) — collections append, review-ready fields stay put.
  // When the new import would REPLACE heavy fields the draft already has
  // (richer-wins rule), the user decides instead of losing them silently.
  const [pendingEnrich, setPendingEnrich] = useState(null) // { patch, replaces: [{label, from, to}] }
  const onEnrichFiles = async (files) => {
    const list = Array.from(files || [])
    if (!list.length) return
    setEnrichError('')
    setEnriching(true)
    try {
      const patch = await extractFromFiles(list, null)
      const HEAVY = [
        ['palette', t('templates.heavyPalette')],
        ['fontAssets', t('templates.heavyFonts')],
        ['dsCards', t('templates.heavyCards')],
      ]
      const replaces = HEAVY.filter(
        ([k]) => (tpl[k]?.length || 0) > 0 && (patch[k]?.length || 0) > (tpl[k]?.length || 0)
      ).map(([k, label]) => ({ label, from: tpl[k].length, to: patch[k].length }))
      if (replaces.length) setPendingEnrich({ patch, replaces })
      else setTpl((t) => mergeTemplate(t, patch))
    } catch (e) {
      setEnrichError(e.message || t('templates.errImportFiles'))
    } finally {
      setEnriching(false)
    }
  }

  const patchAsset = (id, patch) => {
    setTpl((t) => ({ ...t, iconAssets: (t.iconAssets || []).map((a) => (a.id === id ? { ...a, ...patch } : a)) }))
  }

  const removeIconAsset = (id) => {
    if (selectedAsset === id) setSelectedAsset(null)
    setTpl((t) => ({ ...t, iconAssets: (t.iconAssets || []).filter((a) => a.id !== id) }))
  }

  const activeAsset = (tpl.iconAssets || []).find((a) => a.id === selectedAsset)
  const diagramCount = tpl.minedStyle?.diagrams?.length || 0

  return (
    <div className="rounded-xl border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[var(--surface-2)] p-3.5 space-y-3">
      <input
        value={tpl.name}
        onChange={(e) => setTpl((t) => ({ ...t, name: e.target.value }))}
        placeholder={t('templates.namePlaceholder')}
        className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-body focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          ['primaryColor', t('templates.colorPrimary')],
          ['secondaryColor', t('templates.colorSecondary')],
          ['accentColor', t('templates.colorAccent')],
          ['backgroundColor', t('templates.colorBackground')],
        ].map(([key, label]) => (
          <div key={key} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <input
                type="color"
                value={isValidHex(tpl[key]) ? tpl[key] : DS_FALLBACK.colorInput}
                aria-label={label}
                onChange={(e) => setTpl((t) => ({ ...t, [key]: e.target.value.toUpperCase() }))}
                className="w-5 h-5 rounded shrink-0 border-none bg-transparent cursor-pointer"
              />
              <span className="text-caption text-[var(--muted)] truncate">{label}</span>
            </div>
            <input
              value={tpl[key] || ''}
              onChange={(e) => {
                let v = e.target.value.trim().toUpperCase()
                if (v && !v.startsWith('#')) v = '#' + v
                setTpl((t) => ({ ...t, [key]: v }))
              }}
              placeholder="#RRGGBB"
              aria-label={t('templates.hexFor', { name: label })}
              aria-invalid={tpl[key] && !isValidHex(tpl[key]) ? true : undefined}
              spellCheck={false}
              className={`mt-1 w-full text-caption font-mono rounded-md border bg-transparent px-1.5 py-0.5 uppercase ${
                !tpl[key] || isValidHex(tpl[key]) ? 'border-transparent focus:border-[var(--accent)]' : 'border-[color-mix(in_srgb,var(--danger)_60%,transparent)]'
              }`}
            />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <input
          list="deck-font-suggestions"
          value={tpl.headingFont}
          onChange={(e) => setTpl((t) => ({ ...t, headingFont: e.target.value }))}
          placeholder={t('templates.headingFont')}
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-body focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
        />
        <input
          list="deck-font-suggestions"
          value={tpl.bodyFont}
          onChange={(e) => setTpl((t) => ({ ...t, bodyFont: e.target.value }))}
          placeholder={t('templates.bodyFont')}
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-body focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
        />
        <datalist id="deck-font-suggestions">
          {FONT_SUGGESTIONS.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </div>

      <div className="flex items-center gap-3">
        {tpl.logoDataUrl ? (
          <img src={tpl.logoDataUrl} alt={t('templates.logoAlt')} className="w-10 h-10 rounded-lg object-contain border border-[var(--border)] bg-[var(--surface)]" />
        ) : (
          <div className="w-10 h-10 rounded-lg border border-dashed border-[var(--border)] grid place-items-center text-[var(--faint)]">
            <Icon.File size={16} />
          </div>
        )}
        <label className="text-label font-medium text-[var(--accent)] hover:brightness-110 cursor-pointer">
          {tpl.logoDataUrl ? t('templates.logoReplace') : t('templates.logoUpload')}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => onLogoFile(e.target.files?.[0])} />
        </label>
        {tpl.logoDataUrl && (
          <button
            onClick={() => setTpl((t) => ({ ...t, logoDataUrl: '' }))}
            className="text-label text-[var(--faint)] hover:text-[var(--text)]"
          >
            {t('common.delete')}
          </button>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-label font-semibold text-[var(--faint)]">
            {t('templates.dsAssets')}{' '}
            {tpl.iconAssets?.length ? `(${tpl.iconAssets.length})` : ''}
          </span>
          <div className="flex items-center gap-3">
            {(unlabeled.length > 0 || unlabeledDiagrams.length > 0) && (
              <button
                type="button"
                onClick={onLabelAssets}
                disabled={labeling}
                className="text-label font-medium text-[var(--accent)] hover:brightness-110 disabled:opacity-60"
                title={t('templates.labelWithAiTitle')}
              >
                {labeling ? t('templates.labeling') : t('templates.labelWithAi', { n: unlabeled.length + unlabeledDiagrams.length })}
              </button>
            )}
            <label className="text-label font-medium text-[var(--accent)] hover:brightness-110 cursor-pointer">
              {enriching ? t('templates.importing') : t('templates.addFiles')}
              <input
                type="file"
                accept=".pptx,.json,image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                multiple
                className="hidden"
                disabled={enriching}
                onChange={(e) => {
                  onEnrichFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
          </div>
        </div>
        {tpl.iconAssets?.length ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2.5 space-y-2">
            <div className="flex flex-wrap gap-2">
              {tpl.iconAssets.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSelectedAsset((cur) => (cur === a.id ? null : a.id))}
                  className={`relative w-11 h-11 shrink-0 rounded-lg border transition ${
                    selectedAsset === a.id ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--border)] hover:border-[var(--muted)]'
                  }`}
                  title={`${a.label || a.id} · ${kindLabel(t, a.kind)}`}
                >
                  <img
                    src={a.dataUrl}
                    alt={a.label || ''}
                    className={`w-full h-full rounded-lg object-contain ${
                      a.kind === 'image' ? 'p-0.5 opacity-80' : a.kind === 'watermark' ? 'p-1 opacity-40' : 'p-1.5'
                    }`}
                  />
                  {a.kind === 'watermark' && (
                    <span className="absolute -bottom-1 -right-1 grid place-items-center w-4 h-4 rounded-full bg-[var(--surface-3)] border border-[var(--border)] text-[var(--faint)]" title={t('templates.watermarkNeverUsed')}>
                      <Icon.Close size={9} />
                    </span>
                  )}
                </button>
              ))}
            </div>
            {activeAsset && (
              <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5">
                <input
                  value={activeAsset.label || ''}
                  onChange={(e) => patchAsset(activeAsset.id, { label: e.target.value })}
                  placeholder={t('templates.assetLabelPlaceholder')}
                  className="flex-1 min-w-0 text-label rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                />
                <select
                  value={activeAsset.kind || 'icon'}
                  onChange={(e) => patchAsset(activeAsset.id, { kind: e.target.value })}
                  className="text-label rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 py-1"
                  title={t('templates.assetKindTitle')}
                >
                  {KIND_KEYS.map((k) => (
                    <option key={k} value={k}>{kindLabel(t, k)}</option>
                  ))}
                </select>
                <button
                  onClick={() => removeIconAsset(activeAsset.id)}
                  className="p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--faint)] hover:text-[var(--text)]"
                  title={t('templates.removeAsset')}
                >
                  <Icon.Trash size={13} />
                </button>
              </div>
            )}
            <p className="text-caption text-[var(--faint)]">
              {t('templates.assetHelp')}
            </p>
          </div>
        ) : (
          <p className="text-label text-[var(--faint)] rounded-xl border border-dashed border-[var(--border)] px-3 py-2">
            {t('templates.noAssets')}
          </p>
        )}
        {enrichError && <p className="text-label text-[var(--accent)] mt-1.5">{enrichError}</p>}
        {(diagramCount > 0 || tpl.coverPlateDataUrl) && (
          <p className="text-caption text-[var(--faint)] mt-1.5">
            {t('templates.alsoMinedPrefix')} {[
              diagramCount ? t(diagramCount > 1 ? 'templates.minedDiagramsMany' : 'templates.minedDiagramsOne', { n: diagramCount }) : null,
              tpl.coverPlateDataUrl ? t('templates.minedCoverPlate') : null,
              tpl.minedStyle?.sectionPlateDataUrl ? t('templates.minedSectionPlate') : null,
              tpl.minedStyle?.motif ? t('templates.minedMotif') : null,
            ].filter(Boolean).join(' · ')}{t('templates.alsoMinedSuffix')}
          </p>
        )}
      </div>

      <textarea
        value={tpl.styleNotes}
        onChange={(e) => setTpl((t) => ({ ...t, styleNotes: e.target.value }))}
        rows={2}
        placeholder={t('templates.styleNotesPlaceholder')}
        className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-body focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
      />

      <ImportReportPanel report={tpl._importReport} />

      {pendingEnrich && (
        <div className="rounded-xl border border-[color-mix(in_srgb,var(--accent)_60%,transparent)] bg-[var(--surface)] px-3 py-2.5 space-y-2">
          <p className="text-label">
            <span className="font-semibold">{t('templates.enrichReplaceTitle')}</span>{' '}
            {pendingEnrich.replaces.map((r) => `${r.label} (${r.from} → ${r.to})`).join(', ')}. {t('templates.enrichWhatToDo')}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setTpl((t) => mergeTemplate(t, pendingEnrich.patch, { preferBase: true }))
                setPendingEnrich(null)
              }}
              className="rounded-lg bg-[var(--surface-3)] hover:brightness-110 text-label font-semibold px-3 py-1.5"
            >
              {t('templates.enrichKeep')}
            </button>
            <button
              onClick={() => {
                setTpl((t) => mergeTemplate(t, pendingEnrich.patch))
                setPendingEnrich(null)
              }}
              className="rounded-lg bg-[var(--surface-3)] hover:brightness-110 text-label font-semibold px-3 py-1.5"
            >
              {t('templates.enrichReplace')}
            </button>
            {onCreateNew && (
              <button
                onClick={() => {
                  const patch = pendingEnrich.patch
                  setPendingEnrich(null)
                  onCreateNew(patch)
                }}
                className="rounded-lg bg-[var(--surface-3)] hover:brightness-110 text-label font-semibold px-3 py-1.5"
              >
                {t('templates.enrichCreateNew')}
              </button>
            )}
            <button
              onClick={() => setPendingEnrich(null)}
              className="rounded-lg text-label font-medium px-3 py-1.5 text-[var(--muted)] hover:bg-[var(--surface-3)]"
            >
              {t('templates.enrichDiscard')}
            </button>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-xl px-3.5 py-2 text-body font-medium text-[var(--muted)] hover:bg-[var(--surface-3)] transition"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={() => onSave(tpl)}
          disabled={saving || !tpl.name.trim()}
          className="rounded-xl bg-[var(--accent-strong)] hover:brightness-110 disabled:opacity-50 text-[var(--on-accent)] font-semibold text-body px-3.5 py-2 transition"
        >
          {saving ? t('common.saving') : t('templates.saveTemplate')}
        </button>
      </div>
    </div>
  )
}

// Self-hosted design-system webfonts (template.fontAssets, from a bundle
// import) registered once per family/weight/style
const loadedFonts = new Set()
function useTemplateFonts(template) {
  useEffect(() => {
    if (typeof FontFace === 'undefined') return
    for (const f of template?.fontAssets || []) {
      const key = `${f.family}|${f.weight}|${f.style}`
      if (!f.dataUrl || loadedFonts.has(key)) continue
      loadedFonts.add(key)
      try {
        const face = new FontFace(f.family, `url(${f.dataUrl})`, { weight: f.weight || '400', style: f.style || 'normal' })
        face.load().then((ff) => document.fonts.add(ff)).catch(() => {})
      } catch {
        // malformed font data
      }
    }
  }, [template])
}

// Build token styles for injecting into specimen iframes
function buildTokenStyle(template) {
  if (!template) return ''
  const parts = []
  const fonts = template.fontAssets || []
  for (const f of fonts) {
    if (!f?.family || !f?.dataUrl) continue
    parts.push(
      `@font-face{font-family:'${f.family.replace(/'/g, '')}';` +
        `font-weight:${f.weight || 400};font-style:${f.style || 'normal'};` +
        `font-display:swap;src:url(${f.dataUrl});}`,
    )
  }
  const vars = []
  for (const t of template.palette || []) {
    if (t?.varName && typeof t.value === 'string') vars.push(`${t.varName}:${t.value};`)
  }
  const families = [...new Set(fonts.map((f) => f.family).filter(Boolean))]
  const heading = template.headingFont || families[0]
  if (heading) vars.push(`--font-sans:'${heading.replace(/'/g, '')}',system-ui,-apple-system,sans-serif;`)
  const mono = families.find((f) => /mono/i.test(f))
  if (mono) vars.push(`--font-mono:'${mono.replace(/'/g, '')}',ui-monospace,'SF Mono',Menlo,monospace;`)
  /* data:start DS shadow ramp */
  vars.push('--shadow-sm:0 1px 2px rgba(27,49,57,.06),0 1px 3px rgba(27,49,57,.08);')
  vars.push('--shadow-md:0 2px 6px rgba(27,49,57,.08),0 8px 20px rgba(27,49,57,.08);')
  vars.push('--shadow-lg:0 8px 24px rgba(27,49,57,.10),0 24px 48px rgba(27,49,57,.10);')
  /* data:end */
  if (vars.length) parts.push(`:root{${vars.join('')}}`)
  return parts.join('')
}

// Prepend token styles to card HTML
function withTokens(html, tokenStyle) {
  if (!tokenStyle || typeof html !== 'string') return html
  const inject = `<style data-ds-tokens>${tokenStyle}</style>`
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + inject)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + inject)
  return inject + html
}

// One DS slide (authored at the 1280×720 stage) scaled to fill its container
// width — the same transform:scale trick the inspector's SpecimenFrame uses, so
// the mini-slide reads correctly instead of showing an unscaled 1280px corner.
function MiniSlide({ html, title, allowScripts = false }) {
  const wrapRef = useRef(null)
  const [scale, setScale] = useState(0.15)
  useEffect(() => {
    if (!wrapRef.current) return
    const el = wrapRef.current
    const update = () => setScale(el.clientWidth / 1280)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={wrapRef} className="aspect-video flex-1 min-w-0 overflow-hidden rounded-md bg-[var(--surface-3)]">
      <iframe
        title={title}
        // never omit the attribute: an unsandboxed srcdoc document runs with the
        // app's own origin, so DS markup could call /api as the viewer
        sandbox={allowScripts ? 'allow-scripts' : ''}
        srcDoc={html}
        className="border-0 origin-top-left pointer-events-none"
        /* data */ style={{ width: 1280, height: 720, transform: `scale(${scale})` }}
      />
    </div>
  )
}

// Grid thumbnail: the first slide of the DS's first template, rendered as a
// scaled mini-slide (restored after the semantic-tree engine was removed).
// List rows ship previewCardHtml (minified first slide specimen); the inspector
// passes the full template, so fall back to its dsCards there. No specimen →
// branded placeholder.
function TemplatePreviewThumb({ template }) {
  const t = useT()
  useTemplateFonts(template)
  const tokenStyle = buildTokenStyle(template)

  // list rows ship previewCardHtml (server-extracted first Templates slide);
  // the inspector passes full dsCards, so fall back to the first Templates deck
  // there (its <deck-stage> shows slide 1). 'Templates' is our importer's group
  // for template decks — positional, not name-matched to any specific DS.
  const cardHtml =
    template.previewCardHtml ||
    (template.dsCards?.find((c) => c.group === 'Templates' && c.html)?.html) ||
    ''
  if (cardHtml) {
    return (
      <div className="w-full h-full flex items-center justify-center p-1.5 bg-[var(--surface-2)]">
        <MiniSlide html={withTokens(cardHtml, tokenStyle)} title={template.name} allowScripts={!template.previewCardHtml} />
      </div>
    )
  }

  // Fallback: lightweight branded placeholder at 16:9
  const primary = template.primaryColor || DS_FALLBACK.primary
  const accent = template.accentColor || DS_FALLBACK.accent
  const bg = template.backgroundColor || DS_FALLBACK.background
  return (
    // the template's own colours are DS data, so they stay a computed style
    <div className="w-full h-full rounded-lg flex items-center justify-center text-center p-3 font-semibold text-body" /* data */ style={{ background: bg, color: primary }}>
      <div>
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden className="mx-auto mb-2 opacity-80">
          <circle cx="12" cy="12" r="12" fill={accent} />
        </svg>
        {template.name || t('templates.untitled')}
      </div>
    </div>
  )
}

export default function DeckTemplatesSettings({ open, isAdmin = false }) {
  const t = useT()
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(null) // null | { id?, ...fields }
  const [inspecting, setInspecting] = useState(null) // null | template
  const [savingId, setSavingId] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState('')
  const [importError, setImportError] = useState('')
  const fileInputRef = useRef(null)
  const folderInputRef = useRef(null)

  const load = async () => {
    setLoading(true)
    try {
      const r = await getJSON('/api/deck-templates')
      setTemplates(r.templates || [])
    } catch {
      // surfaced implicitly by the empty-state below
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open])

  const select = async (id) => {
    if (templates.find((t) => t.id === id)?.isSelected) return
    setTemplates((prev) => prev.map((t) => ({ ...t, isSelected: t.id === id })))
    try {
      await postJSON(`/api/deck-templates/${id}/select`, {})
    } catch {
      load()
    }
  }

  // deletion keeps the grid in place: the card shows a spinner while the
  // DELETE is in flight and only disappears when the server confirms — the
  // rest of the list never refetches/flashes
  const remove = async (id) => {
    if (templates.length <= 1 || deletingId) return
    setDeletingId(id)
    try {
      await del(`/api/deck-templates/${id}`)
      setTemplates((prev) => {
        const wasSelected = prev.find((t) => t.id === id)?.isSelected
        const next = prev.filter((t) => t.id !== id)
        if (!wasSelected || !next.length) return next
        // mirror the server's promotion rule (most recent remaining wins)
        const promoted = next.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a))
        return next.map((t) => ({ ...t, isSelected: t.id === promoted.id }))
      })
    } catch {
      load()
    } finally {
      setDeletingId(null)
    }
  }

  const duplicate = (tpl) => {
    // a copy is always a PERSONAL template, even when duplicating a global one
    setEditing({ ...tpl, id: undefined, scope: undefined, canEdit: undefined, name: `${tpl.name} ${t('templates.copySuffix')}` })
  }

  // publish/unpublish org-wide (admin only; server re-checks)
  const setScope = async (t, scope) => {
    setTemplates((prev) => prev.map((x) => (x.id === t.id ? { ...x, scope } : x)))
    try {
      await postJSON(`/api/deck-templates/${t.id}/scope`, { scope })
    } catch {
      load()
    }
  }

  // the grid holds summary rows — keep local updates summary-shaped so a
  // just-imported bundle (readme/dsCards can be several MB) doesn't sit in
  // the list state after saving
  const toSummary = (t) => {
    if (!t) return t
    const { readme, dsCards, _importReport, ...rest } = t
    return {
      ...rest,
      hasReadme: !!readme || !!t.hasReadme,
      hasDsCards: !!(dsCards && dsCards.length) || !!t.hasDsCards,
    }
  }

  const saveEditing = async (rawTpl) => {
    // the import report is review-UI-only, never persisted
    const { _importReport, ...tpl } = rawTpl
    setSavingId(true)
    try {
      if (editing?.id) {
        await patchJSON(`/api/deck-templates/${editing.id}`, tpl)
        setTemplates((prev) => prev.map((t) => (t.id === editing.id ? toSummary({ ...t, ...tpl }) : t)))
      } else {
        const r = await postJSON('/api/deck-templates', tpl)
        const created = toSummary(r?.template)
        if (created?.id) {
          setTemplates((prev) => {
            const next = created.isSelected ? prev.map((t) => ({ ...t, isSelected: false })) : prev
            return [...next, created]
          })
        } else {
          await load()
        }
      }
      setEditing(null)
    } finally {
      setSavingId(false)
    }
  }

  // A design system can arrive as SEVERAL files at once — slide templates
  // (.pptx), a saved .json, loose logos/icons, a bundle FOLDER or .zip
  // exported by a design tool (Claude Design) — mined and merged into one
  // reviewable draft (see extractFromFiles / dsImport.js).
  const onImportFiles = async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setImportError('')
    setImporting(true)
    try {
      const extracted = await extractFromFiles(files, null, { onProgress: setImportStatus })
      setEditing({
        ...EMPTY_TEMPLATE,
        ...extracted,
        name: extracted.name || stripExt(files[0].name),
      })
    } catch (e) {
      setImportError(e.message || t('templates.errImport'))
    } finally {
      setImporting(false)
      setImportStatus('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      if (folderInputRef.current) folderInputRef.current.value = ''
    }
  }

  return (
    <div>
      <label className="text-body font-semibold flex items-center gap-2">
        <Icon.Presentation size={16} /> {t('templates.heading')}
      </label>
      <p className="text-label text-[var(--faint)] mt-1">
        {t('templates.intro')}
      </p>

      {loading ? (
        <p className="text-label text-[var(--faint)] mt-3">{t('common.loading')}</p>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2.5">
            {templates.map((tpl) => (
              <div
                key={tpl.id}
                className={`rounded-xl border p-2 transition ${
                  tpl.isSelected ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] hover:bg-[var(--surface-2)]'
                } ${deletingId === tpl.id ? 'opacity-60' : ''}`}
              >
                <button onClick={() => select(tpl.id)} className="w-full text-left">
                  <div className="aspect-video overflow-hidden rounded-control">
                    <TemplatePreviewThumb template={tpl} />
                  </div>
                  <div className="flex items-center gap-1.5 mt-1.5 px-0.5">
                    {tpl.isSelected && <Icon.Check size={13} className="text-[var(--accent)] shrink-0" />}
                    <span className="text-label font-medium truncate flex-1">{tpl.name || t('templates.unnamed')}</span>
                  </div>
                  {tpl.scope === 'global' && (
                    <div className="flex items-center gap-1 mt-1 px-0.5 text-caption text-[var(--accent)]">
                      <Icon.Globe2 size={11} className="shrink-0" />
                      <span className="truncate">{t('templates.orgDefault')}</span>
                    </div>
                  )}
                </button>
                <div className="flex items-center gap-1 mt-1 px-0.5">
                  <button
                    onClick={() => setInspecting(tpl)}
                    className="p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--muted)]"
                    title={t('templates.inspect')}
                  >
                    <Icon.Eye size={13} />
                  </button>
                  {tpl.canEdit !== false && (
                    <button
                      onClick={() => setEditing(tpl)}
                      className="p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--muted)]"
                      title={t('common.edit')}
                    >
                      <Icon.Pencil size={13} />
                    </button>
                  )}
                  <button
                    onClick={() => duplicate(tpl)}
                    className="p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--muted)]"
                    title={t('templates.duplicate')}
                  >
                    <Icon.Copy size={13} />
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => setScope(tpl, tpl.scope === 'global' ? 'user' : 'global')}
                      className={`p-1 rounded-md hover:bg-[var(--surface-3)] ${
                        tpl.scope === 'global' ? 'text-[var(--accent)]' : 'text-[var(--muted)]'
                      }`}
                      title={
                        tpl.scope === 'global'
                          ? t('templates.makePersonal')
                          : t('templates.makeGlobal')
                      }
                    >
                      <Icon.Globe2 size={13} />
                    </button>
                  )}
                  {tpl.canEdit !== false && (
                    <button
                      onClick={() => remove(tpl.id)}
                      disabled={templates.length <= 1 || deletingId === tpl.id}
                      className="p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-30"
                      title={deletingId === tpl.id ? t('templates.deleting') : t('templates.deleteTitle')}
                    >
                      {deletingId === tpl.id ? (
                        <span className="block w-3.5 h-3.5 rounded-full border-2 border-[var(--muted)] border-t-transparent animate-spin" />
                      ) : (
                        <Icon.Trash size={13} />
                      )}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {editing ? (
            <TemplateForm
              initial={editing}
              saving={savingId}
              onCancel={() => setEditing(null)}
              onSave={saveEditing}
              onCreateNew={(patch) =>
                setEditing({ ...EMPTY_TEMPLATE, ...patch, name: patch.name || t('templates.newDesignSystem') })
              }
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                onClick={() => setEditing({ ...EMPTY_TEMPLATE })}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-[var(--surface-3)] hover:brightness-110 text-body font-semibold px-3 py-2.5 transition whitespace-nowrap"
              >
                <Icon.Plus size={15} className="shrink-0" /> {t('templates.newTemplate')}
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-[var(--surface-3)] hover:brightness-110 disabled:opacity-60 text-body font-semibold px-3 py-2.5 transition whitespace-nowrap"
                title={t('templates.importFilesTitle')}
              >
                <Icon.Upload size={15} className="shrink-0" /> {importing ? t('templates.importing') : t('templates.importFiles')}
              </button>
              <button
                onClick={() => folderInputRef.current?.click()}
                disabled={importing}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-[var(--surface-3)] hover:brightness-110 disabled:opacity-60 text-body font-semibold px-3 py-2.5 transition whitespace-nowrap"
                title={t('templates.importFolderTitle')}
              >
                <Icon.Folder size={15} className="shrink-0" /> {importing ? t('templates.importing') : t('templates.importFolder')}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.pptx,.zip,image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                multiple
                className="hidden"
                onChange={(e) => onImportFiles(e.target.files)}
              />
              <input
                ref={folderInputRef}
                type="file"
                webkitdirectory=""
                className="hidden"
                onChange={(e) => onImportFiles(e.target.files)}
              />
            </div>
          )}
          {!editing && (
            <p className="text-caption text-[var(--faint)]">
              {t('templates.kitQuestion')}{' '}
              <button
                onClick={async () => {
                  try {
                    await (await import('../lib/starterKit.ts')).downloadStarterKit()
                  } catch (e) {
                    setImportError(e.message || t('templates.errKitDownload'))
                  }
                }}
                className="underline hover:text-[var(--text)]"
              >
                {t('templates.kitDownload')}
              </button>{' '}
              {t('templates.kitDescription')}
            </p>
          )}
          {importing && importStatus && <p className="text-label text-[var(--faint)]">{importStatus}</p>}
          {importError && <p className="text-label text-[var(--accent)]">{importError}</p>}
        </div>
      )}

      <DeckTemplateInspector template={inspecting} onClose={() => setInspecting(null)} />
    </div>
  )
}
