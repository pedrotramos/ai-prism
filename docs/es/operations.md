<!-- i18n: source=docs/operations.md source-hash=998c48f9899436320a168731f5e2e305336e1b88 status=machine -->
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

**No existe endpoint `/health` hoy.** Para liveness, usa:

| Señal | Cómo | Qué prueba | Qué no prueba |
|---|---|---|---|
| SPA | `GET <APP_URL>/` sin redirección | Proceso en marcha y `client/dist` presente | Base de datos, gateway |
| Identidad | `GET <APP_URL>/api/me` autenticado | Proceso, proxy y token aceptados | Base de datos: `/api/me` degrada a "no admin" cuando falla la base de datos |
| Persistencia | `npm run smoke` (paso "persistencia") | Escritura y lectura en Lakebase | Latencia real bajo carga |

El smoke completo (`npm run smoke`, con `APP_URL` y `DATABRICKS_TOKEN`) es la prueba de
salud que importa después de un despliegue. Crea una sesión de prueba, ejecuta un turno
real, lee los mensajes de vuelta, genera un documento y borra la sesión. Consulta
[§6.1](#61-despliegue) para el orden.

*Recomendación (fuera de este repositorio de docs):* una ruta `/api/health` que haga un
`SELECT 1` en Lakebase y responda 503 cuando falle. Eso exige cambiar `server/index.js`.

---

## 2. Logs

```bash
# últimas líneas de la app
databricks apps logs ai-prism -p <PROFILE>

# el comando también acepta --help para ver los filtros; revisa la versión de la CLI instalada
databricks apps logs --help
```

No hay logs estructurados. Todo es `console.log/warn/error`. Mensajes que merecen una
alerta manual (texto exacto, tal como aparece en el log):

| Mensaje (inicio) | Significado | Acción |
|---|---|---|
| `AI Prism listening on :<porta>` | El proceso arrancó | Confirmar después de cada despliegue o reinicio |
| `identity-binding: could not verify the forwarded token, allowing the request (…)` | El workspace no respondió a `SCIM /Me` (timeout, 5xx, scope); la petición pasó sin el vínculo correo ↔ token. Como máximo 1 línea por minuto | Si es frecuente: revisar el workspace y el scope `iam.current-user:read` del token OBO |
| `identity-binding: identity_mismatch: … (IDENTITY_BINDING=warn, allowed)` / `identity-binding: invalid_token: …` | Modo `warn`: la divergencia se registró y la petición pasó | Diagnóstico del rollback; corregir la causa y volver a `enforce` ([SECURITY.md](SECURITY.md#vínculo-entre-correo-y-token-serveridentitybindingjs)) |
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

*Consulta de ejemplo:* para contar estas ocurrencias, copia la salida de `apps logs` a un
archivo local y usa `grep -c` por mensaje. El servidor no agrega datos.

---

## 3. Telemetría OpenTelemetry

> **PENDIENTE DE REDACTAR.** Esta sección se escribirá cuando AppKit (con telemetría OTEL)
> esté disponible en este proyecto. Hasta entonces no hay traces, métricas ni spans por
> turno; lo que existe hoy es el log de §2 y el ledger de costos.
>
> Puntos que registrar en esta sección: endpoint y variables de exportación, nombres de los
> spans (`chat.turn`, llamada a LLM, tool call, consulta SQL), campos de cada span,
> retención en el destino y cómo vincular un trace con un `request_id`.

---

## 4. Qué monitorear

| Señal | Fuente hoy | Umbral de atención | Acción |
|---|---|---|---|
| Disponibilidad (`/` y `/api/me` con 2xx) | Smoke y prueba de carga | Cualquier falla en 5 min | Ver [§6.6](#66-proceso-bloqueado-o-sin-respuesta) |
| Errores 5xx en la app | Logs (`apps logs`) | Ver SLO S1 | Diagnóstico según [§6.7](#67-diagnosticar-un-turno-lento) |
| Latencia de API | Prueba de carga (`npm run loadtest`) | Ver SLO S2 | Medir en el mismo entorno |
| Turno de chat (TTFT y finalización) | Smoke y prueba de carga; SSE del cliente | Ver SLO S3 y S4 | [§6.7](#67-diagnosticar-un-turno-lento) |
| Costo por día y por modelo | Dashboard de costos (`ai-costs`) | Límite definido por el operador (ver alerta A5) | Revisar usuario y endpoint |
| Volumen, usuarios activos y tokens | Dashboard de operación (`ai-ops`) | Sin límite fijo | Seguir la tendencia |
| Latencia del gateway | `system.ai_gateway.usage` (dashboard `ai-ops`) | Ver SLO S3 | Con retraso de ingestión |
| CPU, memoria y conexiones de Lakebase | Consola de Lakebase | Ver alerta A4 | Dimensionar CU |
| Consumo del SQL Warehouse | Consola del warehouse | Auto-stop de 10 min | Confirmar que se apaga |

**Limitación:** no hay métrica de error por ruta ni percentil de latencia del servidor.
Hoy estos números salen solo de la prueba de carga, que mide desde el lado del cliente.

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
| S4 | Turno completado sin evento `error` | ≥ 98% | 7 días | **No se mide automáticamente**; medir con `loadtest --chat` |
| S5 | Primera petición tras la suspensión de Lakebase | ≤ 15 s | Por ocurrencia | Logs y prueba manual (el `connectionTimeoutMillis` del pool es 15 s, `server/db/pool.js`) |
| S6 | Smoke post-despliegue | 100% en verde antes de liberar el tráfico | Por despliegue | `npm run smoke`; el mismo script se ejecuta en cada PR en la CI ([§5.3](#53-smoke-en-la-ci)) |

### 5.2 Reglas de alerta propuestas

| ID | Condición | Ventana | Severidad | Acción |
|---|---|---|---|---|
| A1 | Falla el smoke post-despliegue (S6) | Inmediata | Crítica | Rollback ([§6.2](#62-rollback)) |
| A2 | Más del 5% de respuestas 5xx o errores de login (302 o 401) en `/api/*` | 10 min | Alta | Logs; token y Lakebase ([§6.5](#65-tokens-y-lakebase)) |
| A3 | Secuencia de `lakebase: service-principal login unavailable` en los logs | 10 min | Alta | Ver [§6.5](#65-tokens-y-lakebase) |
| A4 | Lakebase en el techo de 16 CU por más de 15 min | 15 min | Media | Revisar la carga; evaluar un techo mayor |
| A5 | Costo diario (`usd` en `ai-costs`) por encima de 2× el promedio móvil de 7 días | Diaria | Media | Revisar usuario y endpoint en el dashboard |
| A6 | Usuario con volumen de llamadas por encima de lo esperado (dashboard `ai-ops`, pestaña por usuario) | Diaria | Media | Revisar el caso; puede ser abuso (G4) |

**Cómo ejecutarlo hoy:** A1 viene del script de despliegue (si falla el smoke, falla el
despliegue). A5 y A6 son consultas de alerta en Databricks SQL sobre los datasets de los
dashboards. A2 y A3 dependen de leer los logs manualmente; **no hay alerta automatizada
sobre el log** hasta que la telemetría esté lista ([§3](#3-telemetría-opentelemetry)).

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

---

## 6. Runbook

### 6.1 Despliegue

Requisito previo: artefactos regenerados con `npm run bundle` justo antes del despliegue.
Los PR de funcionalidades no incluyen `client/dist` ni `server-dist` en el commit; los PR
de release (rama `release/*` o etiqueta `release`) los regeneran y los incluyen, y solo en
esos la CI comprueba que están al día. `deploy.sh` todavía no ejecuta el build por sí solo.

<!-- i18n: code-translated -->
```bash
# valida la configuración (no crea nada)
databricks bundle validate -p <PROFILE> -t dev

# 1) Lakebase, warehouse, app, dashboards y job
databricks bundle deploy -p <PROFILE> -t dev

# 2) publica el CÓDIGO de la App. El bundle deploy NO republica el proceso en ejecución.
#    <SRC> lo imprime el bundle deploy (normalmente .../.bundle/ai-prism/dev/files)
databricks apps deploy ai-prism --source-code-path <SRC> -p <PROFILE>

# 3) ejecuta el auto-config (rol PG del SP, UDF de Python, Volume de imágenes, bootstrap de admin)
databricks bundle run ai_prism_auto_config -p <PROFILE> -t dev

# 4) smoke (S6): bloquea la liberación si falla
APP_URL=<URL-de-la-app> DATABRICKS_TOKEN=<token-oauth> npm run smoke
```

Para `DATABRICKS_TOKEN`, usa el token OAuth del usuario (`databricks auth token -p <PROFILE>`).
No pegues el token en logs ni en issues.

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

### 6.3 Detener e iniciar la App

```bash
databricks apps get ai-prism -p <PROFILE>
databricks apps stop ai-prism -p <PROFILE>
databricks apps start ai-prism -p <PROFILE>
```

Consulta `databricks apps --help` para la versión de la CLI instalada.

### 6.4 Migraciones de la base

El schema del Lakebase se versiona en archivos SQL:

<!-- i18n: code-translated -->
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
`NOLOGIN`, `ai_prism_owner` (`AI_PRISM_OWNER_ROLE`), en tres etapas: `prepare` (el job de
auto-config, antes de publicar el código), `0002` (la primera petición del SP) y `grants`
(`deploy.sh`/`deploy.ps1` después del smoke). Después de `grants`, el SP tiene `USAGE` en
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
Las consultas de una feature nueva van en `server/db/<feature>.js`, usando `withClient` o
`withTx` (transacción) de `server/db/pool.js`.

### 6.5 Tokens y Lakebase

| Síntoma (log o respuesta) | Causa probable | Acción |
|---|---|---|
| HTTP 401 en `/api/*` | Token ausente o vencido | Generar un token nuevo y reintentar |
| HTTP 401 `{"code":"identity_mismatch"}` o `{"code":"invalid_token"}` | El correo del proxy no es el dueño del token, o el workspace rechazó el token (`server/identityBinding.js`) | Si afecta a usuarios legítimos, define `IDENTITY_BINDING=warn` en el `env` de `app.yaml`, despliega y lee las líneas `identity-binding:` antes de volver a `enforce` |
| HTTP 403 `{"code":"cross_site_request"}` | Escritura en `/api/*` desde otro origen (`server/csrfGuard.js`) | Esperado para otro sitio. Si es la propia app, revisa que `DATABRICKS_APP_URL` y el `Host` que reenvía el proxy coincidan con la URL abierta en el navegador |
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

Consulta para encontrar las tools más lentas (ejecútala en Lakebase, con el usuario de
diagnóstico, nunca con credenciales de la app en el repositorio):

```sql
SELECT tool_name, status, duration_ms, created_at
FROM chat_tool_calls
WHERE created_at >= now() - interval '24 hours'
ORDER BY duration_ms DESC NULLS LAST
LIMIT 20;
```

Para la latencia del gateway de una respuesta específica, une `system.serving.endpoint_usage`
con `system.ai_gateway.usage` por `databricks_request_id = request_id` (la misma unión del
dashboard `ai-ops`). Hay un retraso de ingestión de unos minutos.

---

## 7. Escala y límites conocidos

- **Pool del service principal:** un pool compartido con `max: 8` conexiones
  (`POOL_OPTS` y `getSpPool`, `server/db/pool.js`). Con muchos usuarios simultáneos, las
  consultas esperan una conexión. Mide antes de subir el techo.
- **Inactividad:** las conexiones inactivas se cierran tras 5 min (`idleTimeoutMillis`).
  Lakebase se suspende tras 30 min sin uso (`suspend_timeout_duration: 1800s`).
- **Warehouse:** 2X-Small, `max_num_clusters: 1`, auto-stop de 10 min. Subir el máximo
  aumenta el costo de la UDF y de las UC Functions.
- **Límites de entrada:** JSON 40 MB, upload 80 MB, 10 archivos.
