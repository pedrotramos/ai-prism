import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import * as Icon from './Icons.tsx'
import { createRecognizer, dictationSupported } from '../lib/speech.ts'
import { useI18n } from '../lib/i18n.tsx'
import {
  availableCommandIds,
  canonicalCompactText,
  nextIndex,
  parseSkillPrefix,
  parseSlashCommand,
  slashMenuItems,
} from '../lib/slashCommands.ts'
import SlashMenu, { SlashHelp, slashItemId } from './composer/SlashMenu.tsx'
import PlusMenu from './composer/PlusMenu.tsx'
import AttachmentChips from './composer/AttachmentChips.tsx'
import ToolChips from './composer/ToolChips.tsx'

// The message composer: text box, "/" command menu, "+" menu (files, images,
// audio/video, commands), attachment and pinned-skill chips, dictation, voice
// mode and Send/Stop.
//
// Keyboard: Enter sends, Shift+Enter adds a line; with the "/" suggestions open
// the arrows move, Enter/Tab pick and Esc closes (the text stays). No confirm
// dialogs anywhere: a command runs, a message sends.
//
// Screen readers: the ARIA 1.1 combobox pattern. A wrapper with role=combobox
// (aria-haspopup=listbox, aria-expanded, aria-owns and aria-controls -> the
// listbox while open; axe requires aria-controls on an expanded combobox)
// contains the textarea, which keeps its native multiline textbox role and
// carries aria-autocomplete=list, aria-controls -> the listbox and
// aria-activedescendant -> the active option. A polite status line announces
// how many suggestions the filter left. No role on the <textarea> itself:
// HTML-ARIA allows none there (axe aria-allowed-role).
//
// Commands (lib/slashCommands.js): `onCommand(id, arg)` runs the app-side ones
// (/nova, /modelo, /historico, ...), optionally narrowed to the ids in
// `commands`; without it the menu offers only /compactar (sent as text, the app
// parses it) and /ajuda (answered here). `models` feeds the second step of
// /modelo; `skills` lets "/<skill>" pin an authored skill for the next message,
// sent as `opts.skills` (skill ids) to onSend(text, files, opts).

const DICTATION_LANG: Record<string, string> = { pt: 'pt-BR', en: 'en-US', es: 'es-ES' }

// Fitts: 44 px on phones, 36 px from md up.
const ICON_BTN =
  'shrink-0 inline-flex items-center justify-center w-11 h-11 md:w-9 md:h-9 rounded-control transition-colors duration-fast'
const QUIET_BTN = `${ICON_BTN} text-muted hover:text-fg hover:bg-surface-3`

// A pinnable authored skill / a catalog model, as far as the composer reads them.
interface ComposerSkill {
  id: string | number
  name: string
  title?: string
  enabled?: boolean
}

interface ComposerModel {
  id: string
  label?: string
  provider?: string
  blurb?: string | null
}

type Translate = (key: string, vars?: Record<string, unknown>) => string

// The recognizer type exported by lib/speech.ts omits start()/stop(); this is the slice used here.
interface RecognizerControls {
  start(): void
  stop(): void
}

type MenuItems = NonNullable<ReturnType<typeof slashMenuItems<ComposerSkill, ComposerModel>>>

interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: (text: string, files: File[], opts?: { skills: (string | number)[] }) => void
  onStop: () => void
  streaming: boolean
  files: File[]
  setFiles: Dispatch<SetStateAction<File[]>>
  supportedExt?: string[]
  mediaExt?: string[]
  onOpenVoice: () => void
  onCommand?: (id: string, arg: string) => void
  commands?: Iterable<string>
  models?: ComposerModel[]
  skills?: ComposerSkill[]
  onStartTemporary?: () => void
}

