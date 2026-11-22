<!-- i18n: source=docs/mcp-apps.md source-hash=5187fdd2bfb8e2a1de3a91ae59d5d65bd0a54021 status=machine -->
# MCP Apps (apps interactivas en el chat)

[English](../mcp-apps.md) · [Português (Brasil)](../pt-BR/mcp-apps.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../mcp-apps.md) es la referencia.

Una tool MCP puede traer su propia interfaz. Cuando una tool que el modelo llamó declara un recurso de interfaz
(`_meta.ui.resourceUri`, la extensión MCP Apps, SEP-1865), AI Prism muestra un marcador bajo la respuesta. Abrirlo
carga la **View** de la propia tool (una pequeña app en HTML) en un marco aislado, junto a la conversación.

La funcionalidad viene **desactivada**. Esta página explica qué puede y qué no puede hacer una View, porque eso es lo que
decide el administrador al activarla.

## Cómo activarla

1. Un administrador activa **MCP Apps** en Configuración → Tools (el ajuste `mcp_apps_enabled`, auditado como
   `mcp_apps.settings`).
2. Para mantenerla desactivada definitivamente, el operador define `MCP_APPS_DISABLED=1` en el entorno de la app. Ese interruptor
   prevalece sobre el ajuste.

Mientras está desactivada: la app no anuncia la capacidad a los servidores MCP, no se captura nada, las rutas responden
`404 mcp_apps_disabled` y no aparece ningún marcador. La reversión es el camino inverso: desactivar el ajuste, luego
definir `MCP_APPS_DISABLED=1` y, si hace falta, desplegar la versión anterior (la columna se conserva; la migración de
bajada solo la elimina).

## Qué ocurre

1. Con la funcionalidad activada, la app indica a cada servicio MCP al que se conecta que sabe mostrar recursos de interfaz
   (`extensions["io.modelcontextprotocol/ui"].mimeTypes = ["text/html;profile=mcp-app"]`).
2. Después de que el modelo llama a una tool que declara un recurso `ui://`, la app lee ese recurso una vez, con la misma URL
   y el mismo token del usuario, y lo guarda con la llamada. Solo se acepta el **tipo MIME `text/html;profile=mcp-app`**, hasta
   **1 MiB**, como máximo **4 apps por respuesta**, y nunca en una ejecución sin supervisión (un agente programado).
3. Si la lectura falla (tipo incorrecto, demasiado grande, lenta, inexistente), la respuesta conserva el resultado simple de la
   tool y el código del motivo se registra en el log. No se guarda nada.
4. El chat muestra **Abrir app · servicio** con los dominios que la app puede contactar. Mientras la respuesta aún se está
   generando, el botón está desactivado ("Disponible cuando termine la respuesta").
5. Abrirlo carga la View. Como máximo hay **3 Views** activas en una página.

Una tool cuya `visibility` no incluye `model` (una tool **solo para la app**) nunca se ofrece al modelo.

## Qué puede y qué no puede hacer una View

| | |
|---|---|
| Se ejecuta en | un `<iframe sandbox="allow-scripts allow-forms">`: un **origen opaco**, nunca `allow-same-origin` |
| La sirve | `GET /api/mcp-apps/view/:toolCallId`, solo para un iframe (`Sec-Fetch-Dest: iframe`, si no 400), con una CSP **propia** en lugar de la de la app |
| Alcanza | solo los orígenes que el servidor declaró (`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`), una vez filtrados |
| No alcanza | la página ni el DOM de esta app, sus cookies, el almacenamiento ni la API (`/api/...`), el host del workspace, ningún host de Databricks |
| Puede pedir al host | llamar a una tool del **mismo servicio** (el usuario confirma, con los argumentos completos), poner texto en el compositor (nunca se envía), abrir un enlace https (el usuario confirma), cambiar de tamaño (80 a 640 px) |
| No puede | pantalla completa, ventanas emergentes, navegar la página, usar cámara, micrófono o ubicación, leer recursos, pedir muestreo, descargar archivos |

