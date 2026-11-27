// Tabs of the same browser profile keep one conversation list: when a turn ends in one
// tab, the others learn it over a BroadcastChannel and reload what they show. The channel
// carries no data, only "this conversation changed": each tab fetches the truth from the
// server, so nothing a tab shows can come from another tab's memory.
const CHANNEL = 'ai-prism:sessions'

export type CrossTabMessage = { kind: 'turn-ended'; id: string }

export interface CrossTab {
  post: (m: CrossTabMessage) => void
  close: () => void
}

interface ChannelLike {
  postMessage: (m: unknown) => void
  close: () => void
  onmessage: ((e: { data: unknown }) => void) | null
}

const isMessage = (d: unknown): d is CrossTabMessage => !!d && typeof d === 'object' && (d as CrossTabMessage).kind === 'turn-ended' && typeof (d as CrossTabMessage).id === 'string'

/** The channel of this app; a no-op where BroadcastChannel does not exist (old webviews, SSR). */
export function openCrossTab(onMessage: (m: CrossTabMessage) => void, make: ((name: string) => ChannelLike) | null = typeof BroadcastChannel === 'function' ? (n) => new BroadcastChannel(n) as unknown as ChannelLike : null): CrossTab {
  if (!make) return { post: () => {}, close: () => {} }
  const ch = make(CHANNEL)
  ch.onmessage = (e) => {
    if (isMessage(e.data)) onMessage(e.data)
  }
  return {
    post: (m) => {
      try {
        ch.postMessage(m)
      } catch {
        // a closed channel: nothing to tell
      }
    },
    close: () => ch.close(),
  }
}

export interface SyncState {
  currentId: string | number | null
  /** this tab is running a turn */
  streaming: boolean
  /** this tab is loading a conversation */
  loadingSession: boolean
}

/**
 * What a tab does on "a turn ended in conversation `id`": always refresh the list (title, order,
 * preview); reload the open conversation only when it is that one and this tab is not itself
 * mid-turn or mid-load (a reload then would drop the tokens it is receiving).
 */
export function planSync(m: CrossTabMessage, s: SyncState): { list: boolean; reload: boolean } {
  return { list: true, reload: s.currentId != null && String(s.currentId) === m.id && !s.streaming && !s.loadingSession }
}
