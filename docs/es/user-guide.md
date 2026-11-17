<!-- i18n: source=docs/user-guide.md source-hash=ef10f9fb7e7ffd7a9f07e7c27acee5a4a43a2016 status=current -->
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
