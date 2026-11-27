// A row store for the token vault that lives in memory: the tests' stand-in for server/db/a2a.ts (which runs every
// statement under the caller's identity and RLS; those are proven in server/a2a.rls.test.ts).
import type { TokenRow, TokenRowSummary, TokenStore } from '../a2aAuth.ts'

export function memoryTokenStore(): TokenStore & { rows: Map<string, TokenRow> } {
  const rows = new Map<string, TokenRow>()
  const k = (email: string, provider: string) => `${email.toLowerCase()}\n${provider}`
  return {
    rows,
    async get(email, _token, provider) {
      return rows.get(k(email, provider)) || null
    },
    async put(email, _token, provider, row) {
      rows.set(k(email, provider), row)
    },
    async updateIfMatches(email, _token, provider, expected, row) {
      const cur = rows.get(k(email, provider))
      if (!cur || cur.accessTokenEnc !== expected) return 0
      rows.set(k(email, provider), row)
      return 1
    },
    async remove(email, _token, provider) {
      rows.delete(k(email, provider))
    },
    async list(email) {
      const out: TokenRowSummary[] = []
      for (const [key, row] of rows) if (key.startsWith(`${email.toLowerCase()}\n`)) out.push({ ...row, providerId: key.split('\n')[1] as string })
      return out
    },
  }
}
