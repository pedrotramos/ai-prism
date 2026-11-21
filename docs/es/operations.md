<!-- i18n: source=docs/operations.md source-hash=162166f94536536341cf3649364f1bad195a2dfb status=machine -->
# Operación de AI Prism

[English](../operations.md) · [Português (Brasil)](../pt-BR/operations.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../operations.md) es la referencia.

Este documento cubre lo necesario para mantener una instalación de AI Prism en
funcionamiento: cómo saber si está sana, dónde están los logs, qué monitorear, los SLO
propuestos y el runbook de despliegue, rollback y diagnóstico.

Los nombres de recursos son los de `databricks.yml` (app `ai-prism`, Lakebase `ai-prism`,
warehouse `ai-prism`, job `ai-prism-auto-config`). Los comandos usan `<PROFILE>` para el
profile de la CLI del workspace de destino; nada de esto depende de un host fijo.

- Modelo de amenazas y controles: [security-threat-model.md](../security-threat-model.md)
- Rendimiento y carga: [performance.md](../performance.md)
- Gobernanza de varias instalaciones: [fleet-governance.md](../fleet-governance.md)

---

## 1. Salud

`GET /api/health` indica si este proceso y su base de datos responden:

| Respuesta | Cuerpo | Cuándo |
|---|---|---|
| `200` | `{"status":"ok","db":"ok","version":"1.4.0","commit":null,"uptime_s":123}` | El `SELECT 1` en Lakebase respondió en 2 s o menos |
| `503` | `{"status":"degraded"}` | La consulta falló o no respondió en 2 s; el motivo está en el log (`health: database check failed: …`) |

```bash
# como lo hace el smoke: un token OAuth de usuario para la URL de la app
curl -sS -i -H "Authorization: Bearer $DATABRICKS_TOKEN" -H "x-request-id: probe-1" <APP_URL>/api/health
```

- Está detrás de la misma autenticación que toda ruta `/api` (el proxy de Apps aporta la
  identidad) y consulta con la identidad de quien llama, por el pool compartido, como cualquier
  otra consulta.
- Nunca retiene una conexión: el propio Postgres aborta la consulta a los 2 s (`SET LOCAL
  statement_timeout`, así la conexión del pool vuelve libre y sin ninguna configuración), la respuesta sale a los 2 s
  haga lo que haga el pool, y como máximo una verificación corre a la vez por proceso (los probes
  que llegan mientras tanto esperan la misma verificación).
- `version` se graba en el bundle del servidor en el build (vale aun sin `package.json` junto a
  `server-dist/`); la app también la registra en el log al arrancar (`AI Prism version <x.y.z>`).
- `commit` viene de la variable de entorno `AI_PRISM_COMMIT` cuando el despliegue la define; si
  no, es `null`.
- El `GET /health` propio de AppKit (sin `/api`) solo indica que el proceso está activo; también
  lleva `x-request-id`.
- Un probe sano no se escribe en el log; un 503 sí.

Otras señales:

| Señal | Cómo | Qué prueba | Qué no prueba |
|---|---|---|---|
| SPA | `GET <APP_URL>/` sin redirect | Proceso activo y `client/dist` presente | Base de datos, gateway |
| Identidad | `GET <APP_URL>/api/me` autenticado | Proceso, proxy y token aceptados | Base de datos: `/api/me` degrada a "no admin" cuando la base de datos falla |
| Persistencia | `npm run smoke` (paso "persistencia") | Escritura y lectura en Lakebase | Latencia real bajo carga |

