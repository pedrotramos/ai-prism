// Portuguese (pt-BR) UI catalog — welcome: welcome screen.
// Namespaces owned by this file: welcome.*.
// Same keys in pt/, en/ and es/; merged by ../index.ts (see ../catalogs.test.ts).
import type en from '../en/welcome.ts'

// Typed against the EN catalog: a key missing here (or not in EN) is a type error.
const catalog: Record<keyof typeof en, string> = {
  // welcome
  'welcome.lead': 'Pergunte sobre os dados a que você tem acesso no workspace, ou peça um deck, um memo ou uma planilha.',
  'welcome.greeting.morning': 'Bom dia. O que vamos analisar?',
  'welcome.greeting.afternoon': 'Boa tarde. O que vamos analisar?',
  'welcome.greeting.evening': 'Boa noite. O que vamos analisar?',
  'welcome.greetingNamed.morning': 'Bom dia, {name}. O que vamos analisar?',
  'welcome.greetingNamed.afternoon': 'Boa tarde, {name}. O que vamos analisar?',
  'welcome.greetingNamed.evening': 'Boa noite, {name}. O que vamos analisar?',
  'welcome.suggestionsLabel': 'Formas de começar',
  'welcome.suggestion.data.title': 'Analisar dados',
  'welcome.suggestion.data.desc': 'Faça uma pergunta sobre os dados a que você tem acesso',
  'welcome.suggestion.data.prompt': 'Usando os dados da empresa, me mostre ',
  'welcome.suggestion.artifact.title': 'Criar um artefato',
  'welcome.suggestion.artifact.desc': 'Um deck, um documento ou uma planilha, prontos para editar',
  'welcome.suggestion.artifact.prompt': 'Crie uma apresentação de 5 slides sobre ',
  'welcome.suggestion.docs.title': 'Pesquisar documentos',
  'welcome.suggestion.docs.desc': 'Encontre respostas nos seus documentos e políticas',
  'welcome.suggestion.docs.prompt': 'O que os nossos documentos dizem sobre ',
  'welcome.project.title': 'Começar dentro de um projeto',
  'welcome.project.none': 'Sem projeto',
  'welcome.project.noneHint': 'Conversa avulsa',
  'welcome.project.hint': 'Usa as instruções e fontes do projeto',
  'welcome.project.trigger': 'Começar no projeto: {name}',
  'welcome.project.list': 'Projetos',
  'welcome.recents.heading': 'Continue de onde parou',
  'welcome.recents.label': 'Conversas recentes',
  'welcome.recents.today': 'Hoje',
  'welcome.recents.yesterday': 'Ontem',
  'welcome.recents.earlier': 'Antes',
}

export default catalog
