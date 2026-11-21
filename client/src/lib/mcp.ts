// A friendly title from an MCP Service's fully-qualified name: the last segment
// (the service name) prettified — e.g. `system.ai.web_search` → "Web Search".
// Lists lead with name + description; the three-part name is shown small and
// muted, not as the headline. An admin-set display name always wins over this.
export const prettyMcpName = (fq: unknown): string =>
  (String(fq).split('.').pop() || String(fq))
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())

export const mcpTitle = (c: { displayName?: string | null; connectionName?: string | null } | null | undefined): string => c?.displayName || prettyMcpName(c?.connectionName || '')
