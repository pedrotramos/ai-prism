<!-- i18n: source=docs/user-guide.md source-hash=30a765e2513e4f0e12a8368c06c61ee35bd08e20 status=current -->
# Guía del usuario

[English](../user-guide.md) · [Português (Brasil)](../pt-BR/user-guide.md) · **Español**

Cómo orientarte en AI Prism. Cada sección cubre una parte de la pantalla; las
secciones del compositor, del chat y del shell de la app se suman junto a
esta.

## Shell

El shell es todo lo que rodea a una conversación: la barra superior, los
enlaces a una conversación, las notificaciones y lo que pasa cuando algo falla.

### La barra superior

La barra sobre la conversación tiene, de izquierda a derecha:

| Control | Qué hace |
|---|---|
| Menú (solo en el móvil) | Abre la lista de conversaciones. |
| Modelo | El modelo que responde en esta conversación. La lista muestra primero tres modelos **Recomendados**. **Más modelos** abre el resto del catálogo, agrupado por proveedor, con un cuadro de búsqueda. Un modelo marcado **Solo texto** no acepta imágenes (o **Imágenes**, cuando la mayor parte de tu catálogo es solo texto). |
| Tools | Las herramientas que el modelo puede llamar en esta conversación (Genie One, generación de imágenes, Genie Agents, funciones de Unity Catalog, índices de Vector Search, conexiones MCP). El número del icono es cuántas están activas. |
| Taxímetro | Cuánto gastaste este mes y, dentro de una conversación, cuánto lleva costado, a precio de lista. En el móvil solo se ve el icono del medidor; tócalo para ver las cifras. |
| Configuración | Preferencias, skills, conexiones MCP y, para los admins, la configuración de la organización. |

Los paneles de Modelo, Tools y Taxímetro se cierran con **Esc** o con un clic fuera, y el foco del
teclado vuelve al botón que los abrió. En la lista de modelos, las flechas del teclado pasan de un
modelo a otro. El panel de costos también se cierra al cambiar de conversación o al usar los
botones de atrás y adelante del navegador.

Las elecciones de modelo y de tools se guardan en la conversación: al reabrirla, vuelven.

### Enlaces a una conversación

Cada conversación tiene su propia dirección (`…/#/chat/<id>`), así que puedes guardarla en
favoritos o usar atrás y adelante del navegador. `…/#/history` abre la lista de todas las
conversaciones.

Si un enlace apunta a una conversación que no existe, se eliminó o no es tuya, AI Prism muestra
**Conversación no encontrada** y ofrece **Volver al historial** y **Nueva conversación**. Nunca abre
la conversación de otra persona: toda lectura se limita al usuario conectado.

### Cuando algo sale mal

**Un turno falla.** Si el modelo o el servicio no pueden responder (por ejemplo, el AI Gateway no
está disponible temporalmente), tu mensaje sigue en la conversación y aparece una tarjeta de error
en lugar de la respuesta. La tarjeta explica qué pasó con palabras sencillas y ofrece:

- **Reintentar**: vuelve a pedirlo. Si el servidor ya guardó tu mensaje, genera la respuesta que
  faltaba; si no, envía el mensaje otra vez con los mismos adjuntos.
- **Copiar prompt**: copia tu mensaje, por si prefieres reformularlo.
- **Detalles**: el mensaje exacto del servidor, útil para informar el problema a un admin.

La misma tarjeta aparece cuando **Regenerar** o **Generar respuesta** fallan. Cuando una
regeneración falla antes de que se guarde una respuesta nueva, la versión anterior se mantiene.

**Un mensaje no se puede mostrar.** Si un mensaje guardado está mal formado, solo ese mensaje se
sustituye por "No se pudo mostrar este mensaje." El resto de la conversación sigue funcionando.

**Algo rompe toda la página.** Aparece "Algo salió mal" con un botón **Recargar**. Tus
conversaciones están guardadas en el servidor, así que recargar no pierde nada de lo enviado.

**Notificaciones.** Los mensajes cortos aparecen en la esquina superior derecha y desaparecen solos
tras unos segundos (los errores duran un poco más). Apuntar a la notificación, o llevar el foco del
teclado a ella, la mantiene abierta para leer los **Detalles**. Los lectores de pantalla las
anuncian; los errores se anuncian de inmediato.

#### Qué significan los mensajes de error

| Mensaje | Causa habitual | Qué hacer |
|---|---|---|
| No se puede conectar con AI Prism | Tu red, VPN o proxy cortó la conexión. | Revisa la conexión y reintenta. |
| El servicio no está disponible temporalmente | El AI Gateway, el workspace o la base de datos no respondieron. | Reintenta en un momento. |
| Demasiadas solicitudes ahora | Un límite de tasa del endpoint del modelo o de AI Prism. | Espera unos segundos y reintenta. |
| Tu sesión expiró | El token de inicio de sesión del proxy de Databricks Apps expiró. | Recarga la página. |
| No tienes permiso para esto | A tu usuario le falta un grant (catálogo, Genie Agent, endpoint). | Pide acceso al admin del workspace. |
| Es demasiado grande para enviar | Un archivo o mensaje por encima del límite de subida. | Envía un archivo más pequeño o divídelo. |
| Tardó demasiado y se detuvo | Una llamada de modelo o tool alcanzó su tiempo límite. | Reintenta, o pide algo más pequeño. |
| Algo salió mal en el servidor | Un error inesperado del servidor. | Reintenta; si se repite, envía los **Detalles** a tu admin. |

