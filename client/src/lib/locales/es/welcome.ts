// Spanish UI catalog — welcome: welcome screen.
// Namespaces owned by this file: welcome.*.
// Same keys in pt/, en/ and es/; merged by ../index.ts (see ../catalogs.test.ts).
import type en from '../en/welcome.ts'

// Typed against the EN catalog: a key missing here (or not in EN) is a type error.
const catalog: Record<keyof typeof en, string> = {
  // welcome
  'welcome.lead': 'Pregunta sobre los datos a los que tienes acceso en el workspace, o pide un deck, un memo o una hoja de cálculo.',
  'welcome.greeting.morning': 'Buenos días. ¿Qué vamos a analizar?',
  'welcome.greeting.afternoon': 'Buenas tardes. ¿Qué vamos a analizar?',
  'welcome.greeting.evening': 'Buenas noches. ¿Qué vamos a analizar?',
  'welcome.greetingNamed.morning': 'Buenos días, {name}. ¿Qué vamos a analizar?',
  'welcome.greetingNamed.afternoon': 'Buenas tardes, {name}. ¿Qué vamos a analizar?',
  'welcome.greetingNamed.evening': 'Buenas noches, {name}. ¿Qué vamos a analizar?',
  'welcome.suggestionsLabel': 'Formas de empezar',
  'welcome.suggestion.data.title': 'Analizar datos',
  'welcome.suggestion.data.desc': 'Haz una pregunta sobre los datos a los que tienes acceso',
  'welcome.suggestion.data.prompt': 'Con los datos de la empresa, muéstrame ',
  'welcome.suggestion.artifact.title': 'Crear un artefacto',
  'welcome.suggestion.artifact.desc': 'Un deck, un documento o una hoja de cálculo, listos para editar',
  'welcome.suggestion.artifact.prompt': 'Crea una presentación de 5 diapositivas sobre ',
  'welcome.suggestion.docs.title': 'Buscar documentos',
  'welcome.suggestion.docs.desc': 'Encuentra respuestas en tus documentos y políticas',
  'welcome.suggestion.docs.prompt': '¿Qué dicen nuestros documentos sobre ',
  'welcome.project.title': 'Empezar dentro de un proyecto',
  'welcome.project.none': 'Sin proyecto',
  'welcome.project.noneHint': 'Conversación suelta',
  'welcome.project.hint': 'Usa las instrucciones y fuentes del proyecto',
  'welcome.project.trigger': 'Empezar en el proyecto: {name}',
  'welcome.project.list': 'Proyectos',
  'welcome.recents.heading': 'Continúa donde lo dejaste',
  'welcome.recents.label': 'Conversaciones recientes',
  'welcome.recents.today': 'Hoy',
  'welcome.recents.yesterday': 'Ayer',
  'welcome.recents.earlier': 'Antes',
}

export default catalog
