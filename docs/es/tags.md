<!-- i18n: source=docs/tags.md source-hash=695bcd7ef88753de042ef8be6f60e7c2c97c0281 status=current -->
# Etiquetas de recurso y atribución de costos

[English](../tags.md) · [Português (Brasil)](../pt-BR/tags.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../tags.md) es la referencia.

Esta guía explica cómo AI Prism etiqueta los recursos que crea en el workspace y el
consumo que genera sobre ellos, cómo pasar las etiquetas en el despliegue, cómo leer el
costo desde las system tables y cuándo usar una serverless usage policy.

## Visión general

Una **etiqueta de recurso** es un par `clave=valor` que Databricks guarda en el recurso y
que aparece en las tablas de sistema de costo y de historial de consultas. Con ella, el
costo de AI Prism se puede separar por centro de costo, área o cualquier criterio que use
tu empresa, sin depender de quién hizo la llamada.

El operador indica las etiquetas **una vez, en el despliegue**. Después AI Prism:

1. **etiqueta los recursos que crea el bundle** (SQL Warehouse, Lakebase, job de
   auto-config y, a través del job, el catálogo, el schema, el volume y la función de
   Python de la instalación);
2. **carga las mismas etiquetas en el runtime de la app** y las envía en cada llamada que
   hace la app: en el `usage_context` de toda llamada a AI Gateway y en los `query_tags`
   de todo statement en el SQL Warehouse.

## Etiqueta integrada: `ai_prism_app`

Toda instalación tiene la etiqueta integrada **`ai_prism_app=<nombre de la app>`** (por
defecto, `ai_prism_app=ai-prism`). Esta etiqueta:

- siempre se agrega y aparece al final en las listas de etiquetas;
- **no se puede sobrescribir**: una etiqueta del operador con ese nombre (en cualquier
  combinación de mayúsculas y minúsculas, incluido `AI_PRISM_APP`) se ignora con una
  advertencia;
- es la clave que separa la instalación de otras en el mismo workspace: el panel de costo
  y las consultas de abajo filtran por ella.

También está **reservada** la clave `application`, que AI Prism usa internamente para
atribuir las llamadas de IA a la propia app (`usage_context['application'] = 'ai-prism'`).
Si el operador pasa `application`, se ignora con una advertencia.

## Cómo pasar las etiquetas en el despliegue

Puedes pasar las etiquetas de cuatro maneras. Todas pasan por la misma validación.

| Dónde | Cómo |
|---|---|
| `deploy.sh` (Linux/macOS) | `--tag cost_center=1234 --tag area=Finanças` (repetible) |
| `deploy.sh` (entorno) | `TAGS="cost_center=1234,area=Finanças" ./deploy.sh DEV` |
| `deploy.ps1` (Windows) | `-Tag 'cost_center=1234','area=Finanças'` o `-Tag "cost_center=1234,area=Finanças"` |
| Notebook instalador | campo **8. Tags de recurso** (la etiqueta del notebook está en portugués): `cost_center=1234,area=Finanças` |

Ejemplo:

```bash
./deploy.sh --tag cost_center=1234 --tag area=Finanças DEV ai_prism
```

### Reglas de clave y valor

- Clave y valor: de 1 a 255 caracteres (el valor puede estar vacío), solo con **letras**
  (incluidas las acentuadas), **números**, espacios y los símbolos `_ + - = . : / @`.
- Sin comillas, comas, punto y coma, barras invertidas, paréntesis y similares.
- **Como máximo 24 etiquetas del operador**, más la integrada, para un total de 25. Es el
  límite de la Jobs API, que recibe las etiquetas del job de auto-config. `deploy.sh` y el
  notebook rechazan una lista más larga antes de tocar cualquier recurso.
- Las claves que solo difieren en mayúsculas y minúsculas (`Area` y `area`) se rechazan,
  porque PowerShell las trata como la misma clave.
- El SQL Warehouse acepta como máximo **20** `query_tags` por statement. El runtime reserva
  espacio para la etiqueta integrada y descarta (con una advertencia en el log) las
  etiquetas del operador que superen ese límite.

