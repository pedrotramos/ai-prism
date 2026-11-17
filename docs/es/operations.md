<!-- i18n: source=docs/operations.md source-hash=55e9629fc23d8c6ec8a07a97060bfff1aaa2080c status=machine -->
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
| `identity-binding: rejected a request: identity_mismatch` / `invalid_token` | Una petición llegó con un correo que no es del dueño del token, o con un token rechazado por el workspace, y recibió 401 | Ver [§6.4](#64-tokens-y-lakebase); si se repite sin explicación, es señal de un intento de suplantación |
| `unhandled error on <MÉTODO> <rota> -> <status>:` | Error que ninguna ruta manejó (JSON mal formado, subida grande, excepción); el cliente recibió JSON genérico | Leer el detalle en la propia línea |
| `lakebase: service-principal login unavailable, using per-user identity:` | Falló el login del SP; la app usó la identidad del usuario | Ver [§6.4](#64-tokens-y-lakebase) |
| `ensureSpGrants: pulado para <e-mail> - …` | Los GRANT al SP todavía no se aplicaron | Ver [§6.4](#64-tokens-y-lakebase) |
| `lakebase SP pool: idle client error (dropped):` | Se cayó una conexión inactiva (normal tras una suspensión) | Investigar solo si es frecuente |
| `embedding update failed:` / `message embedding index failed:` / `title/session update failed:` | Falló el posprocesamiento del turno (no impide la respuesta) | Si es frecuente, indica un problema en el gateway de embeddings |
| `transcrição falhou (…)` / `análise de planilha falhou (…)` / `ingestão de pptx falhou (…)` | Falló un adjunto específico | Lee el mensaje para conocer el motivo |
| `history retrieval failed:` | Falló la recuperación del historial (pgvector) | Revisar la extensión `vector` y el índice |
| `python tool setup failed, continuing without it:` | UDF de Python no disponible (warehouse, grant o scope `sql`) | Ver [§6.4](#64-tokens-y-lakebase) |
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
| Disponibilidad (`/` y `/api/me` con 2xx) | Smoke y prueba de carga | Cualquier falla en 5 min | Ver [§6.5](#65-proceso-bloqueado-o-sin-respuesta) |
| Errores 5xx en la app | Logs (`apps logs`) | Ver SLO S1 | Diagnóstico según [§6.6](#66-diagnosticar-un-turno-lento) |
| Latencia de API | Prueba de carga (`npm run loadtest`) | Ver SLO S2 | Medir en el mismo entorno |
| Turno de chat (TTFT y finalización) | Smoke y prueba de carga; SSE del cliente | Ver SLO S3 y S4 | [§6.6](#66-diagnosticar-un-turno-lento) |
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
| S5 | Primera petición tras la suspensión de Lakebase | ≤ 15 s | Por ocurrencia | Logs y prueba manual (el `connectionTimeoutMillis` del pool es 15 s, `server/db.js`) |
| S6 | Smoke post-despliegue | 100% en verde antes de liberar el tráfico | Por despliegue | `npm run smoke`; el mismo script se ejecuta en cada PR en la CI ([§5.3](#53-smoke-en-la-ci)) |

### 5.2 Reglas de alerta propuestas

| ID | Condición | Ventana | Severidad | Acción |
|---|---|---|---|---|
| A1 | Falla el smoke post-despliegue (S6) | Inmediata | Crítica | Rollback ([§6.2](#62-rollback)) |
| A2 | Más del 5% de respuestas 5xx o errores de login (302 o 401) en `/api/*` | 10 min | Alta | Logs; token y Lakebase ([§6.4](#64-tokens-y-lakebase)) |
| A3 | Secuencia de `lakebase: service-principal login unavailable` en los logs | 10 min | Alta | Ver [§6.4](#64-tokens-y-lakebase) |
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

No hay rollback de base de datos. El DDL es aditivo e idempotente, y no hay migraciones
"down". Por eso, el rollback es de **código**:

1. Identifica el último commit bueno (tag o SHA) que tenía `client/dist` y `server-dist`
   consistentes.
2. Haz checkout de esos artefactos en una rama de hotfix (no reescribas `main`).
3. Repite el [§6.1](#61-despliegue) desde el paso 1.
4. Confirma con `npm run smoke`.

*Atención:* los datos escritos por la versión nueva deben seguir siendo legibles por la
anterior. Si hay un cambio de esquema, verifícalo antes de volver a la versión anterior.

### 6.3 Detener e iniciar la App

```bash
databricks apps get ai-prism -p <PROFILE>
databricks apps stop ai-prism -p <PROFILE>
databricks apps start ai-prism -p <PROFILE>
```

Consulta `databricks apps --help` para la versión de la CLI instalada.

### 6.4 Tokens y Lakebase

| Síntoma (log o respuesta) | Causa probable | Acción |
|---|---|---|
| HTTP 401 en `/api/*` | Token ausente o vencido | Generar un token nuevo y reintentar |
| HTTP 401 `{"code":"identity_mismatch"}` o `{"code":"invalid_token"}` | El correo del proxy no es el dueño del token, o el workspace rechazó el token (`server/identityBinding.js`) | Si afecta a usuarios legítimos, define `IDENTITY_BINDING=warn` en el `env` de `app.yaml`, despliega y lee las líneas `identity-binding:` antes de volver a `enforce` |
| HTTP 403 `{"code":"cross_site_request"}` | Escritura en `/api/*` desde otro origen (`server/csrfGuard.js`) | Esperado para otro sitio. Si es la propia app, revisa que `DATABRICKS_APP_URL` y el `Host` que reenvía el proxy coincidan con la URL abierta en el navegador |
| HTTP 302 en la raíz o en el smoke ("redirect de login") | El proxy no aceptó la credencial | Verificar el profile/token y el acceso a la app |
| `External authorization failed` o SQLSTATE `28000` | Host de Lakebase incorrecto para este workspace | Revisar los recursos y la inyección de `PG_ENDPOINT`/`PGHOST` (ver el comentario en `app.yaml`). No fijar el host en `app.yaml` |
| `permission denied` en la base de datos | Los GRANT del SP todavía no se aplicaron | El dueño (el primer admin) debe abrir la app; `ensureSpGrants` reintenta cada 5 min |
| `OAuth token does not have required scopes: genie` | Falta el scope OBO | Ajustar `user_api_scopes` en el **bundle** (el `app.yaml` no se aplica) y volver a consentir |
| `python tool setup failed` | Warehouse no disponible, grant de `CREATE FUNCTION` o scope `sql` faltante | El chat sigue sin la herramienta de Python; corregir la causa |

### 6.5 Proceso bloqueado o sin respuesta

1. `databricks apps get ai-prism -p <PROFILE>` y revisa el estado.
2. `databricks apps logs ai-prism -p <PROFILE>` y busca la última línea de
   `AI Prism listening on`.
3. Si el proceso está en pie pero sin respuesta, reinícialo con `stop`/`start` (§6.3) y
   ejecuta el smoke.
4. Si el problema vuelve tras el reinicio, sospecha de Lakebase. Revisa el endpoint en la
   consola (estado y CU) antes de tocar la app.

### 6.6 Diagnosticar un turno lento

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
  (`POOL_OPTS` y `getSpPool`, `server/db.js`). Con muchos usuarios simultáneos, las
  consultas esperan una conexión. Mide antes de subir el techo.
- **Inactividad:** las conexiones inactivas se cierran tras 5 min (`idleTimeoutMillis`).
  Lakebase se suspende tras 30 min sin uso (`suspend_timeout_duration: 1800s`).
- **Warehouse:** 2X-Small, `max_num_clusters: 1`, auto-stop de 10 min. Subir el máximo
  aumenta el costo de la UDF y de las UC Functions.
- **Límites de entrada:** JSON 40 MB, upload 80 MB, 10 archivos.
