// Client side of conversation compaction (server/compaction.js).
// A compaction arrives as a message row with role 'compaction' (GET messages) or
// as the `compaction` object of POST /api/sessions/:id/compact. It is shown as a
// divider right after the message it is anchored at.

export const COMPACTION_ROLE = 'compaction'

export function compactionMarker(compaction) {
  return {
    id: `compaction-${compaction.id}`,
    role: COMPACTION_ROLE,
    content: compaction.content || '',
    blocks: null,
    tool_calls: null,
    compaction: {
      id: compaction.id,
      uptoMessageId: String(compaction.uptoMessageId),
      auto: !!compaction.auto,
      messages: compaction.messages ?? 0,
      tokensBefore: compaction.tokensBefore ?? null,
      tokensAfter: compaction.tokensAfter ?? null,
      instructions: compaction.instructions || '',
    },
    created_at: compaction.created_at || null,
  }
}

// Places the divider after its anchor (or at the end when the anchor isn't in view).
// Idempotent: a divider already in the list is left as it is.
export function insertCompactionDivider(messages, compaction) {
  const marker = compactionMarker(compaction)
  if (messages.some((m) => m.id === marker.id)) return messages
  const at = messages.findIndex((m) => String(m.id) === marker.compaction.uptoMessageId)
  if (at < 0) return [...messages, marker]
  return [...messages.slice(0, at + 1), marker, ...messages.slice(at + 1)]
}

// `/compactar` (optionally followed by instructions for the summary). Returns the
// instructions when the text is the command, or null for an ordinary message.
export function parseCompactCommand(text) {
  const m = /^\/compactar(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim())
  if (!m) return null
  return (m[1] || '').trim()
}
