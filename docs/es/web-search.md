<!-- i18n: source=docs/web-search.md source-hash=685f84ef8a457ccc4e73f85212114a6a4178a1a8 status=machine -->
# Búsqueda y lectura de la web

[English](../web-search.md) · [Português (Brasil)](../pt-BR/web-search.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../web-search.md) es la referencia.

AI Prism ofrece dos tools nativas a los modelos:

- `web_search` encuentra páginas públicas y devuelve título, URL y snippet (o una
  respuesta sintetizada con sus fuentes).
- `web_fetch` abre una URL pública y devuelve su contenido real como texto
  legible. Es el único lector de páginas: un snippet de búsqueda nunca se trata
  como la página.

Las dos tools se ofrecen juntas, en cualquier turno, solo cuando al menos un
backend de búsqueda está disponible para el usuario que envía ese turno. Si no,
el modelo no ve ninguna de las dos y la respuesta no se ancla en la web,
exactamente como antes (presentaciones y documentos marcan entonces las cifras
no confirmadas como estimación).

## Cómo se elige el backend

`web_search` recorre una cadena ordenada y gana el primer backend que responde:

| Orden | Backend (valor de `WEB_SEARCH_BACKEND`) | Qué es | Identidad |
|---|---|---|---|
| 1 | `managed-mcp` | El MCP gestionado por Databricks `system.ai.web_search`, a través de Unity Gateway | el token del propio usuario |
| 2 | `external-mcp` | Un servidor MCP que el workspace registró como MCP Service en Unity Gateway, indicado en `WEB_SEARCH_MCP_SERVICE` | el token del propio usuario |
| 3 | `brave` | Brave Search API | clave en un secret de Apps |
| 4 | `tavily` | Tavily Search API | clave en un secret de Apps |
| 5 | `searxng` | Una instancia de SearXNG alojada por usted | ninguna |

Con el valor por defecto `WEB_SEARCH_BACKEND=auto`, se usa cada backend
configurado en este orden. El MCP gestionado solo se intenta donde de verdad
está disponible para el usuario (es un servicio Beta, habilitado por preview,
que no existe en todas las regiones ni nubes). Un deployment que no configura
nada, en un workspace sin el servicio gestionado, se comporta como si la
búsqueda web no existiera.

La disponibilidad se comprueba por usuario, porque los dos caminos MCP corren
con los grants del propio usuario en Unity Catalog. Un usuario sin `EXECUTE`
en un servicio simplemente lo salta; los demás no se ven afectados. La
comprobación es un listado de tools en caché que corre en segundo plano (cuando
la app carga y otra vez cuando el resultado en caché expira); un turno de chat
nunca la espera.

## Configuración

Elija una o más de las opciones siguientes. Todas van en `app.yaml` (el
`config.env` del bundle no llega a la app en ejecución). Vuelva a desplegar
después de un cambio.

### Opción 1: el MCP de búsqueda gestionado (nada que configurar en la app)

Donde su nube y región lo ofrecen, un account admin habilita la preview
*Enhanced Unity Gateway* (account console → Previews). Los account users tienen
`EXECUTE` en `system.ai.web_search` y `USE CATALOG system` /
`USE SCHEMA system.ai` por defecto. No hace falta nada más: `auto` ya lo
incluye. Devuelve una respuesta sintetizada con citas; el modelo que la genera
no es seleccionable y Databricks no publica precio.

No está disponible con HIPAA/BAA, para usuarios solo de consumer access, ni
cuando los controles de red desactivan el acceso a internet.

### Opción 2: un proveedor de búsqueda MCP externo (Firecrawl, You.com, Tavily, Exa…)

Úselo donde el servicio gestionado no existe (por ejemplo, hoy en Azure) o
cuando prefiera otro proveedor. La clave del proveedor vive en una connection
de Unity Catalog, nunca en la app.

1. **Registre el servidor** (admin del workspace o del metastore): Unity Gateway →
   MCPs → *Connect an existing MCP server*. Use el endpoint Streamable HTTP del
   proveedor y ponga su clave en la connection como bearer token. Ejemplos:

   | Proveedor | Endpoint a registrar | Tool de búsqueda |
   |---|---|---|
   | Firecrawl | `https://mcp.firecrawl.dev/v2/mcp-search` (solo búsqueda) | `firecrawl_search` |
   | You.com | `https://api.you.com/mcp` (o el listing del Marketplace) | `you-search` |
   | Tavily | `https://mcp.tavily.com/mcp/` | `tavily-search` |
   | Exa | `https://mcp.exa.ai/mcp?tools=web_search_exa` | `web_search_exa` |
   | Cualquier otro | un servidor Streamable HTTP de su confianza | defina `WEB_SEARCH_MCP_TOOL` |

2. **Restrinja el servicio a su tool de búsqueda.** Configure la selección de
   tools (`include_tool_selectors`) para exponer solo la tool de búsqueda, o
   registre el endpoint solo-de-búsqueda del proveedor. Así el grant que reciben
   sus usuarios vale una tool de búsqueda y nada más. Este paso es obligatorio.
