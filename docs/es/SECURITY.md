<!-- i18n: source=SECURITY.md source-hash=065894b21ccb01e185d5e94adcec382f3636b2e1 status=machine -->
# Política de seguridad

[English](../../SECURITY.md) · [Português (Brasil)](../pt-BR/SECURITY.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../../SECURITY.md) es la referencia.

AI Prism es un acelerador de soluciones de código abierto que despliegas en **tu propio** workspace de Databricks. No es un producto oficial de Databricks y no tiene SLA. Aun así, tomamos las vulnerabilidades en serio. Este documento explica cómo reportarlas.

## Reportar una vulnerabilidad

**No abras un issue público** para reportar una vulnerabilidad de seguridad.

Usa en cambio el canal privado de GitHub:

1. Abre la pestaña **Security** del repositorio.
2. Haz clic en **Report a vulnerability** (GitHub Security Advisories).

Si lo prefieres, abre un issue mínimo **sin detalles técnicos** en el que pidas un canal de contacto privado. La respuesta llegará por ese canal.

Incluye lo siguiente en tu reporte, siempre que sea posible:

- Una descripción de la vulnerabilidad y de su impacto potencial.
- Pasos para reproducirla (prueba de concepto).
- Versiones y entorno afectados (nube, versión de la CLI de Databricks, commit).
- Cualquier mitigación que ya hayas identificado.

Haremos lo posible por confirmar la recepción en unos pocos días hábiles y por mantenerte informado del avance hasta que el problema se resuelva.

## Alcance

Cada instalación se ejecuta en el workspace del equipo que la despliega, así que ten en cuenta el modelo de confianza del proyecto:

- **El aislamiento entre usuarios se aplica en el nivel de la aplicación** (cláusulas `WHERE user_email`), sobre una identidad que entrega el proxy de Apps de Databricks. Los reportes de fallas en ese aislamiento (un usuario que accede a los datos de otro) son especialmente bienvenidos.
- La autenticación usa **OBO (on-behalf-of) del usuario** para las llamadas a la API, y el **service principal de la app** para su propio almacenamiento (Lakebase, el Volume de imágenes).
- Los secretos (tokens del workspace, credenciales de Lakebase) **nunca** deben subirse al repositorio. Consulta el [`.env.example`](../../.env.example) y el [`.gitignore`](../../.gitignore). `.env` está ignorado.

## Identidad de la solicitud

La identidad del usuario llega solo desde el proxy de Databricks Apps (`server/requestIdentity.ts`):

- En el runtime de Apps (cuando hay definida `DATABRICKS_APP_NAME`, `DATABRICKS_APP_PORT` o `DATABRICKS_APP_URL`), la solicitud debe traer los headers `x-forwarded-email` y `x-forwarded-access-token`. Si falta cualquiera de los dos, la respuesta es **401**. En ese caso, ningún correo ni token sale del entorno.
- Fuera del runtime, el entorno solo se usa con `LOCAL_DEV_MODE=1` (el `.env.local` de `npm run dev:local`) o con `LOCAL_DEV_IDENTITY=1`. `NODE_ENV` no cuenta: npm lo define como `production` en los scripts del repo. En este modo el servidor escucha solo en `127.0.0.1` (`listenHost()`): una solicitud sin headers se convierte en el dueño de la app, así que el puerto no queda expuesto en la red local. En el runtime de Apps escucha en `0.0.0.0`.

### Vínculo entre correo y token (`server/identityBinding.ts`)

El correo del header delimita todas las consultas, y Lakebase se conecta como el service principal de la app, no como el usuario. Sin un vínculo, una solicitud que llegara al proceso sin pasar por el proxy, con `x-forwarded-email: <cualquier persona>` y cualquier token, se haría pasar por esa persona (incluido el dueño o un admin). Por eso, en cada solicitud autenticada, la app le pregunta al workspace de quién es el token (`SCIM /Me` con el propio token, la misma llamada que `server/authz.ts` usa para los grupos; el scope `iam.current-user:read` se concede automáticamente al token OBO):

