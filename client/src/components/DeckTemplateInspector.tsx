import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import { MARKDOWN_COMPONENTS, markdownUrlTransform } from './message/Markdown.tsx'
import { safeMessageMarkdown } from './message/safeMessageMarkdown.ts'
import remarkGfm from 'remark-gfm'
import * as Icon from './Icons.tsx'
import { getJSON } from '../api.ts'
import { useT } from '../lib/i18n.tsx'
import { DS_FALLBACK } from '../lib/dsDefaults.ts'
import { useModalDialog } from '../lib/useModalDialog.ts'

// useT()/useI18n() come from i18n.jsx (untyped JS), which infers a one-argument `t`.
type Translate = (key: string, vars?: Record<string, unknown>) => string

// The template as GET /api/deck-templates/:id returns it (list rows carry only
// a summary: no readme, no specimen cards). Every field this viewer reads.
interface FontAsset {
  family: string
  weight?: string
  style?: string
  dataUrl?: string
}

interface PaletteToken {
  varName?: string
  name: string
  value: string
}

interface IconAsset {
  id: string
  kind?: string
  label?: string
  dataUrl: string
}

interface DsCard {
  id: string
  group: string
  title: string
  description?: string
  html: string
}

export interface DsTemplate {
  id?: number | string
  name?: string
  readme?: string
  hasReadme?: boolean
  primaryColor?: string
  secondaryColor?: string
  accentColor?: string
  backgroundColor?: string
  headingFont?: string
  bodyFont?: string
  logoDataUrl?: string
  logoLightDataUrl?: string
  fontAssets?: FontAsset[]
  palette?: PaletteToken[]
  iconAssets?: IconAsset[]
  dsCards?: DsCard[]
}

type CoreColorKey = 'primaryColor' | 'secondaryColor' | 'accentColor' | 'backgroundColor'
type FontKey = 'headingFont' | 'bodyFont'

// Read-only "Design System" viewer for a single template — mirrors the
// browsing experience of Claude Design's own Design System page: a sidebar of
// grouped entries (Readme, Templates, Brand, Colors, Components, Slides,
// Type, …) and a main panel rendering each card. Bundle imports (dsImport.js)
// provide README/palette/fonts/specimen HTML; plain .pptx-mined templates
// fall back to the mined sections (colors, icons, diagrams, preview slides).
// No section is a fixed reproduction of any reference bundle — a template
// without that data simply doesn't show the section.

// ---- font loading hook ------------------------------------------------------

// Self-hosted design-system webfonts (template.fontAssets, from a bundle
// import) registered once per family/weight/style — the preview and Present
// mode then render in the REAL brand font instead of a system fallback. The
// .pptx references fonts by name; viewers with the font installed match 1:1.
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
        // malformed font data — preview falls back to the system stack
      }
    }
  }, [template])
}

// ---- specimen card (self-contained HTML from the bundle) --------------------

// Design tokens (--db-*, --font-*, --shadow-*) reconstructed from the template's
// persisted palette + fontAssets. Cards render inside a sandboxed srcDoc iframe
// (no same-origin), and some — the Templates group especially — pull their
// tokens CSS in at RUNTIME via a JS-created <link href="../../colors_and_type.css">
// (see the bundle's ds-base.js). That relative URL resolves against the app
// origin inside the iframe and 404s, leaving every var(--db-*) unset: token
// backgrounds collapse to transparent, so the same slide shows the stage's
// white canvas when featured but the card's own dark <html> bg as a thumbnail.
// Injecting this block into every card's <head> defines the tokens regardless,
// and because it's built from persisted fields it also repairs templates saved
// before the importer fix — no reimport needed. Built at low precedence (top of
// <head>) so a card's own inline styles still win.
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
  // Family + shadow tokens the bundle slides reference but the color palette
  // doesn't carry. Font families point at the (now @font-face'd) brand faces
  // with sane fallbacks; shadows are static in the source DS.
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

