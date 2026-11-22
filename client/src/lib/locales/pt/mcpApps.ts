// Catálogo de UI em português — mcpApps: MCP Apps (apps interativos que as tools MCP oferecem dentro do chat) e a chave do admin.
// Namespaces deste arquivo: mcpApps.*.
// As mesmas chaves em pt/, en/ e es/; mescladas por ../index.ts (ver ../catalogs.test.ts).
export default {
  'mcpApps.open': 'Abrir app · {service}',
  'mcpApps.close': 'Fechar app',
  'mcpApps.label': 'App interativo de {service}',
  'mcpApps.frameTitle': 'App interativo de {service}',
  'mcpApps.domains': 'Pode contatar: {domains}',
  'mcpApps.noDomains': 'Não pode contatar nenhum site externo.',
  'mcpApps.limit': 'No máximo 3 apps podem ficar abertos ao mesmo tempo. Feche um para abrir outro.',
  'mcpApps.streaming': 'Disponível quando a resposta terminar',
  'mcpApps.loadFailed': 'Não foi possível carregar o app.',
  'mcpApps.callTitle': 'Permitir que este app execute uma tool?',
  'mcpApps.callBody': 'O app de {service} quer executar "{tool}" com os argumentos abaixo. Ele roda com a sua conta.',
  'mcpApps.allow': 'Permitir',
  'mcpApps.linkTitle': 'Abrir este link?',
  'mcpApps.linkBody': 'O app de {service} quer abrir este endereço em uma nova aba:',
  'mcpApps.openLink': 'Abrir link',
  'mcpApps.admin.name': 'MCP Apps',
  'mcpApps.admin.desc': 'Mostra, dentro do chat, os apps interativos que as tools MCP oferecem. O app roda em um sandbox sem acesso a esta aplicação, e cada chamada de tool feita por ele pede confirmação ao usuário. Desligado por padrão.',
  'mcpApps.admin.envOff': 'Desligado pelo operador (MCP_APPS_DISABLED): esta chave não tem efeito.',
  'mcpApps.admin.saveFailed': 'Não foi possível salvar a configuração de MCP Apps.',
}