- El correo del header debe ser igual al `userName` **o** a cualquier `emails[].value` del dueño del token (comparación sin distinguir mayúsculas y minúsculas). Basta con una coincidencia: un `userName` que no es un correo (un usuario externo, como `nome_dominio#EXT#@tenant…`, o un login que no es un correo) pasa si el correo está en `emails`. Solo cuando ninguno coincide la respuesta es **401** `{"code":"identity_mismatch"}`. Ningún otro campo cuenta: el `applicationId` de un service principal no prueba la posesión de un correo, y un `/Me` sin `userName` ni `emails` (token de service principal) da `identity_mismatch` en `enforce`. Si la app debe atender llamadas de service principal a través del proxy, usa `warn` y revisa en los logs qué reenvía el proxy hacia ellas. Un token que el workspace rechaza (401, o 403 "Invalid access token") da **401** `{"code":"invalid_token"}`.
- Un resultado definitivo se guarda en caché durante 5 min (uno sin verificar, como un timeout o un 5xx, durante 30 s), indexado por el `sha256` del token (nunca el token en texto plano), en un LRU acotado. Las solicitudes simultáneas con el mismo token hacen una sola consulta.
- **Primero la disponibilidad:** si el workspace no responde de forma definitiva (timeout de 3 s, 5xx, 403 por un scope faltante, `DATABRICKS_HOST` sin definir), la solicitud pasa y el log registra `identity-binding: could not verify…` como máximo una vez por minuto. Solo una respuesta definitiva bloquea.

| `IDENTITY_BINDING` | Efecto |
|---|---|
| (sin definir) | `enforce` en el runtime de Apps; `off` en desarrollo local |
| `enforce` | Divergencia o token inválido → 401 |
| `warn` | Divergencia o token inválido **no se rechaza**: solo genera un log (`identity-binding: identity_mismatch: …` o `identity-binding: invalid_token: …`) y la solicitud pasa. Es el **rollback seguro** si un workspace se comporta de forma inesperada (por ejemplo, usuarios legítimos que reciben 401) |
| `off` | Desactiva la verificación (el comportamiento anterior; ninguna consulta al workspace) |

Defínelo en el `env` de `app.yaml` (el `config.env` de `databricks.yml` no llega a la app). Un valor inválido cae en el valor por defecto (`enforce` en el runtime): un error de tipeo nunca desactiva la verificación.

**Primer deploy (o primer deploy en un workspace nuevo):** después de abrir la app con algunos usuarios reales, busca en los logs (`databricks apps logs <app> -p <PROFILE>`) las ocurrencias de `identity_mismatch` e `invalid_token`. Si no hay ocurrencias inesperadas, mantén `enforce`. Si usuarios legítimos reciben 401, define `IDENTITY_BINDING=warn` en el `env` de `app.yaml`, haz el deploy y recopila las líneas `identity-binding:` (no traen correo ni token). Vuelve a `enforce` cuando la causa esté resuelta. Usa `off` solo si `warn` no basta.

**Qué verifica esto y qué sigue dependiendo del proxy.** La app verifica que el par correo/token fue emitido por el workspace para la misma persona. Sigue dependiendo de la plataforma que el proxy autentique al usuario y sea el único camino hacia el proceso, y que sobrescriba (no reenvíe) los `x-forwarded-*` del cliente. Quien roba un token válido de otra persona sigue actuando como ella: ese es el modelo de cualquier bearer token.

## Protecciones HTTP

| Protección | Dónde | Qué bloquea |
|---|---|---|
| **CSRF** | `server/csrfGuard.ts`, en `/api/*` antes de parsear el cuerpo | `POST`/`PUT`/`PATCH`/`DELETE` que vienen de otro sitio: pasa con `Sec-Fetch-Site` `same-origin` o `none`, o con `Origin` (o, sin él, `Referer`) cuyo host es el de la solicitud (`Host` o `X-Forwarded-Host`) o el de `DATABRICKS_APP_URL`. La comparación cubre el esquema, el host y el puerto, con el puerto por defecto explícito (`:443` en https, `:80` en http). Otro puerto, o el mismo host y puerto con el otro esquema, es otro origen. Una solicitud sin ninguno de los tres headers (curl, scripts, `npm run smoke`) pasa, porque no viene de un navegador. Todo lo demás recibe **403** `{"code":"cross_site_request"}`. Motivo: `/api/chat` acepta `multipart/form-data`, que un `<form>` de otro sitio puede enviar sin preflight |
| **Headers** | `server/securityHeaders.ts` | `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: SAMEORIGIN`, sin `X-Powered-By`, y una CSP conservadora: `frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'` |
| **Ids numéricos** | `app.param(['id','messageId'])` | Un id fuera de `^\d{1,18}$` omite la ruta y termina en 404. Sin esta comprobación llegaría a Postgres y volvería como 500 con el mensaje del driver |
| **Error final** | `finalErrorHandler` (último middleware) | Un error que ninguna ruta manejó (JSON mal formado, cuerpo o upload demasiado grande, una excepción) se convierte en una respuesta JSON genérica (`bad_request` 400, `payload_too_large` 413, `internal_error` 500). El detalle solo va al log. Las rutas que ya manejan sus propios errores no cambiaron |

