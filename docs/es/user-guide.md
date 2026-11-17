<!-- i18n: source=docs/user-guide.md source-hash=97bbf4d36e0e20119207cc3250c264f3afe470f7 status=current -->
# Guía del usuario

[English](../user-guide.md) · [Português (Brasil)](../pt-BR/user-guide.md) · **Español**

Cómo orientarse en AI Prism. Cada sección cubre una parte de la pantalla; las
secciones del compositor, del chat y del shell de la app se añaden junto a
esta.

## Compositor

El compositor es el cuadro de mensaje en la parte inferior de cada
conversación. Escribe tu pedido, adjunta lo que el modelo debe leer y envía.

### Escribir y enviar

- **Enter** envía el mensaje. **Shift+Enter** inserta un salto de línea.
- El cuadro crece con el texto, hasta unas ocho líneas; después se desplaza.
- Tu mensaje aparece en la conversación en cuanto lo envías, antes de que
  empiece la respuesta.
- Mientras se escribe la respuesta, el botón Enviar pasa a ser **Detener**.
- Nada pide confirmación: el mensaje se envía y el comando se ejecuta al
  momento.

### Añadir archivos e imágenes

Selecciona **+** (a la izquierda del cuadro) para abrir un menú corto:

| Elemento | Qué hace |
|---|---|
| **Adjuntar documentos** | Elige documentos, hojas de cálculo, PDF o imágenes. Su texto se lee y se envía con el mensaje. |
| **Añadir imágenes** | Elige solo imágenes: capturas de pantalla, fotos, diagramas. Los modelos con visión las miran. |
| **Añadir audio o vídeo** | Solo aparece cuando el workspace transcribe medios. La grabación se convierte en texto antes de que el modelo la lea. |
| **Comandos** | Abre el menú de comandos (lo mismo que escribir `/`). |

También puedes **pegar** una captura de pantalla o un archivo copiado en el
cuadro, o **arrastrar y soltar** archivos sobre el compositor. Cada adjunto
aparece como un chip encima del cuadro; las imágenes muestran una miniatura.
Quita un adjunto con su botón **×**. Un mensaje admite hasta 10 adjuntos.

### Comandos

Escribe `/` al inicio del cuadro para abrir el menú de comandos. Sigue
escribiendo para filtrarlo. Cada comando tiene un nombre en cada idioma de la
interfaz y las tildes son opcionales: `/historico`, `/histórico`, `/history` y
`/historial` funcionan. Los espacios de más al final se ignoran.

| Comando (pt · en · es) | Qué hace |
|---|---|
| `/compactar` · `/compact` · `/compactar` | Resume la conversación hasta aquí para liberar contexto. El texto después del comando indica al resumen qué conservar, por ejemplo `/compactar conserva las cifras`. |
| `/contexto` · `/context` · `/contexto` | Muestra cuánto del contexto del modelo usa esta conversación. |
| `/nova` · `/new` · `/nueva` | Empieza una conversación nueva. |
| `/modelo` · `/model` · `/modelo` | Lista los modelos; elige uno para cambiar el de esta conversación. El texto después del comando filtra la lista, por ejemplo `/modelo sonnet`. |
| `/skills` | Abre tus skills en los Ajustes. |
| `/custo` · `/cost` · `/costo` | Muestra cuánto ha costado esta conversación. |
| `/historico` · `/history` · `/historial` | Abre el historial de conversaciones. |
| `/configuracoes` · `/settings` · `/ajustes` | Abre los Ajustes. |
| `/ajuda` · `/help` · `/ayuda` | Lista los comandos disponibles aquí y los atajos de teclado. |

El menú solo lista los comandos que funcionan en tu instalación. Un comando no
disponible, o cualquier otro texto que empiece con `/`, se envía al modelo
como un mensaje normal.

**Skills.** Tus skills activas también aparecen en el menú. Elegir una, o
escribir `/<nombre-de-la-skill>` antes del pedido, fija la skill en ese
mensaje. Aparece como un chip encima del cuadro, vale solo para el siguiente
mensaje y se puede quitar con su **×**.

### Voz

- El **micrófono** dicta en el cuadro, en el idioma de la interfaz.
  Selecciónalo de nuevo para parar.
- El botón de **onda sonora** abre el modo de voz, una conversación hablada
  con el modelo.

El dictado necesita un navegador con reconocimiento de voz, como Chrome o
Edge.

### Teclado y accesibilidad

| Tecla | Dónde | Acción |
|---|---|---|
| Enter | cuadro de mensaje | envía, o elige el comando resaltado |
| Shift+Enter | cuadro de mensaje | nueva línea |
| `/` | inicio del cuadro | abre el menú de comandos |
| ↑ / ↓ | menú de comandos | mueve el resaltado |
| Tab | menú de comandos | elige el comando resaltado |
| Esc | cualquier menú o la ayuda | lo cierra; el texto se queda |
| Enter, Espacio o ↓ | botón **+** | abre el menú en el primer elemento |
| ↑ / ↓, Inicio / Fin | menú **+** | se mueve entre los elementos |

El compositor funciona sin ratón. Los lectores de pantalla anuncian el cuadro
como un cuadro combinado: cuando `/` abre las sugerencias, leen cuántas hay y
leen la resaltada a medida que te mueves con las flechas. Shift+Enter sigue
insertando saltos de línea. Los botones miden al menos 44 px de alto en el móvil y 32 px
en pantallas más grandes. El elemento con el foco siempre muestra un contorno
visible.