## Navegación

### La barra lateral

La barra lateral de la izquierda reúne todo lo que necesitas para moverte por
la app, en este orden:

1. **Nueva conversación** abre una conversación vacía. El logo de AI Prism en
   la parte superior hace lo mismo.
2. **Buscar conversaciones** abre la página de Historial con el cuadro de
   búsqueda listo.
3. **Tus conversaciones**, de la más reciente a la más antigua, agrupadas en
   Hoy, Ayer, Últimos 7 días, Últimos 30 días y Más antiguas. Selecciona un
   título para abrirlo. Pasa el mouse sobre una fila, o llega a ella con el
   teclado, para ver **Renombrar** y **Eliminar**.
4. **Tu cuenta y la Configuración**, abajo a la izquierda: el correo con el
   que iniciaste sesión y el engranaje que abre la Configuración. En el
   teléfono es la forma de llegar a la Configuración: el engranaje cierra la
   barra lateral y la abre.

Mientras la lista carga ves filas grises del mismo tamaño, para que nada
salte cuando llegan las conversaciones. Si aún no tienes conversaciones, la
lista lo indica y ofrece **Empezar la primera conversación**.

### Barra lateral contraída

En una computadora, la flecha junto al logo contrae la barra lateral en un
riel angosto con las mismas acciones como íconos: expandir, Nueva
conversación, Buscar conversaciones, Configuración y tu cuenta. Pasa el mouse
sobre un ícono para ver su nombre. La elección se recuerda en este navegador.

### En el teléfono

En el teléfono la barra lateral está oculta. Ábrela con el botón de menú en la
esquina superior izquierda de la pantalla. Mientras está abierta:

- el resto de la pantalla se oscurece y no se puede usar;
- el teclado se queda dentro de la barra lateral (Tab y Shift+Tab la
  recorren);
- **Esc**, el botón de cerrar o un toque en el área oscurecida la cierran, y
  vuelves a donde estabas.

La fila de la conversación abierta muestra sus botones Renombrar y Eliminar.
Para renombrar o eliminar otras conversaciones, usa la página de Historial,
donde todas las filas los muestran.

### Historial

La página de Historial lista todas las conversaciones y te permite:

- **buscar por tema**: la búsqueda es semántica, así que encuentra una
  conversación por su tema, no solo por las palabras del título. Cada
  resultado muestra un porcentaje de coincidencia. **Esc** o el botón de
  borrar vacían la búsqueda;
- **ordenar** de la más reciente o de la más antigua;
- **seleccionar** conversaciones con las casillas (o **Seleccionar todo**) y
  eliminarlas juntas;
- **renombrar** o **eliminar** una conversación con los botones al final de su
  fila.

Cuando una búsqueda no encuentra nada, la página sugiere otras palabras y
ofrece **Borrar búsqueda**. Sin ninguna conversación, ofrece **Nueva
conversación**.

### Empezar una conversación

Una conversación nueva se abre con un saludo y algunas sugerencias para
empezar: hacer una pregunta a los datos de la empresa, crear una
presentación, armar una hoja de cálculo, redactar un documento, generar una
imagen y ayuda para escribir. La primera sugerencia se destaca como el punto
de partida más útil.

Elegir una sugerencia completa el cuadro de mensaje con el comienzo de un
pedido, por ejemplo "Crea una presentación de 6 diapositivas sobre ", y deja
el cursor al final. Termina la frase y envíala, o ajústala antes.

Solo aparecen las sugerencias que funcionan en esta instalación: la de datos
necesita una herramienta de datos (como Genie One) que el administrador
permita y que esté activada en el menú Herramientas; la de imagen necesita un
modelo de imagen y la herramienta de imagen.

### Idioma y tema

La interfaz está disponible en inglés, portugués de Brasil y español. Con el
idioma de la interfaz en **Predeterminado (navegador)** (Configuración,
Preferencias), AI Prism sigue el idioma del navegador. Si el navegador usa
cualquier otro idioma, la interfaz se muestra en inglés.

Cambiar entre los temas claro y oscuro hace que los colores cambien
suavemente en 200 ms. Si el sistema operativo está configurado para reducir
el movimiento, el cambio es instantáneo.

### Teclado

| Tecla | Dónde | Qué hace |
|---|---|---|
| Tab / Shift+Tab | en cualquier lugar | Pasa de un control a otro; un anillo de foco muestra dónde estás |
| Esc | barra lateral en el teléfono | Cierra la barra lateral |
| Esc | búsqueda del Historial | Borra la búsqueda |
| Esc | al renombrar una conversación | Cancela el cambio de nombre |
| Enter | al renombrar una conversación | Guarda el nuevo nombre |

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

