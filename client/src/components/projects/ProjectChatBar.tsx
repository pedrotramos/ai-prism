import * as Icon from '../Icons.tsx'
import { useT } from '../../lib/i18n.tsx'
import type { TFn } from '../../lib/tFn.ts'

/**
 * A strip under the chat header for a project chat: whose project this is, and
 * who is answering right now (Zeigarnik: an open task stays visible). The live
 * region is always mounted so the announcement is read when it appears.
 */
interface ProjectChatBarProps {
  projectName?: string | null
  answeringBy?: string | null
}

export default function ProjectChatBar({ projectName, answeringBy }: ProjectChatBarProps) {
  const t: TFn = useT()
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 md:px-5 py-1.5 min-h-9 border-b border-[var(--border)] bg-[var(--surface-2)] text-label text-[var(--muted)]">
      <Icon.Folder size={13} className="shrink-0" />
      <span className="min-w-0">{t('projects.chat.inProject', { name: projectName || t('projects.unnamed') })}</span>
      <span role="status" aria-live="polite" className="sm:ml-auto flex items-center gap-1.5 text-[var(--text)] font-medium min-w-0 empty:hidden">
        {answeringBy && (
          <>
            <span aria-hidden className="shrink-0 w-3 h-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
            <span className="break-words min-w-0">{t('projects.chat.answering', { name: answeringBy })}</span>
          </>
        )}
      </span>
    </div>
  )
}
