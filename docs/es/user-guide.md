<!-- i18n: source=docs/user-guide.md source-hash=23297dc32d7d7a3dd960f1871eb058030e3647ec status=current -->
# Guía de usuario de AI Prism

[English](../user-guide.md) · [Português (Brasil)](../pt-BR/user-guide.md) · **Español**

Cómo usar AI Prism en el día a día. Cada sección cubre un área de la app.

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
