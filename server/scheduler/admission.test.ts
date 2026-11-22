// admitAgentTools (W4-4b): which tools an unattended run may offer, re-checked against today's policy and catalog.
import test from 'node:test'
import assert from 'node:assert/strict'
import { admitAgentTools, admittedToolIdentifiers, parseTurnToolRefs, FIXED_TOOL_REFS } from './admission.ts'
import { AGENT_LIMITS } from '../agents/definition.ts'
import type { AgentToolRef } from '../agents/definition.ts'
import { TOOL_GROUP_KEYS } from '../tools.ts'

const catalog = new Map([
  ['acme.tools.ok', { credentialClass: 'databricks' }],
  ['acme.tools.slack', { credentialClass: 'per_user' }],
  ['acme.tools.shared', { credentialClass: 'shared' }],
  ['acme.tools.unverified', { credentialClass: 'unverified' }],
  ['acme.tools.unclassified', { credentialClass: null }],
])
const admit = (tools: AgentToolRef[], toolPolicy: unknown = {}) => admitAgentTools({ tools }, { toolPolicy, catalog })

test('every fixed tool of the definition maps to a ref the turn understands (the table, tested against the turn)', () => {
  const all = Object.keys(FIXED_TOOL_REFS) as AgentToolRef[]
  const r = admit(all)
  assert.ok(r.ok)
  assert.equal(r.turnToolRefs.length, all.length)
  const parsed = parseTurnToolRefs(r.turnToolRefs)
  assert.deepEqual(parsed.refs, [{ kind: 'genie-one' }])
  assert.deepEqual(parsed.caps, { deck: true, spreadsheet: true, document: true, image: true })
  assert.equal(parsed.webSearch, true)
  // the groups an admin can switch off are the turn's own policy keys (ToolsPicker / app_tool_policy)
  for (const { turn, group } of Object.values(FIXED_TOOL_REFS)) {
    if (group) assert.ok(TOOL_GROUP_KEYS.includes(group), `${group} is a policy group`)
    if (group && !turn.startsWith('artifact:')) assert.equal(turn, group, 'the picker kind is the group key')
  }
})

test('mcp: refs map to the picker\'s mcp-external refs, in order and without duplicates', () => {
  const r = admit(['mcp:acme.tools.ok', 'genie_one', 'mcp:acme.tools.ok'])
  assert.ok(r.ok)
  assert.deepEqual(r.turnToolRefs, ['mcp-external:acme.tools.ok', 'genie-one'])
  assert.deepEqual(parseTurnToolRefs(r.turnToolRefs).refs, [{ kind: 'mcp-external', connectionName: 'acme.tools.ok' }, { kind: 'genie-one' }])
})

test('AC7: per_user, shared, unverified and unclassified MCP are refused with mcp_class_refused', () => {
  for (const name of ['slack', 'shared', 'unverified', 'unclassified']) {
    const r = admit([`mcp:acme.tools.${name}`])
    assert.ok(!r.ok)
    assert.deepEqual(r.refused, [{ tool: `mcp:acme.tools.${name}`, code: 'mcp_class_refused' }])
  }
})

test('AC7: an mcp: service that left the catalog is refused with mcp_not_in_catalog', () => {
  const r = admit(['mcp:acme.tools.gone'])
  assert.ok(!r.ok)
  assert.deepEqual(r.refused, [{ tool: 'mcp:acme.tools.gone', code: 'mcp_not_in_catalog' }])
})

test('AC7: web_search is refused when the org policy has it off, and only then', () => {
  assert.ok(admit(['web_search'], { 'web-search': true }).ok)
  assert.ok(admit(['web_search'], {}).ok)
  const r = admit(['web_search'], { 'web-search': false })
  assert.ok(!r.ok)
  assert.deepEqual(r.refused, [{ tool: 'web_search', code: 'web_search_off' }])
})

test('another group the admin switched off is refused with tool_not_allowed; the rest of the list is still judged', () => {
  const r = admit(['generate_image', 'genie_one', 'mcp:acme.tools.ok', 'web_search'], { 'image-gen': false, 'genie-one': false, 'mcp-external': false })
  assert.ok(!r.ok)
  assert.deepEqual(r.refused, [
    { tool: 'generate_image', code: 'tool_not_allowed' },
    { tool: 'genie_one', code: 'tool_not_allowed' },
    { tool: 'mcp:acme.tools.ok', code: 'tool_not_allowed' },
  ])
})

test('an unknown kind is refused, never passed through', () => {
  const r = admit(['python' as AgentToolRef, 'mcp-external:acme.tools.ok' as AgentToolRef])
  assert.ok(!r.ok)
  assert.deepEqual(r.refused.map((x) => x.code), ['tool_not_allowed', 'tool_not_allowed'])
  assert.throws(() => parseTurnToolRefs(['python']), /tool_not_admitted/)
  assert.throws(() => parseTurnToolRefs(['mcp-external:']), /tool_not_admitted/)
})

test('an agent with no tools is admitted with no refs, and the limits are the definition\'s', () => {
  const r = admit([])
  assert.ok(r.ok)
  assert.deepEqual(r.turnToolRefs, [])
  assert.deepEqual(parseTurnToolRefs([]).caps, { deck: false, spreadsheet: false, document: false, image: false })
  assert.ok(AGENT_LIMITS.toolsMax >= 1)
})

test('fail closed: an unreadable policy (not an object) admits no gated tool, whatever is listed', () => {
  for (const policy of [undefined, null, 'x', 0]) {
    // direct call: `admit` would turn an undefined policy into its default {}
    const r = admitAgentTools({ tools: ['web_search', 'generate_image', 'genie_one', 'mcp:acme.tools.ok'] }, { toolPolicy: policy, catalog })
    assert.ok(!r.ok)
    assert.deepEqual(r.refused.map((x) => x.code), ['web_search_off', 'tool_not_allowed', 'tool_not_allowed', 'tool_not_allowed'])
  }
  // artifacts have no policy group: they do not depend on the policy read
  assert.ok(admitAgentTools({ tools: ['artifact:document'] }, { toolPolicy: undefined, catalog }).ok)
})

test('fail closed: no catalog refuses every MCP tool', () => {
  for (const cat of [undefined, null]) {
    const r = admitAgentTools({ tools: ['mcp:acme.tools.ok'] }, { toolPolicy: {}, catalog: cat })
    assert.ok(!r.ok)
    assert.deepEqual(r.refused, [{ tool: 'mcp:acme.tools.ok', code: 'mcp_not_in_catalog' }])
  }
})

test('admittedToolIdentifiers: the fixed tool names per kind plus mcp:<service>, nothing from remote metadata', () => {
  assert.deepEqual([...admittedToolIdentifiers({ tools: ['web_search', 'genie_one', 'artifact:deck', 'mcp:acme.tools.ok'] })].sort(), ['ask_genie_one', 'create_deck', 'mcp:acme.tools.ok', 'update_deck', 'web_fetch', 'web_search'])
  assert.deepEqual([...admittedToolIdentifiers({ tools: [] })], [])
})
