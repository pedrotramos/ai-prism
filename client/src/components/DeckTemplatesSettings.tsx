import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import * as Icon from './Icons.tsx'
import DeckTemplateInspector from './DeckTemplateInspector.tsx'
import type { DsTemplate } from './DeckTemplateInspector.tsx'
import { getJSON, postJSON, patchJSON, del } from '../api.ts'
import { EMPTY_TEMPLATE, extractFromFiles, mergeTemplate, stripExt, rasterizeToPng } from '../lib/pptxMining.ts'
import { useT } from '../lib/i18n.tsx'
import { DS_FALLBACK } from '../lib/dsDefaults.ts'
import { chartColorsOf, isHex as isHexColor } from '../lib/dsSettings.ts'
import type { ExternalRef } from '../lib/dsExternalRefs.ts'

// useT()/useI18n() come from i18n.jsx (untyped JS), which infers a one-argument `t`.
type Translate = (key: string, vars?: Record<string, unknown>) => string

// `webkitdirectory` (folder picker) is not in React's input attributes.
declare module 'react' {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string
  }
}
type TemplateId = number | string

// The editable draft: what the .pptx / bundle miner produces (the type of
// EMPTY_TEMPLATE), plus the identity fields a saved row carries.
type MinedTemplate = typeof EMPTY_TEMPLATE
type MinedPatch = Awaited<ReturnType<typeof extractFromFiles>>
type FormTemplate = MinedTemplate & {
  id?: TemplateId
  scope?: string
  canEdit?: boolean
  isSelected?: boolean
  hasReadme?: boolean
  hasDsCards?: boolean
}
type FormAsset = FormTemplate['iconAssets'][number]

// One row of GET /api/deck-templates (a summary: no readme or specimen cards).
interface TemplateRow extends DsTemplate {
  id: TemplateId
  scope?: string
  canEdit?: boolean
  isSelected?: boolean
  hasDsCards?: boolean
  previewCardHtml?: string
}

// What the importer decided (never persisted), shown in the review panel.
interface ImportReport {
  counts?: Partial<Record<'icon' | 'lockup' | 'illustration' | 'background' | 'image', number>> | null
  paletteCount?: number
  fontCount?: number
  cardCount?: number
  readmeFound?: boolean
  manifestFound?: boolean
  manifestError?: string
  catchAllImages: string[]
  skippedAssets?: { path: string; reason: string }[]
  fontsSkipped?: { path: string; reason: string }[]
  cardsSkipped?: { path: string; reason: string }[]
  externalRefs?: ExternalRef[]
}

type HeavyKey = 'palette' | 'fontAssets' | 'dsCards'
interface PendingEnrich {
  patch: MinedPatch
  replaces: { label: string; from: number; to: number }[]
}

const FONT_SUGGESTIONS = [
  'DM Sans', 'Georgia', 'Helvetica', 'Arial', 'Calibri', 'Verdana', 'Times New Roman', 'Garamond', 'Trebuchet MS', 'Barlow',
]


const KIND_KEYS = ['icon', 'image', 'watermark']
const kindLabel = (t: Translate, k: string) => t(`templates.kind.${KIND_KEYS.includes(k) ? k : 'icon'}`)

function isValidHex(v: string | undefined) {
  return /^#[0-9a-fA-F]{6}$/.test(v || '')
}

// Mined labels are often useless for steering the model ("Imagem 12",
// "Gráfico 37", empty) — those are the ones worth sending to the vision
// labeler; a human-written or already-descriptive label is never overwritten.
function isGenericLabel(label: string | undefined) {
  return !label || /^(imagem|image|picture|gr[aá]fico|graphic|icon|[ií]cone|shape|forma|logo)?[\s_-]*\d*$/i.test(label.trim())
}

// "Relatório da importação" — what the classifier decided for this import:
// counts of what entered, what was ignored (and why) and which files fell
// into the generic-'image' catch-all (the usual sign of a misnamed asset,
// reclassifiable one click away in the asset editor).
const EXTERNAL_REFS_VISIBLE = 5

