import Skeleton from './Skeleton.tsx'
import { useT } from '../lib/i18n.tsx'

// Shown while a session's history is being fetched — mimics the chat layout
// (user bubble on the right, assistant avatar + text lines on the left) so
// switching conversations reads as "loading" instead of looking frozen. The
// shapes are decorative; screen readers get one "Loading conversation" status.
export default function SessionSkeleton() {
  const t = useT()
  return (
    <div
      role="status"
      aria-label={t('sidebar.loadingConversation')}
      aria-busy="true"
      className="mx-auto w-full max-w-3xl px-8 py-8 space-y-6 animate-fade-in"
    >
      <UserTurn w="42%" />
      <AssistantTurn lines={['92%', '78%', '60%']} />
      <UserTurn w="30%" />
      <AssistantTurn lines={['85%', '45%']} />
    </div>
  )
}

function UserTurn({ w }: { w: string }) {
  return (
    <div className="flex justify-end">
      <Skeleton className="h-9" rounded="rounded-modal rounded-br-badge" /* data */ style={{ width: w }} />
    </div>
  )
}

function AssistantTurn({ lines }: { lines: string[] }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Skeleton className="shrink-0 w-7 h-7" rounded="rounded-control" />
        <Skeleton className="h-3 w-24" rounded="rounded-full" />
      </div>
      <div className="space-y-2.5">
        {lines.map((w, i) => (
          <Skeleton key={i} className="h-3" rounded="rounded-full" /* data */ style={{ width: w }} />
        ))}
      </div>
    </div>
  )
}