Las validaciones son las mismas en `deploy.sh`, `deploy.ps1`, el notebook y el runtime
(`server/resourceTags.ts`), y están cubiertas por las pruebas en `tests/resourceTags.test.mjs`.

## Dónde va cada etiqueta

| Recurso o consumo | Mecanismo | Dónde aparece |
|---|---|---|
| SQL Warehouse | `tags.custom_tags` (bundle) | `system.billing.usage.custom_tags` |
| Lakebase (proyecto) | `custom_tags` (bundle, beta; cubre todas las ramas y endpoints) | facturación de Lakebase |
| Job de auto-config | `tags` (bundle) | `system.billing.usage.custom_tags` |
| Catálogo, schema, volume y función de Python creados por la instalación | `ALTER ... SET TAGS` / `SET TAG ON FUNCTION`, ejecutado por el job de auto-config | `information_schema.*_tags` |
| Llamadas a AI Gateway (chat, embeddings, imágenes, transcripción) | `usage_context` en cada llamada, en el runtime | `system.serving.endpoint_usage.usage_context` |
| Llamadas de imagen por un Model Provider Service de Unity Catalog | las mismas etiquetas, en el header de solicitud `Databricks-Ai-Gateway-Request-Tags`, en el runtime | `system.ai_gateway.usage.request_tags` |
| Statements del SQL Warehouse (herramientas de UC, UDF, consultas de la app) | `query_tags` en cada llamada, en el runtime | `system.query.history.query_tags` |
| App (Databricks App) | no tiene campo `tags`; solo una **serverless usage policy** (abajo) | `system.billing.usage` (`usage_metadata.usage_policy_id`) |

Observaciones:

- El **catálogo** solo se etiqueta cuando la propia instalación lo crea. Un catálogo
  preexistente y compartido (el caso típico de un workspace de demostración, donde quien
  despliega solo tiene permiso sobre el catálogo que ya existe) **no se toca**: sus
  etiquetas pertenecen a otros equipos.
- Los objetos de UC se **reconcilian en cada despliegue**: se vuelve a aplicar el valor
  actual de cada etiqueta del operador, y una clave que salió de la configuración se
  elimina (`UNSET TAG`).
- Si un workspace tiene una **tag policy** que rechaza un valor, solo esa etiqueta queda
  fuera de ese objeto; las demás (incluida la integrada) siguen aplicadas.
- Etiquetar funciones requiere Databricks Runtime 18.1 o más reciente. En runtimes que no
  soportan la operación, el auto-config **advierte y continúa** (no interrumpe el despliegue).

## Leer el costo desde las system tables

Los ejemplos suponen que las etiquetas se pasaron como `cost_center` y `area`. Para ver los
nombres exactos en tu workspace, ejecuta `DESCRIBE TABLE system.billing.usage` o
`DESCRIBE TABLE system.serving.endpoint_usage`.

**Costo de infraestructura (SQL Warehouse, Lakebase, job) por etiqueta.** Las filas de la
instalación son las que tienen `ai_prism_app`:

```sql
SELECT
  custom_tags['cost_center']                 AS cost_center,
  sku_name,
  SUM(usage_quantity)                        AS dbus
FROM system.billing.usage
WHERE custom_tags['ai_prism_app'] = 'ai-prism'
  AND usage_date >= date_sub(current_date(), 30)
GROUP BY 1, 2
ORDER BY dbus DESC;
```

**Tokens y llamadas de IA por etiqueta.** `usage_context` es un MAP; el filtro por
`application = 'ai-prism'` separa AI Prism del resto del tráfico de serving del workspace:

```sql
SELECT
  usage_context['cost_center']               AS cost_center,
  endpoint_name,
  SUM(input_token_count)                     AS tokens_in,
  SUM(output_token_count)                    AS tokens_out,
  COUNT(*)                                   AS chamadas
FROM system.serving.endpoint_usage
WHERE usage_context['application'] = 'ai-prism'
  AND usage_context['ai_prism_app'] = 'ai-prism'
  AND request_time >= date_sub(current_date(), 30)
GROUP BY 1, 2;
```

**Consultas SQL de la app por etiqueta.** `query_tags` es un array de `{key, value}`; la
forma exacta de la columna puede variar entre versiones, así que revísala con `DESCRIBE
TABLE system.query.history` antes de armar el panel:

