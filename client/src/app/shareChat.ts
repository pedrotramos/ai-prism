// "Share" on an artifact studio (Q4-B): sharing a chat means putting it in a project and opening the project's
// members. planShare picks the step that applies to the open chat; the Shell acts on it (the move itself and the
// members screen are the existing flows: MoveToProjectDialog and ProjectDetail).
type Id = string | number

export interface ShareSession {
  id: Id
  project_id?: Id | null
  ephemeral?: boolean
  owner_email?: string | null
}

export type ShareStep =
  /** already in a project: nothing to move, go to that project's members */
  | { kind: 'open-members'; projectId: string }
  /** a personal chat and the caller has projects: ask which one */
  | { kind: 'choose-project' }
  /** a personal chat and no project yet: the Projects screen is where one is created */
  | { kind: 'no-projects' }
  | { kind: 'unavailable'; reason: 'no-chat' | 'temporary' | 'foreign' }

export function planShare({ session, projects, email }: { session: ShareSession | null | undefined; projects: unknown[]; email?: string | null }): ShareStep {
  if (!session) return { kind: 'unavailable', reason: 'no-chat' }
  // a temporary chat can never join a project (the server answers 400 ephemeral_in_project)
  if (session.ephemeral) return { kind: 'unavailable', reason: 'temporary' }
  if (session.project_id != null) return { kind: 'open-members', projectId: String(session.project_id) }
  // only the author moves a chat; chats of other people only exist in a project, so this is a safety net
  if (session.owner_email && email && session.owner_email.toLowerCase() !== email.toLowerCase()) return { kind: 'unavailable', reason: 'foreign' }
  return projects.length > 0 ? { kind: 'choose-project' } : { kind: 'no-projects' }
}