// Prepend the reconstructed token <style> to the top of the card's <head> (or
// <html>, or the document) so token-driven colors resolve inside the iframe.
function withTokens(html: string, tokenStyle: string): string {
  if (!tokenStyle || typeof html !== 'string') return html
  const inject = `<style data-ds-tokens>${tokenStyle}</style>`
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + inject)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + inject)
  return inject + html
}

// Sandboxed iframe (scripts allowed for <deck-stage>, but NO same-origin so
// bundle JS can never touch the app). Slides/templates author at a fixed
// 1280×720 stage → scaled to fit; free-flowing preview cards get a natural
// height with internal scrolling.
function SpecimenFrame({ card, tokenStyle }: { card: DsCard; tokenStyle: string }) {
  const isStage = card.group === 'Slides' || card.group === 'Templates' || card.group === 'UI Kit — Website'
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)
  const html = useMemo(() => withTokens(card.html, tokenStyle), [card.html, tokenStyle])
  useEffect(() => {
    if (!isStage || !wrapRef.current) return
    const el = wrapRef.current
    const update = () => setScale(el.clientWidth / 1280)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [isStage])

  if (isStage) {
    return (
      <div ref={wrapRef} className="w-full aspect-video overflow-hidden rounded-b-xl bg-[var(--surface-3)]">
        <iframe
          title={card.title}
          sandbox="allow-scripts"
          srcDoc={html}
          className="border-0 origin-top-left"
          /* data */ style={{ width: 1280, height: 720, transform: `scale(${scale})` }}
        />
      </div>
    )
  }
  return (
    <iframe
      title={card.title}
      sandbox="allow-scripts"
      srcDoc={html}
      className="w-full h-[340px] border-0 rounded-b-xl"
      /* data */ style={{ background: DS_FALLBACK.paper }}
    />
  )
}

interface CardShellProps {
  title: string
  description?: string
  children?: ReactNode
}

function CardShell({ title, description, children }: CardShellProps) {
  return (
    <div className="rounded-xl border border-[var(--border)] overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-baseline gap-2">
        <span className="text-body font-semibold">{title}</span>
        {description && <span className="text-caption text-[var(--faint)] truncate">{description}</span>}
      </div>
      {children}
    </div>
  )
}

// ---- sections ---------------------------------------------------------------

function ReadmeSection({ template }: { template: DsTemplate }) {
  // Reading column centered in the panel (with comfortable side gutters on wide
  // screens) instead of hugging the left edge — the readme is a prose page, so
  // the negative space reads better balanced around the text than pooled on the right.
  return (
    <div className="prose-chat text-body max-w-3xl mx-auto lg:px-6 [&_h1]:text-heading [&_h2]:text-title [&_h2]:mt-6 [&_table]:text-label">
      <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS} urlTransform={markdownUrlTransform}>{safeMessageMarkdown(template.readme || '')}</Markdown>
    </div>
  )
}

const coreSwatches = (t: Translate): [CoreColorKey, string][] => [
  ['primaryColor', t('templateInspector.colorPrimary')],
  ['secondaryColor', t('templateInspector.colorSecondary')],
  ['accentColor', t('templateInspector.colorAccent')],
  ['backgroundColor', t('templateInspector.colorBackground')],
]

function Swatch({ name, value, sub }: { name: string; value?: string; sub?: string }) {
  const light = (() => {
    const c = (value || DS_FALLBACK.swatch).replace('#', '')
    return (0.299 * parseInt(c.slice(0, 2), 16) + 0.587 * parseInt(c.slice(2, 4), 16) + 0.114 * parseInt(c.slice(4, 6), 16)) / 255 > 0.62
  })()
  return (
    <div className="rounded-xl overflow-hidden border border-[var(--border)]">
      <div className="h-16 flex flex-col justify-end p-2" /* data */ style={{ background: value || DS_FALLBACK.swatch, color: light ? DS_FALLBACK.inkOnLight : DS_FALLBACK.inkOnDark }}>
        <div className="text-caption font-bold leading-tight">{name}</div>
        <div className="text-caption font-mono opacity-80 uppercase">{value}</div>
      </div>
      {sub && <div className="px-2 py-1 text-caption text-[var(--faint)] font-mono truncate">{sub}</div>}
    </div>
  )
}

