// English UI catalog — mcpApps: MCP Apps (interactive apps that MCP tools provide inside the chat) and their admin switch.
// Namespaces owned by this file: mcpApps.*.
// Same keys in pt/, en/ and es/; merged by ../index.ts (see ../catalogs.test.ts).
export default {
  'mcpApps.open': 'Open app · {service}',
  'mcpApps.close': 'Close app',
  'mcpApps.label': 'Interactive app from {service}',
  'mcpApps.frameTitle': 'Interactive app from {service}',
  'mcpApps.domains': 'It may contact: {domains}',
  'mcpApps.noDomains': 'It cannot contact any outside site.',
  'mcpApps.limit': 'At most 3 apps can be open at once. Close one to open another.',
  'mcpApps.streaming': 'Available when the answer finishes',
  'mcpApps.loadFailed': 'The app could not be loaded.',
  'mcpApps.callTitle': 'Allow this app to run a tool?',
  'mcpApps.callBody': 'The app from {service} wants to run "{tool}" with the arguments below. It runs with your account.',
  'mcpApps.allow': 'Allow',
  'mcpApps.linkTitle': 'Open this link?',
  'mcpApps.linkBody': 'The app from {service} wants to open this address in a new tab:',
  'mcpApps.openLink': 'Open link',
  'mcpApps.admin.name': 'MCP Apps',
  'mcpApps.admin.desc': 'Show the interactive apps that MCP tools provide, inside the chat. An app runs in a sandbox with no access to this application, and every tool call an app makes asks the user first. Off by default.',
  'mcpApps.admin.envOff': 'Turned off by the operator (MCP_APPS_DISABLED), so this switch has no effect.',
  'mcpApps.admin.saveFailed': 'Could not save the MCP Apps setting.',
}
