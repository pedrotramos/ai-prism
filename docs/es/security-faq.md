<!-- i18n: source=docs/security-faq.md source-hash=98ae81f32ce2ee63a70066fd56298538c6db6085 status=machine -->
# Preguntas frecuentes de seguridad de AI Prism

[English](../security-faq.md) · [Português (Brasil)](../pt-BR/security-faq.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../security-faq.md) es la referencia.

Respuestas a las objeciones que surgen en las revisiones de seguridad. Cada respuesta separa lo que **hace la app** (código de este repositorio) de lo que **provee la plataforma Databricks o serverless**. Cuando una respuesta depende de la configuración del workspace, se indica. Para más detalle, consulta el [modelo de amenazas](../security-threat-model.md) (los identificadores G1–G13 y C1–C16 vienen de ahí).

---

### 1. ¿La app implementa login?

**No.** La app no tiene pantalla ni flujo de autenticación propio. El **Apps proxy** del workspace autentica al usuario (OAuth/SSO) y reenvía la solicitud con `x-forwarded-email` y `x-forwarded-access-token`. La app lee esos headers (`server/requestIdentity.js`) y responde 401 cuando falta el token o el correo. También verifica con el workspace (`SCIM /Me`) que el correo pertenezca al dueño del token, y responde 401 si no le pertenece (`server/identityBinding.js`, `IDENTITY_BINDING`; ver [SECURITY.md](SECURITY.md#vínculo-entre-correo-y-token-serveridentitybindingjs)).

*Plataforma:* autenticación, SSO, expiración de sesión, revocación de acceso y ser el único camino hacia el proceso.
*App:* exige los dos headers y el vínculo entre ellos. Si el workspace no responde, la solicitud pasa y el log registra una advertencia.

---

### 2. ¿Un usuario puede ver la conversación de otro?

**No por diseño, pero el aislamiento lo aplica la aplicación, no la base de datos.** Todas las lecturas de conversación, mensaje, artefacto y búsqueda filtran por dueño (`WHERE user_email` o un JOIN con `chat_sessions`). Un `sessionId` ajeno recibe 403 antes de que empiece el stream.

Un punto que los revisores deben conocer: las consultas corren con el **service principal** de la app (`withClient`, `server/db.js`), que tiene DML en todas las tablas del schema `public`, y **no hay RLS**. Las pruebas automatizadas de dos usuarios ya corren en la CI: `server/isolation.test.js` (10 casos, contra las funciones reales de `db.js`) y `tests/routes.test.mjs` (leer, listar y borrar el chat de otro usuario quedan denegados). La CI ejecuta ambas con `--fail-on-skip` y exige que los 10 casos de aislamiento pasen, así que una prueba omitida hace fallar el paso de CI. Estas pruebas cubren solo lo que ejercitan: una consulta nueva fuera de esa cobertura todavía puede exponer datos de otro usuario. Esta sigue siendo la brecha de mayor impacto del proyecto (G2). La brecha de no tener una prueba automatizada de aislamiento en la CI (G13) está cerrada a nivel de aplicación.

*Mitigación planeada:* un schema dedicado con roles de privilegio mínimo, y RLS con `FORCE`. La suite de aislamiento ya corre en la CI. Cuando exista RLS, la suite también debe correr contra él.

---

### 3. ¿Dónde se guardan los datos?

- **Conversaciones, artefactos, embeddings y el ledger:** Lakebase (Postgres serverless) en tu propio workspace, creado por `databricks.yml`.
- **Imágenes generadas:** UC Volume `ai_prism_images` en el catálogo `ai_prism`.
- **Datos consultados:** Unity Catalog, Genie y Vector Search, siempre con el token del usuario (OBO).
- **Salidas de modelos:** llamadas al AI Gateway del workspace.

La app **no envía datos a otros destinos**, salvo los servidores MCP o A2A que el usuario o un admin configuraron, y la búsqueda web, cuando un admin la habilita.

*Plataforma:* región, residencia y cifrado en reposo y en tránsito del workspace.

---

### 4. ¿Los datos se usan para entrenar modelos?

Depende del **modelo servido por el AI Gateway** y de los términos del proveedor de ese modelo. La app no tiene forma de cambiar esa política. Antes de habilitar un modelo, un admin debe revisar los términos del endpoint en el propio workspace. Este documento no afirma nada sobre la política de terceros.

---

### 5. ¿Qué permisos usa la app, y en nombre de quién?

Dos modos, según el recurso (tabla completa en §4 del [modelo de amenazas](../security-threat-model.md)):

- **OBO (token del usuario):** modelos, Genie, SQL Warehouse (funciones UC y UDF de Python), Vector Search y las conexiones MCP del usuario. El usuario solo alcanza lo que ya alcanza.
- **Service principal de la app:** Lakebase (por defecto), el Volume de imágenes y el listado de sugerencias del catálogo MCP.

Los scopes OBO están en `user_api_scopes` en `databricks.yml`. Deben estar en el bundle, no en `app.yaml`: `bundle deploy` no aplica los scopes de `app.yaml`.

*Limitación:* el SP tiene más privilegio que las lecturas de cualquier usuario, por el motivo dado en la respuesta 2.

---

### 6. ¿Quién es administrador?

- **Owner:** el correo en `APP_OWNER_EMAIL`, cuando está definido. El bundle **no** define esta variable.
- **Admins:** la tabla `app_admins`, por correo o por grupo del workspace (la lista de grupos viene de SCIM con el token del propio usuario; si SCIM falla, los grupos no dan acceso).
- **Bootstrap:** el job de auto-config (`bundle/auto_config.py`) registra a quien hizo el deploy como primer admin.

Las rutas de administración pasan por `requireAdmin`. No hay doble aprobación para cambiar admins.

---

### 7. ¿Hay un registro de auditoría?

Hay **tres fuentes**, y ninguna es un registro de auditoría completo de la app:

- **Plataforma:** `system.access.audit` registra los eventos del workspace y de Unity Catalog. Es la fuente de referencia para saber quién hizo qué.
- **App:** `usage_ledger` (costo por llamada, por usuario y sesión) y los propios mensajes del chat.
- **Logs:** la salida de `console` del proceso, sin formato estructurado. La plataforma define la retención (cómo consultarlo: [operations.md](operations.md)).

*Brecha (G8):* las acciones administrativas (crear un admin, cambiar el catálogo MCP, cambiar modelos) no tienen una tabla de auditoría propia en la app.

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

- Las descripciones de tools MCP llegan al prompt truncadas a 300 caracteres, sin sanitización específica (G7).
- Los adjuntos entran al contexto como texto, sin una marca de "no confiable" (G12).

Lo que limita el daño: cada tool corre con el token OBO del usuario, así que una inyección no amplía los privilegios más allá de lo que el usuario ya puede hacer. El riesgo real es que el modelo ejecute una **escritura** que el usuario no quería. Por eso, la recomendación es restringir las tools de escritura por política (`app_tool_policy`) y exigir confirmación humana.

---

### 11. ¿Hay protección contra SSRF?

Sí, en el fetch web (`server/web.js`): bloquea `localhost`, IPs privadas (IPv4 e IPv6, incluidas las mapeadas), resuelve el DNS antes de conectar y limita los redirects. Hay una prueba en `server/web.test.js`. El mismo control **no** se verificó para las URLs de servidores MCP que informan los usuarios; trátalo como una pendiente que resolver antes de una revisión formal.

---

### 12. ¿Hay rate limit o protección contra abuso de costos?

**No en la app (G4).** Un usuario autenticado puede disparar muchos turnos. Las protecciones existentes son:

- Límites de recursos: SQL Warehouse 2X-Small, `max_num_clusters: 1`, auto-stop de 10 minutos; Lakebase con tope de 16 CU.
- Visibilidad: `usage_ledger` por usuario y el dashboard de costos.

*Recomendación:* un presupuesto nativo del workspace por usuario o grupo, y un límite de tasa en el proxy, si el workspace lo ofrece.

---

### 13. ¿Cómo se guardan las claves y contraseñas?

- **Ningún secreto en el repositorio.** `.env` está en `.gitignore`; `.env.example` no tiene valores reales.
- **Service principal:** `DATABRICKS_CLIENT_ID` y `DATABRICKS_CLIENT_SECRET` los inyecta el runtime de Apps.
- **`PGPASSWORD`:** existe solo para la base de datos de desarrollo local.
- **Tokens de usuario:** llegan en cada solicitud, en el header del proxy.

*Plataforma:* rotación y almacenamiento del secreto del SP.

---

### 14. ¿Se verifica la conexión con la base de datos?

**Parcialmente (G3).** La conexión usa TLS (`PGSSLMODE=require`), pero con `rejectUnauthorized: false` en `server/db.js`, así que la identidad del servidor no se valida contra una CA. Eso deja la conexión expuesta a un intermediario que pueda interceptar el tráfico dentro de la red del workspace. La corrección es fijar la CA de Lakebase. Hasta entonces, el riesgo debe aceptarse formalmente.

---

### 15. ¿La aplicación tiene headers de seguridad (CSP, HSTS)?

**Parcial (G6).** La app define `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` y `X-Frame-Options: SAMEORIGIN`, elimina `X-Powered-By` y envía una CSP conservadora (`frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'`), todo en `server/securityHeaders.js`. La CSP no restringe scripts, estilos ni imágenes, porque los iframes `srcdoc` de los decks heredan la política y necesitan scripts en línea y assets del design system (el motivo está en [SECURITY.md](SECURITY.md#protecciones-http)). HSTS viene del proxy de Apps. Lo que el proxy agrega a la respuesta no se ha verificado.

---

### 16. ¿Hay protección contra CSRF?

**Sí (G5, mitigada).** `server/csrfGuard.js` rechaza con 403 cualquier `POST`, `PUT`, `PATCH` o `DELETE` en `/api/*` que venga de otro sitio (`Sec-Fetch-Site` `cross-site` o `same-site`, o un `Origin` o `Referer` de otro host), antes de leer el cuerpo. No hay token anti-CSRF. La verificación de origen cubre los navegadores actuales y no depende del `SameSite` de la cookie del proxy, que sigue sin verificarse. Las solicitudes sin ninguno de estos headers (scripts, `npm run smoke`) pasan, porque no vienen de un navegador.

---

### 17. ¿Se auditan las dependencias?

**No en la CI hoy (G9).** El `.npmrc` tiene `audit=false`, y la CI no ejecuta `npm audit` ni ningún escaneo de dependencias. Lo que existe: `npm ci` con el lockfile (con `--ignore-scripts`) y un deploy que ejecuta el bundle versionado en el repositorio. El bundle incluye las dependencias de runtime, así que una vulnerabilidad en una dependencia permanece en el artefacto hasta que se regenera el bundle.

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
| Aislamiento entre usuarios en la base de datos | **No provisto** (es de aplicación) | Revisa las consultas nuevas (ver G2) |
| Auditoría de la plataforma | `system.access.audit` | Mantiene la retención y el acceso a la tabla |
| Escaneo de dependencias y CVEs | — | Ejecuta el escaneo y regenera el bundle |
| Rate limit y cuotas de uso | Parcial (proxy y presupuestos) | Configura presupuestos por usuario |