interface SectionProps {
  template: DsTemplate
  cards?: DsCard[]
  tokenStyle: string
}

function ColorsSection({ template, cards, tokenStyle }: SectionProps) {
  const t = useT() as Translate
  const palette = template.palette || []
  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <div className="text-label font-semibold text-[var(--faint)] mb-2">{t('templateInspector.colorsApplied')}</div>
        <div className="grid grid-cols-4 gap-2.5">
          {coreSwatches(t).map(([key, label]) => (
            <Swatch key={key} name={label} value={template[key] || DS_FALLBACK.swatch} />
          ))}
        </div>
      </div>
      {palette.length > 0 && (
        <div>
          <div className="text-label font-semibold text-[var(--faint)] mb-2">{t('templateInspector.fullPalette', { n: palette.length })}</div>
          <div className="grid grid-cols-5 gap-2.5">
            {palette.map((t) => (
              <Swatch key={t.varName} name={t.name} value={t.value} sub={t.varName} />
            ))}
          </div>
        </div>
      )}
      <CardsList cards={cards} tokenStyle={tokenStyle} />
    </div>
  )
}

function TypeSection({ template, cards, tokenStyle }: SectionProps) {
  const t = useT() as Translate
  useTemplateFonts(template)
  const families = [...new Set((template.fontAssets || []).map((f) => f.family))]
  return (
    <div className="space-y-4 max-w-3xl">
      {([
        ['headingFont', t('templateInspector.headingFont')],
        ['bodyFont', t('templateInspector.bodyFont')],
      ] as [FontKey, string][]).map(([key, label]) => (
        <div key={key} className="rounded-xl border border-[var(--border)] p-4">
          <div className="text-label font-semibold text-[var(--faint)] mb-2">
            {label} — {template[key] || t('templateInspector.fontUndefined')}
            {families.includes(template[key] as string) && ` · ${t('templateInspector.webfontLoaded')}`}
          </div>
          <div /* data */ style={{ fontFamily: template[key] || 'inherit' }} className="text-heading">
            Aa Bb Cc — do more with your data
          </div>
          <div /* data */ style={{ fontFamily: template[key] || 'inherit' }} className="text-body mt-1 text-[var(--muted)]">
            abcdefghijklmnopqrstuvwxyz · 0123456789 · R$ 1.234,56
          </div>
        </div>
      ))}
      {(template.fontAssets || []).length > 0 && (
        <div className="text-caption text-[var(--faint)]">
          {t('templateInspector.fontFilesPrefix', { n: (template.fontAssets as FontAsset[]).length })} {families.join(', ')}{t('templateInspector.fontFilesSuffix')}
        </div>
      )}
      <CardsList cards={cards} tokenStyle={tokenStyle} />
    </div>
  )
}

const brandGroups = (t: Translate): [string, string][] => [
  ['icon', t('templateInspector.brandIcons')],
  ['lockup', t('templateInspector.brandLockups')],
  ['illustration', t('templateInspector.brandIllustrations')],
  ['background', t('templateInspector.brandBackgrounds')],
  ['image', t('templateInspector.brandImages')],
  ['watermark', t('templateInspector.brandWatermarks')],
]