La CSP de una View empieza con `sandbox allow-scripts allow-forms; default-src 'none'`, nunca contiene `'self'` (salvo en
`frame-ancestors`, para que esta app pueda enmarcarla) ni `'unsafe-eval'`. Las listas declaradas se filtran: solo
`https://host[:puerto]` y `https://*.host`, como máximo 32 por directiva, y la política resultante tiene como máximo 4096 caracteres (una más larga se rechaza: el App no se captura, código `csp_too_long`; un registro guardado por encima del límite no se sirve); se descartan el host de esta
app, el host del workspace, cualquier host `databricksapps.com` o de Databricks, las IP literales, otros esquemas, comillas,
punto y coma y rutas.

### Las llamadas a tools de una View

Una View puede llamar a una tool mediante `POST /api/mcp-apps/:toolCallId/tools/call`. La llamada pasa por las mismas reglas
que una llamada del modelo:

- el token de **quien la pide** (un miembro del proyecto que abre el App de otra persona se ejecuta con su propia identidad);
- la clase de credencial del servicio (los servicios `shared` y los no verificados se rechazan);
- la política de tools de la organización y el catálogo MCP (un servicio oculto o un grupo desactivado se rechaza);
- solo una tool que el servidor marcó como invocable por una app, en el servicio de donde vino el App (si no, 403 con un código);
- tiempo límite de 20 s, resultado de hasta 1 MiB, 60 llamadas por minuto por usuario;
- un cuadro de confirmación en la app (no en el marco) con el servicio, la tool y los **argumentos completos**; más de 16 KiB
  de argumentos se rechaza, nunca se trunca.

La llamada no se guarda. Solo se registran códigos en el log.

## Quién puede abrir un App

El dueño del chat y, en un chat de proyecto, todos los miembros del proyecto (la misma regla que para leer el chat). Cualquier
otra persona recibe `404`, idéntico al de un id que no existe. El HTML guardado es una instantánea de lo que se mostró en el
momento de la llamada; se elimina junto con el chat (y por la retención). La respuesta de sesiones nunca lleva el HTML.

## Límites

| Límite | Valor |
|---|---|
| Tamaño del recurso | 1 MiB (la base de datos también comprueba 1.400.000 bytes) |
| Apps por respuesta | 4 |
| Views activas por página | 3 |
| Fuentes por directiva de la CSP | 32; la política emitida, como máximo 4096 caracteres (más larga: rechazada, nunca acortada) |
| Argumentos de la llamada a una tool de una View | 16 KiB en la app, 64 KiB en el servidor |
| Tiempo límite / resultado / tasa de la llamada a una tool | 20 s / 1 MiB / 60 por minuto por usuario |
| Altura del marco | 80 a 640 px |

## Notas de operación

- La migración `0016_tool_call_ui_resource` añade `chat_tool_calls.ui_resource` (jsonb, nulo en toda llamada anterior). La
  bajada elimina la columna y los Apps ya mostrados no pueden volver a abrirse.
- El cliente usa `@modelcontextprotocol/ext-apps` **1.7.5**, fijado exactamente (ADR-0019). Solo se carga cuando se abre una
  View y nunca entra en el bundle del servidor.
- Una View no puede usar cookies ni almacenamiento (el origen es opaco); una View bien hecha lo comprueba.
- Aún falta probar en un despliegue si el Unity AI Gateway reenvía la capacidad `extensions`, el `_meta` de las tools y
  `resources/read`, y si el proxy de Apps deja intactas las cabeceras de la View (abajo). Si el gateway no los reenvía, la
  funcionalidad queda desactivada y nada más cambia.

## Verificación real pendiente (G-live)

Aún no ejecutada; es un despliegue y necesita autorización:

1. Registrar un servidor MCP App de prueba como servicio MCP de Unity Catalog.
2. Registrar si el Unity AI Gateway reenvía la capacidad `extensions`, el `_meta` de las tools y `resources/read`.
3. Registrar que el navegador recibe la CSP y el `X-Frame-Options` de esta app para la View sin modificar a través del proxy de Apps.
4. Si el gateway no los reenvía, la funcionalidad se entrega desactivada, con el hallazgo documentado.
