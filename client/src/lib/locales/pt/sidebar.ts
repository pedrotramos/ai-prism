// Portuguese (pt-BR) UI catalog — sidebar: sidebar and history page.
// Namespaces owned by this file: sidebar.*, history.*.
// Same keys in pt/, en/ and es/; merged by ../index.ts (see ../catalogs.test.ts).
import type en from '../en/sidebar.ts'

// Typed against the EN catalog: a key missing here (or not in EN) is a type error.
const catalog: Record<keyof typeof en, string> = {
  // sidebar
  'sidebar.newChat': 'Nova conversa',
  'sidebar.home': 'Início (nova conversa)',
  'sidebar.history': 'Histórico',
  'sidebar.today': 'HOJE',
  'sidebar.yesterday': 'ONTEM',
  'sidebar.poweredBy': 'Powered by Databricks AI Gateway',
  'sidebar.expand': 'Expandir barra lateral',
  'sidebar.collapse': 'Colapsar barra lateral',
  'sidebar.empty': 'Nenhuma conversa ainda.',
  'sidebar.deleting': 'Excluindo…',
  'sidebar.rename': 'Renomear',
  'sidebar.search': 'Buscar conversas',
  'sidebar.costs': 'Custos',
  'sidebar.openSettings': 'Abrir configurações',
  'sidebar.close': 'Fechar barra lateral',
  'sidebar.navLabel': 'Conversas',
  'sidebar.drawerLabel': 'Navegação',
  'sidebar.emptyHint': 'Suas conversas aparecem aqui.',
  'sidebar.startFirst': 'Começar a primeira conversa',
  'sidebar.renameChat': 'Renomear “{title}”',
  'sidebar.deleteChat': 'Excluir “{title}”',
  'sidebar.account': 'Conectado como {email}',
  'sidebar.loading': 'Carregando conversas',
  'sidebar.temporary': 'Temporário',
  'sidebar.temporaryHint': 'Chat temporário: não é salvo e é apagado quando você sai',
  'sidebar.loadingConversation': 'Carregando conversa',

  // history page
  'history.back': 'Voltar para a conversa',
  'history.searchPlaceholder': 'Buscar por assunto (busca semântica)…',
  'history.selectAll': 'Selecionar tudo',
  'history.sortNewest': 'Mais novos',
  'history.sortOldest': 'Mais antigos',
  'history.deleteSelected': 'Excluir {n} selecionada',
  'history.deleteSelectedPlural': 'Excluir {n} selecionadas',
  'history.searching': 'Buscando…',
  'history.noResults': 'Nenhum chat relacionado encontrado.',
  'history.searchLabel': 'Buscar conversas',
  'history.clearSearch': 'Limpar busca',
  'history.selectRow': 'Selecionar “{title}”',
  'history.sortLabel': 'Ordenar conversas',
  'history.emptyTitle': 'Nenhuma conversa ainda',
  'history.emptyHint': 'Comece uma conversa e ela aparece aqui, pronta para ser buscada.',
  'history.noResultsHint': 'Tente outras palavras ou limpe a busca para ver todas as conversas.',

  // shell revamp
  'sidebar.spendMonth': 'Gasto em {month}',
  'sidebar.spendNote': 'Estimativa a preço de tabela',
  'sidebar.themeToLight': 'Mudar para o tema claro',
  'sidebar.themeToDark': 'Mudar para o tema escuro',
  'sidebar.spendError': 'Não foi possível carregar o gasto.',
  'sidebar.spendStale': 'Desatualizado.',
  'sidebar.spendRetry': 'Tentar de novo',
}

export default catalog
