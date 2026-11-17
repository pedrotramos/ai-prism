<!-- i18n: source=dashboards/README.md source-hash=f5cf33be18ea3932588d72a90a7c190ec127114a status=current -->
# AI Prism — dashboards de AI/BI

[English](../../../dashboards/README.md) · [Português (Brasil)](../../pt-BR/dashboards/README.md) · **Español**

Los administradores auditan AI Prism con dos **dashboards de AI/BI (Lakeview) de
Databricks**, no dentro de la app. Ambos leen solo **system tables** de Unity Catalog:
no necesitan instrumentación adicional y no dependen del Lakebase de la app. Las
consultas se ejecutan en AI/BI, en el SQL Warehouse del bundle, en ejecuciones propias:
un warehouse frío o un escaneo pesado de system tables nunca bloquea la interfaz de la
app.

| Dashboard | Archivo | Responde |
| --- | --- | --- |
| **AI Prism — AI costs per user** | `ai-costs.lvdash.json` | "¿Cuánto costó y quién lo usó?" |
| **AI Prism — Operations** | `ai-ops.lvdash.json` | "¿Se está usando la app y está respondiendo?" |

Un `databricks bundle deploy` (o `./deploy.sh`) despliega los dos: están declarados en
`databricks.yml` como `dashboards.ai_prism_costs` y `dashboards.ai_prism_ops`, en el
mismo warehouse que la app. Cada workspace que ejecuta AI Prism despliega su propia
copia; nada en esta carpeta está atado a una cuenta, un warehouse o un usuario concreto.

## Dashboard de costos (`ai-costs.lvdash.json`)

### Qué muestra

El costo **facturado** real — `DBU × precio de lista` de `system.billing.usage` ⋈
`system.billing.list_prices` — repartido por usuario según su parte de los tokens
diarios del endpoint (`system.serving.endpoint_usage` ⋈
`system.serving.served_entities` para el nombre del endpoint). El alcance es AI Prism,
mediante la marca `usage_context['application'] = 'ai-prism'` que se graba en cada
llamada al gateway (ver `server/llm.js`). **Nota:** `usage_context` llega a
`system.serving.endpoint_usage.usage_context`, *no* a
`system.ai_gateway.usage.request_tags`; una consulta anterior leía la tabla/columna
equivocada y siempre devolvía "No data".

Un dataset (**`ai_prism_detail`**), por usuario × endpoint × día, con `prompt_tokens`,
`completion_tokens`, `total_tokens`, `turns` y los `dbus` / `usd` repartidos, alimenta
todos los widgets (últimos 90 días).

Diseño (cuadrícula de 12 columnas), igual a la versión curada en el editor de dashboards:

- **Filtros + KPI principales** (arriba): selección múltiple de usuario y selector de
  período (por defecto, los últimos 30 días), más contadores: DBU consumidas, costo
  estimado (USD), turnos, usuarios distintos, tokens de entrada / salida / total.
- **Tabla de detalle**: usuario · endpoint · día, con columnas de tokens y turnos.
- **Cuatro secciones**, cada una con barras por endpoint + por día + por usuario:
  **USD**, **Tokens**, **DBU** y **Turnos**.

Los colores usan las posiciones de `visualizationColors` del tema del workspace, así
que el dashboard sigue el lenguaje visual de la app en lugar de un color distinto por
gráfico.

### Notas

> **Retraso de ingesta.** `system.serving.endpoint_usage` (tokens) y
> `system.billing.usage` (costo) llegan con cerca de 1 h de retraso: el dashboard es
> casi en tiempo real, no en vivo.

