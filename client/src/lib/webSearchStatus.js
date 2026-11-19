// Pure mapping from GET /api/admin/web-search/status (server/webSearch/index.js
// webSearchStatus) to the admin card's states (W2-11b). Counts and fixed codes
// only: the payload never carries a key value or a query, and nothing here
// reads anything but the documented fields.

const MCP_KINDS = new Set(['managed-mcp', 'external-mcp'])
const KEYED_KINDS = new Set(['brave', 'tavily'])

/**
 * One chain row → 'up' | 'unknown' | 'forbidden' | 'no_tool' | 'no_key' |
 * 'quota' | 'unavailable'.
 */
export function chainRowState(row) {
  if (!row) return 'unknown'
  if (KEYED_KINDS.has(row.kind) && row.keyPresent === false) return 'no_key'
  if (row.state === 'up') return 'up'
  if (row.state === 'down') {
    switch (row.code) {
      case 'forbidden':
        return 'forbidden'
      case 'quota':
        return 'quota'
      case 'unconfigured':
        return MCP_KINDS.has(row.kind) ? 'no_tool' : 'unavailable'
      default:
        return 'unavailable' // unavailable, timeout, bad_response, missing code
    }
  }
  return 'unknown'
}

/**
 * The card's overall state. `policyOn` is the org's `web-search` tool policy
 * (default on). → 'policy_off' | 'kill_switch' | 'backend_off' |
 * 'invalid_backend' | 'none_configured' | 'off' | 'on' | null (not loaded).
 */
export function overallState(status, policyOn = true) {
  if (!status) return null
  if (policyOn === false) return 'policy_off'
  const hasChain = Array.isArray(status.chain) && status.chain.length > 0
  if (status.enabled && hasChain) return 'on'
  if (status.offReason) return status.offReason
  // a backend without offReason: auto/list with nothing usable = nothing configured
  return status.mode === 'off' ? 'off' : 'none_configured'
}

/** The entry the next search tries first: the first row that is not down. */
export function activeRowIndex(chain) {
  if (!Array.isArray(chain)) return -1
  return chain.findIndex((r) => {
    const s = chainRowState(r)
    return s === 'up' || s === 'unknown'
  })
}

export function forbiddenLast24h(status) {
  const n = Number(status?.last24h?.byCode?.forbidden)
  return Number.isFinite(n) && n > 0 ? n : 0
}
