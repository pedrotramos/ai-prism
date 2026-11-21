import { useId, useState } from 'react'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import { putJSON } from '../api.ts'
import { parseThemeTokens } from '../lib/themePreview.ts'
import tokensCss from '../styles/tokens.css?raw'
import { Switch, Disclosure } from './SettingsControls.jsx'
import MemorySection from './MemorySection.jsx'

// Personal preferences: appearance, UI/response language, notifications and
// (as children) tone & prompt; the image model sits under Advanced with the
// org default marked Recommended. All persisted in localStorage by App (this
// tab is a pure controlled view over the props), so it applies live.

const THEME_COLORS = parseThemeTokens(tokensCss)

// Miniature app drawn in each theme card, coloured from tokens.css so the
// choice previews the real surfaces. SVG attributes, not inline styles.
function MiniApp({ c, x = 0, w = 120 }) {
  return (
    <g>
      <rect x={x} y="0" width={w} height="60" fill={c.bg} />
      <rect x={x} y="0" width="11" height="60" fill={c.rail} />
      <rect x={x + 3.5} y="4" width="4" height="4" rx="2" fill={c.line} />
      <rect x={x + 2.5} y="12" width="6" height="2.5" rx="1" fill={c.line} />
      <rect x={x + 2.5} y="17" width="6" height="2.5" rx="1" fill={c.line} />
      <rect x={x + 16} y="7" width={(w - 22) * 0.6} height="3" rx="1.5" fill={c.line} />
      <rect x={x + w - 6 - 7 - 4 - (w - 22) * 0.5} y="15" width={(w - 22) * 0.5} height="7" rx="3.5" fill={c.bubble} />
      <circle cx={x + w - 9.5} cy="18.5" r="3.5" fill={c.accent} />
    </g>
  )
}

function ThemePreview({ mode }) {
  return (
    <svg viewBox="0 0 120 60" preserveAspectRatio="none" aria-hidden className="block w-full h-20 rounded-control border border-[var(--border)]">
      {mode === 'system' ? (
        <>
          <MiniApp c={THEME_COLORS.light} x={0} w={60} />
          <MiniApp c={THEME_COLORS.dark} x={60} w={60} />
        </>
      ) : (
        <MiniApp c={mode === 'light' ? THEME_COLORS.light : THEME_COLORS.dark} />
      )}
    </svg>
  )
}

