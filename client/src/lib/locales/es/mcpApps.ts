// Catálogo de UI en español — mcpApps: MCP Apps (apps interactivas que las tools MCP ofrecen dentro del chat) y su interruptor de admin.
// Namespaces de este archivo: mcpApps.*.
// Las mismas claves en pt/, en/ y es/; combinadas por ../index.ts (ver ../catalogs.test.ts).
export default {
  'mcpApps.open': 'Abrir app · {service}',
  'mcpApps.close': 'Cerrar app',
  'mcpApps.label': 'App interactiva de {service}',
  'mcpApps.frameTitle': 'App interactiva de {service}',
  'mcpApps.domains': 'Puede contactar: {domains}',
  'mcpApps.noDomains': 'No puede contactar ningún sitio externo.',
  'mcpApps.limit': 'Como máximo 3 apps pueden estar abiertas a la vez. Cierra una para abrir otra.',
  'mcpApps.streaming': 'Disponible cuando termine la respuesta',
  'mcpApps.loadFailed': 'No se pudo cargar la app.',
  'mcpApps.callTitle': '¿Permitir que esta app ejecute una tool?',
  'mcpApps.callBody': 'La app de {service} quiere ejecutar "{tool}" con los argumentos de abajo. Se ejecuta con tu cuenta.',
  'mcpApps.allow': 'Permitir',
  'mcpApps.linkTitle': '¿Abrir este enlace?',
  'mcpApps.linkBody': 'La app de {service} quiere abrir esta dirección en una pestaña nueva:',
  'mcpApps.openLink': 'Abrir enlace',
  'mcpApps.admin.name': 'MCP Apps',
  'mcpApps.admin.desc': 'Muestra, dentro del chat, las apps interactivas que ofrecen las tools MCP. La app se ejecuta en un sandbox sin acceso a esta aplicación y cada llamada a una tool que hace pide confirmación al usuario. Desactivado por defecto.',
  'mcpApps.admin.envOff': 'Desactivado por el operador (MCP_APPS_DISABLED): este interruptor no tiene efecto.',
  'mcpApps.admin.saveFailed': 'No se pudo guardar la configuración de MCP Apps.',
}