> **Edición.** `ai-costs.lvdash.json` es la exportación exacta del editor de
> dashboards de Databricks. Edítalo allí y trae el cambio de vuelta al repositorio (ver
> [Editar un dashboard](#editar-un-dashboard)); no edites el JSON a mano.

## Dashboard de operación (`ai-ops.lvdash.json`)

Complementa el de costos con **volumen, usuarios y latencia**. El mismo alcance
(`usage_context['application'] = 'ai-prism'` en `system.serving.endpoint_usage`), la
misma ventana de 90 días en las consultas y un filtro de período (por defecto, los
últimos 30 días).

### Qué muestra

| Widget | Dataset | Medida |
| --- | --- | --- |
| Llamadas, usuarios activos, tokens (contadores) | `ops_daily`, `ops_user` | Total del período |
| Llamadas por día × endpoint | `ops_daily` | Volumen diario, apilado por endpoint |
| Tokens por día × endpoint | `ops_daily` | Lo mismo, en tokens |
| Llamadas por usuario | `ops_user` | Concentración del uso |
| Totales por endpoint | `ops_daily` | Llamadas y tokens por modelo |
| Latencia p95 del gateway por día | `ops_latency` (join con `system.ai_gateway.usage`) | p95 por día y endpoint, con retraso de ingesta |

El join de latencia usa `databricks_request_id = request_id`. Solo devuelve filas de
las llamadas que también llegan a `system.ai_gateway.usage`. En el workspace de prueba
revisado el 2026-11-17 la consulta se ejecutó, pero devolvió 0 filas: las llamadas de
AI Prism a `/serving-endpoints` no estaban en esa tabla allí, así que el panel de
latencia queda vacío hasta que lo estén. Los otros cinco widgets no dependen de él.

### Qué no muestra (y por qué)

- **Tasa de error**: `system.serving.endpoint_usage` tiene la columna `status_code`
  (esquema revisado el 2026-11-17), pero ningún widget la usa todavía. Un panel de tasa
  de error está previsto junto con los paneles de OpenTelemetry de abajo.
- **Llamadas sin precio** (`cost_usd IS NULL`): es un concepto de `usage_ledger`, que
  vive en el Lakebase de la app y no es una system table.
- **Volumen por tipo de llamada** (chat, multimedia, clasificador de intención,
  imagen): la app solo graba `application` en `usage_context`. Para separar por tipo,
  `server/llm.js` tiene que pasar también una clave como `feature`.
- **Latencia de extremo a extremo de un turno**: el gateway solo mide la llamada al
  modelo. La latencia del turno completo (base de datos, tools, posprocesamiento) viene
  de la telemetría de OpenTelemetry.

### Paneles de OpenTelemetry (por agregar)

> **Por completar cuando la telemetría esté activa.** Paneles previstos, sin datos hoy:
>
> - Tasa de error por ruta (`/api/*`) y por tipo de error.
> - Latencia p50/p95/p99 por ruta y por tool.
> - Turno de chat de extremo a extremo: TTFT, tiempo hasta `done` y el reparto por fase
>   (base de datos, tools, modelo, posprocesamiento).
> - Saturación del pool de conexiones de Lakebase (tiempo de espera por conexión).
> - Tasa de error de tools y de MCP, con el servidor de origen.
> - Tokens y costo por turno, correlacionados con el `request_id`.
>
> Ver [docs/operations.md §3](../../operations.md#3-telemetria-opentelemetry).

## Despliegue y publicación

### Con el bundle (por defecto)

Normalmente no despliegas estos dashboards a mano. `databricks bundle deploy` (que
`./deploy.sh` y `.\deploy.ps1` ejecutan por ti) crea o actualiza los dos como
**borrador** en la carpeta del bundle en el workspace. Después:

- **Dashboard de costos**: el job de auto-config posterior al despliegue
  (`bundle/auto_config.py`) lo **publica**, así que los administradores lo ven
  publicado sin ningún paso manual.
- **Dashboard de operación**: queda como **borrador**. Ábrelo en el workspace
  (*Dashboards* → "AI Prism — Operations"; en el target `dev` el nombre lleva el
  prefijo `[dev <usuario>]`) y haz clic en **Publish** una vez. Los despliegues
  siguientes actualizan el borrador; vuelve a publicar para llevar el cambio a quienes
  solo lo consultan.

### Por separado, con `deploy.sh`

`dashboards/deploy.sh` envía un dashboard por la API de Lakeview, fuera del bundle.
Necesita un perfil autenticado de la CLI `databricks` y `jq`. Usa tus propios valores
(nada aquí está atado a una cuenta concreta):

| Variable | Qué poner |
| --- | --- |
| `PROFILE` | Tu perfil de la CLI `databricks` (de `databricks auth login`). |
| `WAREHOUSE_ID` | Cualquier SQL Warehouse del workspace que pueda leer las system tables. |
| `PARENT_PATH` | La carpeta del workspace donde crear el dashboard, p. ej. `/Users/<tú>@<empresa>.com`. |
| `DASHBOARD_ID` | Solo para actualizar en el lugar: el id que se imprime al crearlo. |
| `DASHBOARD_FILE` | Opcional: `ai-costs.lvdash.json` (por defecto) o `ai-ops.lvdash.json`. |
| `DISPLAY_NAME` | Opcional: el nombre del dashboard (por defecto "AI Prism — AI costs per user"). |

```bash
# First time (creates a new dashboard in your workspace, prints its id):
PROFILE=<your-cli-profile> \
WAREHOUSE_ID=<your-warehouse-id> \
PARENT_PATH=/Users/<you>@<company>.com \
  ./dashboards/deploy.sh

# Update in place afterwards (idempotent):
PROFILE=<your-cli-profile> \
WAREHOUSE_ID=<your-warehouse-id> \
DASHBOARD_ID=<id-from-create> \
  ./dashboards/deploy.sh

# The operations dashboard, with its own name:
PROFILE=<your-cli-profile> \
WAREHOUSE_ID=<your-warehouse-id> \
PARENT_PATH=/Users/<you>@<company>.com \
DASHBOARD_FILE=ai-ops.lvdash.json \
DISPLAY_NAME="AI Prism — Operations" \
  ./dashboards/deploy.sh
```

Después, abre el dashboard en el workspace y haz clic en **Publish** para que los demás
administradores lo vean. Los archivos `.lvdash.json` son totalmente portables, y las
system tables que leen (`system.billing.*`, `system.serving.*`, `system.ai_gateway.*`)
existen en todo workspace con Unity Catalog.

## Editar un dashboard

Los archivos JSON son exportaciones del editor de dashboards, y la copia del
repositorio es lo que despliega cada deploy. Para cambiar un dashboard:

1. Edita el borrador desplegado en el editor de dashboards y comprueba que todos los
   datasets se ejecutan.
2. Trae el cambio de vuelta al repositorio, por ejemplo
   `databricks bundle generate dashboard --resource ai_prism_ops --force -p <PROFILE>`
   (o `ai_prism_costs`), o *File → Export* y sobrescribe el archivo aquí.
3. Haz commit del JSON. El próximo `bundle deploy` lo despliega tal cual.

La prueba `tests/bundleDashboards.test.mjs` comprueba, sin conexión, que cada archivo
de aquí está declarado en `databricks.yml`, que cada widget lee un dataset que existe y
que cada consulta sobre `system.serving.endpoint_usage` tiene el alcance de AI Prism.

## Archivos

- `ai-costs.lvdash.json`: el dashboard de costos (fuente de verdad del bundle).
- `ai-ops.lvdash.json`: el dashboard de operación (fuente de verdad del bundle).
- `deploy.sh`: crea o actualiza un dashboard en un workspace por la API de Lakeview,
  fuera del bundle.
