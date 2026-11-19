<!-- i18n: source=docs/performance.md source-hash=42cf2c3d552e3bcc2832a6992e7e58b404591fe0 status=machine -->
# Rendimiento: método de carga y análisis de consultas

[English](../performance.md) · [Português (Brasil)](../pt-BR/performance.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../performance.md) es la referencia.

Esta página describe cómo medir AI Prism bajo carga y cómo analizar las consultas críticas
de Lakebase con `EXPLAIN (ANALYZE, BUFFERS)`. También registra una ejecución medida: cada
tabla de las §3, §4.6 y §4.7 indica el commit, la fecha y la configuración de la medición.
Los números de una instalación son una referencia, no una promesa para otra: mida su
instalación en su propio entorno de prueba antes de confiar en ellos.

Herramientas del repositorio:

- `npm run smoke`: verificación funcional, un usuario, un turno (ver [operations.md](operations.md)).
- `npm run loadtest`: generador de carga sin dependencias (`scripts/load-test.mjs`).
- `scripts/bench/explain.sql`: `EXPLAIN (ANALYZE, BUFFERS)` de las consultas de la §4,
  ejecutado con `psql` directamente contra una base de prueba.

---

## 1. Objetivo y criterios

Responder tres preguntas, en orden:

1. ¿Con cuántos usuarios simultáneos la latencia de las lecturas y del primer token supera
   los objetivos de SLO (ver [operations.md §5.1](operations.md#51-slo-propuestos))?
2. ¿Cuál es el cuello de botella al crecer: el pool de la base, el gateway de modelos, el
   warehouse o la CPU de la app?
3. ¿Qué consultas dominan el tiempo de base de datos, y su plan cambia con el volumen?

Escenarios por defecto: **1, 5, 20 y 50 usuarios virtuales**, con al menos 60 s por etapa
para que la cola se estabilice. Son los valores por defecto de `loadtest`.

---

## 2. Método

### 2.1 Preparación

1. **Entorno de prueba dedicado.** Use una instalación de prueba en el mismo workspace y
   la misma región que sus usuarios. Medir desde un portátil lejos de la región mide la
   red, no la app (ver el piso de latencia en la §3).
2. **Base desechable.** Apunte la instalación de prueba a un branch desechable de Lakebase
   (`databricks postgres create-branch ... --ttl 4h`), nunca al branch de producción, y
   borre el branch al final. Un branch copia las tablas del branch de origen y los roles
   dueños de ellas: si el service principal de la app de prueba no puede asumirlas, cree
   una base separada en el branch y ejecute `node scripts/migrate.mjs up --role <SP de la app de prueba>`
   contra ella con la identidad que hace el deploy.
3. **Estado de Lakebase declarado.** Registre si la prueba empezó con el endpoint
   suspendido (cold) o activo (warm). La primera solicitud después de una suspensión paga
   el arranque en frío.
4. **Volumen de datos declarado.** Registre cuántas sesiones, mensajes y embeddings hay
   antes de la prueba. Sin eso, los planes no son comparables.
5. **Smoke antes de la carga.** `npm run smoke` tiene que pasar. Carga sobre una app rota
   solo mide errores.

Datos sintéticos para un usuario de prueba (ejecútelos **solo** en una instalación de
prueba; el correo es ficticio y la limpieza es obligatoria). Las tablas están en el schema
`ai_prism` y tienen seguridad por fila forzada, así que la transacción que inserta tiene
que llevar la identidad en cuyo nombre escribe:

```sql
SET search_path = ai_prism, public;
BEGIN;
SELECT set_config('app.user_email', 'carga-teste@example.com', true);

-- 200 sesiones x 40 mensajes
INSERT INTO chat_sessions (user_email, title, model)
SELECT 'carga-teste@example.com', 'load ' || g, 'databricks-claude-haiku-5-5'
FROM generate_series(1, 200) g;

INSERT INTO chat_messages (session_id, role, content, created_at)
SELECT s.id,
       CASE WHEN m % 2 = 0 THEN 'assistant' ELSE 'user' END,
       'load message ' || m,
       now() - (m || ' minutes')::interval
FROM chat_sessions s
CROSS JOIN generate_series(1, 40) m
WHERE s.user_email = 'carga-teste@example.com';

-- embeddings de 1024 dimensiones (Q4 y Q5 requieren la variante pgvector de la tabla)
INSERT INTO chat_message_embeddings (message_id, session_id, embedding)
SELECT m.id, m.session_id,
       (SELECT ('[' || string_agg(round(random()::numeric, 4)::text, ',') || ']')::vector
          FROM generate_series(1, 1024))
FROM chat_messages m
JOIN chat_sessions s ON s.id = m.session_id
WHERE s.user_email = 'carga-teste@example.com';
COMMIT;

-- limpieza al final (la cascada elimina mensajes, embeddings y tool calls)
BEGIN;
SELECT set_config('app.user_email', 'carga-teste@example.com', true);
DELETE FROM chat_sessions WHERE user_email = 'carga-teste@example.com';
COMMIT;
```

Los vectores aleatorios uniformes son un caso degenerado para un índice aproximado: cada
punto queda más o menos a la misma distancia de todos los demás. Para las mediciones de
HNSW de la §4.7, los vectores se generaron alrededor de 64 centroides aleatorios (cada
sesión abarca 3), para que los vecinos parezcan temas, con `setseed` para que cada
ejecución genere los mismos datos. Un segundo usuario ficticio (`outro-usuario@example.com`)
es dueño del 20% de las filas, para que los planes muestren si una consulta lee datos de
otros usuarios. 20 sesiones de ese usuario (200 en el volumen B) están en un proyecto
compartido con el grupo `w213-analysts` (rol view), al que el usuario medido solo llega por
`app.user_groups`.

**Configuración de referencia.** Los datos medidos en las §4.6 y §4.7 se generaron con
`scripts/bench/seed.sql` (con `seed_user.sql` y `seed_project.sql`), y el conjunto de consultas
de HNSW con `scripts/bench/hnsw-bench.mjs`; esta sección los resume, y cualquier divergencia
entre los dos es un error de esta página. Después de `SELECT setseed(0.4213)`, el script arma 64
centroides de 1024 dimensiones, cada coordenada `random() - 0.5`; el embedding de cada mensaje
es el centroide `(session_id × 7 + message_id mod 3) mod 64` más un ruido independiente
`(random() - 0.5) × 0.6` en cada coordenada, así que los mensajes de una sesión caen en 3
clústeres. Cada consulta del bench es el mensaje a un tercio de la sesión (por id) más un ruido
`(r - 0.5) × 0.3` por coordenada, con `r` tomado de `mulberry32(4213)`, que también elige las
sesiones. El volumen A es una ejecución con `main_sessions=200 other_sessions=50 msgs=40
proj_sessions=20`; el volumen B ejecuta el mismo script otra vez con `main_sessions=1800
other_sessions=450 proj_sessions=180`; el índice HNSW se eliminó antes de cada carga y se
reconstruyó después.

**Un rol al que alcanza la seguridad por fila.** La identidad que hace el deploy no sirve
para medir los planes: en Lakebase tiene `BYPASSRLS` (`databricks_superuser` también), y un
rol con bypass se salta incluso las políticas forzadas. El rol del propio service principal
de la app tiene `rolsuper = false`, `rolbypassrls = false`, `rolinherit = true`. Ejecute las
consultas de la §4 con ese rol, o con un rol de los mismos atributos y los mismos grants de
la app, mediante `SET ROLE`:

```sql
CREATE ROLE bench_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;
GRANT bench_app TO CURRENT_USER;  -- permite a la identidad del deploy hacer SET ROLE a él
```

```bash
node scripts/migrate.mjs grants --role bench_app   # los grants de mínimo privilegio de la app
```

### 2.2 Ejecución

```bash
# lecturas baratas, 1/5/20/50 usuarios, 60 s por etapa, think time de 1 s
APP_URL=<app-URL> DATABRICKS_TOKEN=<oauth-token> \
  npm run loadtest -- --stages 1,5,20,50 --duration 60 --think 1000 > read-results.md

# con turnos de chat (CUESTA TOKENS): un turno cada 10 iteraciones por usuario
APP_URL=<app-URL> DATABRICKS_TOKEN=<oauth-token> \
  npm run loadtest -- --chat --chat-every 10 --model <fast model> \
  --stages 1,5,20,50 --duration 60 --think 1000 > chat-results.md
```

`loadtest` no se ejecuta en CI: con la variable `CI` definida, se niega a correr. La sesión
de cada turno de chat se borra después, pero los turnos generan costo real en el gateway y
quedan en `usage_ledger` (el ledger conserva las filas: `session_id` pasa a `NULL`).
Acuerde el horario y el modelo antes. Con `--chat`, el informe incluye además dos filas
derivadas por etapa, que no son solicitudes y quedan fuera del total de la etapa:
`chat: envio → 1º token` (del envío al primer token) y `chat: meta → 1º token (S3)` (del
evento `meta` al primer evento `token`, la medida del S3).

**Todos los usuarios virtuales son la misma identidad** (la dueña del token). El límite de
tasa por usuario (`RATE_LIMIT_API_PER_MIN`, 120 por defecto, y `RATE_LIMIT_TURNS_PER_MIN`,
12 por defecto, `server/middleware/rateLimit.js`) respondería a la mayor parte de la carga
con 429 y estaría midiendo el limitador. Los usuarios reales quedan, cada uno, muy por
debajo de él; así que, **solo en la instalación de prueba**, ponga los dos en `0` en el
`app.yaml` mientras dure la prueba.

Ejecute una etapa por invocación (`--stages N`) cuando necesite el costo de cada etapa:
lea `SUM(cost_usd)` de `usage_ledger` antes y después de cada una.

Use el mismo `--think` y la misma duración entre ejecuciones que vaya a comparar.

### 2.3 Durante la prueba

Registre, por etapa, lo que `loadtest` no muestra:

- Lakebase: conexiones del service principal de la app (`pg_stat_activity` con `usename`
  igual al client id del SP) y, si está disponible, las CU en la consola.
- El estado del warehouse (si la carga pasa por UC Functions o por la UDF de Python).
- Errores en los logs de la app: `databricks apps logs <app> -p <PROFILE>` (ver
  [operations.md §2](operations.md#2-logs)).

### 2.4 Interpretación

- **El codo de la curva.** El punto en que la latencia p95 crece más rápido que el número
  de usuarios. Antes, el sistema escala; después, hay cola.
- **Cola en el pool.** El pool del service principal tiene un techo fijo de 8 conexiones
  (`POOL_OPTS`, `server/db/pool.js`). Si el p95 de las lecturas de base sube linealmente
  con los usuarios mientras Lakebase está ocioso y el SP tiene 8 conexiones, todas
  `active`, el cuello de botella es el pool, no la base. No existe la variable
  `PG_POOL_MAX`: el techo solo cambia en el código (ver §5). `PG_POOL_IDLE_TIMEOUT_MS`
  (2 min por defecto) es la única configuración del pool que se lee del entorno.
- **Errores sin latencia alta** indican un fallo de autenticación o de ruta. Lea la tabla
  de errores más frecuentes antes de concluir nada.
- **La tasa de error no es el único criterio.** Una etapa con 0% de errores y p95 por
  encima del SLO sigue reprobada.

---

## 3. Resultados de carga

**Medido el 2026-11-19, commit `a27c9ca`** (main), con el `scripts/load-test.mjs` de este
cambio (el mismo bucle de solicitudes, más las filas de primer token).

**Entorno:** una instalación de prueba desechable (app y service principal propios,
borrados después de la ejecución) en un workspace interno de prueba en AWS, región
us-west-2 · Lakebase: un branch desechable del proyecto de la instalación, autoscaling
0,5–16 CU, **warm** (endpoint activo, smoke justo antes) · datos: una base vacía, recién
migrada (versión 0007) · el generador de carga corrió en un portátil **fuera de la región**.

**Configuración:** `--duration 60 --think 1000 --timeout 30000 --chat --chat-every 10
--model databricks-claude-haiku-5-5`, una etapa por invocación, `enabledTools: []`, una
identidad para todos los usuarios virtuales, `RATE_LIMIT_API_PER_MIN=0` y
`RATE_LIMIT_TURNS_PER_MIN=0` en la instalación de prueba (§2.2). Tráfico de chat en total:
4 etapas × 60 s.

**Piso de latencia.** Las mismas consultas medidas dentro de la base tardan 0,4 ms, y unos
195 ms desde el portátil (§4.7); así que unos 200 ms de cada número de abajo son la red
entre el generador de carga y la región. Ejecute desde dentro de la región para quitarlos.

### 3.1 Todas las solicitudes, por etapa

| Usuarios | Solicitudes | Errores | Tasa de error | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 40 | 0 | 0,00% | 0,66 | 208 | 1698 | 3661 |
| 5 | 211 | 0 | 0,00% | 3,45 | 203 | 1705 | 3314 |
| 20 | 853 | 0 | 0,00% | 13,99 | 205 | 1938 | 2257 |
| 50 | 2071 | 0 | 0,00% | 33,27 | 210 | 1767 | 3851 |

El p95/p99 de la etapa son los turnos de chat (una solicitud de cada once); las lecturas
están en la §3.2.

### 3.2 Lecturas, por endpoint

| Usuarios | Endpoint | Solicitudes | Errores | p50 (ms) | p95 (ms) | p99 (ms) |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `GET /api/me` | 12 | 0 | 198 | 903 | 903 |
| 1 | `GET /api/models` | 12 | 0 | 199 | 214 | 214 |
| 1 | `GET /api/sessions` | 12 | 0 | 212 | 221 | 221 |
| 5 | `GET /api/me` | 65 | 0 | 197 | 213 | 871 |
| 5 | `GET /api/models` | 63 | 0 | 199 | 225 | 845 |
| 5 | `GET /api/sessions` | 63 | 0 | 216 | 242 | 860 |
| 20 | `GET /api/me` | 257 | 0 | 197 | 235 | 861 |
| 20 | `GET /api/models` | 259 | 0 | 198 | 258 | 841 |
| 20 | `GET /api/sessions` | 257 | 0 | 214 | 265 | 891 |
| 50 | `GET /api/me` | 627 | 0 | 198 | 344 | 871 |
| 50 | `GET /api/models` | 620 | 0 | 200 | 341 | 867 |
| 50 | `GET /api/sessions` | 624 | 0 | 218 | 334 | 877 |

Con 12 muestras, el p95 y el p99 de 1 usuario son la muestra más lenta (el primer `/api/me`).

### 3.3 Turnos de chat (`--chat`)

| Usuarios | Turnos | Errores | Turno p50 / p95 / p99 (ms) | Envío → 1.er token p50 / p95 / p99 (ms) | `meta` → 1.er token p50 / p95 / p99 (ms) |
|---:|---:|---:|---|---|---|
| 1 | 4 | 0 | 1698 / 3661 / 3661 | 1055 / 1179 / 1179 | 800 / 919 / 919 |
| 5 | 20 | 0 | 1705 / 3647 / 4304 | 1099 / 2751 / 3722 | 808 / 2499 / 2798 |
| 20 | 80 | 0 | 1948 / 2369 / 2863 | 1376 / 1751 / 2299 | 849 / 1197 / 2047 |
| 50 | 200 | 0 | 1805 / 4023 / 4225 | 1208 / 2024 / 3108 | 875 / 1615 / 2805 |

El tiempo del turno llega hasta el evento `done`. Con 4 y 20 muestras, los percentiles de
1 y 5 usuarios quedan cerca del máximo.

### 3.4 Costo por etapa (delta de `usage_ledger`)

| Usuarios | Filas del ledger | USD | Tokens de prompt | Tokens de respuesta | De ellos: títulos | chat | embeddings |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 16 | 0,001186 | 15.774 | 91 | 0,001015 | 0,000171 | 0,000000 |
| 5 | 80 | 0,005774 | 78.961 | 460 | 0,004892 | 0,000879 | 0,000003 |
| 20 | 320 | 0,023358 | 315.546 | 1.934 | 0,019810 | 0,003532 | 0,000016 |
| 50 | 800 | 0,058276 | 789.104 | 4.309 | 0,049737 | 0,008539 | 0,000000 |
| **Total** | **1.216** | **0,088594** | | | | | |

Cada turno escribió 4 filas en el ledger (chat, título, 2 embeddings); ninguna quedó sin
precio. Unos US$ 0,0003 por turno. **Los títulos son el 85% del costo** porque la prueba de
carga abre una sesión nueva por turno, y cada sesión nueva paga un título. Un usuario real
paga un título por conversación. Más del 99% de los tokens de prompt del chat fueron
lecturas de la caché de prompt.

### 3.5 Recursos durante la prueba

| Usuarios | Conexiones del SP (máx.) | Activas en la muestra (máx.) | Warehouse | Observaciones |
|---:|---:|---:|---|---|
| 1 | 4 | 0 | no usado | |
| 5 | 6 | 0 | no usado | |
| 20 | 8 | 1 | no usado | el pool llegó a su techo de 8 |
| 50 | 8 | 2 | no usado | en el techo, pero el p95 de las lecturas quedó en 334–344 ms |

Las conexiones se muestrearon de `pg_stat_activity` cada ~3,6 s (17 muestras por etapa).
Las CU no se registraron.

### 3.6 Veredictos

| SLO | Objetivo | Medido | Veredicto |
|---|---|---|---|
| S2 | p95 ≤ 800 ms en `/api/me`, `/api/models`, `/api/sessions`, 20 usuarios, app warm | 235 / 258 / 265 ms (50 usuarios: 344 / 341 / 334 ms) | **Aprobado**, con unos 200 ms de red incluidos |
| S3 | `meta` → 1.er token p95 ≤ 4 s, modelo rápido, Lakebase warm | 1197 ms con 20 usuarios, 1615 ms con 50 (Haiku 5.5) | **Aprobado** |
| S4 | ≥ 98% de los turnos sin evento `error` | 304 de 304 turnos | Aprobado (una ejecución, no una ventana de 7 días) |

Lo que esta ejecución **no** demuestra: volumen de datos (la carga corrió sobre una base
vacía; el costo del volumen está en la §4.6), arranque en frío (S5), herramientas (ninguna
UC Function, Genie ni búsqueda web en los turnos), usuarios reales repartidos en varias
identidades y un cliente dentro de la región.

---

## 4. Consultas críticas

Las consultas vienen de `server/db.js`. `scripts/bench/explain.sql` ejecuta cada una con
`EXPLAIN (ANALYZE, BUFFERS)` exactamente como la envía hoy la app (parámetros como
literales). Corre como `bench_role` (§2.1): imprime el `rolsuper` y el `rolbypassrls` del
rol y se detiene si alguno es verdadero. Cada consulta corre en una transacción que define
las tres configuraciones que define `withTx` (`app.user_email`, `app.is_admin`,
`app.user_groups`) y las imprime antes del plan, para que cada plan lleve la identidad con
la que corrió. Todo se deshace (rollback). Conéctese con `psql` a una base de prueba, con la
identidad que hace el deploy y una credencial de base recién generada, nunca con
credenciales guardadas en el repositorio:

```bash
psql -X -v uemail=carga-teste@example.com -v bench_role=bench_app \
  -v groups='["w213-analysts"]' -f scripts/bench/explain.sql
# opcional: -v sid=<id de sesión> (por defecto: la sesión más grande del usuario)
```

| ID | Consulta | La llama | Frecuencia esperada |
|---|---|---|---|
| Q1 | Lista de sesiones (`listSessions`) | `GET /api/sessions` | Apertura de la barra lateral |
| Q2 | Mensajes de la sesión (`fetchActiveMessages`) | `GET /api/sessions/:id/messages`, en cada turno | Apertura de conversación y cada turno |
| Q3 | Tool calls de la sesión (`fetchActiveMessages`, `chat_tool_calls`) | Junto con Q2 | Ídem |
| Q4 | Recuperación de historial por embedding (`retrieveRelevantMessages`) | Cada turno, con `HISTORY_RETRIEVAL` activo | Cada turno |
| Q5 | Búsqueda semántica entre sesiones (`searchSessionsByVector`) | `GET /api/search` | Al escribir en la búsqueda |
| Q6 | Uso del mes (`usageTotals`, mes) | `GET /api/usage/summary` | Inicio de sesión, cambio de conversación y fin de cada turno (el medidor no hace polling) |
| Q7 | Uso de la sesión (`usageTotals`, por tipo) | Ídem, con `sessionId` | Ídem |

Los índices relevantes (de las migraciones): `idx_chat_sessions_user (user_email,
updated_at DESC)`, `idx_chat_messages_session (session_id, id)`,
`idx_chat_tool_calls_message (message_id, seq)`, `idx_msg_emb_session (session_id)`,
`idx_msg_emb_hnsw` (HNSW, `vector_cosine_ops`), `idx_usage_ledger_user_time (user_email,
created_at)` e `idx_usage_ledger_session (session_id)`.

### 4.1 Q1: lista de sesiones

Un `LATERAL` lee los mensajes de cada sesión listada para reunir los nombres de adjuntos,
así que el costo crece con los mensajes de las 100 sesiones listadas, no solo con el
número de sesiones.

### 4.2 Q2 y Q3: mensajes y tool calls de una sesión

La Q2 une los mensajes con su sesión (la verificación de dueño). La Q3 recibe los ids que
leyó la Q2 (`WHERE message_id = ANY($1)`). Con la seguridad por fila, las dos llevan además
las verificaciones de las políticas: las políticas de la familia de la sesión arman el
conjunto de sesiones de proyecto de las que quien llama es miembro, llamando a
`aip_project_rank()` una vez por sesión de proyecto, y la Q3 verifica el mensaje y la sesión
de cada tool call fila por fila (§4.6).

### 4.3 Q4: recuperación de historial por embedding

La consulta filtra por una sesión (`e.session_id = $1`), numera las filas con
`ROW_NUMBER() OVER (ORDER BY m.id DESC)`, descarta las 6 más recientes y ordena por
similitud en una consulta externa. Por la función de ventana, **el índice HNSW no puede
atenderla**: la distancia se calcula para cada embedding de la sesión, lo que hace exacto
el resultado.

### 4.4 Q5: búsqueda semántica entre sesiones

La consulta agrupa por sesión con `MAX` y filtra con `HAVING`, lo que también impide el
índice HNSW. Con la seguridad por fila, el plan recorre las sesiones de quien llama y lee
los embeddings de cada una por `idx_msg_emb_session`, con una verificación de política por
fila de embedding, y calcula la distancia a cada vector del usuario (medido en la §4.6). El
costo crece con los embeddings del usuario. (Un rol que se salta las políticas recibe otro
plan, un Seq Scan sobre los embeddings de todos los usuarios: un motivo más para medir con
un rol al que alcanza la seguridad por fila.)

### 4.5 Q6 y Q7: uso (medidor)

Se espera que la Q6 use `idx_usage_ledger_user_time` y la Q7, `idx_usage_ledger_session`.
Las dos lo hacen.

### 4.6 Resultados de EXPLAIN

**Medido el 2026-11-19 (20:22–21:00 UTC)** con el SQL y las migraciones de la app del commit
`a27c9ca` (migraciones 0001–0007) y el `scripts/bench/explain.sql` de este cambio, en un
branch desechable (PostgreSQL 17, pgvector 0.8.0), datos sintéticos de la §2.1. **Semilla de
los datos:** `SELECT setseed(0.4213)` antes de cualquier llamada a `random()` (distinta de la
semilla de las consultas de HNSW de la §4.7). **Rol:**
`bench_role = w213_bench`, creado como en la §2.1 (`rolsuper = false`, `rolbypassrls = false`,
`rolinherit = true`, sin pertenecer a otros roles, los grants de la app), mediante
`SET ROLE` desde la identidad del deploy (`rolbypassrls = true`). **Configuración de quien
llama en cada transacción:** `app.user_email = carga-teste@example.com`,
`app.is_admin = off`, `app.user_groups = ["w213-analysts"]`.

- **Volumen A:** 250 sesiones (200 del usuario medido, 20 compartidas por grupo) / 10.000
  mensajes / 10.000 embeddings / 5.000 filas de ledger.
- **Volumen B:** 2.500 sesiones (2.000 del usuario medido, 200 compartidas por grupo) /
  100.000 mensajes / 100.000 embeddings / 50.000 filas de ledger.

Cada consulta corrió sobre dos sesiones de 40 mensajes: una del propio usuario medido
("propia") y una sesión de proyecto compartida por grupo, con 40 tool calls ("grupo"). Los
dos tiempos de B "propia" son dos ejecuciones sobre el mismo schema.

| ID | Volumen | Sesión | Tiempo de ejecución (ms) | Buffers (hit/read) | Recorrido e índice | Observaciones |
|---|---|---|---:|---|---|---|
| Q1 | A | — | 4,5 | 4.671 / 0 | Index Scan `idx_chat_sessions_user`; `idx_chat_messages_session` × 100 | |
| Q1 | B | — | 4,4 / 4,5 | 5.209 / 394 | Ídem | Solo crece con las 100 sesiones listadas |
| Q2 | A | propia / grupo | 2,8 / 3,0 | 121 / 0; 110 / 0 | Index Scan `idx_chat_messages_session`; `chat_sessions_pkey`; política: SubPlan con hash sobre las sesiones de proyecto (`idx_chat_sessions_project`) | |
| Q2 | B | propia / grupo | 13,1 / 14,6 | 774 / 0; 617 / 40 | Ídem | **Costo de la política**: un `aip_project_rank()` por sesión de proyecto (200), 12,6 ms |
| Q3 | A | propia / grupo | 1,1 / 7,6 | 6 / 0; 526 / 0 | Index Scan `idx_chat_tool_calls_message`; política `EXISTS` por fila (`chat_messages_pkey`, `chat_sessions_pkey`) | Sesión propia sin tool calls; sesión del grupo con 40 |
| Q3 | B | propia / grupo | 1,1 / 7,6 | 2 / 4; 592 / 14 | Ídem | ~0,17 ms por tool call, no depende del volumen |
| Q4 | A | propia / grupo | 3,0 / 8,4 | 580 / 0; 725 / 0 | `idx_msg_emb_session`; `chat_messages_pkey`; `chat_sessions_pkey`; SubPlan de la política como en la Q2 | Sin HNSW (§4.3) |
| Q4 | B | propia / grupo | 14,0 / 19,3 | 1.370 / 21; 1.390 / 0 | Ídem | El mismo costo de política que la Q2 |
| Q5 | A | — | 37,5 | 28.034 / 0 | Nested Loop: 200 sesiones de quien llama × Index Scan `idx_msg_emb_session` (8.000 filas); verificación de política por fila | Lee solo los embeddings de quien llama |
| Q5 | B | — | **902,3 / 738,2** | 535.974 / 76.147 | Ídem (2.000 sesiones, 80.000 filas) | **Brecha**: lineal en los embeddings del usuario (§5) |
| Q6 | A | — | 0,55 | 66 / 0 | Bitmap Index Scan `idx_usage_ledger_user_time` (836 filas del mes) | |
| Q6 | B | — | 5,0 / 5,0 | 0 / 624 | Ídem (8.436 filas del mes) | Crece con las filas del usuario en el mes |
| Q7 | A | — | 0,18 | 22 / 0 | Bitmap Index Scan `idx_usage_ledger_session` | |
| Q7 | B | — | 0,16 / 0,16 | 19 / 3 | Index Scan `idx_usage_ledger_session` | |

El volumen B es el volumen A ampliado con la misma semilla de los datos; los planes del
volumen A se midieron una vez en la carga y otra vez después de reducir B exactamente al A
(sesiones con id > 250 borradas, sesiones 221–250 sacadas de nuevo del proyecto compartido),
y las dos ejecuciones coinciden en menos de 1 ms (Q5: 37,5 y 37,1 ms).

**Antes y después de un índice.** Ningún plan mostró la falta de un índice: cada búsqueda
usa un índice existente. Los dos costos sensibles al volumen vienen de la forma de las
consultas y de las políticas, no de un índice que falte: la Q5 calcula la distancia a cada
vector del usuario, y las políticas de la familia de la sesión evalúan `aip_project_rank()`
una vez por sesión de proyecto y no una vez por proyecto. No se creó ningún índice, así que
no hay migración `0008_indexes`; el segundo tiempo de B es el "después", sobre el mismo
schema.

**Cifras anteriores retiradas.** Una primera ejecución de esta tabla (commit `1ca7bd6` de
este cambio) se midió con la identidad del deploy, que se salta la seguridad por fila, sin
`app.user_groups`. Sus planes no tenían verificaciones de política y su Q5 era un Seq Scan
sobre los embeddings de todos los usuarios. Esas cifras quedan reemplazadas por la tabla de
arriba.

### 4.7 HNSW: recall y latencia

**Medido el 2026-11-19 (20:22–21:00 UTC)**, mismo branch, datos y rol de la §4.6; SQL de la
app del commit `a27c9ca`. **Conjunto de consultas:** determinista, `mulberry32` con semilla
4213: 50 sesiones propias del usuario medido (y 20 compartidas por grupo para la Q4), cada
vector de consulta una perturbación de un mensaje de esa sesión (una "pregunta
relacionada"). **Verdad de referencia, calculada fuera de la base:** cada vector en bruto se
lee una vez (`vector_send`, float4 binario) y la respuesta exacta se calcula en JavaScript
por similitud de coseno. Para la Q4, con las mismas reglas que `retrieveRelevantMessages`
(excluye los 6 más recientes, similitud ≥ 0,35, top 6); para el top 10 directo, sobre la
tabla entera y sobre las filas que quien llama puede leer (sesiones propias más el proyecto
compartido). La misma consulta con los recorridos por índice desactivados (el recorrido
exacto de la base) devolvió la respuesta de JavaScript en todas las consultas
(concordancia 1,000 en los dos volúmenes). **Identidad:** la Q4 y el top 10 visible para el
usuario corren como `w213_bench` con la configuración de quien llama de la §4.6, así que las
políticas filtran las filas; el top 10 de la tabla entera es una caracterización del índice
y corre con la identidad del deploy (sin políticas). Los tiempos son el tiempo de ejecución
en la base (`EXPLAIN ANALYZE`); desde el portátil, cada consulta tardó unos 200 ms más.

| Volumen | Consulta | Recall (media / mín.) | Ejecución p50 / p95 (ms) | Usa HNSW |
|---|---|---|---|---|
| 10k | Q4, sesiones propias (50) | 1,000 / 1,000 | 2,58 / 2,78 | 0 de 50 |
| 10k | Q4, sesiones compartidas por grupo (20) | 1,000 / 1,000 | 8,21 / 10,71 | 0 de 20 |
| 100k | Q4, sesiones propias (50) | 1,000 / 1,000 | 13,59 / 15,20 | 0 de 50 |
| 100k | Q4, sesiones compartidas por grupo (20) | 1,000 / 1,000 | 19,49 / 22,12 | 0 de 20 |

Top 10 directo (`ORDER BY embedding <=> q LIMIT 10`), 50 consultas:

| Volumen | Filas buscadas | `ef_search` | `iterative_scan` | Recall (media / mín.) | Consultas con recall 0 / por debajo de 0,9 | Ejecución p50 / p95 (ms) | Recorrido exacto p50 / p95 (ms) |
|---|---|---:|---|---|---|---|---|
| 10k | tabla entera | 40 | off | 0,978 / 0,0 | 1 / 1 | 0,43 / 0,52 | 32,4 / 35,3 |
| 10k | tabla entera | 100 | off | 0,998 / 0,9 | 0 / 0 | 0,53 / 0,77 | |
| 10k | tabla entera | 400 | off | 1,000 / 1,0 | 0 / 0 | 2,16 / 2,73 | |
| 10k | visibles para el usuario (RLS) | 40 | off | 0,978 / 0,0 | 1 / 1 | 2,42 / 4,04 | 32,9 / 35,3 |
| 10k | visibles para el usuario (RLS) | 400 | relaxed_order | 1,000 / 1,0 | 0 / 0 | 4,25 / 4,94 | |
| 100k | tabla entera | 40 | off | 0,916 / 0,0 | 1 / 7 | 0,93 / 1,05 | 489,6 / 514,5 |
| 100k | tabla entera | 100 | off | 0,968 / 0,7 | 0 / 3 | 1,36 / 1,50 | |
| 100k | tabla entera | 200 | off | 0,976 / 0,8 | 0 / 3 | 1,72 / 1,87 | |
| 100k | tabla entera | 400 | off | 0,984 / 0,8 | 0 / 2 | 2,16 / 2,32 | |
| 100k | visibles para el usuario (RLS) | 40 | off | 0,916 / 0,0 | 1 / 9 | 15,38 / 18,00 | 471,6 / 500,7 |
| 100k | visibles para el usuario (RLS) | 100 | off | 0,966 / 0,8 | 0 / 3 | 15,66 / 16,62 | |
| 100k | visibles para el usuario (RLS) | 40 | relaxed_order | 0,916 / 0,0 | 1 / 9 | 15,30 / 17,65 | |
| 100k | visibles para el usuario (RLS) | 400 | relaxed_order | 0,984 / 0,8 | 0 / 2 | 16,59 / 19,09 | |

Construcción del índice (`CREATE INDEX ... USING hnsw`, configuración por defecto): 3,3 s en
10k, **4 min 44 s en 100k**. El grafo dejó de caber en `maintenance_work_mem` después de
13.935 filas.

Cómo leer los números:

- **La recuperación por turno de la app (Q4) es exacta en los dos volúmenes** y nunca usa el
  índice HNSW. Con las políticas cuesta 2,6 ms en 10k y 13,6 ms en 100k; el crecimiento es la
  verificación de política de la §4.6 (un `aip_project_rank()` por sesión de proyecto), no la
  distancia.
- **Ninguna consulta de la app usa `idx_msg_emb_hnsw` hoy**: la Q4 y la Q5 lo esquivan. El
  índice cuesta tiempo de escritura en cada embedding y minutos para reconstruirse.
- **El recall del HNSW directo** en 100k es 0,916 con el `ef_search` por defecto (40) y 0,968
  o más desde 100, contra la verdad independiente. Las políticas no cambian el recall;
  suman unos 14 ms por consulta en 100k. Un fallo suele ser todo o nada para una consulta
  (encuentra su clúster o no), el fallo conocido de HNSW con clústeres bien separados, y los
  clústeres sintéticos están más separados que los embeddings reales. Mida el recall con
  embeddings reales antes de ajustar `ef_search` o los parámetros de construcción.

**Cifras anteriores retiradas.** La primera ejecución de esta sección (commit `1ca7bd6`)
comparó el HNSW directo con el recorrido exacto de la propia base en lugar de una verdad
independiente, sorteó un conjunto de consultas nuevo y generó el volumen B con centroides
distintos de los del volumen A. Sus cifras de recall directo (0,850 con `ef_search` 40, 0,960
con 400) quedan reemplazadas por las tablas de arriba.

---

## 5. Próximos pasos después de la medición

- **Q5 (la brecha).** Reescribir `searchSessionsByVector` para que la base tome un
  conjunto de candidatos de HNSW restringido a las sesiones del usuario y lo agrupe por
  sesión, en lugar de calcular la distancia a todos los vectores. Un prototipo en el volumen
  B, ejecutado como `w213_bench` con la configuración de quien llama de la §4.6,
  `ef_search = 400`, `iterative_scan = relaxed_order` y 400 candidatos, pasó de 685 / 717 ms
  a **20,2 / 22,9 ms** (p50 / p95, 20 consultas), con el 98,8% de las 20 mejores sesiones en
  común con la consulta actual (una ejecución exploratoria, sin semilla). Cambia código de la app y resultados de la búsqueda, así que
  es una tarea aparte: compruebe el recall con datos reales y póngalo detrás de un flag.
  Hasta entonces, la Q5 cuesta unos 5 a 11 ms por cada 1.000 embeddings del usuario.
- **Políticas de proyecto.** Las políticas de la familia de la sesión llaman a
  `aip_project_rank()` una vez por cada sesión de proyecto que quien llama puede ver
  (12,6 ms para 200 sesiones de un proyecto), un costo que la Q2 y la Q4 pagan en cada
  turno. Evaluar la pertenencia una vez por proyecto (por ejemplo, un join con los proyectos
  de quien llama en lugar de una llamada a función por fila) es una migración y una tarea
  aparte; mídalo con este mismo script y rol.
- **`idx_msg_emb_hnsw`.** O la reescritura de la Q5 lo usa, o se puede eliminar (hoy no
  atiende ninguna consulta). Si lo mantiene, dele a la construcción del índice un
  `maintenance_work_mem` mayor para tablas grandes.
- **El pool.** Con 50 usuarios de este perfil, el pool del SP mantuvo sus 8 conexiones,
  pero con como mucho 2 activas por muestra y la latencia de las lecturas estable, no es
  el cuello de botella. No existe `PG_POOL_MAX`: el techo es el `max: 8` de `POOL_OPTS`
  (`server/db/pool.js`). Cree una variable de entorno solo después de que una medición
  muestre 8 conexiones activas de forma sostenida mientras crece el p95 de las lecturas, y
  tenga en cuenta el límite de conexiones de Lakebase.
- **El gateway.** La latencia del modelo no es de la app. Muestre los datos de
  `system.ai_gateway.usage` (dashboard `ai-ops`) en el informe.
- Repita la prueba desde dentro de la región, con herramientas activas y con más de una
  identidad, y después de cada cambio relevante, con el mismo `--think` y la misma duración.