// External http(s) references the kit kept: the CSP + deck sanitizer block
// them, so say so at import time (what, why, and the fix), never silently.
function ExternalRefsWarning({ refs, t }: { refs: ExternalRef[]; t: Translate }) {
  if (!refs.length) return null
  const item = (r: ExternalRef, i: number) => (
    <li key={i} className="font-mono break-all">
      {t('templates.report.extItem', { host: r.host, kind: t(`templates.report.ext.kind.${r.kind}`), n: r.count })}
    </li>
  )
  const rest = refs.slice(EXTERNAL_REFS_VISIBLE)
  return (
    <div data-testid="ds-external-refs" className="space-y-1 border-t border-[var(--border)] pt-1.5">
      <p className="text-caption font-semibold">{t('templates.report.extTitle')}</p>
      <ul className="text-caption text-[var(--muted)] space-y-0.5">{refs.slice(0, EXTERNAL_REFS_VISIBLE).map(item)}</ul>
      {rest.length > 0 && (
        <details className="text-caption text-[var(--muted)]">
          <summary className="cursor-pointer">{t('templates.report.extMore', { n: rest.length })}</summary>
          <ul className="mt-1 space-y-0.5">{rest.map(item)}</ul>
        </details>
      )}
      <p className="text-caption text-[var(--muted)]">{t('templates.report.extWhy')}</p>
      <p className="text-caption text-[var(--muted)]">{t('templates.report.extFix')}</p>
    </div>
  )
}

