import { useId, useState } from 'react'
import * as Icon from '../Icons.jsx'
import { useT } from '../../lib/i18n.jsx'
import { projectsApi } from './projectsApi.ts'
import { assignableRoles, can, memberAccess } from './projectsLogic.ts'
import type { ApiFailure, Member, Role } from './projectsLogic.ts'
import { FailureNotice, Section, inputCls, selectCls, primaryBtn, ghostBtn, iconBtn } from './ui.tsx'

interface MembersSectionProps {
  projectId: string | number
  role: string | null
  email?: string | null
  members: Member[]
  onReload: () => Promise<unknown> | void
  onRefused: (err: ApiFailure) => void
  onLeft: () => void
  onChanged?: () => void | Promise<void>
}

export default function MembersSection({ projectId, role, email, members, onReload, onRefused, onLeft, onChanged }: MembersSectionProps) {
  const t = useT()
  const formId = useId()
  const [kind, setKind] = useState('user')
  const [principal, setPrincipal] = useState('')
  const [newRole, setNewRole] = useState<Role>('view')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiFailure | null>(null)
  const [note, setNote] = useState('')
  const canManage = can(role, 'members')
  const roles = assignableRoles(role)

  const run = async (fn: () => Promise<unknown>, okNote?: string) => {
    setBusy(true)
    setError(null)
    setNote('')
    try {
      await fn()
      if (okNote) setNote(okNote)
      await onReload()
      return true
    } catch (e) {
      setError(e as ApiFailure)
      onRefused(e as ApiFailure)
      return false
    } finally {
      setBusy(false)
    }
  }

  const add = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const p = principal.trim()
    if (!p) return setError({ status: 400, code: 'invalid_principal' })
    const ok = await run(() => projectsApi.addMember(projectId, { kind, principal: p, role: newRole }), t('projects.members.added', { name: p }))
    if (ok) setPrincipal('')
  }

  const leave = async (m: Member) => {
    setBusy(true)
    setError(null)
    try {
      await projectsApi.removeMember(projectId, m)
      await onChanged?.()
      onLeft()
    } catch (e) {
      setError(e as ApiFailure)
      onRefused(e as ApiFailure)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={t('projects.members.title')} hint={canManage ? t('projects.members.hint') : t('projects.members.hintReadOnly')}>
      <ul className="divide-y divide-[var(--border)]">
        {members.map((m) => {
          const a = memberAccess(role, m, email)
          const rowName = m.principal
          return (
            <li key={`${m.kind}:${m.principal}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              {m.kind === 'group' ? <Icon.Users size={16} className="shrink-0 text-[var(--muted)]" /> : <Icon.User size={16} className="shrink-0 text-[var(--muted)]" />}
              <div className="min-w-0 flex-1 basis-40">
                <p className="text-body text-[var(--text)] truncate" title={rowName}>
                  {rowName}
                </p>
                <p className="text-label text-[var(--muted)]">{t(m.kind === 'group' ? 'projects.members.kind.group' : 'projects.members.kind.user')}</p>
              </div>
              {a.canChangeRole ? (
                <select
                  aria-label={t('projects.members.roleOf', { name: rowName })}
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => run(() => projectsApi.setRole(projectId, m, e.target.value), t('projects.members.roleChanged', { name: rowName, role: t(`projects.role.${e.target.value}`) }))}
                  className={selectCls}
                >
                  {(roles.includes(m.role) ? roles : [m.role, ...roles]).map((r) => (
                    <option key={r} value={r}>
                      {t(`projects.role.${r}`)}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-label font-semibold text-[var(--muted)]">{t(`projects.role.${m.role}`)}</span>
              )}
              {a.canRemove && !a.canLeave && (
                <button type="button" disabled={busy} onClick={() => run(() => projectsApi.removeMember(projectId, m), t('projects.members.removed', { name: rowName }))} className={`${iconBtn} hover:text-[var(--danger)]`} aria-label={t('projects.members.remove', { name: rowName })} title={t('projects.members.removeShort')}>
                  <Icon.Trash size={15} />
                </button>
              )}
              {a.canLeave && (
                <button type="button" disabled={busy} onClick={() => leave(m)} className={ghostBtn}>
                  {t('projects.members.leave')}
                </button>
              )}
            </li>
          )
        })}
      </ul>

      {canManage ? (
        <form onSubmit={add} className="space-y-2 pt-1" noValidate aria-labelledby={`${formId}-t`}>
          <p id={`${formId}-t`} className="text-label font-semibold text-[var(--text)]">
            {t('projects.members.addTitle')}
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <select aria-label={t('projects.members.kindLabel')} value={kind} onChange={(e) => setKind(e.target.value)} className={`${inputCls} sm:w-auto sm:shrink-0`}>
              <option value="user">{t('projects.members.kind.user')}</option>
              <option value="group">{t('projects.members.kind.group')}</option>
            </select>
            <input
              aria-label={t(kind === 'group' ? 'projects.members.groupLabel' : 'projects.members.emailLabel')}
              value={principal}
              onChange={(e) => setPrincipal(e.target.value)}
              placeholder={t(kind === 'group' ? 'projects.members.groupPlaceholder' : 'projects.members.emailPlaceholder')}
              className={inputCls}
              autoComplete="off"
              inputMode={kind === 'user' ? 'email' : undefined}
            />
            <select aria-label={t('projects.members.newRoleLabel')} value={newRole} onChange={(e) => setNewRole(e.target.value as Role)} className={`${inputCls} sm:w-auto sm:shrink-0`}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {t(`projects.role.${r}`)}
                </option>
              ))}
            </select>
            <button type="submit" disabled={busy} className={`${primaryBtn} shrink-0`}>
              <Icon.Plus size={14} /> {t('projects.members.add')}
            </button>
          </div>
        </form>
      ) : (
        <p className="text-label text-[var(--muted)]">{t('projects.members.cannotManage')}</p>
      )}
      <p role="status" className="text-label text-[var(--muted)] empty:hidden">
        {note}
      </p>
      <FailureNotice error={error} ctx="members" onDismiss={() => setError(null)} />
    </Section>
  )
}