function BrandSection({ template, cards, tokenStyle }: SectionProps) {
  const t = useT() as Translate
  const assets = template.iconAssets || []
  const byKind = (k: string) => assets.filter((a) => (a.kind || 'icon') === k)
  return (
    <div className="space-y-6">
      {(template.logoDataUrl || template.logoLightDataUrl) && (
        <div>
          <div className="text-label font-semibold text-[var(--faint)] mb-2">{t('templateInspector.logo')}</div>
          <div className="flex gap-2.5">
            {template.logoDataUrl && (
              <div className="rounded-xl border border-[var(--border)] p-4 flex items-center justify-center min-w-44" /* data */ style={{ background: template.primaryColor || DS_FALLBACK.brandDark }}>
                <img src={template.logoDataUrl} alt={t('templateInspector.logoDarkAlt')} className="h-8 object-contain" />
              </div>
            )}
            {template.logoLightDataUrl && (
              <div className="rounded-xl border border-[var(--border)] p-4 flex items-center justify-center min-w-44" /* data */ style={{ background: template.backgroundColor || DS_FALLBACK.background }}>
                <img src={template.logoLightDataUrl} alt={t('templateInspector.logoLightAlt')} className="h-8 object-contain" />
              </div>
            )}
          </div>
        </div>
      )}
      {brandGroups(t).map(([kind, label]) => {
        const items = byKind(kind)
        if (!items.length) return null
        const dark = kind === 'illustration'
        const wide = kind === 'background' || kind === 'lockup'
        return (
          <div key={kind}>
            <div className="text-label font-semibold text-[var(--faint)] mb-2">
              {label} ({items.length})
            </div>
            <div className={`grid gap-2.5 ${wide ? 'grid-cols-4' : 'grid-cols-6'}`}>
              {items.map((a) => (
                <div
                  key={a.id}
                  className={`rounded-lg border border-[var(--border)] p-2 flex flex-col items-center gap-1 ${kind === 'watermark' ? 'opacity-60' : ''}`}
                  /* data */ style={dark ? { background: template.primaryColor || DS_FALLBACK.brandDark } : undefined}
                  title={a.label || a.id}
                >
                  <img src={a.dataUrl} alt="" className={`object-contain ${wide ? 'w-full h-14' : 'w-9 h-9'}`} />
                  <span className={`text-caption truncate w-full text-center ${dark ? 'text-[color-mix(in_srgb,var(--on-accent)_75%,transparent)]' : 'text-[var(--faint)]'}`}>{a.label || '—'}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
      <CardsList cards={cards} tokenStyle={tokenStyle} />
    </div>
  )
}

function CardsList({ cards, tokenStyle }: { cards?: DsCard[]; tokenStyle: string }) {
  if (!cards?.length) return null
  return (
    <div className="space-y-4">
      {cards.map((c) => (
        <CardShell key={c.id} title={c.title} description={c.description}>
          <SpecimenFrame card={c} tokenStyle={tokenStyle} />
        </CardShell>
      ))}
    </div>
  )
}

// ---- main -------------------------------------------------------------------

// Mounted only while a template is being inspected, so the dialog's focus
// trap captures the opener on mount and restores it on close.
interface DeckTemplateInspectorProps {
  template: DsTemplate | null | undefined
  onClose: () => void
}

export default function DeckTemplateInspector(props: DeckTemplateInspectorProps) {
  if (!props.template) return null
  return <InspectorDialog template={props.template} onClose={props.onClose} />
}

function InspectorDialog({ template: summary, onClose }: { template: DsTemplate; onClose: () => void }) {
  const t = useT() as Translate
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalDialog(dialogRef, { onClose })
  // list rows are summaries (no readme/specimen cards) — hydrate on open
  const [full, setFull] = useState<DsTemplate | null>(null)
  useEffect(() => {
    setFull(null)
    if (!summary?.id) return
    getJSON<{ template: DsTemplate }>(`/api/deck-templates/${summary.id}`)
      .then((r) => setFull(r.template))
      .catch(() => setFull(summary))
  }, [summary?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const template = full || summary
  const cardsByGroup = useMemo(() => {
    const map = new Map<string, DsCard[]>()
    for (const c of template?.dsCards || []) {
      if (!map.has(c.group)) map.set(c.group, [])
      map.get(c.group)!.push(c) // set on the line above
    }
    return map
  }, [template])
  // Reconstructed once per template (fonts are ~1MB of base64) and injected
  // into every specimen iframe so runtime-loaded token CSS never 404s.
  const tokenStyle = useMemo(() => buildTokenStyle(template), [template])

  const sections = useMemo(() => {
    if (!template) return []
    const list = []
    const assets = template.iconAssets || []
    // labels exibidos em pt-BR; os ids e as CHAVES de grupo (`c.group`, vindas
    // do manifest do bundle) permanecem originais — só o texto é traduzido
    if (template.readme) list.push({ id: 'readme', label: t('templateInspector.sectionReadme') })
    if (cardsByGroup.has('Templates')) list.push({ id: 'templates', label: t('templateInspector.sectionTemplates') })
    if (assets.length || template.logoDataUrl) list.push({ id: 'brand', label: t('templateInspector.sectionBrand') })
    list.push({ id: 'colors', label: t('templateInspector.sectionColors') })
    if (cardsByGroup.has('Components')) list.push({ id: 'components', label: t('templateInspector.sectionComponents') })
    if (cardsByGroup.has('Slides')) list.push({ id: 'slides', label: t('templateInspector.sectionSlides') })
    list.push({ id: 'type', label: t('templateInspector.sectionType') })
    if (cardsByGroup.has('Spacing')) list.push({ id: 'spacing', label: t('templateInspector.sectionSpacing') })
    return list
  }, [template, cardsByGroup, t])

  const [section, setSection] = useState('colors')
  useEffect(() => {
    if (summary) setSection(summary.hasReadme || summary.readme ? 'readme' : 'colors')
  }, [summary?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ds-inspector-title"
      tabIndex={-1}
      className="fixed inset-0 z-editor flex flex-col bg-[var(--bg)] animate-fade-in"
    >
      <header className="shrink-0 h-14 flex items-center gap-3 px-4 border-b border-[var(--border)]">
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="grid place-items-center w-10 h-10 -ml-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]">
          <Icon.Close size={20} />
        </button>
        <Icon.Eye size={18} className="text-[var(--accent)]" />
        <span id="ds-inspector-title" className="font-semibold text-body">{t('templateInspector.headerTitle', { name: template.name || t('templateInspector.defaultName') })}</span>
        {!full && <span className="text-label text-[var(--faint)]">{t('templateInspector.loadingShort')}</span>}
      </header>

      <div className="flex-1 flex min-h-0">
        <div className="w-52 shrink-0 border-r border-[var(--border)] p-3 space-y-1 overflow-y-auto">
          {sections.map((s) => (
            <button
              type="button"
              key={s.id}
              aria-current={section === s.id ? 'page' : undefined}
              onClick={() => setSection(s.id)}
              className={`w-full text-left text-body rounded-lg px-3 py-2 transition ${
                section === s.id ? 'bg-[var(--accent-soft)] text-[var(--accent-text)] font-medium' : 'hover:bg-[var(--surface-3)] text-[var(--muted)]'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
          {section === 'readme' && template.readme && <ReadmeSection template={template} />}
          {section === 'templates' && <CardsList cards={cardsByGroup.get('Templates')} tokenStyle={tokenStyle} />}
          {section === 'brand' && <BrandSection template={template} cards={cardsByGroup.get('Brand')} tokenStyle={tokenStyle} />}
          {section === 'colors' && <ColorsSection template={template} cards={cardsByGroup.get('Colors')} tokenStyle={tokenStyle} />}
          {section === 'components' && <CardsList cards={cardsByGroup.get('Components')} tokenStyle={tokenStyle} />}
          {section === 'slides' && <CardsList cards={cardsByGroup.get('Slides')} tokenStyle={tokenStyle} />}
          {section === 'type' && <TypeSection template={template} cards={cardsByGroup.get('Type')} tokenStyle={tokenStyle} />}
          {section === 'spacing' && <CardsList cards={cardsByGroup.get('Spacing')} tokenStyle={tokenStyle} />}
        </div>
      </div>
    </div>
  )
}