function ImportReportPanel({ report }: { report?: ImportReport | null }) {
  const t = useT() as Translate
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
      <ExternalRefsWarning refs={report.externalRefs || []} t={t} />
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

interface TemplateFormProps {
  initial: FormTemplate
  onCancel: () => void
  onSave: (tpl: FormTemplate) => void | Promise<void>
  saving: boolean
  onCreateNew?: (patch: MinedPatch) => void
}

function TemplateForm({ initial, onCancel, onSave, saving, onCreateNew }: TemplateFormProps) {
  const t = useT() as Translate
  const [tpl, setTpl] = useState<FormTemplate>(initial)
  // mergeTemplate takes a draft and returns a draft: a complete base stays complete
  const merge = (base: FormTemplate, patch: MinedPatch, opts?: { preferBase?: boolean }) => mergeTemplate(base, patch, opts) as FormTemplate
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null) // asset id being edited
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
      const assets: { id: string; kind: string; dataUrl: string }[] = []
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
      const r = await postJSON<{ labels?: Record<string, string> }>('/api/deck-templates/label-assets', { assets, diagrams })
      const labels = r.labels || {}
      if (Object.keys(labels).length) {
        setTpl((t) => ({
          ...t,
          iconAssets: (t.iconAssets || []).map((a) => (labels[a.id] ? { ...a, label: labels[a.id] as string } : a)),
          minedStyle: t.minedStyle
            ? {
                ...t.minedStyle,
                diagrams: (t.minedStyle.diagrams || []).map((d) => (labels[d.id] ? { ...d, label: labels[d.id] as string } : d)),
              }
            : t.minedStyle,
        }))
      }
    } catch (e) {
      setEnrichError((e as Error).message || t('templates.errLabelAssets'))
    } finally {
      setLabeling(false)
    }
  }

  const onLogoFile = (file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setTpl((t) => ({ ...t, logoDataUrl: reader.result as string } /* readAsDataURL always yields a string */))
    reader.readAsDataURL(file)
  }

  // Feeds MORE source files into this design system (another .pptx, loose
  // icon/logo images…) — collections append, review-ready fields stay put.
  // When the new import would REPLACE heavy fields the draft already has
  // (richer-wins rule), the user decides instead of losing them silently.
  const [pendingEnrich, setPendingEnrich] = useState<PendingEnrich | null>(null) // { patch, replaces: [{label, from, to}] }
  const onEnrichFiles = async (files: FileList | null) => {
    const list = Array.from(files || [])
    if (!list.length) return
    setEnrichError('')
    setEnriching(true)
    try {
      const patch = await extractFromFiles(list, null)
      const HEAVY: [HeavyKey, string][] = [
        ['palette', t('templates.heavyPalette')],
        ['fontAssets', t('templates.heavyFonts')],
        ['dsCards', t('templates.heavyCards')],
      ]
      const replaces = HEAVY.filter(
        ([k]) => (tpl[k]?.length || 0) > 0 && (patch[k]?.length || 0) > (tpl[k]?.length || 0)
      ).map(([k, label]) => ({ label, from: tpl[k].length, to: patch[k]!.length }))
      if (replaces.length) setPendingEnrich({ patch, replaces })
      else setTpl((t) => merge(t, patch))
    } catch (e) {
      setEnrichError((e as Error).message || t('templates.errImportFiles'))
    } finally {
      setEnriching(false)
    }
  }

  const patchAsset = (id: string, patch: Partial<FormAsset>) => {
    setTpl((t) => ({ ...t, iconAssets: (t.iconAssets || []).map((a) => (a.id === id ? { ...a, ...patch } : a)) }))
  }

  const removeIconAsset = (id: string) => {
    if (selectedAsset === id) setSelectedAsset(null)
    setTpl((t) => ({ ...t, iconAssets: (t.iconAssets || []).filter((a) => a.id !== id) }))
  }

  const activeAsset = (tpl.iconAssets || []).find((a) => a.id === selectedAsset)
  const diagramCount = tpl.minedStyle?.diagrams?.length || 0

  return (
    <div className="rounded-card border border-[var(--border)] bg-raised p-3.5 space-y-3">
      <input
        value={tpl.name}
        onChange={(e) => setTpl((t) => ({ ...t, name: e.target.value }))}
        placeholder={t('templates.namePlaceholder')}
        className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-body focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {([
          ['primaryColor', t('templates.colorPrimary')],
          ['secondaryColor', t('templates.colorSecondary')],
          ['accentColor', t('templates.colorAccent')],
          ['backgroundColor', t('templates.colorBackground')],
        ] as ['primaryColor' | 'secondaryColor' | 'accentColor' | 'backgroundColor', string][]).map(([key, label]) => (
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

      <ImportReportPanel report={tpl._importReport as ImportReport | undefined} />

      {pendingEnrich && (
        <div className="rounded-xl border border-[color-mix(in_srgb,var(--accent)_60%,transparent)] bg-[var(--surface)] px-3 py-2.5 space-y-2">
          <p className="text-label">
            <span className="font-semibold">{t('templates.enrichReplaceTitle')}</span>{' '}
            {pendingEnrich.replaces.map((r) => `${r.label} (${r.from} → ${r.to})`).join(', ')}. {t('templates.enrichWhatToDo')}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setTpl((t) => merge(t, pendingEnrich.patch, { preferBase: true }))
                setPendingEnrich(null)
              }}
              className="rounded-lg bg-[var(--surface-3)] hover:brightness-110 text-label font-semibold px-3 py-1.5"
            >
              {t('templates.enrichKeep')}
            </button>
            <button
              onClick={() => {
                setTpl((t) => merge(t, pendingEnrich.patch))
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
          className="rounded-control bg-action text-on-action hover:opacity-90 disabled:opacity-50 font-semibold text-body px-3.5 min-h-10 transition duration-fast"
        >
          {saving ? t('common.saving') : t('templates.saveTemplate')}
        </button>
      </div>
    </div>
  )
}

// Self-hosted design-system webfonts (template.fontAssets, from a bundle
// import) registered once per family/weight/style
const loadedFonts = new Set<string>()
function useTemplateFonts(template: DsTemplate | null | undefined) {
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
function buildTokenStyle(template: DsTemplate | null | undefined): string {
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
function withTokens(html: string, tokenStyle: string): string {
  if (!tokenStyle || typeof html !== 'string') return html
  const inject = `<style data-ds-tokens>${tokenStyle}</style>`
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + inject)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + inject)
  return inject + html
}

// One DS slide (authored at the 1280×720 stage) scaled to fill its container
// width — the same transform:scale trick the inspector's SpecimenFrame uses, so
// the mini-slide reads correctly instead of showing an unscaled 1280px corner.
function MiniSlide({ html, title, allowScripts = false }: { html: string; title?: string; allowScripts?: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null)
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
function TemplatePreviewThumb({ template }: { template: TemplateRow }) {
  const t = useT() as Translate
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

  // Fallback: lightweight branded placeholder at 16:9. The template's own colours are DS data and
  // travel as SVG paint attributes, never as inline styles.
  const paint = (v: string | undefined, fallback: string) => (isHexColor(v) ? (v as string) : fallback)
  const primary = paint(template.primaryColor, DS_FALLBACK.primary)
  const accent = paint(template.accentColor, DS_FALLBACK.accent)
  const bg = paint(template.backgroundColor, DS_FALLBACK.background)
  const label = template.name || t('templates.untitled')
  return (
    <svg viewBox="0 0 160 90" role="img" aria-label={label} className="block w-full h-full">
      <rect width="160" height="90" fill={bg} />
      <circle cx="80" cy="34" r="9" fill={accent} opacity="0.85" />
      <text x="80" y="62" textAnchor="middle" fontSize="9" fontWeight="600" fill={primary}>
        {label.slice(0, 28)}
      </text>
    </svg>
  )
}

type DsTab = 'brand' | 'assets' | 'charts'
const DS_TABS: DsTab[] = ['brand', 'assets', 'charts']

// A DS colour is data from an imported file. Only literal colours may paint: a `var(--…)` in a palette value must
// never resolve against the app's own tokens.
const LITERAL_COLOR = /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%/-]+\))$/i
const paintOf = (v: string | undefined) => (v && LITERAL_COLOR.test(v.trim()) ? v.trim() : '')

// A swatch: the colour is an SVG paint attribute (DS data), the text is chrome.
function Swatch({ name, value, sub }: { name: string; value?: string; sub?: string }) {
  const paint = paintOf(value)
  return (
    <div className="rounded-card border border-[var(--border)] bg-raised overflow-hidden">
      <svg viewBox="0 0 10 3" preserveAspectRatio="none" aria-hidden className="block w-full h-14 border-b border-[var(--border-soft)]">
        {paint ? <rect width="10" height="3" fill={paint} /> : null}
      </svg>
      <div className="px-2.5 py-2 min-w-0">
        <div className="text-label font-medium truncate">{name}</div>
        <div className="text-caption font-mono uppercase text-[var(--muted)] truncate">{value || '—'}</div>
        {sub && <div className="text-caption font-mono text-[var(--muted)] truncate">{sub}</div>}
      </div>
    </div>
  )
}

export default function DeckTemplatesSettings({ open, isAdmin = false }: { open: boolean; isAdmin?: boolean }) {
  const t = useT() as Translate
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [loading, setLoading] = useState(true) // the tab mounts when opened: start in loading, never flash an empty state
  const [editing, setEditing] = useState<FormTemplate | null>(null) // null | { id?, ...fields }
  const [inspecting, setInspecting] = useState<TemplateRow | null>(null) // null | template
  const [savingId, setSavingId] = useState(false)
  const [deletingId, setDeletingId] = useState<TemplateId | null>(null)
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState('')
  const [importError, setImportError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<DsTab>('brand')

  const load = async () => {
    setLoading(true)
    try {
      const r = await getJSON<{ templates?: TemplateRow[] }>('/api/deck-templates')
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

  const select = async (id: TemplateId) => {
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
  const remove = async (id: TemplateId) => {
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

  const duplicate = (tpl: TemplateRow) => {
    // a copy is always a PERSONAL template, even when duplicating a global one
    // a summary row seeds the draft; the form tolerates the collections it lacks
    setEditing({ ...tpl, id: undefined, scope: undefined, canEdit: undefined, name: `${tpl.name} ${t('templates.copySuffix')}` } as FormTemplate)
  }

  // publish/unpublish org-wide (admin only; server re-checks)
  const setScope = async (t: TemplateRow, scope: string) => {
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
  function toSummary(t: TemplateRow): TemplateRow
  function toSummary(t: TemplateRow | null | undefined): TemplateRow | null | undefined
  function toSummary(t: TemplateRow | null | undefined): TemplateRow | null | undefined {
    if (!t) return t
    const { readme, dsCards, _importReport, ...rest } = t as TemplateRow & { _importReport?: unknown }
    return {
      ...rest,
      hasReadme: !!readme || !!t.hasReadme,
      hasDsCards: !!(dsCards && dsCards.length) || !!t.hasDsCards,
    }
  }

  const saveEditing = async (rawTpl: FormTemplate) => {
    // the import report is review-UI-only, never persisted
    const { _importReport, ...tpl } = rawTpl
    setSavingId(true)
    try {
      if (editing?.id) {
        await patchJSON(`/api/deck-templates/${editing.id}`, tpl)
        setTemplates((prev) => prev.map((t) => (t.id === editing.id ? toSummary({ ...t, ...tpl } as TemplateRow) : t)))
      } else {
        const r = await postJSON<{ template?: TemplateRow }>('/api/deck-templates', tpl)
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
  const onImportFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setImportError('')
    setImporting(true)
    try {
      const extracted = await extractFromFiles(files, null, { onProgress: setImportStatus })
      setEditing({
        ...EMPTY_TEMPLATE,
        ...extracted,
        name: extracted.name || stripExt((files[0] as File).name),
      })
    } catch (e) {
      setImportError((e as Error).message || t('templates.errImport'))
    } finally {
      setImporting(false)
      setImportStatus('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      if (folderInputRef.current) folderInputRef.current.value = ''
    }
  }

  const current = templates.find((x) => x.isSelected) || templates[0]
  const inkBtn =
    'inline-flex items-center justify-center gap-1.5 rounded-control bg-action text-on-action hover:opacity-90 disabled:opacity-60 text-label font-semibold px-3 min-h-9 transition duration-fast whitespace-nowrap'
  const quietBtn =
    'inline-flex items-center justify-center gap-1.5 rounded-control border border-[var(--border)] bg-raised hover:bg-[var(--surface-3)] disabled:opacity-60 text-label font-semibold px-3 min-h-9 transition duration-fast whitespace-nowrap'
  const iconBtn =
    'grid place-items-center w-9 h-9 rounded-control border border-[var(--border)] bg-raised text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] disabled:opacity-30 transition duration-fast'

  const assets = current?.iconAssets || []
  const byKind = (k: string) => assets.filter((a) => (a.kind || 'icon') === k)
  const watermarks = byKind('watermark')
  const palette = (current?.palette || []).filter((p) => p?.varName && p.value)
  const chartColors = chartColorsOf(current)
  const coreColors: [keyof Pick<TemplateRow, 'primaryColor' | 'secondaryColor' | 'accentColor' | 'backgroundColor'>, string][] = [
    ['primaryColor', t('templateInspector.colorPrimary')],
    ['secondaryColor', t('templateInspector.colorSecondary')],
    ['accentColor', t('templateInspector.colorAccent')],
    ['backgroundColor', t('templateInspector.colorBackground')],
  ]
  const assetGroups: [string, string][] = [
    ['lockup', t('templateInspector.brandLockups')],
    ['illustration', t('templateInspector.brandIllustrations')],
    ['background', t('templateInspector.brandBackgrounds')],
    ['image', t('templateInspector.brandImages')],
  ]

  const onTabKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    const dir = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0
    if (!dir) return
    ev.preventDefault()
    const next = DS_TABS[(DS_TABS.indexOf(tab) + dir + DS_TABS.length) % DS_TABS.length] as DsTab
    setTab(next)
    document.getElementById(`ds-tab-${next}`)?.focus()
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-title font-semibold">{t('templates.heading')}</h3>
        <p className="text-label text-[var(--muted)] mt-1 max-w-[62ch]">{t('dsSettings.intro')}</p>
      </div>

      {loading ? (
        <p className="text-label text-[var(--muted)]">{t('common.loading')}</p>
      ) : (
        <div className="space-y-5">
          {/* ---- which design system, and what can be done with it ---- */}
          {current && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <select
                  aria-label={t('dsSettings.pickerLabel')}
                  value={String(current.id)}
                  disabled={!!editing}
                  onChange={(ev) => {
                    const next = templates.find((x) => String(x.id) === ev.target.value)
                    if (next) select(next.id)
                  }}
                  className="appearance-none max-w-[min(100%,22rem)] rounded-control border border-[var(--border)] bg-raised pl-3 pr-9 min-h-10 text-body font-medium text-[var(--text)] focus:border-[var(--accent)] disabled:opacity-60"
                >
                  {templates.map((x) => (
                    <option key={x.id} value={String(x.id)}>
                      {(x.name || t('templates.unnamed')) + (x.scope === 'global' ? ` — ${t('templates.orgDefault')}` : '')}
                    </option>
                  ))}
                </select>
                <Icon.ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
              </div>
              {!editing && (
                <div className="flex items-center gap-1.5 ml-auto">
                  <button type="button" onClick={() => setInspecting(current)} className={iconBtn} title={t('templates.inspect')} aria-label={t('templates.inspect')}>
                    <Icon.Eye size={15} />
                  </button>
                  {current.canEdit !== false && (
                    <button type="button" onClick={() => setEditing(current as FormTemplate)} className={iconBtn} title={t('common.edit')} aria-label={t('common.edit')}>
                      <Icon.Pencil size={15} />
                    </button>
                  )}
                  <button type="button" onClick={() => duplicate(current)} className={iconBtn} title={t('templates.duplicate')} aria-label={t('templates.duplicate')}>
                    <Icon.Copy size={15} />
                  </button>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => setScope(current, current.scope === 'global' ? 'user' : 'global')}
                      aria-pressed={current.scope === 'global'}
                      className={`${iconBtn} ${current.scope === 'global' ? '!text-[var(--accent-text)] !bg-[var(--accent-soft)]' : ''}`}
                      title={current.scope === 'global' ? t('templates.makePersonal') : t('templates.makeGlobal')}
                      aria-label={current.scope === 'global' ? t('templates.makePersonal') : t('templates.makeGlobal')}
                    >
                      <Icon.Globe2 size={15} />
                    </button>
                  )}
                  {current.canEdit !== false && (
                    <button
                      type="button"
                      onClick={() => remove(current.id)}
                      disabled={templates.length <= 1 || deletingId === current.id}
                      className={iconBtn}
                      title={deletingId === current.id ? t('templates.deleting') : t('templates.deleteTitle')}
                      aria-label={t('templates.deleteTitle')}
                    >
                      {deletingId === current.id ? (
                        <span className="block w-3.5 h-3.5 rounded-pill border-2 border-[var(--muted)] border-t-transparent animate-spin" />
                      ) : (
                        <Icon.Trash size={15} />
                      )}
                    </button>
                  )}
                </div>
              )}
              <p className="basis-full text-caption text-[var(--muted)]">{t('dsSettings.personalHint')}</p>
            </div>
          )}

          {editing ? (
            <TemplateForm
              initial={editing}
              saving={savingId}
              onCancel={() => setEditing(null)}
              onSave={saveEditing}
              onCreateNew={(patch) => setEditing({ ...EMPTY_TEMPLATE, ...patch, name: patch.name || t('templates.newDesignSystem') })}
            />
          ) : (
            <>
              <div role="tablist" aria-label={t('dsSettings.tabs')} onKeyDown={onTabKey} className="flex gap-1 border-b border-[var(--border)]">
                {DS_TABS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    id={`ds-tab-${id}`}
                    aria-selected={tab === id}
                    aria-controls={`ds-panel-${id}`}
                    tabIndex={tab === id ? 0 : -1}
                    onClick={() => setTab(id)}
                    className={`-mb-px px-3 min-h-10 text-body border-b-2 transition duration-fast ${
                      tab === id ? 'border-[var(--text)] font-semibold text-[var(--text)]' : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'
                    }`}
                  >
                    {t(`dsSettings.tab.${id}`)}
                  </button>
                ))}
              </div>

              <div role="tabpanel" id={`ds-panel-${tab}`} aria-labelledby={`ds-tab-${tab}`} className="space-y-5">
                {tab === 'brand' && (
                  <>
                    {/* import: folder or loose files, then the starter kit */}
                    <div className="rounded-card border border-dashed border-[var(--border)] bg-raised p-4 flex flex-wrap items-center gap-3">
                      <Icon.Upload size={18} className="shrink-0 text-[var(--muted)]" />
                      <div className="min-w-0 flex-1 basis-56">
                        <div className="text-body font-semibold">{t('dsSettings.import.title')}</div>
                        <p className="text-label text-[var(--muted)] mt-0.5">{t('dsSettings.import.desc')}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => folderInputRef.current?.click()} disabled={importing} className={inkBtn} title={t('templates.importFolderTitle')}>
                          <Icon.Folder size={14} className="shrink-0" /> {importing ? t('templates.importing') : t('templates.importFolder')}
                        </button>
                        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={importing} className={quietBtn} title={t('templates.importFilesTitle')}>
                          {importing ? t('templates.importing') : t('templates.importFiles')}
                        </button>
                        <button type="button" onClick={() => setEditing({ ...EMPTY_TEMPLATE })} className={quietBtn}>
                          <Icon.Plus size={14} className="shrink-0" /> {t('templates.newTemplate')}
                        </button>
                      </div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json,.pptx,.zip,image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                        multiple
                        className="hidden"
                        onChange={(e) => onImportFiles(e.target.files)}
                      />
                      <input ref={folderInputRef} type="file" webkitdirectory="" className="hidden" onChange={(e) => onImportFiles(e.target.files)} />
                    </div>
                    {importing && importStatus && <p className="text-label text-[var(--muted)]">{importStatus}</p>}
                    {importError && (
                      <p role="alert" className="text-label text-[var(--danger)]">
                        {importError}
                      </p>
                    )}

                    <div className="rounded-card border border-[var(--border)] bg-raised p-4 flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1 basis-56">
                        <div className="text-body font-semibold">{t('templates.kitQuestion')}</div>
                        <p className="text-label text-[var(--muted)] mt-0.5">{t('dsSettings.kit.desc')}</p>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await (await import('../lib/starterKit.ts')).downloadStarterKit()
                          } catch (e) {
                            setImportError((e as Error).message || t('templates.errKitDownload'))
                          }
                        }}
                        className={quietBtn}
                      >
                        <Icon.Download size={14} className="shrink-0" /> {t('templates.kitDownload')}
                      </button>
                    </div>

                    {current && (
                      <>
                        <div className="flex items-center gap-3 rounded-card border border-[var(--border)] bg-raised p-3">
                          <div className="w-40 shrink-0 aspect-video overflow-hidden rounded-control border border-[var(--border-soft)]">
                            <TemplatePreviewThumb template={current} />
                          </div>
                          <div className="min-w-0">
                            <div className="text-body font-semibold truncate">{current.name || t('templates.unnamed')}</div>
                            {current.scope === 'global' && (
                              <div className="flex items-center gap-1 mt-1 text-caption text-[var(--accent-text)]">
                                <Icon.Globe2 size={12} className="shrink-0" />
                                <span className="truncate">{t('templates.orgDefault')}</span>
                              </div>
                            )}
                            <div className="mt-1 text-caption text-[var(--muted)] truncate">
                              {[current.headingFont, current.bodyFont].filter(Boolean).join(' · ')}
                            </div>
                          </div>
                        </div>

                        <section aria-labelledby="ds-colors">
                          <h4 id="ds-colors" className="text-body font-semibold mb-2">
                            {t('dsSettings.colors')}
                          </h4>
                          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
                            {coreColors.map(([key, label]) => (
                              <Swatch key={key} name={label} value={current[key]} />
                            ))}
                            {palette.map((p) => (
                              <Swatch key={p.varName} name={p.name} value={p.value} sub={p.varName} />
                            ))}
                          </div>
                        </section>
                      </>
                    )}
                  </>
                )}

                {tab === 'assets' && current && (
                  <>
                    <section aria-labelledby="ds-logo">
                      <h4 id="ds-logo" className="text-body font-semibold mb-2">
                        {t('templateInspector.logo')}
                      </h4>
                      {current.logoDataUrl || current.logoLightDataUrl ? (
                        <div className="flex flex-wrap gap-2.5">
                          {[
                            [current.logoDataUrl, t('templateInspector.logoDarkAlt')],
                            [current.logoLightDataUrl, t('templateInspector.logoLightAlt')],
                          ].map(([src, alt]) =>
                            src ? (
                              <div key={alt} className="rounded-card border border-[var(--border)] bg-raised p-4 grid place-items-center min-w-44">
                                <img src={src} alt={alt} className="h-9 object-contain" />
                              </div>
                            ) : null
                          )}
                        </div>
                      ) : (
                        <p className="text-label text-[var(--muted)] rounded-card border border-dashed border-[var(--border)] px-3 py-3">{t('dsSettings.assets.noLogo')}</p>
                      )}
                    </section>

                    {byKind('icon').length > 0 && (
                      <section aria-labelledby="ds-icons">
                        <h4 id="ds-icons" className="text-body font-semibold mb-2">
                          {t('dsSettings.assets.icons')}{' '}
                          <span className="text-label font-normal text-[var(--muted)]">{t('dsSettings.assets.iconsHint', { n: byKind('icon').length })}</span>
                        </h4>
                        <ul className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2.5">
                          {byKind('icon').map((a) => (
                            <li key={a.id} title={a.label || a.id} className="aspect-square rounded-card border border-[var(--border)] bg-raised grid place-items-center p-3">
                              <img src={a.dataUrl} alt={a.label || ''} className="w-full h-full object-contain" />
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}

                    {assetGroups.map(([kind, label]) => {
                      const items = byKind(kind)
                      if (!items.length) return null
                      return (
                        <section key={kind} aria-label={label}>
                          <h4 className="text-body font-semibold mb-2">
                            {label} <span className="text-label font-normal text-[var(--muted)]">({items.length})</span>
                          </h4>
                          <ul className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2.5">
                            {items.map((a) => (
                              <li key={a.id} title={a.label || a.id} className="rounded-card border border-[var(--border)] bg-raised p-2 min-w-0">
                                <img src={a.dataUrl} alt={a.label || ''} className="w-full h-16 object-contain" />
                                <div className="mt-1 text-caption text-[var(--muted)] truncate text-center">{a.label || '—'}</div>
                              </li>
                            ))}
                          </ul>
                        </section>
                      )
                    })}

                    {assets.length === 0 && <p className="text-label text-[var(--muted)] rounded-card border border-dashed border-[var(--border)] px-3 py-3">{t('templates.noAssets')}</p>}

                    {watermarks.length > 0 && (
                      <div className="flex flex-wrap items-center gap-3 rounded-card border border-[var(--border)] bg-raised px-4 py-3">
                        <Icon.Eye size={16} className="shrink-0 text-[var(--muted)]" />
                        <div className="min-w-0 flex-1 basis-56">
                          <div className="text-body font-semibold">{t(watermarks.length > 1 ? 'dsSettings.watermark.many' : 'dsSettings.watermark.one', { n: watermarks.length })}</div>
                          <p className="text-label text-[var(--muted)] mt-0.5">{t('dsSettings.watermark.desc')}</p>
                        </div>
                        {current.canEdit !== false && (
                          <button type="button" onClick={() => setEditing(current as FormTemplate)} className={quietBtn}>
                            {t('dsSettings.watermark.review')}
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}

                {tab === 'charts' && current && (
                  <>
                    <section aria-labelledby="ds-chart-colors" className="rounded-card border border-[var(--border)] bg-raised p-4">
                      <h4 id="ds-chart-colors" className="text-body font-semibold">
                        {t('dsSettings.charts.series')}
                      </h4>
                      <p className="text-label text-[var(--muted)] mt-0.5">{t('dsSettings.charts.desc')}</p>
                      {chartColors.length > 0 ? (
                        <ul className="mt-3 flex flex-wrap gap-2" aria-label={t('dsSettings.charts.series')}>
                          {chartColors.map((c) => (
                            <li key={c} title={c} className="flex items-center gap-1.5">
                              <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden className="rounded-badge">
                                <rect width="28" height="28" rx="6" fill={c} />
                              </svg>
                              <span className="sr-only">{c}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-3 text-label text-[var(--muted)]">{t('dsSettings.charts.empty')}</p>
                      )}
                    </section>
                    {current.hasDsCards && (
                      <button type="button" onClick={() => setInspecting(current)} className={quietBtn}>
                        <Icon.Eye size={14} className="shrink-0" /> {t('dsSettings.charts.openViewer')}
                      </button>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <DeckTemplateInspector template={inspecting} onClose={() => setInspecting(null)} />
    </div>
  )
}
