<!-- i18n: source=docs/security-faq.md source-hash=9d2f111d2a885550b566554f0d2f6e4a10c07fef status=machine -->
# Preguntas frecuentes de seguridad de AI Prism

[English](../security-faq.md) · [Português (Brasil)](../pt-BR/security-faq.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../security-faq.md) es la referencia.

Respuestas a las objeciones que surgen en las revisiones de seguridad. Cada respuesta separa lo que **hace la app** (código de este repositorio) de lo que **provee la plataforma Databricks o serverless**. Cuando una respuesta depende de la configuración del workspace, se indica. Para más detalle, consulta el [modelo de amenazas](../security-threat-model.md) (los identificadores G1–G15 y C1–C22 vienen de ahí).

---

### 1. ¿La app implementa login?

**No.** La app no tiene pantalla ni flujo de autenticación propio. El **Apps proxy** del workspace autentica al usuario (OAuth/SSO) y reenvía la solicitud con `x-forwarded-email` y `x-forwarded-access-token`. La app lee esos headers (`server/requestIdentity.js`) y responde 401 cuando falta el token o el correo. También verifica con el workspace (`SCIM /Me`) que el correo pertenezca al dueño del token, y responde 401 si no le pertenece (`server/identityBinding.js`, `IDENTITY_BINDING`; ver [SECURITY.md](SECURITY.md#vínculo-entre-correo-y-token-serveridentitybindingjs)).

*Plataforma:* autenticación, SSO, expiración de sesión, revocación de acceso y ser el único camino hacia el proceso.
*App:* exige los dos headers y el vínculo entre ellos. Si el workspace no responde, la solicitud pasa y el log registra una advertencia.

---

### 2. ¿Un usuario puede ver la conversación de otro?

**Una conversación personal, no, y la base de datos lo aplica (row-level security, migraciones 0003 y 0005). La única excepción deliberada es un proyecto compartido: sus conversaciones las pueden leer los miembros actuales del proyecto.** Las tablas de la app en el schema `ai_prism` tienen `ENABLE` y `FORCE ROW LEVEL SECURITY`. Hay dos excepciones, y ninguna guarda contenido de conversaciones. `project_members` tiene row-level security habilitado pero no forzado, para que la función de membresía pueda leerla ([TB9 del modelo de amenazas](../security-threat-model.md#3-trust-boundaries)). `schema_migrations` no tiene ninguno: solo guarda versiones de migración. Por defecto, la app se conecta con **un solo** rol de Postgres para todos los usuarios: su service principal. Ese rol no es dueño de ninguna tabla, no tiene `BYPASSRLS` y, después de un deploy, no es miembro del rol dueño. Cuando el service principal no puede conectarse, la app recurre a la identidad de base de datos del propio llamador ([pregunta 5](#5-qué-permisos-usa-la-app-y-en-nombre-de-quién)). Cada consulta corre dentro de `withTx` (`server/db/pool.js`). Solo para esa transacción, define el correo de quien llama (`app.user_email`), los grupos del workspace de quien llama (`app.user_groups`) y una marca de admin (`app.is_admin`). Sin una identidad de quien llama, no es visible ninguna fila personal ni de proyecto. Las tablas compartidas y de administración que siguen siguen siendo legibles, porque su política de lectura está abierta a todos.

- **Datos personales** (chats fuera de un proyecto con sus mensajes y llamadas a herramientas, artefactos, imágenes, ledger de costos, memoria, conexiones MCP, selecciones): una fila es visible y escribible solo por el usuario al que pertenece, directamente (`user_email`) o a través de su chat (`chat_sessions`). Ser miembro de un proyecto no da acceso a los chats personales de otro miembro. Un chat temporal (migración 0011) es un chat personal que nunca puede pertenecer a un proyecto; se le aplican las mismas reglas de acceso exclusivo del dueño.
- **Conversaciones de proyecto** (migración 0005): un chat creado dentro de un proyecto lo pueden leer los miembros *actuales* del proyecto (una persona o un grupo del workspace confirmado) con cualquier rol (owner, manage, view). Pueden leer el chat, sus mensajes, llamadas a herramientas, compactaciones, conversaciones de Genie y embeddings. Todo miembro puede publicar turnos nuevos; solo manage u owner pueden reescribir su historial. Los artefactos, imágenes y filas de costos que un miembro crea en un chat de proyecto siguen siendo legibles solo por ese miembro. Desde la migración 0008, la pertenencia se evalúa una vez por sentencia como un conjunto de ids de proyecto (`aip_my_project_ids()`, [ADR 0016](../adr/0016-project-membership-set.md)); las reglas de acceso no cambian. Quien sale del proyecto pierde el acceso a sus chats, incluso a los que creó. Un admin de la app no tiene acceso implícito. Prueba: `server/isolation.projects.test.js` (un miembro lee el chat compartido de otro miembro; un no miembro, un admin y una identidad vacía no). Ver TB9 en el [modelo de amenazas](../security-threat-model.md#3-trust-boundaries).
- **Tablas compartidas** (plantillas de design system, skills): cada persona lee sus propias filas y las globales; solo una solicitud de admin escribe una fila global.
- **Tablas de administración** (admins, catálogo MCP, política de herramientas, catálogo de modelos, configuración de la organización): todos leen; solo una solicitud de admin escribe. El rastro de auditoría de admin (`admin_audit`) solo es legible con la marca de admin. Hay una lectura más que cruza usuarios: el ledger de costos (`usage_ledger`) sigue siendo por usuario, salvo que una solicitud que lleve la marca de admin **y** una identidad de quien llama puede leer las filas del ledger de todos los usuarios mediante una política de solo SELECT (`aipa_admin_read`, migración 0010, [ADR 0015](../adr/0015-admin-ledger-read.md)). La app la usa solo para los agregados de costo de la búsqueda web para admins (usuarios con hash en la respuesta); no da acceso de escritura y, sin identidad, no da lectura.

La marca de admin la define únicamente el código del servidor después de verificar al admin (`requireAdmin`, `authz.isAdmin`), nunca a partir de un header o del cuerpo, y no da acceso a las filas propias de otros usuarios. Las consultas conservan sus filtros `WHERE user_email` como defensa en profundidad. La CI lo prueba: `server/isolation.test.js` (19 casos) ejecuta `db.js` como un rol de app que no es dueño y bajo las políticas, incluido un `SELECT` crudo en cada tabla por usuario que debe devolver 0 filas del otro usuario, y `server/rls.test.js` (16 casos) verifica las políticas, `FORCE`, los atributos del rol, el uso de índices y el ida y vuelta de la migración. G2 y G13 están cerradas (ver el modelo de amenazas). Sigue abierto: ejecutar la misma verificación en un branch real de Lakebase (G-live-7 en el modelo de amenazas).

---

### 3. ¿Dónde se guardan los datos?

- **Conversaciones, artefactos, embeddings y el ledger:** Lakebase (Postgres serverless) en tu propio workspace, creado por `databricks.yml`.
- **Entradas de memoria:** tabla `user_memories` en el mismo Lakebase, una fila por dato recordado, legible solo por su dueño ([pregunta 20](#20-qué-guarda-la-memoria-y-cómo-se-borra)).
- **Imágenes generadas:** un UC Volume, por defecto `ai_prism.default.ai_prism_images` (configurable con `IMAGE_VOLUME_CATALOG`, `IMAGE_VOLUME_SCHEMA` e `IMAGE_VOLUME_NAME`).
- **Datos consultados:** Unity Catalog, Genie y Vector Search, siempre con el token del usuario (OBO).
- **Salidas de modelos:** llamadas al AI Gateway del workspace.

La app **no envía datos a otros destinos**, salvo los servidores MCP o A2A que el usuario o un admin configuraron, y la búsqueda web, cuando un admin la habilita.

**Cuánto tiempo se guardan:** hasta que el usuario borra la conversación, salvo que un admin defina un período de retención (`retentionDays`, desactivado por defecto). Con la retención activada, un barrido diario borra toda conversación inactiva durante más tiempo que ese, con sus mensajes, artefactos y archivos de imagen. Las filas de costo se quedan, sin el vínculo con la conversación ([operations.md §6.8](operations.md#68-retención-instrucciones-de-la-organización-y-registro-de-auditoría-de-admin)). Un **chat temporal** (elegido en el menú + del compositor) es la excepción: se elimina cuando el usuario sale y, si eso no llega, por un barrido tras 24 horas de inactividad (con la retención activada o no). No escribe embeddings, no extrae memoria y nunca es un resultado de búsqueda; la auditoría guarda solo el conteo de cuántos se iniciaron, sin id de conversación, usuario, título ni contenido.

*Plataforma:* región, residencia y cifrado en reposo y en tránsito del workspace.

---

### 4. ¿Los datos se usan para entrenar modelos?

Depende del **modelo servido por el AI Gateway** y de los términos del proveedor de ese modelo. La app no tiene forma de cambiar esa política. Antes de habilitar un modelo, un admin debe revisar los términos del endpoint en el propio workspace. Este documento no afirma nada sobre la política de terceros.

---

### 5. ¿Qué permisos usa la app, y en nombre de quién?

Tres formas, según el recurso (tabla completa en §4 del [modelo de amenazas](../security-threat-model.md)):

- **OBO (token del usuario):** modelos, Genie, SQL Warehouse (funciones UC y UDF de Python, y la creación única del Volume de imágenes), Vector Search y las conexiones MCP del usuario. El usuario solo alcanza lo que ya alcanza.
- **Service principal de la app, por defecto:** Lakebase, el Volume de imágenes y el listado de sugerencias del catálogo MCP.
- **Fallback a la identidad del usuario.** Si la app no tiene credenciales de service principal, o el service principal no puede iniciar sesión en Lakebase o alcanzarlo, la app se conecta a Lakebase como el propio rol de Postgres de quien llama, con el token del usuario como contraseña. Si el service principal está configurado y luego falla, la app permanece en esa ruta durante 5 minutos antes de intentar de nuevo con el service principal; sin ninguna credencial de service principal no hay nada que reintentar, y la app usa la ruta por usuario directamente hasta que cambie la configuración (`createWithClient` en `server/db/pool.js`; línea de log `lakebase: service-principal login unavailable, using per-user identity`, alerta A3 en [operations.md](operations.md#52-reglas-de-alerta-propuestas)). Se aplican la misma identidad de `withTx` y las mismas políticas. La mayoría de los usuarios del workspace no tiene un rol en Lakebase, así que sus solicitudes fallan durante un fallback. Un llamador cuyo propio rol tiene `BYPASSRLS` (en Lakebase, lo tiene la identidad que despliega) no queda sujeto a las políticas durante un fallback. Para ese llamador solo quedan las verificaciones de dueño de la propia app (brecha G15 en el [modelo de amenazas](../security-threat-model.md#7-declared-gaps)). Un error de permisos (`42501`) o el rechazo de una política nunca activa el fallback. El Volume de imágenes usa el token del usuario cuando no se puede obtener el token del service principal (`storageToken` en `server/imageStore.js`). Esa ruta necesita el scope `files` del usuario.

Los scopes OBO están en `user_api_scopes` en `databricks.yml`. Deben estar en el bundle, no en `app.yaml`: `bundle deploy` no aplica los scopes de `app.yaml`.

*Limitación:* el privilegio propio del SP en la base de datos es más amplio que las lecturas de cualquier usuario; row-level security (respuesta 2) lo acota por solicitud, salvo en el caso de fallback descrito arriba (G15).

---

### 6. ¿Quién es administrador?

- **Owner:** el correo en `APP_OWNER_EMAIL`, cuando está definido. El bundle **no** define esta variable.
- **Admins:** la tabla `app_admins`, por correo o por grupo del workspace (la lista de grupos viene de SCIM con el token del propio usuario; si SCIM falla, los grupos no dan acceso).
- **Bootstrap:** el job de auto-config (`bundle/auto_config.py`) registra a quien hizo el deploy como primer admin.

Las rutas de administración pasan por `requireAdmin`. No hay doble aprobación para cambiar admins.

---

### 7. ¿Hay un registro de auditoría?

Sí, para las acciones administrativas, y hay otras fuentes para el resto:

- **Acciones de admin (app):** cada cambio de admin escribe una fila en la tabla `admin_audit` en la misma transacción que el cambio. Cubre admins, catálogo MCP, política de herramientas, alcance de plantillas, plantillas y skills globales, endpoints de modelo y los ajustes de retención y de instrucciones de la organización. El barrido de retención también escribe una fila con sus conteos. Iniciar un chat temporal inserta una fila de solo conteo (`ephemeral.started`, actor `system`, sin destino, sin id de conversación, usuario, título ni contenido; migración 0011, política `aipe_started_insert`), que los admins leen como un número mediante `GET /api/admin/ephemeral-chats`. El actor se guarda como hash, nunca el e-mail: con `APP_AUDIT_HASH_KEY` configurada es un HMAC con clave (prefijo `h2:`) que **no** coincide con el `user_hash` de los logs, a propósito; sin la clave es el mismo `user_hash` sin sal de los logs ([cómo correlacionar ambos](security-threat-model.md#61-correlacionar-la-traza-de-auditoría-con-los-logs)). La app no puede modificar ni borrar filas. Los admins lo leen con `GET /api/admin/audit` ([operations.md §6.8](operations.md#68-retención-instrucciones-de-la-organización-y-registro-de-auditoría-de-admin)).
- **Plataforma:** `system.access.audit` registra los eventos del workspace y de Unity Catalog. Es la fuente de referencia para saber quién hizo qué fuera de la app.
- **App:** `usage_ledger` (costo por llamada, por usuario y sesión) y los propios mensajes del chat.
- **Logs:** líneas JSON estructuradas con `request_id` y `user_hash` (el hash sin clave), con e-mails, tokens y SQL redactados (`server/log.js`). La plataforma define la retención (cómo consultarlo: [operations.md](operations.md)).

*Límite:* lo que los usuarios hacen en sus propias conversaciones no está en `admin_audit`. Sus mensajes y el `usage_ledger` son el registro.

---

### 8. ¿La app ejecuta código generado por el modelo?

**No en el proceso de la app.** La herramienta Python corre como UC Function (UDF) en un SQL Warehouse serverless, con el token del usuario. La ejecución ocurre en el sandbox del warehouse y se limita a lo que el usuario puede ejecutar. Las tools de Unity Catalog siguen la misma regla.

---

### 9. ¿El contenido que genera el modelo puede ejecutar scripts en el navegador?

Hay tres capas, y ninguna basta por sí sola:

- Markdown: el cliente no renderiza HTML crudo (sin `rehype-raw`).
- Slides HTML: `<script>` se elimina al guardar el deck (`sanitizeHtmlDeck`), y el iframe usa `sandbox="allow-scripts"` **sin** `allow-same-origin`, así que tiene origen opaco: sin acceso a cookies, almacenamiento ni al DOM de la app.
- Un iframe de vista previa usa `allow-same-origin`, pero **sin** `allow-scripts`.

---

### 10. ¿La prompt injection puede hacer que el modelo actúe contra el usuario?

**Es un riesgo abierto, y en el estado actual no puede eliminarse.** Un servidor MCP o una página web pueden poner instrucciones en su contenido, y hoy:

- Las descripciones, instrucciones y esquemas de las tools MCP, los títulos de las salas de Genie y los comentarios de las UC Functions se neutralizan antes de llegar al prompt (`server/toolMetadata.js`, G7 mitigada). Eso reduce el riesgo; no lo elimina.
- Los resultados de la búsqueda web se envuelven en un sobre fijo de "contenido externo, no confiable" (G12, mitigada para `web_search`). Los adjuntos y el texto de `web_fetch` todavía entran al contexto sin esa marca (G12, abierta para esos dos).

Lo que limita el daño: las tools que llegan a datos del workspace (Genie, SQL Warehouse y funciones UC, Vector Search, las conexiones MCP del usuario, modelos) corren con el token OBO del usuario, así que una inyección no puede alcanzar datos del workspace que el usuario no alcance ya. El almacenamiento propio de la app funciona de otra manera. Lakebase y el Volume de imágenes se alcanzan por defecto con el service principal de la app, y con la identidad del propio llamador solo como fallback ([pregunta 5](#5-qué-permisos-usa-la-app-y-en-nombre-de-quién)). Con cualquiera de las dos identidades, el modelo no recibe ninguna conexión a la base de datos ni elige ninguna ruta de almacenamiento. Toda lectura o escritura de datos de la app es código de la app que corre dentro de `withTx` con la identidad del llamador; en la ruta del service principal corre bajo row-level security, y en el fallback por usuario bajo un rol con `BYPASSRLS` las políticas se omiten y las verificaciones de dueño de la app (`WHERE user_email`, `sessionAccessSql`) son el control residual (G15). Un archivo de imagen solo se alcanza a través de su fila `chat_images`. Por eso, una inyección no puede ampliar lo que esas verificaciones permiten. El riesgo real es que el modelo ejecute una **escritura** que el usuario no quería. Por eso, la recomendación es restringir las tools de escritura por política (`app_tool_policy`) y exigir confirmación humana.

---

### 11. ¿Hay protección contra SSRF?

Sí, en el fetch web (`server/web.js`): bloquea `localhost`, IPs privadas (IPv4 e IPv6, incluidas las mapeadas), resuelve el DNS antes de conectar y limita los redirects. Hay una prueba en `server/web.test.js`. Los usuarios no informan URLs de servidores MCP: una conexión MCP es un servicio de Unity Catalog, y la app arma su dirección como el host del workspace más `/ai-gateway/mcp-services/<name>`, con el nombre codificado como URL en un único segmento de ruta (`externalMcpUrl`, `server/externalMcp.js`); `/api/mcp/connections/:name` responde 400 a los nombres con caracteres de ruta o de query. Después, el gateway del workspace, no la app, llama al servidor externo. La tool `web_fetch` es el único lugar donde la propia app busca una URL pública arbitraria, y es la ruta con las verificaciones anti-SSRF.

---

### 12. ¿Hay rate limit o protección contra abuso de costos?

**Sí, por usuario (G4, mitigada).** `server/middleware/rateLimit.js` da a cada usuario un token bucket con la clave de la identidad que reenvía el proxy de Apps (`x-forwarded-email`), nunca solo la IP, porque muchos usuarios salen por la misma IP:

- 120 solicitudes `/api` por minuto (`RATE_LIMIT_API_PER_MIN`) y 12 turnos de modelo por minuto (`RATE_LIMIT_TURNS_PER_MIN`: chat, continue, regenerate, compact y los tweaks de los estudios). `0` desactiva un límite. Por encima del límite, la respuesta es `429` con `Retry-After`.
- Límites de cuerpo, por clase de ruta en una única tabla explícita (`server/middleware/security.js`; cada ruta de escritura tiene clase): JSON hasta 1 MB por defecto; 40 MB para importar o actualizar un design system; 46 MiB para el guardado, la edición por IA y la exportación nativa del estudio de decks y la edición por IA de la hoja de cálculo, que llevan slides, notas del presentador e imágenes como data URLs (un deck de 40 slides con fondo de marca en cada uno exporta un cuerpo de 25,6 MB; el estudio de decks limita sus entradas a 9 MiB por nota del presentador y cuatro adjuntos de 6 MiB cada uno, y una edición por IA en esos topes tiene 45,4 MB; por encima de un tope, la respuesta es `413` con el límite); 4 MB para guardar una hoja de cálculo. Uploads del chat hasta 80 MB y 10 archivos, uploads de skills hasta 5 MB y 1 archivo. Por encima del límite, la respuesta es `413`. Con el boot AppKit, el parser JSON del propio AppKit lee el cuerpo de cada ruta (hasta 64 MB, el tope de memoria por solicitud) antes de los middlewares de la app: el límite por ruta sigue respondiendo `413` según el `Content-Length` declarado, y un cuerpo JSON sin él (chunked) recibe `411 Length Required`, porque el objeto parseado no muestra cuántos bytes llegaron. Los bytes ya se leyeron, así que es una verificación de política, no una protección de memoria. Con el boot legado el parser cuenta el propio stream, chunked o no.
- Límites de recursos: SQL Warehouse 2X-Small, `max_num_clusters: 1`, auto-stop de 10 minutos; Lakebase con tope de 16 CU.
- Visibilidad: `usage_ledger` por usuario y el dashboard de costos.

*Límites de este control:* los buckets viven en cada proceso de la app, así que varias instancias multiplican el tope, y un límite de solicitudes no es un tope de gasto. *Recomendación:* presupuestos por usuario o grupo en el Unity AI Gateway para el tope de costo.

---

### 13. ¿Cómo se guardan las claves y contraseñas?

- **Ningún secreto en el repositorio.** `.env` está en `.gitignore`; `.env.example` no tiene valores reales.
- **Service principal:** `DATABRICKS_CLIENT_ID` y `DATABRICKS_CLIENT_SECRET` los inyecta el runtime de Apps.
- **`PGPASSWORD`:** existe solo para la base de datos de desarrollo local.
- **Tokens de usuario:** llegan en cada solicitud, en el header del proxy.

*Plataforma:* rotación y almacenamiento del secreto del SP.

---

### 14. ¿Se verifica la conexión con la base de datos?

**Parcialmente, y desactivado por defecto (G3, abierta).** TLS está activado por defecto (`PGSSLMODE=require`, definido en `app.yaml`); `PGSSLMODE=disable` lo desactiva y es solo para una base de datos local. El certificado del servidor se verifica solo si lo activas: define `PG_SSL_CA` (un PEM o una ruta de archivo; fija la CA y activa la verificación) o `PG_SSL_VERIFY=1` (verifica contra el almacén de confianza de Node); un `0` explícito lo desactiva (`pgSslOptions` en `server/db/pool.js`, `SECURITY.md`, pruebas en `server/pgSsl.test.js`). Sin ninguna de las dos, la conexión está cifrada pero la identidad del servidor no se valida, lo que la deja expuesta a un intermediario que pueda interceptar el tráfico dentro de la red del workspace. No es el valor por defecto porque la cadena de Lakebase todavía no se confirmó contra el almacén de confianza del runtime en un despliegue real (G-live-6). Hasta entonces, define la variable en tu despliegue o acepta formalmente el riesgo.

---

### 15. ¿La aplicación tiene headers de seguridad (CSP, HSTS)?

**Parcial (G6).** En cada respuesta la app define `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: SAMEORIGIN` y `Permissions-Policy: microphone=(self), camera=()` (el micrófono solo para el dictado de la propia app), elimina `X-Powered-By` y envía dos CSP:

- **Aplicada**, conservadora: `frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'` (`server/securityHeaders.js`).
- **Report-only**, la política objetivo: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'` (`server/middleware/security.js`). El navegador no bloquea nada con ella; solo reporta a `POST /api/csp-report`, que registra una línea JSON por violación con la directiva, el origen bloqueado, la ruta del documento y la disposición, sin query string, muestra ni identidad.

La política objetivo todavía no se aplica porque los iframes `srcdoc` de los decks y de las vistas previas de design system heredan la política de la página y necesitan scripts en línea y assets del design system en otros hosts (el motivo está en [SECURITY.md](SECURITY.md#protecciones-http)). Los reportes recogidos son la evidencia necesaria antes de aplicarla. `Referrer-Policy` queda en `same-origin`, más estricta que `strict-origin-when-cross-origin`: los sitios externos no reciben ningún referrer. HSTS viene del proxy de Apps. Lo que el proxy agrega a la respuesta no se ha verificado (modelo de amenazas §7.1).

---

### 16. ¿Hay protección contra CSRF?

**Sí (G5, mitigada).** `server/csrfGuard.js` rechaza con 403 cualquier `POST`, `PUT`, `PATCH` o `DELETE` en `/api/*` que venga de otro sitio, antes de cobrar el rate limit del usuario y, con el boot legado, antes de leer el cuerpo (con el boot AppKit, el parser JSON de AppKit ya lo leyó): `Sec-Fetch-Site: cross-site` siempre se rechaza, aunque el `Origin` parezca el de la app; si no, se rechaza un `Origin` o `Referer` de otro host. No hay token anti-CSRF. La verificación de origen cubre los navegadores actuales y no depende del `SameSite` de la cookie del proxy, que sigue sin verificarse. Las solicitudes sin ninguno de estos headers (scripts, `npm run smoke`) pasan, porque no vienen de un navegador.

---

### 17. ¿Se auditan las dependencias?

**Se reporta, no se exige (G9, abierta).** La CI ejecuta `npm audit` (el conjunto de runtime y el árbol completo) en un paso solo de reporte que nunca hace fallar el job, y el `.npmrc` tiene `audit=false` para la instalación en el deploy. No hay automatización de actualización de dependencias ni una barrera sobre los hallazgos. Lo que existe: `npm ci` con el lockfile (con `--ignore-scripts`) y un deploy que ejecuta el bundle. El bundle incluye las dependencias, así que una vulnerabilidad en una de ellas permanece en el artefacto hasta que se reconstruye el bundle en un release.

---

### 18. ¿Cómo reporto una vulnerabilidad?

Por el canal privado de GitHub (la pestaña **Security**), como se describe en [SECURITY.md](SECURITY.md). No abras un issue público con detalles técnicos.

---

### 19. ¿Qué hace la plataforma y qué es responsabilidad de quien despliega?

| Tema | Plataforma Databricks | Quien despliega |
|---|---|---|
| Autenticación y SSO | Apps proxy, OAuth | Configura el workspace y los grupos |
| Cifrado en reposo y en tránsito | Lakebase, UC, Volumes, Apps | Elige claves administradas, si son requeridas |
| Aislamiento de red | Red del workspace y de Lakebase | Configura la red (por ejemplo, private link) |
| Permisos de datos | UC, Genie, Vector Search | Otorga acceso a tablas y Genie Agents |
| Costo y límites | SQL Warehouse, Lakebase, AI Gateway | Define presupuestos y auto-stop |
| Aislamiento entre usuarios en la base de datos | Lakebase aplica las políticas; no las crea | La app las incluye (row-level security con `FORCE`, migración 0003); quien despliega mantiene el rol de la app sin ser owner y sin `BYPASSRLS`, y ejecuta la suite de aislamiento contra un branch real (G2, G13) |
| Auditoría de la plataforma | `system.access.audit` | Mantiene la retención y el acceso a la tabla |
| Escaneo de dependencias y CVEs | — | Lee la salida de `npm audit` (solo reporte), aplica las correcciones y reconstruye el bundle (G9) |
| Rate limit y cuotas de uso | Límites de solicitudes y de turnos por usuario en la app; presupuestos en el AI Gateway | Configura presupuestos por usuario |

---

### 20. ¿Qué guarda la memoria y cómo se borra?

- **Qué:** datos breves sobre un usuario (como máximo 200 entradas de 500 caracteres cada una), cada uno con su categoría, su origen (escrito por el usuario o aprendido después de un turno) y, para un dato aprendido, el chat del que vino. Tabla `user_memories` en Lakebase, migración 0006.
- **Quién lo lee:** solo su dueño. Row-level security en `user_memories` (`app.user_email`), como en los chats; los administradores no tienen acceso.
- **Qué se aprende:** después de responder un turno, el modelo pequeño del clasificador de intención lee **solo el mensaje del usuario** (nunca la respuesta, los resultados de herramientas ni contenido web) y puede guardar hasta tres datos. Solo se ejecuta en mensajes cortos con una pista en primera persona que no parecen pegados (sin citas, bloques de código ni encabezados de correo), y descarta cualquier dato que parezca una instrucción al asistente o que traiga un enlace o una dirección, así que un texto de terceros pegado no puede plantar una instrucción duradera. Nunca guarda salud, política, religión ni finanzas personales; una entrada sensible que escriba el usuario solo se usa después de que dé su consentimiento en esa entrada. Un turno cancelado no aprende nada. La llamada queda en el ledger con kind `memory`.
- **Qué llega al modelo:** como máximo 10 entradas por turno y como máximo 1.500 tokens, contados de forma conservadora por sistema de escritura (cerca del doble de la tasa usual en cualquier idioma, así que escrituras densas como el chino no lo desbordan), marcadas como datos no confiables, no instrucciones, con los marcadores del bloque neutralizados dentro de las entradas, así que una entrada no puede hacerse pasar por una instrucción de sistema (ver la pregunta 10).
- **Logs:** el texto de la memoria nunca se registra.
- **Cómo borrar:** el usuario elimina una entrada o todas (`DELETE /api/memory/:id`, `DELETE /api/memory`). "Olvidar todo" también graba una marca por usuario (`user_memory_state.forgot_at`), así que una extracción aún en curso en cualquier instancia de la app no escribe nada después; eliminar un chat no borra lo aprendido de él. Un administrador desactiva la función con la clave de política de herramientas `memory` (Configuración → Herramientas): no se aprende, no se inyecta ni se lista nada; las filas guardadas quedan hasta que su dueño las elimine, y eliminar sigue funcionando. Revertir la migración 0006 borra la tabla y todas las entradas.

*Plataforma:* el mismo cifrado, residencia y backups de Lakebase que el resto de los datos.