**Por qué la CSP no restringe scripts, estilos ni imágenes.** Los iframes `srcdoc` heredan la CSP de la página. El editor de slides inyecta un `<script>` en línea en el iframe, y el design system importado trae scripts en línea, estilos y fuentes o imágenes de cualquier host. Una restricción de `script-src`, `style-src`, `img-src` o `font-src` rompería la vista previa y la edición de los decks. Lo comprobamos en Chrome contra la SPA compilada: con la CSP de arriba no hay ninguna violación, y el script en línea, el estilo en línea y las fuentes funcionan en iframes `srcdoc` tanto con como sin sandbox. Para endurecer la CSP primero hay que servir esos iframes desde un origen propio. HSTS y TLS quedan a cargo del proxy de Apps.

**Depende del proxy:** no verificamos el `SameSite` de la cookie de sesión de Apps, ni si el proxy agrega sus propios headers de seguridad. El guard de CSRF no depende de esto: rechaza la solicitud cross-site aunque la cookie viaje con ella.

## Aislamiento entre usuarios

Todas las conexiones a Postgres usan la misma identidad (el service principal de la app, o el usuario local en desarrollo). Por eso, cada lectura **y cada escritura** debe filtrar por dueño en su propio SQL: `chat_sessions.user_email` y, para todo lo que pertenece a una sesión (mensajes, llamadas a tools, embeddings, artefactos, la conversación de Genie), un `EXISTS` sobre la sesión de quien llama. Un id numérico enumerable (BIGSERIAL) no puede bastar por sí solo.

Lo que esta versión reforzó:

- **Las escrituras por id** que antes confiaban en una comprobación previa ahora vuelven a verificar el dueño en la misma instrucción (`server/ownerScopedWrites.ts`): la reactivación de variantes (el `variant_group` viene del cliente), los embeddings de mensajes, las llamadas a tools, la conversación de Genie (lectura y escritura), el embedding de skills y la creación de decks, planillas, documentos e imágenes (una sesión de otra persona da 404).
- **Pruebas de dos usuarios** en `server/isolation.test.js`, contra las funciones reales de `db.js`: sesiones, mensajes, variantes, llamadas a tools, embeddings y búsqueda semántica, artefactos, conexiones MCP, skills, Genie y costos. La suite se ejecuta con `node --test server/isolation.test.js` contra el Postgres de `npm run local:up`, y se omite si esa base no está disponible. Falla con el código anterior a estos cambios (variantes, llamadas a tools, embeddings, artefactos, skills y Genie).
- **Escrituras que dependen de la ruta** (sin verificación de dueño en el SQL): `upsertSkill`, `deleteSkill`, `updateDeckTemplate`, `deleteDeckTemplate` y `setDeckTemplateScope` reciben un flag de admin desde quien llama y están protegidas por las rutas (`requireAdmin` / `isAdmin`). `getUsageStats` (auditoría de costos de todos los usuarios) no filtra por dueño por diseño, así que solo puede exponerse detrás de `requireAdmin`. Hoy ninguna ruta lo usa.

## Contenido de terceros en el prompt