El smoke completo (`npm run smoke`, con `APP_URL` y `DATABRICKS_TOKEN`) es la prueba de
salud que importa después de un despliegue. Crea una sesión de prueba, ejecuta un turno
real, lee los mensajes de vuelta, genera un documento y borra la sesión. Consulta
[§6.1](#61-despliegue) para el orden.

---

## 2. Logs

```bash
# últimas líneas de la app
databricks apps logs ai-prism -p <PROFILE>

# el comando también acepta --help para ver los filtros; revisa la versión de la CLI instalada
databricks apps logs --help
```

Cada línea del servidor es un objeto JSON con exactamente estos campos (`null` cuando el campo
no aplica):

| Campo | Contenido |
|---|---|
| `ts` | Marca de tiempo ISO-8601 |
| `level` | `debug`, `info`, `warn` o `error` (`warn` y `error` van a stderr) |
| `request_id` | El id de la solicitud, también devuelto en la cabecera de respuesta `x-request-id`. Un `x-request-id` entrante (letras, dígitos, `.`, `_`, `:`, `-`, hasta 128 caracteres) se conserva; si no, el servidor genera un UUID |
| `user_hash` | Los primeros 12 caracteres hex del SHA-256 del e-mail del usuario en minúsculas: agrupa las líneas de un usuario sin la dirección |
| `route` | Método y patrón de la ruta (`POST /api/sessions/:id/compact`); nunca la query string |
| `status` | Estado HTTP, en la línea de acceso |
| `duration_ms` | Duración de la solicitud, en la línea de acceso |
| `msg` | El mensaje; un error va después de `: ` |

Cada solicitud `/api` escribe una línea de acceso (`"msg":"request"`) cuando termina su
respuesta, y también cualquier 5xx fuera de `/api`. Las líneas escritas mientras se atiende una
solicitud (un aviso en medio de un turno) llevan su `request_id`, así que todas las líneas de una
solicitud se pueden reunir; quien reporta un problema puede indicar el `x-request-id` de la
respuesta que falló.

Lo que nunca llega al log: solo se escriben los campos de arriba, así que ningún prompt,
respuesta, cuerpo de solicitud ni argumento de tool; los e-mails pasan a `[email]`, los bearer
tokens, tokens de acceso personal y JWT pasan a `[token]`, y las sentencias SQL pasan a `[sql]`
(lo garantiza `server/log.test.ts`). Un mensaje tiene como máximo 1000 caracteres.

Mensajes que merecen una alerta manual (el inicio de `msg`, texto exacto):

| Mensaje (inicio) | Significado | Acción |
|---|---|---|
| `AI Prism listening on :<porta>` | El proceso arrancó | Confirmar después de cada despliegue o reinicio |
| `identity-binding: could not verify the forwarded token, allowing the request (…)` | El workspace no respondió a `SCIM /Me` (timeout, 5xx, scope); la petición pasó sin el vínculo correo ↔ token. Como máximo 1 línea por minuto | Si es frecuente: revisar el workspace y el scope `iam.current-user:read` del token OBO |
| `identity-binding: identity_mismatch: … (IDENTITY_BINDING=warn, allowed)` / `identity-binding: invalid_token: …` | Modo `warn`: la divergencia se registró y la petición pasó | Diagnóstico del rollback; corregir la causa y volver a `enforce` ([SECURITY.md](SECURITY.md#vínculo-entre-correo-y-token-serveridentitybindingts)) |
| `identity-binding: rejected a request: identity_mismatch` / `invalid_token` | Una petición llegó con un correo que no es del dueño del token, o con un token rechazado por el workspace, y recibió 401 | Ver [§6.5](#65-tokens-y-lakebase); si se repite sin explicación, es señal de un intento de suplantación |
| `unhandled error on <MÉTODO> <rota> -> <status>:` | Error que ninguna ruta manejó (JSON mal formado, subida grande, excepción); el cliente recibió JSON genérico | Leer el detalle en la propia línea |
| `lakebase: service-principal login unavailable, using per-user identity:` | Falló el login del SP; la app usó la identidad del usuario | Ver [§6.5](#65-tokens-y-lakebase) |
| `lakebase: permission denied for the service principal (…); identity unchanged` | Al SP le falta un privilegio: sus grants no se aplicaron o están desactualizados | Ejecutar `node scripts/migrate.mjs grants --role <SP>` como dueño de las tablas ([§6.4](#64-migraciones-de-la-base)) |
| `migrations: 0002 schema_ai_prism deferred … ownership not normalized` | El traspaso de propiedad no se ejecutó antes de publicar el código nuevo; el app sigue en `public` | Ejecutar el job de auto-config (o `migrate.mjs prepare`) y luego `migrate.mjs grants` ([§6.4](#64-migraciones-de-la-base)) |
| `lakebase SP pool: idle client error (dropped):` | Se cayó una conexión inactiva (normal tras una suspensión) | Investigar solo si es frecuente |
| `embedding update failed:` / `message embedding index failed:` / `title/session update failed:` | Falló el posprocesamiento del turno (no impide la respuesta) | Si es frecuente, indica un problema en el gateway de embeddings |
| `transcrição falhou (…)` / `análise de planilha falhou (…)` / `ingestão de pptx falhou (…)` | Falló un adjunto específico | Lee el mensaje para conocer el motivo |
| `history retrieval failed:` | Falló la recuperación del historial (pgvector) | Revisar la extensión `vector` y el índice |
| `python tool setup failed, continuing without it:` | UDF de Python no disponible (warehouse, grant o scope `sql`) | Ver [§6.5](#65-tokens-y-lakebase) |
| `migrations: applied <NNNN> <nombre>` / `migrations: recorded 0001 baseline for an existing 1.x schema (no DDL run)` | Se aplicó una migración en el arranque / una base 1.x quedó registrada como versión 1 | Esperado una vez por migración nueva. Ver [§6.4](#64-migraciones-de-la-base) |
| `migrations: existing 1.x schema is incomplete (missing N: …)` | A una base 1.x le falta algún elemento del baseline (tabla, columna, índice o constraint); se ejecuta el `0001` idempotente en lugar de solo registrarlo | Ninguna, salvo que aparezca la línea siguiente |
| `migrations: after 0001 baseline the schema still differs from the baseline (…)` | Divergencia que el `0001` no corrige (p. ej. una constraint borrada a mano); el app sigue | Corregir a mano o restaurar un backup ([§6.4](#64-migraciones-de-la-base)) |
| `migrations: the database has versions this code does not know (…)` | Una release más nueva migró la base (p. ej. después de un rollback de código) | Esperado en un rollback; ver [§6.2](#62-rollback) |
| `migrations: no privilege to record the schema version (42501: …)` | La identidad del app no puede crear ni escribir `schema_migrations`; el schema 1.x está completo y el app sigue | Ejecutar `scripts/migrate.mjs up` como dueño de las tablas ([§6.4](#64-migraciones-de-la-base)) |
| `migrations: applied file changed: …` `[MIGRATION_CHECKSUM]` | Se editó un archivo de migración ya aplicado; el app no arranca | Restaurar el archivo publicado ([§6.4](#64-migraciones-de-la-base)) |
| `limpeza de imagens da sessão falhou:` | No se borró el archivo del Volume | Limpieza manual si persiste |

*Consultas de ejemplo:* con la salida de `apps logs` en un archivo local (cada línea JSON puede
llevar un prefijo del recolector de logs, por eso el `grep -o`):

```bash
# guardar el log
databricks apps logs ai-prism -p <PROFILE> > app.log

# todas las líneas de una solicitud
grep -o '{"ts".*}' app.log | jq -c 'select(.request_id == "<REQUEST_ID>")'

# errores del servidor con ruta y duración
grep -o '{"ts".*}' app.log | jq -r 'select(.status >= 500) | [.ts, .route, .status, .duration_ms, .msg] | @tsv'

# solicitudes por ruta
grep -o '{"ts".*}' app.log | jq -r 'select(.msg == "request") | .route' | sort | uniq -c | sort -rn
```

El servidor no agrega datos; para conteos en el tiempo, usa las tablas de telemetría
([§3](#3-telemetría-opentelemetry)).

---

## 3. Telemetría OpenTelemetry

El servidor crea tres tipos de span con la API de OpenTelemetry:

| Span | Atributo | Significado |
|---|---|---|
| `llm.call` | `gen_ai.request.model` | Serving endpoint llamado |
| `llm.call` | `gen_ai.usage.input_tokens` | Tokens de prompt (incluidos los de caché), tal como los informó el gateway |
| `llm.call` | `gen_ai.usage.output_tokens` | Tokens de salida, contados como en el ledger de costos: el mayor entre `completion_tokens` y `total_tokens − prompt_tokens` |
| `llm.call` | `cost_usd` | Costo con precio de la llamada (el precio del ledger); ausente fuera de una solicitud de usuario |
| `llm.call` | `status` | `ok` o `error` |
| `tool.call` | `tool.name` | Nombre de la función que llamó el modelo (`execute_python`, `ask_genie_one`, una función UC, una tool MCP) |
| `tool.call` | `tool.kind` | `python`, `genie`, `genie-one`, `vector-search`, `uc`, `mcp-external`, `image-gen`, … |
| `tool.call` | `duration_ms` | Duración de la llamada a la tool |
| `tool.call` | `status` | `ok` o `error` (también `error` cuando la tool respondió con un texto `ERROR:`) |
| `chat.turn` | `route` | `/api/chat`, `/api/sessions/:id/continue` o `/api/sessions/:id/messages/:messageId/regenerate` |
| `chat.turn` | `request_id` | El `x-request-id` de la respuesta, también en las líneas de log y en el evento SSE `meta` |
| `chat.turn` | `session.id` | Id de la sesión de chat (vacío cuando la solicitud se rechazó antes de haber uno) |
| `chat.turn` | `model` | Modelo que el usuario eligió para el turno |
| `chat.turn` | `caps` | Capacidades activadas en el turno, separadas por comas (`deck`, `document`, `image`, …) |
| `chat.turn` | `status` | `ok`, `error`, `cancelled` (el cliente se fue; no se guardó nada) o `rejected` (4xx antes del streaming, como `409 turn_in_flight`) |
| `chat.turn` | `saved` | Solo en `cancelled`: `false` cuando no se guardó nada (la regla), `true` cuando el cliente se fue con la respuesta ya guardándose, así que se guardó entera |
| Span HTTP de servidor | `http.status_code`, `http.method`, `http.target` | Un span por solicitud, llamado `<MÉTODO> <ruta>` (`kind = SPAN_KIND_SERVER`); lo agrega AppKit, no AI Prism. El trace de un turno empieza aquí: `POST /api/chat` es el padre de `chat.turn` |

Cada ronda de chat, título, clasificación de intención, embedding y generación de imagen produce
un `llm.call`; cada invocación de tool produce un `tool.call`. Los atributos nunca llevan texto
de prompt, argumentos de tool, e-mails ni SQL. Cada ruta de turno produce un `chat.turn`, padre
de todo `llm.call` y `tool.call` de ese turno, así que un trace es un turno.

**Exportación.** Los spans solo se exportan cuando `OTEL_EXPORTER_OTLP_ENDPOINT` está definida: AppKit entonces
registra el exportador OTLP. Sin ella, y siempre con `APPKIT_BOOT=0`, los spans son no-ops:
no se exporta nada y nada falla. Databricks Apps define la variable cuando la telemetría de la app está
activada (Beta, solo en regiones soportadas; las tablas deben ser Delta administradas en la región del
workspace). Verificado en un workspace real: tras un redeploy, los spans llegan a
`otel_spans` alrededor de un minuto después de la solicitud (el protocolo `grpc` que anuncia el runtime no es un problema).

Usa el script, no un comando escrito a mano. `databricks apps update --json` **reemplaza el spec
completo de la app**: enviar solo `telemetry_export_destinations` borraría los recursos de la app
(warehouse, Lakebase) y sus scopes de API del usuario. El script lee la app antes y fusiona.

```bash
# crea el schema una vez; el service principal de la app necesita USE CATALOG en el catálogo y
# USE SCHEMA + CREATE TABLE + SELECT + MODIFY en el schema (la plataforma crea las tablas)
scripts/telemetry/enable.sh --profile <PROFILE> --app <APP_NAME> --catalog <catalog> --schema <schema> --dry-run   # solo imprime
scripts/telemetry/enable.sh --profile <PROFILE> --app <APP_NAME> --catalog <catalog> --schema <schema>
# luego haz redeploy de la app (§6.1): la variable se lee al iniciar
```

El script exige `--profile` y `--app` explícitos, acepta solo identificadores simples, no imprime
secretos y **rechaza la app llamada `ai-prism`**: cambia la app en producción a mano con el mismo payload
(`{"telemetry_export_destinations":[{"unity_catalog":{"logs_table":"<c>.<s>.otel_logs","metrics_table":"<c>.<s>.otel_metrics","traces_table":"<c>.<s>.otel_spans"}}]}`),
después de leer su spec actual para no perder nada más. Donde la región no está soportada,
`OTEL_EXPORTER_OTLP_ENDPOINT` puede apuntar a un colector propio.

**Dashboard.** `dashboards/ai-telemetry.lvdash.json` ("AI Prism — Telemetry") se **genera**
con `dashboards/build.py` para un `catalog.schema` (un archivo Lakeview no acepta variables
del bundle). Edita el generador, nunca el JSON; `python3 dashboards/build.py --check` falla cuando
el archivo en disco está desactualizado. El archivo versionado apunta a `ai_prism.telemetry`, los valores por defecto de las
variables del bundle `telemetry_catalog` y `telemetry_schema`; para otro schema ejecuta
`python3 dashboards/build.py --catalog <catalog> --schema <schema>` antes del `bundle deploy`.
Pestaña **Telemetria**: solicitudes, 5xx, turnos y llamadas al gateway, solicitudes por día por clase de estado,
turnos por día por resultado, y tablas de rutas (p95), modelos (llamadas, errores, tokens, costo, p95)
y herramientas. Pestaña **Falhas e trace**: las fallas de los últimos 7 días con su `trace_id`, y un
filtro que muestra todos los spans de un trace.

**Consulta.** `attributes` es `VARIANT`; revisa las columnas con
`DESCRIBE TABLE <catalog>.<schema>.otel_spans` antes de la primera consulta. Las llamadas al
gateway y a tools más lentas de las últimas 24 horas:

```sql
SELECT
  time,
  trace_id,
  name,
  attributes:['gen_ai.request.model']::string AS model,
  attributes:['gen_ai.usage.input_tokens']::bigint AS input_tokens,
  attributes:['gen_ai.usage.output_tokens']::bigint AS output_tokens,
  attributes:['cost_usd']::double AS cost_usd,
  attributes:['tool.name']::string AS tool,
  attributes:['status']::string AS status,
  (end_time_unix_nano - start_time_unix_nano) / 1e6 AS duration_ms
FROM <catalog>.<schema>.otel_spans
WHERE service_name = 'ai-prism'
  AND name IN ('llm.call', 'tool.call')
  AND time >= current_timestamp() - INTERVAL 24 HOURS
ORDER BY duration_ms DESC
LIMIT 50
```

`service_name` es el nombre de la app. La retención es la de la tabla Delta (la app no define
ninguna).

---

## 4. Qué monitorear

| Señal | Fuente hoy | Umbral de atención | Acción |
|---|---|---|---|
| Disponibilidad (`/api/health` con 200 y `db: ok`, `/` y `/api/me` con 2xx) | Smoke y prueba de carga; `GET /api/health` (autenticado; responde `{ status, db, version, commit, uptime_s }`, 503 `degraded` cuando la base de datos no responde en 2 s) | Cualquier falla en 5 min | Ver [§6.6](#66-proceso-bloqueado-o-sin-respuesta) |
| Errores 5xx en la app | Logs (`apps logs`) | Ver SLO S1 | Diagnóstico según [§6.7](#67-diagnosticar-un-turno-lento) |
| Latencia de API | Prueba de carga (`npm run loadtest`) | Ver SLO S2 | Medir en el mismo entorno |
| Turno de chat (TTFT y finalización) | Smoke y prueba de carga; SSE del cliente | Ver SLO S3 y S4 | [§6.7](#67-diagnosticar-un-turno-lento) |
| Costo por día y por modelo | Dashboard de costos (`ai-costs`) | Límite definido por el operador (ver alerta A5) | Revisar usuario y endpoint |
| Volumen, usuarios activos y tokens | Dashboard de operación (`ai-ops`) | Sin límite fijo | Seguir la tendencia |
| Latencia del gateway | `system.ai_gateway.usage` (dashboard `ai-ops`) | Ver SLO S3 | Con retraso de ingestión |
| CPU, memoria y conexiones de Lakebase | Consola de Lakebase | Ver alerta A4 | Dimensionar CU |
| Consumo del SQL Warehouse | Consola del warehouse | Auto-stop de 10 min | Confirmar que se apaga |
| Cambios de admin y ejecuciones de retención | `GET /api/admin/audit` (solo admins) | Cualquier acción de admin que nadie sepa explicar; falta una fila `retention.sweep` por más de un día mientras `retentionDays` está activa | [§6.8](#68-retención-instrucciones-de-la-organización-y-registro-de-auditoría-de-admin) |
| Avisos de arranque | Logs (`apps logs`): `APP_AUDIT_HASH_KEY is not set`, `the database has versions this code does not know`, `migrations: no privilege to record the schema version` | Cualquiera de ellos después de un despliegue | [§6.4](#64-migraciones-de-la-base), [§6.10](#610-roles-y-row-level-security) |

**Limitación:** sin telemetría ([§3](#3-telemetría-opentelemetry)) no hay métrica de error por
ruta ni percentil de latencia del servidor; esos números salen solo de la prueba de carga, que mide
desde el lado del cliente. Con la telemetría activada, el dashboard `ai-telemetry` muestra ambos
(5xx y p95 por ruta, errores por modelo y herramienta) y las alertas A2 y A7 los vigilan.

---

## 5. SLO y alertas

Los números siguientes son **propuestas**. Deben validarse con `npm run loadtest` en el
entorno real antes de convertirse en un compromiso. Medición: las fuentes de §4.

### 5.1 SLO propuestos

| ID | SLO | Objetivo | Ventana | Medición hoy |
|---|---|---|---|---|
| S1 | Disponibilidad de la API (`/api/me` responde 2xx) | ≥ 99,5% | 30 días, excluyendo las ventanas de despliegue anunciadas | Prueba de carga periódica; logs |
| S2 | Latencia de lectura (`/api/me`, `/api/models`, `/api/sessions`) | p95 ≤ 800 ms con la app caliente, con 20 usuarios virtuales | Por prueba de carga | `npm run loadtest` |
| S3 | Primer token del turno (evento `meta` hasta el primer `token`) | p95 ≤ 4 s, modelo rápido, sin cold start de Lakebase | Por prueba de carga | Smoke y `loadtest --chat` |
| S4 | Turno completado sin evento `error` | ≥ 98% | 7 días | Spans `chat.turn` con `status = error` (dashboard `ai-telemetry`, alerta A7) con la telemetría activada; si no, `loadtest --chat` |
| S5 | Primera petición tras la suspensión de Lakebase | ≤ 15 s | Por ocurrencia | Logs y prueba manual (el `connectionTimeoutMillis` del pool es 15 s, `server/db/pool.js`) |
| S6 | Smoke post-despliegue | 100% en verde antes de liberar el tráfico | Por despliegue | `npm run smoke`; el mismo script se ejecuta en cada PR en la CI ([§5.3](#53-smoke-en-la-ci)) |

### 5.2 Reglas de alerta propuestas

| ID | Condición | Ventana | Severidad | Acción |
|---|---|---|---|---|
| A1 | Falla el smoke post-despliegue (S6) | Inmediata | Crítica | Rollback ([§6.2](#62-rollback)) |
| A2 | Más del 5% de respuestas 5xx o errores de login (302 o 401) en `/api/*` (al menos 5 solicitudes) | 10 min | Alta | Trace de la solicitud que falló (abajo); token y Lakebase ([§6.5](#65-tokens-y-lakebase)) |
| A3 | Secuencia de `lakebase: service-principal login unavailable` en los logs | 10 min | Alta | Ver [§6.5](#65-tokens-y-lakebase) |
| A4 | Lakebase en el techo de 16 CU por más de 15 min | 15 min | Media | Revisar la carga; evaluar un techo mayor |
| A5 | Costo diario (`usd` en `ai-costs`) por encima de 2× el promedio móvil de 7 días | Diaria | Media | Revisar usuario y endpoint en el dashboard |
| A6 | Usuario con volumen de llamadas por encima de lo esperado (dashboard `ai-ops`, pestaña por usuario) | Diaria | Media | Revisar el caso; puede ser abuso (G4) |
| A7 | Más del 10% de los spans `chat.turn` terminan en `error` (al menos 5 turnos) | 30 min | Alta | Trace del turno que falló (abajo); SLO S4 |

**Cómo ejecutarlo hoy:** A1 viene del script de despliegue (si falla el smoke, falla el
despliegue). A5 y A6 son consultas de alerta en Databricks SQL sobre los datasets de los
dashboards. **A2 y A7 son alertas SQL sobre las tablas de telemetría**, declaradas en `databricks.yml`
(`alerts.ai_prism_a2_http_errors`, `alerts.ai_prism_a7_turn_errors`) con las tablas tomadas de las
variables `telemetry_catalog` y `telemetry_schema`. Nacen **pausadas** (`telemetry_alerts_pause=PAUSED`):
sus consultas leen `otel_spans`, que solo existe después de activar la telemetría
([§3](#3-telemetría-opentelemetry)). Cuando exista, despliega con `--var telemetry_alerts_pause=UNPAUSED`
(y tu catálogo y schema) y agrega suscriptores a cada alerta en el workspace. Cada alerta devuelve
`error_pct` (la columna evaluada) y `last_failing_trace_id`. A3 sigue dependiendo de leer los logs.

**De la alerta al trace en tres clics.**

1. Abre la alerta desde su notificación: la fila de resultado muestra `error_pct` y `last_failing_trace_id`.
2. Abre el dashboard de telemetría desde el enlace en la descripción de la alerta, pestaña **Falhas e trace**.
3. Elige ese trace id en el filtro **Trace id**: la tabla lista todos los spans del turno
   (`POST /api/...` → `chat.turn` → `llm.call` / `tool.call`) con resultado y duración. El paso
   que falló es el que tiene `error` o 5xx.

Sin el dashboard, el mismo trace en SQL: `SELECT time, name, attributes:['status']::string AS status,
(end_time_unix_nano - start_time_unix_nano) / 1e6 AS duration_ms FROM <catalog>.<schema>.otel_spans
WHERE trace_id = '<id>' ORDER BY time`. El `request_id` del turno (líneas de log, `meta` del SSE) es un
atributo del span `chat.turn`.

### 5.3 Smoke en la CI

El `scripts/smoke.mjs` del post-despliegue (S6) también se ejecuta en cada PR y en cada
push a `main`, en el job `Build & QA`. Así, una rotura en el recorrido del usuario aparece
antes del merge y no solo después del despliegue. El paso:

1. levanta `scripts/fake-gateway.mjs` en `127.0.0.1:8787`. Es un AI Gateway falso cuyos
   formatos (streaming, `tool_calls`, `usage`, embeddings) están fijados a una grabación de
   un gateway real (`tests/fixtures/gateway-shapes.live.json`);
2. levanta `node server/index.js` con `LOCAL_DEV_MODE=1`, `DATABRICKS_HOST` apuntando al
   gateway falso y el Postgres con pgvector del servicio de la CI;
3. ejecuta `npm run smoke` con `SMOKE_SKIP_ARTIFACT=0` y `SMOKE_EXPECT_EMAIL`. Verifica
   la SPA, la identidad, los modelos, un turno de chat por SSE, la persistencia, el
   listado, el artefacto y la limpieza. Para el artefacto, el gateway falso responde al
   pedido de documento con un bloque `document`, que el servidor guarda;
4. si algo falla, imprime los logs del servidor y del gateway falso en el propio job.

Lo que este smoke **no** prueba: la autenticación del proxy de Apps, un Lakebase real, ni
modelos y latencia reales. Eso sigue a cargo del smoke post-despliegue contra la URL de la
App ([§6.1](#61-despliegue)). Para reproducirlo en local, consulta "Smoke local" en
[CONTRIBUTING.md](CONTRIBUTING.md#smoke-local).

### CI (rama efímera de Lakebase)

El workflow [`Lakebase branch`](../../.github/workflows/lakebase-branch.yml) (separado de
`ci.yml`) prueba, contra un Lakebase **real** (Postgres 17, `databricks_auth`), lo que el Postgres
desechable del job principal no prueba: las migraciones suben, bajan hasta 0 y vuelven a subir, y
las suites de aislamiento y de RLS pasan. Se ejecuta en los PR que tocan migraciones, `server/db*` o
el script, y bajo demanda. Quien hace el trabajo es
[`scripts/ci/lakebase-branch.sh`](../../scripts/ci/lakebase-branch.sh):

1. crea la branch `w3-1-<run>` a partir de `production` con un TTL de 4 h (la red de seguridad si el
   job muere). `production` es solo el origen de la copia; nunca recibe escrituras ni se borra;
2. crea una **base nueva** `ai_prism_ci` y el rol `ai_prism_app` (`NOSUPERUSER`, `NOBYPASSRLS`) en
   ella. Las tablas copiadas de producción pertenecen al service principal de la app en producción
   y no se pueden asumir, así que no se usa nada de ellas;
3. ejecuta `migrate.mjs up` y luego la guarda de rol: imprime `current_user`, `rolsuper` y
   `rolbypassrls` del rol con el que corren las suites y **hace fallar el job** si alguna bandera es
   verdadera. La identidad que despliega y `databricks_superuser` tienen `rolbypassrls = t`, y una
   suite de RLS ejecutada con ese rol pasa sin probar nada;
4. ejecuta `server/isolation.test.js` y `server/rls.test.js` (35 casos, ninguno omitido);
5. ejecuta `migrate.mjs down --to 0 --yes` y luego `up` otra vez;
6. borra la branch por su ruta literal, en un trap que también corre cuando un paso falla. El borrado
   rechaza cualquier ruta que contenga `production` o que no sea `projects/<p>/branches/w3-1-<id>`.
   Un paso `always()` barre después las branches de la propia ejecución.

Las suites conectan con `ssl: false`, a un host de loopback, con una sola contraseña para todos los
roles. Lakebase exige TLS, acepta solo el token OAuth como login (el login nativo por contraseña
está desactivado) y un rol creado por SQL no puede entrar. Por eso el job ejecuta
[`scripts/ci/pg-tls-proxy.mjs`](../../scripts/ci/pg-tls-proxy.mjs) en `127.0.0.1`: habla TLS con el
endpoint, cambia una contraseña desechable por el token y mapea un login como rol `X` a la identidad
del despliegue con `-c role=X`. La sesión pasa a correr como `X` (`current_user = X`, `rolbypassrls`
de `X`), que es lo que comprueba la guarda de rol.

**Sin credenciales el job se omite y sigue en verde**, con un aviso en el log. Necesita tres
secrets del repositorio, creados por una persona (el workflow nunca los crea): `LAKEBASE_CI_HOST`,
`LAKEBASE_CI_CLIENT_ID` y `LAKEBASE_CI_CLIENT_SECRET` (un service principal que crea y borra branches
del proyecto y pertenece a `databricks_superuser`), y opcionalmente la variable
`LAKEBASE_CI_PROJECT` (por defecto `ai-prism`). El tiempo total es de unos 15 minutos, casi todo en
la suite de RLS por la red. Para ejecutarlo en local igual:

```bash
# needs: databricks CLI, psql, node, jq, perl. Never touches the production branch.
SECRETS_PRESENT=1 LB_PROFILE=<PROFILE> LB_SUFFIX=local1 \
  LB_EVIDENCE_DIR=./evidence bash scripts/ci/lakebase-branch.sh run
```

Si un job muere, busca branches `w3-1-*` sobrantes (`databricks postgres list-branches
projects/<p>`); el TTL las elimina de todos modos. Una branch en `ARCHIVED` despierta en la primera
conexión; no es un incidente.

---

## 6. Runbook

### 6.1 Despliegue

**Preferido: un solo script.** `./deploy.sh [options] <PROFILE> [CATALOG]` genera los artefactos
(`npm run bundle`), ejecuta `bundle deploy`, ejecuta el job de auto-config, abre el traspaso al
dueño (`migrate.mjs prepare`), publica el código (`apps deploy`), ejecuta el smoke (`npm run smoke`)
contra la URL de la app y, al final, ejecuta `migrate.mjs up --role <app SP>` como dueño de la base
de datos (migraciones, grants de mínimo privilegio, cierra el traspaso). El target viene de
`AI_PRISM_TARGET` (`dev` por defecto; `prod` para el despliegue oficial). Un smoke fallido no hace
rollback: la versión nueva ya está en producción, así que lee la tabla del smoke antes de dar
acceso a los usuarios. La descripción completa y las opciones (`--skip-build`, `--skip-smoke`,
etiquetas, usage policy) están en [onboarding-deployment.md](onboarding-deployment.md).

```bash
AI_PRISM_TARGET=prod ./deploy.sh <PROFILE>
```

**Manual, paso a paso** (la misma secuencia que ejecuta el script; úsala para retomar una
ejecución fallida). Los PR de funcionalidades no incluyen `client/dist` ni `server-dist` en el
commit; los PR de release los regeneran y los incluyen.

<!-- i18n: code-translated en=19a229b432d5 -->
```bash
# valida la configuración (no crea nada)
databricks bundle validate -p <PROFILE> -t dev

# 0) artefactos que ejecuta la app
npm run bundle

# 1) Lakebase, warehouse, app, dashboards y job
databricks bundle deploy -p <PROFILE> -t dev

# 2) auto-config (rol PG del SP y traspaso al dueño, UDF de Python, Volume de imágenes, semilla de admin).
#    Ejecútalo ANTES de publicar el código.
databricks bundle run ai_prism_auto_config -p <PROFILE> -t dev

# 2b) como dueño de la base de datos: abre el traspaso al dueño para el SP de la app (§6.4)
node scripts/migrate.mjs prepare --role <app SP client id>

# 3) publica el CÓDIGO de la app. El bundle deploy NO republica el proceso en ejecución.
#    <SRC> lo imprime el bundle deploy (normalmente .../.bundle/ai-prism/dev/files)
databricks apps deploy ai-prism --source-code-path <SRC> -p <PROFILE>

# 4) smoke (S6): bloquea la liberación si falla
APP_URL=<URL-de-la-app> DATABRICKS_TOKEN=<token-oauth> npm run smoke

# 5) como dueño de la base de datos: migraciones pendientes y grants del SP; cierra el traspaso
node scripts/migrate.mjs up --role <app SP client id>
```

Para `DATABRICKS_TOKEN`, usa el token OAuth del usuario (`databricks auth token -p <PROFILE>`).
No pegues el token en logs ni en issues. Nunca dejes el paso 2b sin el paso 5: si una ejecución se
detiene entre ambos, ejecuta `node scripts/migrate.mjs close --role <app SP client id>` (solo revoca).

### 6.2 Rollback

El rollback normal es de **código**. El schema de la base solo vuelve atrás junto con él
cuando la versión nueva trajo una migración que la anterior no soporta (ver [§6.4](#64-migraciones-de-la-base)).

1. Identifique el último commit bueno (tag o SHA) con `client/dist` y `server-dist`
   consistentes.
2. **Schema:** compare `server/migrations/` de las dos versiones. Si la versión nueva no
   trajo migración, o si la migración nueva solo agrega (una tabla o columna que la versión
   anterior ignora), no toque la base: la versión anterior arranca sin problema sobre una
   base más nueva (cada arranque registra `the database has versions this code does not know`). Si la
   migración nueva cambia algo que la anterior lee, ejecute el `down` **con el código nuevo
   todavía a mano**, antes de cambiar el código:
   `node scripts/migrate.mjs down --to <última versión de la release anterior> --yes`.
3. Haga checkout de los artefactos buenos en una rama de hotfix (no reescriba `main`).
4. Repita [§6.1](#61-despliegue) desde el paso 1.
5. Confirme con `npm run smoke`.

*Atención:* el `down` de una migración puede borrar datos que solo la versión nueva grabó.
Lea el archivo `.down.sql` antes de ejecutarlo.

**Por entorno.**

| Entorno | Quién puede hacer rollback | Cómo | Verificaciones adicionales |
|---|---|---|---|
| Desarrollo local | El desarrollador | `git checkout`, luego `node --env-file=.env.local scripts/migrate.mjs status`; `down --to <N> --yes` es aceptable en una base de datos de prueba | Revisa la línea `target:` que imprime el comando antes de `down` |
| CI / base de datos efímera | Nadie: se descarta la base de datos | Volver a crearla | `down --to 0` es aceptable solo aquí |
| Target `dev` (`AI_PRISM_TARGET=dev`) | El responsable técnico | Pasos 1-5 de arriba con los artefactos anteriores; `down` solo para una migración incompatible | Avisa a quienes están probando; `dev` antepone el nombre de usuario de quien despliega a los nombres de los recursos |
| Target `prod` | El responsable técnico, con el responsable del costo y de los datos informado ([fleet-governance.md §2](fleet-governance.md#2-dueño-y-responsables)) | Pasos 1-5 de arriba desde una rama de hotfix; `down` **solo** después de leer el `.down.sql` y, si borra datos, después de anotar un punto de restauración point-in-time de Lakebase | Ejecuta `npm run smoke` contra la URL de la app; registra el SHA del commit en el inventario |

Si los artefactos están bien pero los datos están mal (por ejemplo, un `retentionDays` reducido),
el rollback de código no ayuda: el point-in-time restore de Lakebase es la única vuelta atrás ([§6.8](#68-retención-instrucciones-de-la-organización-y-registro-de-auditoría-de-admin)).

### 6.3 Detener e iniciar la App

```bash
databricks apps get ai-prism -p <PROFILE>
databricks apps stop ai-prism -p <PROFILE>
databricks apps start ai-prism -p <PROFILE>
```

Consulta `databricks apps --help` para la versión de la CLI instalada.

### 6.4 Migraciones de la base

El schema del Lakebase se versiona en archivos SQL:

<!-- i18n: code-translated en=72cf80e8695f -->
```
server/migrations/NNNN_<nombre>.up.sql     el cambio (obligatorio)
server/migrations/NNNN_<nombre>.down.sql   su rollback (obligatorio)
```

La tabla `schema_migrations(version, name, checksum, applied_at)` registra lo que ya se
aplicó. La versión `0001_baseline` es exactamente el schema que la 1.4 creaba al arrancar.

**Al arrancar (automático).** La primera petición de cada proceso ejecuta `ensureSchema`,
que aplica las migraciones pendientes en orden. Cada una corre en una transacción junto con
su fila en `schema_migrations`: o entra completa y registrada, o no entra. Un advisory lock
de Postgres deja migrar a un solo proceso a la vez; los demás esperan y encuentran todo
aplicado. Con todo aplicado, el costo son dos `SELECT` y ningún lock. La espera del lock tiene límite
(2 min): pasado ese tiempo, la petición falla con `[MIGRATION_LOCK_TIMEOUT]` y la siguiente
vuelve a intentar. Como cada archivo corre en una transacción, los comandos que Postgres
rechaza dentro de una transacción (`CREATE INDEX CONCURRENTLY`, `VACUUM`) no pueden ir en
una migración.

**Base creada por una versión 1.x.** Sin `schema_migrations`, el runner revisa en el catálogo
de Postgres cada tabla, columna, índice y constraint (con su definición) que crea el `0001`.
Si está todo, registra la versión 1 sin ejecutar DDL (log
`recorded 0001 baseline for an existing 1.x schema`). Si falta algo (una 1.x más antigua o
un schema parcial), ejecuta el `0001` completo, que es idempotente y completa lo que falta
sin tocar los datos, y registra lo que faltaba (`existing 1.x schema is incomplete`). El
`0001` no recrea todo: una constraint borrada a mano, por ejemplo, sigue faltando. En ese
caso el log dice `the schema still differs from the baseline` con la lista y el app sigue;
corríjalo a mano.

**Identidad.** Quien crea `schema_migrations` y ejecuta DDL tiene que ser el dueño de las
tablas. Si el app arranca con el service principal en una base creada por otra identidad, y
el schema 1.x ya está completo, el app sigue funcionando y registra
`migrations: no privilege to record the schema version`. En ese caso, ejecute `up` una vez
como el dueño (abajo). Si hay una migración nueva pendiente y el SP no puede aplicarla, el
error aparece. Un `permission denied` (42501) en el SP ya no cambia a la identidad del
usuario: el app registra `lakebase: permission denied for the service principal (…); identity unchanged`,
devuelve el error y pide una ejecución de grants (como mucho cada 5 minutos). En un app
desplegado esa ejecución no hace nada, porque el SP no puede concederse privilegios a sí
mismo. La solución es `node scripts/migrate.mjs grants --role <SP>` como dueño de las
tablas (abajo).

**Schema dedicado y mínimo privilegio (0002).** La migración `0002_schema_ai_prism` mueve
las 20 tablas del app y `schema_migrations` de `public` al schema `ai_prism`. Las
secuencias, los índices (también el índice vectorial HNSW) y las filas van con ellas. El
`down` las devuelve y borra el schema vacío. El app se conecta con
`search_path = ai_prism, public` (`vector` sigue en `public`). Las bases ya desplegadas
tienen dueños mezclados: el SP es dueño de la mayoría de las tablas y la identidad del
despliegue es dueña de `app_admins`. Por eso el despliegue se las pasa a un rol neutro
`NOLOGIN`, `ai_prism_owner`, en tres etapas: `prepare` (el job de
auto-config y luego `migrate.mjs prepare` en `deploy.sh`/`deploy.ps1`, antes de publicar el
código), `0002` (la primera petición del SP) y `grants` (`migrate.mjs up --role` después del
smoke, en cualquier salida con el traspaso abierto; los scripts solo terminan con éxito con
el SP fuera de `ai_prism_owner`). Después de `grants`, el SP tiene `USAGE` en
`ai_prism`, DML en las tablas del app, `USAGE/SELECT` en sus secuencias y `SELECT` en
`schema_migrations`. No es dueño de ninguna tabla, no tiene grants explícitos en `public`
y no es miembro de `ai_prism_owner`. Esto cierra la mitad de privilegios de la fila G2 del
threat model; la mitad de aislamiento (row-level security) es la W2-1. Sin `prepare`, la
`0002` se detiene antes de cambiar nada
(`migrations: 0002 schema_ai_prism deferred … ownership not normalized`): el app sigue en
`public` y lo reintenta un minuto después. Los roles y los comandos manuales están en
[onboarding-deployment.md](onboarding-deployment.md#sobre-los-roles-y-permisos-de-lakebase).

**Por línea de comandos.** `scripts/migrate.mjs` usa las variables estándar de Postgres
(`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`) y los mismos
`PG_SSL_CA`/`PG_SSL_VERIFY` del app (`PG_SSL_REJECT_UNAUTHORIZED` es el nombre antiguo). En
el Lakebase, use como `PGPASSWORD` una credencial de base del dueño de las tablas
(`databricks postgres generate-database-credential <endpoint>`).
El token de la CLI no se acepta. Cada comando imprime primero el destino
(`target: <host>:<puerto>/<base> as <usuario>`): revíselo antes de seguir, sobre todo si el
`.env.local` apunta al mismo Lakebase del app.

```bash
# qué está aplicado, pendiente o alterado (sale con 1 si un archivo aplicado cambió)
node scripts/migrate.mjs status

# upgrade: aplica las pendientes (lo mismo que hace el arranque)
node scripts/migrate.mjs up

# rollback: deshace, de la más nueva a la más antigua, toda versión por encima de N
# (sin --yes solo muestra el destino y se detiene)
node scripts/migrate.mjs down --to <N> --yes

# grants de mínimo privilegio del SP del app en ai_prism (idempotente; deploy.sh lo ejecuta como up --role)
node scripts/migrate.mjs grants --role <app SP client id>

# traspaso de propiedad antes de publicar código nuevo (lo ejecuta el job de auto-config)
node scripts/migrate.mjs prepare --role <app SP client id>

# solo revoca: el SP del app sale del rol dueño (la limpieza del despliegue antes de publicar el código)
node scripts/migrate.mjs close --role <app SP client id>

# base local de desarrollo
node --env-file=.env.local scripts/migrate.mjs status
```

`down --to 0` deshace el `0001_baseline`, es decir, **borra todas las tablas y los datos del
app**, y al final borra la propia `schema_migrations`: el schema queda vacío. Úselo solo en
una base de prueba o de CI. En producción, el rollback de schema es de
una migración específica y planificada ([§6.2](#62-rollback)).

**Archivo modificado después de aplicado.** El runner guarda el SHA-256 de cada `.up.sql`
aplicado (los finales de línea CRLF y el BOM no cuentan). Si el archivo cambió, el arranque
y el `up` se detienen con `migrations: applied file changed … [MIGRATION_CHECKSUM]` y no se
ejecuta nada más: dos bases con la misma versión y schemas distintos serían peores que un
app detenido. Restaure el archivo de la release y ponga el cambio en una migración nueva.

**Cambios de schema (desarrolladores).** Nunca edite un archivo ya publicado ni ponga DDL en
`server/db.js`. Cree el número siguiente (`NNNN_<nombre>.up.sql` y `.down.sql`) con el `down`
probado: `server/migrate.test.js` y `server/schemaAiPrism.test.js` muestran las pruebas de
ida y vuelta en una base temporal, la segunda con dueños de tabla mezclados.
Las consultas de una feature nueva van en `server/db/<feature>.js`, usando `withTx` de `server/db/pool.js` (una prueba de lint en `server/rls.test.js` rechaza `withClient(` fuera de ese archivo).

**`0010_admin_usage_read` (tile de costo de la búsqueda web).** Agrega una política SELECT en
`usage_ledger` (`aipa_admin_read`, atada a la flag de admin y a una identidad presente) y el índice
`idx_usage_ledger_kind_time (kind, created_at)`. El índice es un `CREATE INDEX` simple, no
`CONCURRENTLY` (una migración corre en una transacción), así que **bloquea los inserts del registro
mientras se construye**: segundos al volumen actual. Si el registro es grande, despliega en una ventana
tranquila. El rollback es `node scripts/migrate.mjs down --to 0009`: elimina la política y el índice y no
toca los datos. Solo `server/db/adminUsage.js` lee el registro con la flag de admin, y devuelve agregados.

### 6.5 Tokens y Lakebase

| Síntoma (log o respuesta) | Causa probable | Acción |
|---|---|---|
| HTTP 401 en `/api/*` | Token ausente o vencido | Generar un token nuevo y reintentar |
| HTTP 401 `{"code":"identity_mismatch"}` o `{"code":"invalid_token"}` | El correo del proxy no es el dueño del token, o el workspace rechazó el token (`server/identityBinding.ts`) | Si afecta a usuarios legítimos, define `IDENTITY_BINDING=warn` en el `env` de `app.yaml`, despliega y lee las líneas `identity-binding:` antes de volver a `enforce` |
| HTTP 403 `{"code":"cross_site_request"}` | Escritura en `/api/*` desde otro origen (`server/csrfGuard.ts`) | Esperado para otro sitio. Si es la propia app, revisa que `DATABRICKS_APP_URL` y el `Host` que reenvía el proxy coincidan con la URL abierta en el navegador |
| HTTP 302 en la raíz o en el smoke ("redirect de login") | El proxy no aceptó la credencial | Verificar el profile/token y el acceso a la app |
| `External authorization failed` o SQLSTATE `28000` | Host de Lakebase incorrecto para este workspace | Revisar los recursos y la inyección de `PG_ENDPOINT`/`PGHOST` (ver el comentario en `app.yaml`). No fijar el host en `app.yaml` |
| `permission denied` en la base de datos | Los GRANT del SP todavía no se aplicaron, o no se reaplicaron después de una migración | Ejecutar `node scripts/migrate.mjs grants --role <SP>` como dueño de las tablas ([§6.4](#64-migraciones-de-la-base)); `deploy.sh`/`deploy.ps1` lo hacen después del smoke |
| `OAuth token does not have required scopes: genie` | Falta el scope OBO | Ajustar `user_api_scopes` en el **bundle** (el `app.yaml` no se aplica) y volver a consentir |
| `python tool setup failed` | Warehouse no disponible, grant de `CREATE FUNCTION` o scope `sql` faltante | El chat sigue sin la herramienta de Python; corregir la causa |

### 6.6 Proceso bloqueado o sin respuesta

1. `databricks apps get ai-prism -p <PROFILE>` y revisa el estado.
2. `databricks apps logs ai-prism -p <PROFILE>` y busca la última línea de
   `AI Prism listening on`.
3. Si el proceso está en pie pero sin respuesta, reinícialo con `stop`/`start` (§6.3) y
   ejecuta el smoke.
4. Si el problema vuelve tras el reinicio, sospecha de Lakebase. Revisa el endpoint en la
   consola (estado y CU) antes de tocar la app.

### 6.7 Diagnosticar un turno lento

El turno tiene varias partes con costos distintos:

- **Antes del primer token:** escritura del mensaje del usuario, lectura del historial
  (Lakebase), recuperación del historial por embedding (gateway), llamada al modelo. El
  evento `meta` sale justo después de escribir el mensaje del usuario. Si `meta` tarda, el
  cuello de botella es la base de datos. Si `meta` sale rápido pero el `token` tarda, son el
  modelo o una herramienta.
- **Durante la respuesta:** tools. Cada tool registrada tiene `duration_ms` en
  `chat_tool_calls` (consulta abajo). Los eventos SSE `tool_call` y `tool_progress` muestran
  el avance.
- **Después del último token:** el evento `done` solo sale después de embedding, indexación
  y título (`Promise.all` en `server/index.js`). Un `done` tardío con la respuesta completa
  casi siempre viene de ahí, no del modelo.

**Qué tools son lentas.** Prefiere los traces: con la exportación de telemetría activada ([§3](#3-telemetría-opentelemetry)), cada span `tool.call` lleva su `duration_ms`, y leerlos no requiere acceso a filas de usuarios (ver *Por trace* más abajo).

Para leer `ai_prism.chat_tool_calls` directamente, debes saber qué hace row-level security a una conexión de operador. La tabla tiene row-level security forzado, y sus filas pertenecen a usuarios (directamente o a través de un proyecto). Por eso, una conexión sin identidad de usuario ve **0 filas, sin error**, incluso como dueño de la tabla, porque `FORCE` también obliga al dueño (migración 0003). Solo un superusuario o un rol con `BYPASSRLS` ve todas las filas. En Lakebase, la identidad que despliega, cuya credencial de base de datos usa `migrate.mjs` ([§6.4](#64-migraciones-de-la-base)), tiene `BYPASSRLS` ([performance.md §2.1](performance.md#21-preparación)). Todavía no existe un rol de diagnóstico de solo lectura más acotado.

1. Conéctate como la identidad que despliega, con las variables de conexión de [§6.4](#64-migraciones-de-la-base), y confirma que esa conexión omite row-level security:

   ```sql
   SELECT current_user, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user;
   ```

   Si ambos son `false`, detente. La consulta de abajo devolvería 0 filas, y eso no significaría que no hubo llamadas a tools. En una base local o de CI, usa el superusuario que la creó.
2. Ejecuta la agregación en una transacción de solo lectura. Selecciona solo estas columnas: `arguments` y `result` guardan contenido de usuarios y no hacen falta para diagnosticar la latencia.

   ```sql
   BEGIN READ ONLY;
   SELECT tool_name, status, count(*) AS calls,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
          max(duration_ms) AS max_ms
   FROM ai_prism.chat_tool_calls
   WHERE created_at >= now() - interval '24 hours'
   GROUP BY tool_name, status
   ORDER BY p95_ms DESC NULLS LAST
   LIMIT 20;
   COMMIT;
   ```

No obtengas las filas de ninguna otra manera:

- nunca con las credenciales del service principal de la app;
- nunca definiendo los ajustes de transacción de la app. `app.user_email` lee los datos de un usuario como ese usuario. `app.is_admin` no abre ninguna fila por usuario. `app.maintenance` pertenece al barrido de retención y solo abre chats personales vencidos, no las llamadas a tools;
- nunca con `ALTER TABLE … NO FORCE ROW LEVEL SECURITY`: toma un lock `ACCESS EXCLUSIVE` que retiene todas las solicitudes de chat hasta el commit.

Esta conexión omite todas las políticas. Úsala solo para esta consulta y las verificaciones de [§6.10](#610-roles-y-row-level-security), y nunca para el tráfico de la aplicación.

Para la latencia del gateway de una respuesta específica, une `system.serving.endpoint_usage`
con `system.ai_gateway.usage` por `databricks_request_id = request_id` (la misma unión del
dashboard `ai-ops`). Hay un retraso de ingestión de unos minutos.

**Por trace** (con la exportación de telemetría activada, §3): toma el `request_id` del evento SSE
`meta` o del encabezado `x-request-id` de la respuesta, busca en `otel_spans` el span `chat.turn`
con ese `request_id` y lee sus hijos por `trace_id`. Cada `llm.call` es una ronda del modelo (o
una diapositiva de un deck, el título, el clasificador de intención), cada `tool.call` una tool
con su `duration_ms`; el intervalo entre ellos es tiempo en la base de datos o en el servidor. Un
`chat.turn` con `status = 'cancelled'` lo detuvo el usuario o una conexión caída: sus llamadas al
gateway y a las tools se cancelaron y no se guardó nada.

### 6.8 Retención, instrucciones de la organización y registro de auditoría de admin

Los admins definen dos ajustes de la organización con `PUT /api/admin/settings` (guardados en
`app_settings`, migración 0007):

- `retentionDays`: `0` = desactivada (el valor por defecto), o de 1 a 3650. Una conversación
  cuya **última actividad** es más antigua que eso se borra con
  todo su contenido: mensajes, llamadas a herramientas, embeddings, compactaciones, hilos de
  Genie, decks, hojas de cálculo, documentos e imágenes. Las filas de costo de `usage_ledger`
  se quedan (su `session_id` pasa a `NULL`), así el dashboard de costos conserva el historial.
  Los archivos de imagen del UC Volume se borran después de las filas de la base.
  La última actividad es la más reciente entre: la actualización de la propia conversación
  (`chat_sessions.updated_at`, que cada mensaje nuevo y cada guardado en el estudio actualizan), su mensaje más nuevo y la
  última edición de sus decks, hojas de cálculo y documentos. Una conversación con cualquiera
  de ellos dentro del período se conserva, incluidas las que tienen un `updated_at`
  desactualizado de antes de esta versión.
- `orgInstructions`: hasta 8.000 caracteres, añadidas a cada turno como un mensaje de sistema.
  Un valor vacío lo elimina. Las demás instancias de la app ven el cambio en menos de un
  minuto.

**El barrido** (`server/retention.ts`) comprueba cada hora, empezando 5 minutos después del
arranque, y se ejecuta como máximo una vez al día entre todas las instancias. Se ejecuta
dentro de un `pg_try_advisory_xact_lock`: si una segunda instancia lo intenta mientras otra
lo ejecuta, lo omite y registra `retention sweep: skipped (locked)`. Cada ejecución registra
una línea con sus conteos, por ejemplo `retention sweep: done sessions=12 users=3 images=4
files_deleted=4 files_failed=0 retention_days=90`, y escribe una fila `retention.sweep`
(actor `system`) en el registro de auditoría. Una conversación con un turno en curso en esta
instancia queda para la próxima ejecución. `files_failed` cuenta los archivos de imagen que no
se pudieron borrar. Quedan huérfanos en el volumen y no se reintentan. Una ejecución borra como máximo 100.000
conversaciones, en sentencias de 500. Un acumulado mayor registra `capped=true`, y las
siguientes ejecuciones diarias lo terminan.

- **Desactivarlo durante un incidente:** defina la variable de entorno `RETENTION_SWEEP=off` en
  la app y reiníciela. El ajuste sigue guardado, así que el barrido vuelve cuando se quita la
  variable.
- **Ver la última ejecución:** `GET /api/admin/settings` devuelve `retentionLastSweepAt`, y
  `GET /api/admin/audit` lista las filas `retention.sweep` con sus conteos.
- **Reduzca la retención con cuidado:** pasar de 365 a 30 días borra, en la siguiente
  ejecución, toda conversación inactiva desde hace más de 30 días. No se puede deshacer. El
  point-in-time restore de Lakebase es la única vuelta atrás.

El barrido no tiene identidad de usuario: su transacción define `app.maintenance = 'on'`
(local a la transacción), y las políticas de row-level security de la 0007 le dejan ver y
borrar **solo** conversaciones ya vencidas, y leer las rutas de imagen de esas conversaciones.
Una transacción con usuario (toda petición) nunca obtiene ese acceso.

**Registro de auditoría.** Cada mutación de admin escribe una fila en `admin_audit` en la misma
transacción que el cambio: admins, catálogo MCP, política de herramientas, alcance de
plantilla, edición y borrado de plantillas y skills globales, endpoints de modelo (incluida la
carga inicial) y los ajustes de arriba. Una fila tiene `at`, `actor_hash`, `action`, `target`
y `details`. `actor_hash` es un hash del e-mail, nunca el e-mail. **Con `APP_AUDIT_HASH_KEY` definida** es
`h2:` + 12 hex de un HMAC con ese secreto, y **no** es igual al `user_hash` de los logs
(§2), a propósito: la tabla de auditoría no se puede contrastar con una lista de e-mails sin el secreto.
Sin la clave (y en las filas escritas antes del 2026-11-19) es el mismo hash de 12 caracteres sin sal
que `user_hash`, y una fila se une con sus líneas de log por ese valor. Un destino que es un usuario
se hashea igual. Para buscar a una persona conocida en ambas fuentes, o para vincular una fila con una
petición, sigue [security-threat-model.md §6.1](security-threat-model.md#61-correlacionar-la-traza-de-auditoría-con-los-logs).
Mantén la misma clave entre despliegues: tras un cambio de clave, las filas antiguas ya no coinciden con
los hashes nuevos. Una clave ausente registra un aviso en el arranque (`APP_AUDIT_HASH_KEY is not set`);
cómo configurarla se describe en `bundle/optional/audit-hash-key-secret.yml.example`. Para el rol de
la app la tabla solo admite inserciones
(ninguna política de update o delete, y esos privilegios están revocados).
`GET /api/admin/audit?limit=50&cursor=<nextCursor>` la pagina de la más nueva a la más antigua
(como máximo 200 filas por página). `migrate.mjs down` por debajo de la versión 7 borra la
tabla: expórtela antes si necesita conservarla.

### 6.9 Sondear qué modelos admiten esfuerzo de razonamiento

La flag `reasoning` de un modelo del catálogo (`server/llm.js`, `MODELS`) activa el control
**Esfuerzo de razonamiento** en la lista de modelos. Solo se define con evidencia: ejecuta la sonda
en el workspace donde haces el deploy cada vez que añadas un modelo o cambie el gateway.

```bash
node scripts/probe/reasoning-effort.mjs --profile <databricks-cli-profile> \
  [--models id1,id2] [--shape auto|openai|anthropic|anthropic-budget|gemini] \
  --out /path/outside/the/repo/reasoning-effort-probe.json
```

Para cada modelo de chat curado, envía cinco solicitudes pequeñas y sin streaming (sin tools,
`max_tokens` 2048, una pregunta corta que exige razonar): una sin el parámetro, una para cada uno de
`low`, `medium` y `high`, y una con un valor inválido como control negativo. Escribe una fila por
solicitud (`model`, `shape`, `level`, `accepted`, `status`, `usage`, `error` truncado) en `--out` e
imprime una tabla. Solo llama a `serving-endpoints/chat/completions`; no crea, cambia ni borra nada.
El token sale de `databricks auth token` y nunca se imprime ni se guarda. Es una herramienta manual
y nunca se ejecuta en la CI.

Define la flag en un modelo cuando `low`, `medium` y `high` se aceptan **y** el valor inválido se
rechaza (el endpoint valida el campo, así que la aceptación es real), y hay un efecto visible en el
uso o documentado por el proveedor. `param` es el formato de cuerpo que se aceptó: `openai`
(`reasoning_effort`), `anthropic` (`thinking: adaptive` más `output_config.effort`),
`anthropic-budget` (`thinking.enabled` con presupuesto de tokens) o `gemini` (`thinking_config`).

### 6.10 Roles y row-level security

Un único rol de Postgres atiende a todos los usuarios (decisión D1): el service principal de la app.
No es dueño de ninguna tabla y no tiene `BYPASSRLS`. Toda tabla de la app en el schema `ai_prism` tiene
row-level security habilitado y forzado (migración 0003; `project_members` es la única excepción
documentada, ver [security-threat-model.md TB9](security-threat-model.md#3-fronteras-de-confianza)). La
identidad del usuario llega a las políticas por transacción: `withTx` (`server/db/pool.js`) define
`app.user_email`, `app.is_admin` y `app.user_groups` con `set_config(..., true)` (local a la transacción),
así que una consulta sin identidad no ve ninguna fila. Las tablas pertenecen al rol `NOLOGIN`
`ai_prism_owner`; el despliegue le da al SP la membresía en él solo durante la ventana de traspaso
(`prepare` … `up --role`).

Verificaciones de rutina (como dueño de la tabla, con las variables de conexión de [§6.4](#64-migraciones-de-la-base)):

```bash
# versions applied, pending or changed
node scripts/migrate.mjs status

# re-apply the least-privilege grants (idempotent) after a migration or a permission denied
node scripts/migrate.mjs grants --role <app SP client id>
```

```sql
-- the app role must have rolbypassrls = false and rolsuper = false
SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = '<app SP client id>';

-- tables of the app schema WITHOUT forced row-level security (expected: project_members and schema_migrations)
SELECT c.relname
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'ai_prism' AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

-- the SP must not be a member of the owner role once the deploy has finished
SELECT pg_has_role('<app SP client id>', 'ai_prism_owner', 'member');   -- expected: false
```

| Síntoma | Significado | Acción |
|---|---|---|
| Un usuario ve una lista vacía que debería tener filas | La petición se ejecutó sin identidad (una ruta fuera de `withTx`), o el usuario no es el dueño | Revisa la línea de log de ese `request_id`; la prueba de lint `server/rls.test.js` ("no withClient( call outside server/db/pool.js") debería haber detectado una ruta nueva |
| `permission denied` para el SP | Los grants no se aplicaron después de una migración | `migrate.mjs grants --role <SP>` como dueño ([§6.5](#65-tokens-y-lakebase)) |
| 503 `service_unavailable` y la línea de log `lakebase: per-user fallback refused` | El service principal no está disponible y el rol del fallback por usuario es superusuario o tiene `BYPASSRLS` (la identidad que despliega). La app falla cerrada en lugar de correr fuera de las políticas (G15) | Restaura el service principal ([§6.5](#65-tokens-y-lakebase)). No hay configuración para desactivar la revisión |
| La consulta `pg_has_role` devuelve `true` | La ventana de traspaso sigue abierta (un despliegue se detuvo a mitad de camino) | `node scripts/migrate.mjs close --role <SP>` |

Nunca ejecutes tráfico de la aplicación como `ai_prism_owner` ni como un rol con `BYPASSRLS`: las
políticas dejarían de aplicarse. Las migraciones de datos que deben leer las filas de todos los
usuarios (`migrate.mjs backfill-usage`) se ejecutan solo como dueño, a mano.

### 6.11 De las alertas a las acciones

| Alerta ([§5.2](#52-reglas-de-alerta-propuestas)) | Primer comando | Después |
|---|---|---|
| A1 falla el smoke posterior al despliegue | La tabla de salida de `npm run smoke`; `databricks apps logs ai-prism -p <PROFILE>` | Haz rollback ([§6.2](#62-rollback)); no liberes tráfico |
| A2 más de 5% de 5xx o errores de login | `databricks apps logs ai-prism -p <PROFILE>` y filtra por `status` ≥ 500 (cada línea es JSON: `route`, `status`, `request_id`) | Tabla de tokens/Lakebase ([§6.5](#65-tokens-y-lakebase)); una ruta lenta: [§6.7](#67-diagnosticar-un-turno-lento) |
| A3 `lakebase: service-principal login unavailable` | `databricks apps get ai-prism -p <PROFILE>` y el estado del endpoint de Lakebase en la consola | [§6.5](#65-tokens-y-lakebase), luego [§6.6](#66-proceso-bloqueado-o-sin-respuesta) |
| A4 Lakebase en 16 CU durante 15 min | Consola de Lakebase (CPU, conexiones) | Revisa [§6.7](#67-diagnosticar-un-turno-lento) por una consulta lenta; sube el techo solo después de medir ([§7](#7-escala-y-límites-conocidos)) |
| A5 costo diario por encima de 2× el promedio de 7 días | Dashboard `ai-costs`: usuario y endpoint | Si es un solo usuario: revisa `GET /api/admin/audit` por un cambio reciente de modelo o de política, luego el volumen del usuario; considera el presupuesto por usuario o grupo en el AI Gateway (G4) |
| A6 volumen de usuarios por encima de lo esperado | Dashboard `ai-ops`, pestaña por usuario | Igual que A5; el rate limit por proceso (429) no es un tope de costo |
| Falta la fila de retención | `GET /api/admin/settings` (`retentionLastSweepAt`) y la línea de log `retention sweep:` | [§6.8](#68-retención-instrucciones-de-la-organización-y-registro-de-auditoría-de-admin); `RETENTION_SWEEP=off` es el kill switch |

### 6.12 Contexto del proyecto en el turno

Cada turno de una conversación en un proyecto lleva las instrucciones del proyecto (siempre completas) y sus
archivos, hasta un presupuesto de tokens (`server/projectContext.js`, ADR 0013).

- `PROJECT_CONTEXT_FILES_MAX_TOKENS` (por defecto `32000`, de `0` a `120000`): el presupuesto de archivos por
  turno. `0` apaga los archivos y mantiene las instrucciones. Es el interruptor de los archivos y la perilla
  del costo: los tokens se cuentan de forma conservadora (ASCII 0,5 token por carácter), y el costo aparece
  por turno en `usage_ledger` (`prompt_tokens`, `cache_read_tokens`); las rondas de herramienta dentro de un
  turno leen el texto del proyecto del caché de prompt.
- Los archivos por encima del presupuesto se nombran al modelo y los marca `GET /api/projects/:id/files`
  (`context: "excluded"`). Si ocurre en más de cerca del 20% de los proyectos activos, es la señal para
  construir recuperación sobre los archivos.
- Una lectura más lenta que 1,5 s, o que falla, se registra como `project context: read failed` y el turno
  sigue sin el proyecto. La lectura también lleva un límite de tiempo en el servidor justo debajo de ese
  valor, así que Postgres cancela la consulta lenta y la conexión vuelve al pool. Una racha constante de esto
  apunta a la base de datos.
- La migración `0009_project_context` añade `project_files.context_tokens` y `chat_messages.sent_by` (sellado
  por un trigger a partir de la identidad de la transacción). Requiere al dueño de la tabla y no toma locks
  largos. `migrate.mjs down --to 8` quita las dos columnas, y la autoría guardada se pierde.

---

## 7. Escala y límites conocidos

- **Pool del service principal:** un pool compartido con `max: 8` conexiones
  (`POOL_OPTS` y `getSpPool`, `server/db/pool.js`). Con muchos usuarios simultáneos, las
  consultas esperan una conexión. Mide antes de subir el techo. El techo está en el código: no
  existe la variable `PG_POOL_MAX` (`PG_POOL_IDLE_TIMEOUT_MS` es la única configuración del pool
  que se lee del entorno). En la ejecución medida de [performance.md §3](performance.md#3-resultados-de-carga),
  50 usuarios virtuales mantuvieron las 8 conexiones abiertas con como mucho 2 activas y latencia
  de lectura estable: el pool no fue el cuello de botella.
- **Inactividad:** las conexiones inactivas se cierran por defecto tras 2 min (`PG_POOL_IDLE_TIMEOUT_MS`, de 1 s a 30 min). Lakebase se suspende
  por defecto tras 10 min sin uso (variable del bundle `lakebase_suspend_timeout`, `600s`).
- **Warehouse:** 2X-Small, `max_num_clusters: 1`, auto-stop de 10 min. Subir el máximo
  aumenta el costo de la UDF y de las UC Functions.
- **Límites de entrada:** los cuerpos JSON tienen una clase por ruta: 1 MB por defecto, 4 MB para
  guardar un libro de cálculo, 40 MB para importar un design system, 46 MiB para las escrituras del
  estudio de decks con medios; las subidas del chat llegan hasta 80 MB y 10 archivos. El arranque
  AppKit lee todo cuerpo JSON hasta 64 MB antes de la verificación por ruta (`JSON_ROUTE_LIMITS`,
  `APPKIT_BODY_LIMIT` en `server/middleware/security.ts`; la tabla está en
  [security-threat-model.md C11](security-threat-model.md#5-controles-presentes)).
- **Rate limits:** por usuario y por proceso, 120 solicitudes `/api`/min y 12 turnos/min
  (`RATE_LIMIT_API_PER_MIN`, `RATE_LIMIT_TURNS_PER_MIN`; `0` los desactiva). Con varias instancias
  de la app el techo se multiplica, y no es un tope de gasto (G4).
- **Barrido de retención:** como máximo 100.000 conversaciones por ejecución, en sentencias de 500 ([§6.8](#68-retención-instrucciones-de-la-organización-y-registro-de-auditoría-de-admin)).