```sql
SELECT t.value AS cost_center, COUNT(*) AS statements
FROM system.query.history h
LATERAL VIEW EXPLODE(h.query_tags) q AS t
WHERE q.key = 'ai_prism_app' AND q.value = 'ai-prism'
  AND t.key = 'cost_center'
GROUP BY 1;
```

El panel de costos de AI Prism (`dashboards/ai-costs.lvdash.json`, publicado por el job de
auto-config) lee las mismas fuentes: `system.serving.endpoint_usage` filtrada por
`usage_context['application'] = 'ai-prism'` y `system.billing.usage`.

> **Retraso:** las system tables de facturación llegan con algunas horas de retraso, y el
> día de hoy siempre está incompleto. Las etiquetas nuevas solo aparecen en las filas
> posteriores al despliegue.

## Serverless usage policy

Una **serverless usage policy** es un objeto **de la cuenta** que asigna el consumo
serverless a un conjunto de etiquetas, con un presupuesto opcional. El bundle **nunca crea**
la policy: se comparte entre workspaces, así que un admin la crea una vez y AI Prism solo
recibe el id.

1. Un admin de la cuenta crea la policy en **Settings → Compute → Serverless usage
   policies → Manage** (en el workspace, o en la consola de la cuenta), con las etiquetas de
   costo que quieras.
2. Pasa el id al instalador:
   ```bash
   ./deploy.sh --usage-policy-id <id> DEV ai_prism
   ```
   (en Windows, `-UsagePolicyId <id>`; en el notebook, el campo **7. Serverless usage policy
   id**, cuya etiqueta está en portugués).
3. Sin el id, no se asigna nada. Un id no válido aparece en `bundle deploy`.

La policy cubre la **App** y el **job de auto-config**. El SQL Warehouse y Lakebase reciben
las etiquetas por sus propios campos, descritos arriba.

## Ruta nativa del bundle (sin el script de despliegue)

`databricks bundle deploy` directo, sin `deploy.sh`, `deploy.ps1` ni el notebook, funciona,
pero con una diferencia:

- las **etiquetas de los recursos** (warehouse, Lakebase, job, objetos de UC) se aplican
  igual, porque vienen de las variables del bundle (`resource_tags`, `resource_tags_list`);
- las **etiquetas en el runtime de la app** (`usage_context` y `query_tags`) solo cambian
  cuando se actualiza `AI_PRISM_RESOURCE_TAGS` en `app.yaml`. Los wrappers hacen esto; en la
  ruta nativa tienes que editar `app.yaml` con el JSON que el job de auto-config imprime al
  final del log (la línea `AVISO IMPORTANTE — tags de recurso no runtime do app`, impresa en
  portugués), y volver a ejecutar `databricks apps deploy`.

Mientras no se haga, la app sigue usando solo la etiqueta integrada en AI Gateway y en el
SQL Warehouse. El job no puede hacer ese cambio por sí solo, porque requiere un nuevo
despliegue del código de la app.

## Cambiar las etiquetas después de la instalación

Vuelve a ejecutar el despliegue con las etiquetas nuevas (el proceso es idempotente):

```bash
./deploy.sh --tag cost_center=5678 DEV ai_prism
```

- Las etiquetas agregadas o con un valor nuevo empiezan a valer para el **consumo nuevo**;
  el historial de costos guarda la etiqueta que estaba vigente en su momento.
- Una etiqueta quitada de la lista deja de enviarse. En los objetos de UC, el auto-config la
  elimina (`UNSET TAG`); en los recursos del bundle, sale en la próxima actualización.

## Referencias

- Despliegue e instalación: [docs/onboarding-deployment.md](onboarding-deployment.md)
- Runtime: `server/resourceTags.ts` (reglas, `usageContext`, `queryTagsFor`)
- Pruebas: `tests/resourceTags.test.mjs` (`node --test tests/resourceTags.test.mjs`)
- Variables del bundle: `databricks.yml` (`resource_tags`, `resource_tags_list`,
  `resource_tags_json`, `serverless_usage_policy_id`, `warehouse_serverless`)