El texto que la app no escribe y que va al modelo (descripciones, instrucciones y schemas de tools MCP, títulos y descripciones de Genie Agents, comentarios de funciones de Unity Catalog, títulos de documentos) pasa por `server/toolMetadata.ts`. Los imperativos ("ignora las instrucciones"), las etiquetas de rol ("system:"), el HTML y los links se neutralizan, y el texto tiene un tamaño máximo. Esta es una defensa parcial contra la inyección de prompts, no una garantía: el modelo aún puede verse influido por texto que no coincide con estos patrones. Por eso, los datos de una tool no deben tratarse como una instrucción confiable.

Los documentos Markdown se guardan sin HTML crudo y sin links con un esquema peligroso (`shared/markdownSafety.js`). El editor WYSIWYG renderiza con `innerHTML`, así que esto impide que un miembro de un proyecto ejecute código en el editor de otro miembro.

### HTML de design system (miniaturas de modelo)

Un design system (DS) es HTML y CSS que viene de afuera (un bundle de agencia, un export de Figma, un zip), y un DS **global** aparece para todos los usuarios en la pantalla de Modelos. Por eso, la miniatura del primer slide tiene dos capas:

- **Un iframe que siempre tiene `sandbox`** (`client/src/components/DeckTemplatesSettings.jsx`). Sin el atributo, un documento `srcdoc` se ejecuta con el origen de la propia app y podría llamar a `/api/sessions` como la persona que está viendo la pantalla (leer los chats de esa persona). Ahora la miniatura usa `sandbox=""` (sin scripts), y el inspector de DS usa `sandbox="allow-scripts"` sin `allow-same-origin` (origen opaco, sin acceso a la API).
- **HTML sanitizado en el servidor** (`server/sanitizeDsHtml.ts`, aplicado por `extractFirstTemplateSlide` en `server/db.ts` al leer, así que también vale para los DS que ya estaban guardados), con la biblioteca `sanitize-html` y una allowlist pensada para slides: estructura, texto, listas, tablas, `img`, dibujo `svg` y bloques `<style>`. Quedan fuera `script`, los atributos `on*`, `iframe`, `object`, `embed`, `base`, `meta`, `form` y `foreignObject`. URLs: se permiten `http`, `https`, `mailto` y las relativas. `data:` solo se permite en `<img>` y solo como `data:image/*`. `<use>` solo puede apuntar a un `#fragmento`. Las pruebas están en `server/sanitizeDsHtml.test.ts`.
- **CSS sin recursos de otros hosts** (`stripRemoteCssUrls`, en el mismo archivo). El sandbox bloquea los scripts, pero no impide que el CSS descargue archivos. Esto aplica a los bloques `<style>`, a los atributos `style` y a los atributos de pintura de SVG (`fill`, `stroke`, `clip-path`, `mask`, `filter`, `marker-*`). El CSS primero se **normaliza**: cada comentario `/* */` fuera de cadenas se convierte en un espacio (separa tokens), NUL se elimina (dentro de una cadena, `/* */` es texto y se conserva), y los escapes que forman una letra ASCII o `-` (`\68`, `h\74tp`) se decodifican. El texto normalizado es lo que se verifica **y** lo que llega al navegador. Las reglas son estas:
  - un `url(…)` solo se conserva si su argumento es exactamente una cadena entre comillas, o un token sin comillas cuyo valor sea un URI `data:` de imagen o fuente, una ruta relativa o un `#fragmento`;
  - cualquier otro caso, o cualquier caso ambiguo (una comilla suelta, una barra invertida sobrante, un paréntesis desbalanceado), **elimina la declaración completa**. Si no hay un tramo balanceado, la eliminación llega hasta el final del CSS;
  - `@import`, `image-set()`, `-webkit-image-set()`, `image()`, `cross-fade()`, `-webkit-cross-fade()`, `element()` y `src()` siempre se eliminan;
  - un atributo de pintura afectado pasa a `none`, y un atributo `style` que queda vacío se elimina;
  - la búsqueda no distingue mayúsculas y también encuentra nombres dentro de cadenas, así que solo puede eliminar de más (por ejemplo, `content:"url(https://…)"` también se elimina).

  Esto **no** es un tokenizador de CSS: es conservador por construcción. Además es lineal: dos pasadas de izquierda a derecha sin volver a recorrer tramos, así que el tiempo crece en proporción al tamaño de la entrada. Las pruebas exigen que una entrada mal formada de 2 MB termine en menos de 1 s. Sin esta capa, un DS global haría que el navegador de cada persona que abre la pantalla llame a un tercero (rastreo). Efectos visibles: los comentarios de CSS se convierten en un espacio, una fuente de CDN que importa el CSS del DS (por ejemplo, Google Fonts) ya no carga en la miniatura, y una lista `src` de `@font-face` con cualquier entrada remota pierde toda la declaración `src`. Las fuentes de marca siguen llegando como URLs `data:` a través del CSS de tokens. **Sigue permitido:** `<img src>` con `http(s)` (según la política de URLs de arriba), que también hace una solicitud hacia afuera.