3. **Conceda acceso** a los usuarios de la app: `EXECUTE` en el servicio y
   `USE CATALOG` y `USE SCHEMA` en su catálogo y schema. Los usuarios no
   necesitan `USE CONNECTION`.
4. **Apunte la app a él** en `app.yaml`:

   ```yaml
   - name: WEB_SEARCH_MCP_SERVICE
     value: 'my_catalog.my_schema.firecrawl_search'
   # optional, when the tool name is not one of the known ones above
   - name: WEB_SEARCH_MCP_TOOL
     value: 'firecrawl_search'
   ```

Cómo trata la app ese servicio:

- Llama a **una tool**: `WEB_SEARCH_MCP_TOOL`, si no un nombre de tool de
  búsqueda conocido, si no una tool cuyo nombre coincide con
  `web_search`/`web-search`. Si no encuentra ninguna, el backend aparece como
  "tool de búsqueda no identificada" y no se llama a nada.
- La app arma los argumentos solo con la consulta y el límite de resultados.
- Las descripciones e instrucciones de las tools del servidor nunca llegan al
  modelo.
- El servicio no aparece en el catálogo MCP y los usuarios no pueden
  conectarlo por su cuenta: un servicio con credencial compartida sigue
  rechazado en todo camino de conexión del usuario. Si un usuario ya lo tiene
  conectado (o `system.ai.web_search`), esa conexión se omite en los turnos en
  que se ofrece la tool nativa, para que el modelo nunca vea dos tools de
  búsqueda.
- Un servicio con login por usuario (OAuth U2M) no sirve para esta función: los
  usuarios sin consentimiento se tratan como no autorizados.

### Opción 3: una API de búsqueda con clave (último recurso)

Guarde la clave en un secret scope de Databricks, declárela como recurso
`secret` de la app y mapéela en `app.yaml` con `valueFrom` (vea los ejemplos
comentados en `databricks.yml` y `app.yaml`):

```yaml
- name: BRAVE_SEARCH_API_KEY
  valueFrom: 'web-search-key'
```

`TAVILY_API_KEY` funciona igual. `SEARXNG_URL` apunta a una instancia de
SearXNG alojada por usted con el formato JSON habilitado
(`/search?format=json`); una dirección privada se rechaza como cualquier URL
privada. Los caminos con clave necesitan salida desde la app hacia
`api.search.brave.com` o `api.tavily.com`; los caminos MCP no necesitan
ninguna desde la app (la llamada la hace el gateway).

### Todos los ajustes

| Variable | Por defecto | Significado |
|---|---|---|
| `WEB_SEARCH_DISABLED` | vacío | `1` desactiva las dos tools; gana sobre todo lo demás |
| `WEB_SEARCH_BACKEND` | `auto` | `auto`, `off`, un backend, o una lista ordenada separada por comas como `external-mcp,brave`. Un valor desconocido desactiva la búsqueda (falla cerrada) |
| `WEB_SEARCH_MCP_SERVICE` | vacío | MCP Service externo, `<catalogo>.<schema>.<servicio>`. El legado `WEB_SEARCH_CONNECTION` se lee como alias cuando tiene tres partes |
| `WEB_SEARCH_MCP_TOOL` | vacío | fija el nombre de la tool de búsqueda en el servicio externo |
| `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY` | vacío | fallback con clave, desde un secret de Apps |
| `WEB_SEARCH_COUNTRY`, `WEB_SEARCH_LANG` | vacío | valores por defecto de Brave |
| `SEARXNG_URL` | vacío | su instancia de SearXNG |
| `WEB_SEARCH_PRICE_PER_1K_USD` | vacío | precio por 1.000 búsquedas para todos los proveedores; prevalece sobre los precios integrados de Brave/Tavily/SearXNG y cede ante un precio fijado por el admin |
| `WEB_SEARCH_TIMEOUT_MS` / `WEB_SEARCH_MCP_TIMEOUT_MS` / `WEB_SEARCH_DEADLINE_MS` | `12000` / `20000` / `30000` | intento con clave / intento MCP / búsqueda completa |

El interruptor de toda la organización es la política de tool `web-search`
(pestaña Tools del admin): apagada, quita las dos tools para todos sin volver a
desplegar.

## Costos

Cada búsqueda respondida escribe una fila en el ledger de uso
(`kind = web_search`; la columna de modelo guarda el proveedor: `databricks`,
`firecrawl-mcp`, `you-mcp`, `tavily-mcp`, `exa-mcp`, `brave-mcp`, `mcp`,
`brave`, `tavily`, `searxng`). Los intentos fallidos no escriben nada, tampoco
un turno que el usuario canceló. Brave cuesta USD 5 y Tavily USD 8 por 1.000
búsquedas; SearXNG no cuesta nada. Los proveedores MCP no tienen precio
publicado, así que sus filas aparecen como "sin precio" hasta que un admin
defina uno (un override de precio para `tool:web_search:<proveedor>` o
`tool:web_search`, o `WEB_SEARCH_PRICE_PER_1K_USD`). El proveedor cobra en su
propio plan (Firecrawl, por ejemplo, cobra créditos por búsqueda); el gateway
también registra cada llamada MCP en `system.ai_gateway.usage`.

