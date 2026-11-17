<!-- i18n: source=docs/user-guide.md source-hash=09fea3e23f8b5a5cf7784697a5605d5bf55cf47c status=current -->
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
   que iniciaste sesión y el engranaje que abre la Configuración.

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
pedido, por ejemplo "Crea una presentación de 6 diapositivas sobre ". Termina
la frase y envíala, o ajústala antes.

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
