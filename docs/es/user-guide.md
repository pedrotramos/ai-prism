[English](../user-guide.md) · [Português (Brasil)](../pt-BR/user-guide.md) · **Español**

# Guía del usuario de AI Prism

Esta guía cubre lo que rodea a una conversación: la barra superior, las notificaciones y lo que
pasa cuando algo falla. Las demás secciones (composer, mensajes, barra lateral) se añaden a medida
que se revisan esas partes de la interfaz.

## La barra superior

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

## Enlaces a una conversación

Cada conversación tiene su propia dirección (`…/#/chat/<id>`), así que puedes guardarla en
favoritos o usar atrás y adelante del navegador. `…/#/history` abre la lista de todas las
conversaciones.

Si un enlace apunta a una conversación que no existe, se eliminó o no es tuya, AI Prism muestra
**Conversación no encontrada** y ofrece **Volver al historial** y **Nueva conversación**. Nunca abre
la conversación de otra persona: toda lectura se limita al usuario conectado.

## Cuando algo sale mal

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

### Qué significan los mensajes de error

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