- **Tokens del DS validados al guardar** (`server/templatePayload.ts`, invocado por `validateTemplatePayload`). El cliente arma un `<style>` con `fontAssets[]` (familia, peso, estilo, `dataUrl`), `headingFont`, `bodyFont` y `palette[].varName` **después** de la sanitización. Por eso cada campo acepta solo una lista de caracteres (sin comillas, `\`, `;`, `{`, `}`, `<`, `>` ni `/`) con un tamaño máximo, y `dataUrl` debe ser una fuente en base64 (`font/*`, `application/(x-)font-*`, EOT o `application/octet-stream`, que el importador usa para extensiones desconocidas). Un payload inválido recibe un 400 que indica el campo.

**Por qué `sanitize-html`:** tiene mantenimiento activo y defensas específicas, con pruebas, para los casos en que su parser y el navegador no coinciden. Escapa `<` dentro de `<style>` bajo `svg` o `math`, escapa el contenido de `textarea` y `xmp`, y vuelve a sanitizar el fallback de `iframe`. Su parser (htmlparser2) no es conforme con la especificación HTML: su propio README dice que toma atajos. La seguridad viene de esas defensas, de la allowlist y del sandbox, no del parser. Es JavaScript puro y funciona en el servidor sin DOM. DOMPurify necesitaría un DOM en Node (jsdom o linkedom), lo que pesa más en el bundle y agrega una dependencia más que mantener.

**Otros iframes `srcdoc` revisados:**

| Dónde | Sandbox | Evaluación |
|---|---|---|
| `DeckTemplateInspector.jsx:120,131` y la miniatura sin `previewCardHtml` (`DeckTemplatesSettings.jsx`) | `allow-scripts` | Aceptable. Los scripts del DS corren con origen opaco (sin cookies, sin la `/api` de la app, sin navegar la página superior ni abrir pop-ups). Aun así pueden hacer solicitudes de red hacia afuera, pero el frame solo contiene el propio DS. |
| `deck/HtmlSlideFrame.jsx:103`, `deck/HtmlSlideEditor.jsx:776` | `allow-scripts` | **Seguimiento pendiente.** El HTML de los slides viene del modelo, y el servidor (`sanitizeHtmlDeck`, `server/blocks.js:75`) solo elimina `<script>…</script>` con una regex: los atributos `on*` sobreviven y se ejecutan en estos frames. El origen es opaco (sin acceso a la API), pero un slide generado por inyección de prompt podría enviar el contenido del slide hacia afuera y, en el editor, enviar un mensaje `html` que el padre acepta (se verifica `e.source`) y guarda en el propio deck. Corrección propuesta: sanitizar el HTML del deck en el servidor con la misma biblioteca (el runtime del editor lo inyecta el cliente, así que el contenido puede quedar sin handlers) y una CSP con `connect-src`. |
| `lib/domToSlideOps.js:457`, `allow-same-origin`, sin scripts | `allow-same-origin` | Aceptable. Frame oculto para medir el layout durante el export. Los scripts y handlers no se ejecutan, y ningún nodo del frame se mueve al documento principal. No agregues `allow-scripts` aquí: con `allow-same-origin`, eso da acceso total a la app. |
| `HtmlDeckPreview.jsx:53`, `allow-same-origin`, sin scripts | `allow-same-origin` | Aceptable, misma regla. El componente no se importa en ningún lugar (código muerto, candidato a eliminar). |

**Seguimiento de pruebas:** hoy la presencia del atributo `sandbox` se verifica en el código fuente (`server/iframeSandbox.test.js`). Falta una prueba de UI que renderice la miniatura e inspeccione el `<iframe>` resultante.

Lo que esto **no** cubre: el propio DS sigue siendo contenido confiable para el prompt (un DS global influye en los decks de todos), y la CSP de la app (arriba) no restringe scripts, estilos, imágenes ni `connect-src` en estos iframes.

Cuando la app busca una URL que elige el modelo (la tool de página web), la conexión solo sigue hacia direcciones públicas: loopback, redes privadas, CGNAT, link-local (incluido el endpoint de metadatos de la nube), ULA y direcciones reservadas quedan bloqueadas, en cada salto de redirección. La misma regla está en `server/a2aGuard.ts`, que usará A2A.

## Imágenes generadas (UC Volume)

Los bytes de las imágenes generadas se escriben y se leen con el token del service principal de la app, en `/Volumes/<catálogo>/<schema>/<volume>/<correo codificado>/<uuid>.png` (`server/imageStore.ts`). Sin credenciales de service principal (desarrollo local), el código usa el token propio de quien hace la llamada (`storageToken`, `server/imageStore.ts:24-34`). Dentro de la app, una imagen solo se sirve a través de la fila de la base de datos de su dueño (`/api/images/:id`). **Fuera de la app no hay aislamiento por usuario:** cualquiera con `READ VOLUME` en ese schema (el dueño del catálogo, los admins del metastore, o permisos amplios sobre un catálogo existente, como en workspaces con un metastore compartido) puede listar y leer las imágenes de todos los usuarios, y ver por la ruta quién generó cada una. Al instalar, verifica que solo el service principal de la app tenga acceso al volume de imágenes.

## TLS para Postgres (Lakebase)

Por defecto, la conexión a Postgres está **cifrada, pero la cadena del certificado no se verifica** (`ssl: { rejectUnauthorized: false }` en `server/db.ts`, función `pgSslOptions`). Esta es la decisión histórica del proyecto, y tiene un costo que debes conocer:

- **Por qué existe**: el código no registra la razón original. La razón probable es operativa: la app no incluye la CA de Lakebase, así que la validación con el trust store por defecto de Node fallaría sin configuración adicional. Las opciones de abajo hacen que la CA sea configurable sin cambiar el valor por defecto.
- **Modelo de amenaza**: la conexión sale del contenedor de la app hacia el endpoint de Lakebase, dentro de la red del workspace. Sin verificación, un atacante capaz de interceptar ese camino podría hacerse pasar por el endpoint y recibir el token del service principal o la credencial del usuario (que es el propio token OBO, usado como contraseña). El riesgo es menor que en una red pública, pero no es cero.
- **Cómo cerrarlo**: proporciona la CA, y la verificación se activa automáticamente.

| Variable | Efecto |
|---|---|
| (ninguna) | Cifrado, cadena no verificada (valor por defecto, sin cambios) |
| `PG_SSL_CA` | PEM en línea o ruta de archivo con la CA. Activa la verificación |
| `PG_SSL_REJECT_UNAUTHORIZED=1` | Verifica la cadena (con o sin `PG_SSL_CA`; sin CA usa el trust store de Node) |
| `PG_SSL_REJECT_UNAUTHORIZED=0` | No verifica, incluso con `PG_SSL_CA` (para diagnóstico) |
| `PGSSLMODE=disable` | Sin TLS (solo para una base local) |

Con `PG_SSL_CA`, la cadena se verifica por defecto, porque una CA fijada que no se verifica no protege nada. Usa la CA que presenta tu endpoint de Lakebase. Aparece en la documentación de Lakebase de tu workspace.

## Fuera de alcance

- Vulnerabilidades en la plataforma Databricks en sí (repórtalas a Databricks).
- Configuraciones inseguras hechas por quien despliega la app (por ejemplo, exponer secretos u otorgar permisos demasiado amplios en el workspace).

## Buenas prácticas para quien despliega

- Ejecuta siempre la versión más reciente de `main`.
- No codifiques hosts, tokens ni credenciales en `app.yaml` ni en `databricks.yml`. El modelo independiente de la nube inyecta todo en runtime (consulta el README).
- Restringe el acceso a la app y al workspace con los ACL de Databricks.