## Chat: mensajes y respuestas

### Leer una respuesta mientras llega

- La respuesta aparece a medida que el modelo la escribe. Un cursor
  parpadeante indica que todavía está llegando texto.
- Cuando el modelo llama a una herramienta (Genie One, un agente de Genie, una
  función de Unity Catalog, un índice de vector search, Python, un servidor
  MCP), aparece un **chip de herramienta** en ese punto de la respuesta.
  Siempre muestra su estado:

  - **En ejecución**: un indicador giratorio y los segundos transcurridos.
  - **Completada**: una marca de verificación y cuánto tardó la llamada.
  - **Falló**: un signo de advertencia, cuánto tardó y la primera línea del
    error, para que veas qué salió mal sin abrir el chip.

  Haz clic en el chip para ver qué se preguntó (la pregunta, la consulta o el
  código) y qué se devolvió.
- **Pensando…** aparece solo cuando nada más indica que el turno sigue
  trabajando, por ejemplo mientras el modelo decide qué hacer con el resultado
  de una herramienta. Nunca aparece junto a un chip en ejecución.
- Si el modelo transmite su razonamiento, aparece en un panel
  **Razonamiento** encima de la respuesta. El panel queda abierto mientras el
  modelo razona y se contrae cuando empieza la respuesta. Haz clic para
  abrirlo o cerrarlo de nuevo.
- Los lectores de pantalla anuncian la respuesta cuando termina, no token a
  token.

### Código y tablas

- Los bloques de código muestran el lenguaje arriba a la izquierda.
  **Copiar** copia el código tal como está. El botón de ajuste de línea ajusta
  las líneas largas en lugar de desplazarlas hacia el lado; púlsalo de nuevo
  para volver.
- Las tablas se desplazan dentro de su propio marco y mantienen visible el
  encabezado mientras te desplazas. Con el teclado, llega a la tabla con Tab y
  usa las flechas.

### Gráficos

- Los colores de las series siguen el tema de la app y el design system que
  eligió tu organización. Cuando un gráfico compara dos series, como el
  trimestre anterior y el actual, la anterior es gris y la actual tiene color.
- **Ver datos** abre los números del gráfico como una tabla. El botón de
  descarga guarda el gráfico como PNG.
- Los lectores de pantalla leen el título del gráfico, sus series y el número
  de categorías.

### Archivos generados: presentaciones, hojas de cálculo y documentos

Cada archivo generado aparece como una tarjeta con el mismo diseño: un icono,
el título, una descripción breve (número de diapositivas, de pestañas, tipo de
documento) y las acciones. La acción principal abre el archivo en su estudio.
La tarjeta de hoja de cálculo también tiene **Descargar** para el archivo
`.xlsx`. La tarjeta de documento muestra el primer párrafo del documento.
Cuando el chat queda en una columna estrecha junto a un estudio abierto, las
acciones pasan debajo del título, para que el título siga legible.

### Cuando una respuesta se detiene antes o falla

- **El turno se detuvo antes** (el modelo repitió la misma llamada o alcanzó
  el límite de rondas de herramientas o de tiempo): una nota azul debajo de la
  respuesta explica el motivo. La respuesta de arriba usa los datos obtenidos
  hasta ahí. **Reintentar** genera la respuesta otra vez; para continuar desde
  donde se detuvo, envía un mensaje nuevo.
- **La respuesta llegó incompleta o falló** (se alcanzó el límite de salida o
  el AI Gateway devolvió un error): una nota roja explica qué pasó, con
  **Reintentar**.
- **No llegó ninguna respuesta**: la fila lo indica en lugar de quedarse vacía.
- **Una parte de la respuesta no se puede mostrar** (un gráfico, una tabla o
  una tarjeta de archivo con datos dañados): solo esa parte se convierte en una
  nota, "No se pudo mostrar esta parte del mensaje.", con **Detalles**. El resto de la respuesta se sigue mostrando.
- Copiar, Escuchar, Exportar PDF y Regenerar aparecen solo debajo de una
  respuesta terminada, con contenido, que no falló. Debajo de una respuesta que
  falló, aunque tenga parte del texto, **Reintentar** en la nota roja es la
  única acción; aún puedes seleccionar el texto y copiarlo a mano.

### Acciones de los mensajes

- Debajo de cada respuesta: **Copiar**, **Escuchar**, **Exportar PDF** y
  **Regenerar**. Si regeneraste una respuesta, las flechas cambian entre sus
  versiones.
- En tus propios mensajes, **Editar** y **Copiar mensaje** aparecen al pasar
  el ratón sobre el mensaje o al llevar el foco del teclado hasta él. En un
  teléfono o tableta, toca tu mensaje para mostrarlas y tócalo de nuevo para
  ocultarlas.
- Cada acción tiene un nombre que anuncian los lectores de pantalla y un área
  de al menos 32 × 32 px con ratón y 44 × 44 px en pantallas táctiles.