// label above the control, hint below the label (Jakob: the familiar form layout)
function SelectField({ icon: IconCmp, label, hint, value, onChange, options }) {
  const id = useId()
  return (
    <div className="py-3">
      <label htmlFor={id} className="flex items-center gap-2 text-body font-medium">
        {IconCmp && <IconCmp size={16} className="text-[var(--muted)] shrink-0" />}
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="text-label text-[var(--muted)] mt-0.5">
          {hint}
        </p>
      )}
      <select
        id={id}
        value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 w-full sm:w-72 min-h-10 rounded-control border border-[var(--border)] bg-[var(--surface-2)] px-3 text-body focus:border-[var(--accent)]"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export default function PersonalTab({
  theme,
  setTheme,
  uiLang,
  setUiLang,
  responseLang,
  setResponseLang,
  notify,
  setNotify,
  imageModel,
  setImageModel,
  imageModels = [],
  imageModelDefaultId = null,
  children,
}) {
  const t = useT()
  const notifyId = useId()
  const appearanceId = useId()
  const [notifHint, setNotifHint] = useState('')

  // Persist the choice server-side so it follows the user across devices
  // (mirrors the deck template selection), while setImageModel keeps
  // localStorage + the live turn payload in sync.
  const onChangeImageModel = (id) => {
    setImageModel(id)
    if (id) putJSON('/api/image-models/selected', { modelId: id }).catch(() => {})
  }
  // No opaque "Default" entry: the picker lists the real models, the org
  // default is pre-selected and labelled Recommended.
  const IMAGE_MODEL_OPTIONS = imageModels.map((m) => ({
    id: m.id,
    label: m.id === imageModelDefaultId ? t('settings.recommendedOption', { name: m.label }) : m.label,
  }))
  const selectedImageModel = imageModel || imageModelDefaultId || ''

  const THEMES = [
    { id: 'light', label: t('personal.theme.light') },
    { id: 'dark', label: t('personal.theme.dark') },
    { id: 'system', label: t('personal.theme.system') },
  ]

  const UI_LANGS = [
    { id: 'auto', label: t('personal.uiLang.auto') },
    { id: 'pt-BR', label: 'Português' },
    { id: 'en', label: 'English' },
    { id: 'es', label: 'Español' },
  ]

  const RESPONSE_LANGS = [
    { id: 'auto', label: t('personal.responseLang.auto') },
    { id: 'pt', label: 'Português' },
    { id: 'en', label: 'English' },
    { id: 'es', label: 'Español' },
  ]

  // Turning notifications on requires the browser permission — request it on
  // enable and only flip the pref if granted (denied → explain, don't silently
  // enable a setting that can never fire).
  const toggleNotify = async () => {
    if (notify) {
      setNotify(false)
      setNotifHint('')
      return
    }
    if (typeof Notification === 'undefined') {
      setNotifHint(t('personal.notify.unsupported'))
      return
    }
    if (Notification.permission === 'granted') {
      setNotify(true)
      setNotifHint('')
      return
    }
    if (Notification.permission === 'denied') {
      setNotifHint(t('personal.notify.blocked'))
      return
    }
    const perm = await Notification.requestPermission()
    if (perm === 'granted') {
      setNotify(true)
      setNotifHint('')
    } else {
      setNotifHint(t('personal.notify.denied'))
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-title font-semibold flex items-center gap-2">
          <Icon.User size={16} /> {t('personal.title')}
        </h3>
        <p className="text-label text-[var(--muted)] mt-0.5">{t('personal.subtitle')}</p>
      </div>

      {/* Appearance */}
      <div role="group" aria-labelledby={appearanceId}>
        <div id={appearanceId} className="text-body font-medium mb-2">
          {t('personal.appearance')}
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          {THEMES.map((th) => {
            const active = theme === th.id
            return (
              <button
                type="button"
                key={th.id}
                aria-pressed={active}
                onClick={() => setTheme(th.id)}
                className={`rounded-card border p-2 text-left transition duration-fast ${
                  active
                    ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]'
                    : 'border-[var(--border)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <ThemePreview mode={th.id} />
                <div className="mt-1.5 flex items-center gap-1.5 text-label font-medium px-0.5">
                  {active && <Icon.Check size={13} className="text-[var(--accent)]" />}
                  {th.label}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
        <SelectField
          icon={Icon.Languages}
          label={t('personal.uiLangRow.title')}
          hint={t('personal.uiLangRow.hint')}
          value={uiLang}
          onChange={setUiLang}
          options={UI_LANGS}
        />
        <SelectField
          icon={Icon.Sparkle}
          label={t('personal.responseLangRow.title')}
          hint={t('personal.responseLangRow.hint')}
          value={responseLang}
          onChange={setResponseLang}
          options={RESPONSE_LANGS}
        />
        <div className="py-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div id={notifyId} className="flex items-center gap-2 text-body font-medium">
              <Icon.Bell size={16} className="text-[var(--muted)] shrink-0" />
              {t('personal.notifyRow.title')}
            </div>
            <p id={`${notifyId}-hint`} role={notifHint ? 'status' : undefined} className="text-label text-[var(--muted)] mt-0.5">
              {notifHint || t('personal.notifyRow.hint')}
            </p>
          </div>
          <Switch checked={notify} onChange={toggleNotify} labelledBy={notifyId} describedBy={`${notifyId}-hint`} />
        </div>
      </div>

      <div className="border-t border-[var(--border)] pt-6">
        <MemorySection />
      </div>

      {children && <div className="border-t border-[var(--border)] pt-6">{children}</div>}

      {imageModels.length > 0 && (
        <Disclosure title={t('settings.advanced')} hint={t('settings.advancedHint')}>
          <SelectField
            icon={Icon.Image}
            label={t('personal.imageModelRow.title')}
            hint={t('personal.imageModelRow.hint')}
            value={selectedImageModel}
            onChange={onChangeImageModel}
            options={IMAGE_MODEL_OPTIONS}
          />
        </Disclosure>
      )}
    </div>
  )
}