### El tile de costo y el editor de precios

El admin ve cuánto cuesta la búsqueda web en la página Costos (el tile **Búsqueda web**, debajo del
selector de período). Lee el registro de uso de la propia app, no las system tables, así que funciona
sin SQL warehouse y muestra llamadas y costo del período elegido: totales, llamadas por día, el reparto
por proveedor y los usuarios más activos. Los usuarios aparecen como un hash con clave (el mismo de la
página de auditoría), nunca como correo electrónico.

Las llamadas sin precio aparecen como **sin precio**, con una estimación al precio vigente. Bajo el tile,
**Precio por 1.000 llamadas** define el precio para todos los proveedores (`web_search`) o para un
proveedor visto en el período (`web_search:<proveedor>`), en USD de 0 a 1000; un campo vacío quita la
sobrescritura. El precio rige para las **próximas** llamadas: el costo de una fila del registro se fija
cuando se escribe, así que guardar un precio nunca reescribe el historial. Cada cambio queda en la
pista de auditoría del admin como `tool_price.set`. El mismo libro de precios está detrás de
`GET /api/admin/usage/tools?kind=web_search[&from=AAAA-MM-DD&to=AAAA-MM-DD]` (solo agregados) y de
`PUT /api/admin/tool-prices/:key` (cuerpo `{ "per1kUsd": 5 }`, o `null` para limpiar). Otra instancia en
ejecución toma el nuevo precio cuando se recarga la caché del catálogo de modelos (unos 30 s).

## Estado para el admin

`GET /api/admin/web-search/status` devuelve la cadena resuelta, una fila por
backend con su estado para el admin que llama (`up`, `down` con un código, o
`unknown`), el servicio y la tool en las filas MCP, si hay clave en las filas
con clave (nunca su valor) y los resultados de las últimas 24 horas.
`POST /api/admin/web-search/verify` recibe `{ "entry": <índice de la fila>, "kind": "<backend>" }`
y hace UNA búsqueda real en esa entrada de la cadena con una consulta fija, como
el admin, y devuelve solo conteos (como mucho una vez cada 10 s por admin y por
entrada; una entrada no válida o desactualizada es un 400, sin llamar al
proveedor). La tarjeta del admin en Configuración → Herramientas muestra las
filas con un botón Verificar en cada una.

| Código | Significado |
|---|---|
| `forbidden` | sin permiso o servicio inexistente (el gateway no los distingue); también una clave de proveedor inválida en la connection |
| `unconfigured` | no se identificó una tool de búsqueda, o la selección de tools la excluye |
| `quota` | límite de tasa o cuota del proveedor (HTTP 429) |
| `timeout` | el intento superó su límite de tiempo |
| `unavailable` | cualquier otro fallo |
| `bad_response` | el proveedor respondió en un formato inesperado |

## Privacidad y seguridad

- Cada consulta sale del workspace hacia el proveedor de búsqueda. La
  descripción de la tool le indica al modelo que nunca ponga datos internos,
  nombres de clientes ni contenido de adjuntos en una consulta; queda un riesgo
  residual. Se puede adjuntar al MCP Service una política de Sensitive Data
  Detection del gateway (Beta).
- Los resultados de búsqueda no son confiables. El resultado de la tool va
  dentro de un sobre fijo de "contenido externo, no confiable", y el texto de
  los resultados no puede cerrarlo.
- Los logs tienen una línea por intento (backend, proveedor, estado, código,
  duración), nunca la consulta, un resultado ni el texto de error del
  proveedor.
- El servicio gestionado no está disponible con HIPAA/BAA; en los demás
  proveedores, usted elige y contrata al proveedor y acepta sus términos.

## Lectura de páginas (`web_fetch`)

El lector acepta solo HTTP/HTTPS, resuelve y fija la dirección IP antes de
conectar, rechaza redes privadas, loopback y link-local, vuelve a comprobar cada
redirect y rechaza un redirect entre hosts cuando la petición lleva
credenciales. Cada página tiene timeout, límite de redirects, límite de descarga
y límite del texto devuelto al modelo. Se leen HTML, texto y JSON; los PDF, las
páginas detrás de un login o CAPTCHA y los sitios que solo se renderizan con
JavaScript devuelven un error explícito.

## Cómo desactivarlo

`WEB_SEARCH_DISABLED=1` en `app.yaml` y vuelva a desplegar, o apague la
política de tool `web-search` en la pestaña del admin (sin volver a desplegar).