export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  files,
  setFiles,
  supportedExt,
  mediaExt,
  onOpenVoice,
  onCommand,
  commands,
  models,
  skills,
  onStartTemporary,
}: ComposerProps) {
  // useI18n() comes from i18n.jsx (untyped JS), which infers a one-argument `t`
  const { t, locale } = useI18n() as { t: Translate; locale: string }
  const fileInput = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const recRef = useRef<RecognizerControls | null>(null)
  const baseRef = useRef('')
  const dragDepth = useRef(0)
  const listId = useId().replace(/:/g, '') // usable as a CSS id selector
  const [listening, setListening] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [menuIndex, setMenuIndex] = useState(0)
  // Esc hides the menu for the current text; any edit brings it back
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [pinned, setPinned] = useState<ComposerSkill[]>([])

  const media = mediaExt || []
  const available = useMemo(() => availableCommandIds({ hasHandler: !!onCommand, commands }), [onCommand, commands])
  const allItems = useMemo(
    () => slashMenuItems(value, { t, available, skills: skills || [], models: models || [] }),
    [value, t, available, skills, models]
  )
  const items = dismissedFor === value ? null : allItems
  const menuOpen = !!items
  const activeIndex = menuOpen ? Math.min(menuIndex, items.length - 1) : -1

  // a new filter result starts at the top
  useEffect(() => setMenuIndex(0), [allItems])

  // auto-grow the textarea with its content (up to max-h-48) — a fixed
  // one-line box feels cramped, especially in the narrow focus-mode column
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 192) + 'px'
  }, [value])

  const focusBox = () => requestAnimationFrame(() => taRef.current?.focus())

  const addFiles = (list: ArrayLike<File> | null | undefined) => {
    const incoming = Array.from(list || [])
    if (!incoming.length) return
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name + f.size))
      return [...prev, ...incoming.filter((f) => !names.has(f.name + f.size))].slice(0, 10)
    })
  }

  // One hidden input serves every "+" entry; each sets its own accept list.
  // Images are always acceptable (vision input); audio/video only when the
  // workspace advertises media_extensions (transcribed server-side).
  const docAccept = (supportedExt || []).map((e) => '.' + e)
  const mediaAccept = [...media.map((e) => '.' + e), 'audio/*', 'video/*']
  const pickFiles = (accept: string[]) => {
    const input = fileInput.current
    if (!input) return
    input.accept = accept.join(',')
    input.click()
  }

  // Paste-to-attach: files on the clipboard (a screenshot, "copy image", a file
  // copied in the OS file manager) are attached like any other; plain text is
  // left to the textarea. A pasted image usually has a generic name
  // ("image.png") that would collide with the name+size dedup key, so each gets
  // a unique one.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const pasted: File[] = []
    for (const it of items) {
      if (it.kind !== 'file') continue
      const blob = it.getAsFile()
      if (!blob) continue
      const generic = !blob.name || /^image\.(png|jpe?g|gif|webp)$/i.test(blob.name)
      if (generic && (blob.type || '').startsWith('image/')) {
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
        pasted.push(new File([blob], `pasted-${pasted.length + 1}-${blob.size}.${ext}`, { type: blob.type }))
      } else {
        pasted.push(blob)
      }
    }
    if (pasted.length) {
      e.preventDefault() // don't also drop the binary as text into the box
      addFiles(pasted)
    }
  }

  // Drag and drop over the whole composer. A depth counter keeps the highlight
  // steady while the pointer crosses child elements.
  const hasFiles = (e: React.DragEvent<HTMLDivElement>) => Array.from(e.dataTransfer?.types || []).includes('Files')
  const dropHandlers = {
    onDragEnter: (e: React.DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current += 1
      setDragOver(true)
    },
    onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
      if (hasFiles(e)) e.preventDefault()
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragOver(false)
    },
    onDrop: (e: React.DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer?.files?.length) return
      e.preventDefault()
      dragDepth.current = 0
      setDragOver(false)
      addFiles(e.dataTransfer.files)
    },
  }

  const pinSkill = (skill: ComposerSkill) => setPinned((prev) => (prev.some((s) => s.id === skill.id) ? prev : [...prev, skill]))

  const runCommand = (id: string, arg = '') => {
    setDismissedFor(null)
    if (id === 'compact') {
      // the app parses compaction from the text it receives (lib/compaction.js)
      onSend(arg ? `/compactar ${arg}` : '/compactar', [])
      return
    }
    onChange('')
    if (id === 'help') {
      setHelpOpen(true)
      focusBox()
      return
    }
    setHelpOpen(false)
    onCommand?.(id, arg)
  }

  const pick = (item: MenuItems[number]) => {
    // `kind` says which of cmd / skill / model the menu row carries
    if (item.kind === 'skill') {
      pinSkill(item.skill!)
      onChange('')
    } else if (item.kind === 'model') {
      onChange('')
      onCommand?.('model', item.model!.id)
    } else if (item.cmd!.arg === 'model' && (models || []).length) {
      // second step: list the models to pick from
      onChange(`/${t('composer.slash.cmd.model')} `)
    } else {
      runCommand(item.cmd!.id)
    }
    focusBox()
  }

  const doSend = () => {
    if (streaming) return
    const command = parseSlashCommand(value)
    if (command && available.has(command.cmd.id)) {
      if (command.cmd.id === 'compact') return onSend(canonicalCompactText(value)!, []) // non-null: the text parsed as /compact
      return runCommand(command.cmd.id, command.arg)
    }
    let text = value
    let pins = pinned
    const prefixed = parseSkillPrefix(value, skills)
    if (prefixed) {
      pins = pins.some((s) => s.id === prefixed.skill.id) ? pins : [...pins, prefixed.skill]
      text = prefixed.rest
      if (!text.trim() && files.length === 0) {
        setPinned(pins)
        onChange('')
        return
      }
    }
    if (!text.trim() && files.length === 0) return
    onSend(text, files, pins.length ? { skills: pins.map((s) => s.id) } : undefined)
    setPinned([])
    setHelpOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return // IME candidate selection, not a send
    if (menuOpen) {
      if (['ArrowDown', 'ArrowUp'].includes(e.key) || (e.key === 'Home' && e.ctrlKey) || (e.key === 'End' && e.ctrlKey)) {
        e.preventDefault()
        setMenuIndex(nextIndex(activeIndex, items.length, e.key))
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        pick(items[activeIndex]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissedFor(value)
        return
      }
    }
    if (e.key === 'Escape' && helpOpen) {
      e.preventDefault()
      setHelpOpen(false)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  }

  const toggleDictation = () => {
    if (listening) {
      recRef.current?.stop()
      return
    }
    baseRef.current = value ? value.replace(/\s+$/, '') + ' ' : ''
    const rec = createRecognizer({
      lang: DICTATION_LANG[locale] || 'pt-BR',
      onResult: (said: string) => onChange(baseRef.current + said),
      onEnd: () => setListening(false),
      onError: () => setListening(false),
    })
    if (!rec) return
    const ctl = rec as unknown as RecognizerControls // see RecognizerControls
    recRef.current = ctl
    ctl.start()
    setListening(true)
  }

  const plusGroups = [
    {
      id: 'attach',
      label: t('composer.plus.groupAttach'),
      items: [
        {
          id: 'files',
          icon: 'Paperclip',
          label: t('composer.attach'),
          hint: t('composer.plus.filesHint'),
          onSelect: () => pickFiles([...docAccept, 'image/*', ...(media.length ? mediaAccept : [])]),
        },
        { id: 'images', icon: 'Image', label: t('composer.plus.images'), hint: t('composer.plus.imagesHint'), onSelect: () => pickFiles(['image/*']) },
        ...(media.length
          ? [{ id: 'media', icon: 'Waveform', label: t('composer.plus.media'), hint: t('composer.plus.mediaHint'), onSelect: () => pickFiles(mediaAccept) }]
          : []),
      ],
    },
    {
      id: 'commands',
      label: t('composer.plus.groupCommands'),
      items: [
        // W3-6: offered while the open chat is not already a temporary one
        ...(onStartTemporary
          ? [{ id: 'temporary', icon: 'Lock', label: t('composer.plus.temporary'), hint: t('composer.plus.temporaryHint'), onSelect: onStartTemporary }]
          : []),
        {
          id: 'slash',
          icon: 'Terminal',
          label: t('composer.plus.commands'),
          hint: t('composer.plus.commandsHint'),
          onSelect: () => {
            setDismissedFor(null)
            onChange('/')
            focusBox()
          },
        },
      ],
    },
  ]

  const canSend = !!value.trim() || files.length > 0

  return (
    <div className="px-3 md:px-0" data-composer="">
      <div
        {...dropHandlers}
        className={`relative rounded-3xl border bg-surface transition-colors duration-fast shadow-lg shadow-black/10 ${
          dragOver ? 'border-accent ring-2 ring-accent-soft' : 'border-border'
        }`}
      >
        {menuOpen && <SlashMenu id={listId} items={items} activeIndex={activeIndex} onPick={pick} onHover={setMenuIndex} />}
        <div role="status" aria-live="polite" className="sr-only">
          {menuOpen ? t(items.length === 1 ? 'composer.slash.countOne' : 'composer.slash.count', { n: items.length }) : ''}
        </div>
        {!menuOpen && helpOpen && (
          <SlashHelp
            available={available}
            onClose={() => {
              setHelpOpen(false)
              focusBox()
            }}
          />
        )}
        {dragOver && (
          <div
            aria-hidden="true"
            className="absolute inset-0 z-raised flex items-center justify-center rounded-3xl bg-surface-2 border-2 border-dashed border-accent text-body text-fg pointer-events-none"
          >
            <Icon.Upload size={18} className="mr-2 text-accent" />
            {t('composer.dropHint')}
          </div>
        )}

        <ToolChips skills={pinned} onRemove={(id: string | number) => setPinned((prev) => prev.filter((s) => s.id !== id))} />
        <AttachmentChips files={files} mediaExt={media} onRemove={(i: number) => setFiles((prev) => prev.filter((_, j) => j !== i))} />

        {/* two rows (textarea on top, controls below): the placeholder never
            wraps behind the buttons, no matter how narrow the chat column
            gets (e.g. Studio focus mode) */}
        <div
          role="combobox"
          aria-label={t('composer.inputLabel')}
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
          aria-owns={menuOpen ? listId : undefined}
          aria-controls={menuOpen ? listId : undefined}
          className="px-3 pt-2 pb-1"
        >
          <textarea
            ref={taRef}
            rows={1}
            aria-label={t('composer.inputLabel')}
            aria-controls={menuOpen ? listId : undefined}
            aria-activedescendant={menuOpen ? slashItemId(listId, activeIndex) : undefined}
            aria-autocomplete="list"
            value={value}
            onChange={(e) => {
              setDismissedFor(null)
              onChange(e.target.value)
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={listening ? t('composer.listening') : t('composer.placeholder')}
            className="w-full max-h-48 resize-none bg-transparent py-1 text-title md:text-body leading-6 md:leading-6 placeholder:text-faint"
          />
        </div>
        <div className="flex items-center gap-1 px-2 pb-2">
          <PlusMenu groups={plusGroups} buttonClassName={QUIET_BTN} />
          <input
            ref={fileInput}
            type="file"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <span className="flex-1" />
          {dictationSupported && (
            <button
              type="button"
              onClick={toggleDictation}
              aria-pressed={listening}
              aria-label={t('composer.dictate')}
              title={t('composer.dictate')}
              className={`${ICON_BTN} relative ${listening ? 'text-on-accent bg-accent-strong' : 'text-muted hover:text-fg hover:bg-surface-3'}`}
            >
              {listening && <span className="absolute inset-0 rounded-control bg-accent animate-pulse-ring" />}
              <Icon.Mic size={19} />
            </button>
          )}

          <button
            type="button"
            onClick={onOpenVoice}
            aria-label={t('composer.voiceMode')}
            title={t('composer.voiceMode')}
            className={QUIET_BTN}
          >
            <Icon.Waveform size={19} />
          </button>

          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label={t('composer.stop')}
              title={t('composer.stop')}
              className={`${ICON_BTN} bg-surface-3 hover:bg-border text-fg`}
            >
              <Icon.Stop size={18} />
            </button>
          ) : (
            <button
              type="button"
              onClick={doSend}
              disabled={!canSend}
              aria-label={t('composer.send')}
              title={t('composer.send')}
              className={`${ICON_BTN} bg-accent-strong text-on-accent hover:brightness-110 disabled:bg-disabled disabled:text-disabled-text disabled:cursor-not-allowed disabled:hover:brightness-100`}
            >
              <Icon.Send size={18} />
            </button>
          )}
        </div>
      </div>
      <p className="text-center text-balance text-caption text-faint mt-2 mb-1.5 px-2">{t('composer.disclaimer')}</p>
    </div>
  )
}
