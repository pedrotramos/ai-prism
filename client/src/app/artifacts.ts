// The artifact panel toggle in the chat's top bar reopens the chat's most recent artifact: the last deck,
// spreadsheet or document block, in message order (a later one wins).
type Id = string | number

export type ArtifactRef = { kind: 'deck' | 'spreadsheet' | 'document'; id: Id }

interface BlockLike {
  type?: string
  deckId?: Id | null
  spreadsheetId?: Id | null
  documentId?: Id | null
}

export function latestArtifact(messages: Array<{ blocks?: unknown[] | null }>): ArtifactRef | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = (messages[i]?.blocks ?? []) as BlockLike[]
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j]
      if (!b) continue
      if ((b.type === 'deck' || b.type === 'deck-html') && b.deckId) return { kind: 'deck', id: b.deckId }
      if (b.type === 'spreadsheet' && b.spreadsheetId) return { kind: 'spreadsheet', id: b.spreadsheetId }
      if (b.type === 'document' && b.documentId) return { kind: 'document', id: b.documentId }
    }
  }
  return null
}
