import Skeleton from './Skeleton.jsx'
import { useT } from '../lib/i18n.jsx'

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
      className="max-w-3xl mx-auto px-4 py-6 space-y-6 animate-fade-in"
    >
      <UserTurn w="42%" />
      <AssistantTurn lines={['92%', '78%', '60%']} />
      <UserTurn w="30%" />
      <AssistantTurn lines={['85%', '45%']} />
    </div>
  )
}

function UserTurn({ w }) {
  return (
    <div className="flex justify-end">
      <Skeleton className="h-9" rounded="rounded-2xl rounded-tr-md" /* data */ style={{ width: w }} />
    </div>
  )
}

function AssistantTurn({ lines }) {
  return (
    <div className="flex gap-3">
      <Skeleton className="shrink-0 mt-0.5 w-8 h-8" rounded="rounded-lg" />
      <div className="flex-1 space-y-2.5 pt-1">
        {lines.map((w, i) => (
          <Skeleton key={i} className="h-3" rounded="rounded-full" /* data */ style={{ width: w }} />
        ))}
      </div>
    </div>
  )
}
