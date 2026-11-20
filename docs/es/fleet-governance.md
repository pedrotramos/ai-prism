<!-- i18n: source=docs/fleet-governance.md source-hash=4fb878f8a7c78061b14c331d2976545bc3c9b2d6 status=machine -->
# Gobernanza de varias instalaciones de AI Prism

[English](../fleet-governance.md) · [Português (Brasil)](../pt-BR/fleet-governance.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../fleet-governance.md) es la referencia.

Cuando la misma organización ejecuta AI Prism en más de un workspace (o en más de un
entorno, o para más de un equipo), cada instalación es independiente: tiene su app, su
Lakebase, su warehouse, su catálogo y sus admins. Este documento define cómo mantener ese
conjunto bajo control: quién es dueño de cada instalación, cómo nombrar y etiquetar los
recursos, qué guardrails hay en el bundle, cómo atribuir el costo y cómo desactivar una
instalación sin dejar recursos huérfanos.

Para el modelo de amenazas de cada instalación, consulta [security-threat-model.md](../security-threat-model.md).
Para la operación del día a día, consulta [operations.md](operations.md).

---

## 1. Modelo

- **Una instalación = un workspace (o un entorno) + un `databricks.yml` + un profile de la CLI.**
  No hay base de datos, catálogo ni admin compartidos entre instalaciones.
- El bundle es **independiente de la nube**: ningún host está en el archivo. La instalación se
  elige con `-p <PROFILE>` y `-t <target>` (`dev` o `prod`, definidos en `databricks.yml`).
- El código es el mismo en todas las instalaciones (artefactos versionados). Las diferencias
  entre instalaciones deben venir solo de variables del bundle (`--var`) y de recursos del
  workspace.

---

## 2. Dueño y responsables

Cada instalación necesita un registro con estos campos, mantenido fuera del repositorio
(una hoja de cálculo, una wiki o el propio inventario de recursos de la organización):

| Campo | Valor esperado | Por qué importa |
|---|---|---|
| Responsable técnico | Persona que ejecuta `bundle deploy` y recibe las alertas | Responde por el despliegue y por el smoke |
| Admin de bootstrap | Correo registrado en `app_admins` por el job de auto-config (`ai_prism_auto_config`) | Primer admin; los demás los agrega un admin existente |
| Responsable del costo | Persona o centro de costo que paga el workspace | Recibe el informe de costos (§5) |
| Workspace y profile | Host real y nombre del profile | Evita desplegar en el workspace equivocado |
| Versión desplegada | SHA del commit de los artefactos | Ver §3.5 |

**Owner (`APP_OWNER_EMAIL`).** El bundle no define esta variable, y `app.yaml` tampoco. Sin
ella, ningún usuario tiene el rol de owner (`isOwner` en `server/authz.js` es falso; la función
también lee `DATABRICKS_USER_EMAIL`, una variable de desarrollo local que el runtime de Apps no
define para la app). Los admins vienen de
`app_admins`. Es una decisión de diseño del proyecto, no un error, pero hay que saberlo antes de
diseñar un proceso de aprobación.

---

## 3. Nombres, etiquetas e inventario

### 3.1 Nombres que crea el bundle

| Recurso | Nombre (target `dev`/`prod`) | Observación |
|---|---|---|
| Bundle | `ai-prism` | Nombre del bundle; el despliegue de `dev` usa el prefijo de desarrollo de la propia CLI |
| App | `ai-prism` | Nombre de la app en el workspace; es el destino de `apps deploy` |
| Proyecto Lakebase | `ai-prism` (branch `production`, endpoint `primary`) | Un proyecto por instalación |
| SQL Warehouse | `ai-prism` | 2X-Small, serverless |
| Job de auto-config | `ai-prism-auto-config` | Se ejecuta con `bundle run` |
| Dashboards | `AI Prism — AI costs per user` y `AI Prism — Operations` | Declarados en `databricks.yml` (`ai_prism_costs`, `ai_prism_ops`) |
| Catálogo | `ai_prism` (valor por defecto de `image_volume_catalog` y `tools_catalog`) | Compartido por la UDF y el Volume dentro de la instalación |
| Volume de imágenes | `ai_prism.default.ai_prism_images` | Valor por defecto del bundle |

Para varias instalaciones **en el mismo metastore**, el catálogo `ai_prism` es un conflicto:
una segunda instalación no puede crearlo. Define `image_volume_catalog` y `tools_catalog` con
un nombre por instalación (por ejemplo, `ai_prism_<equipo>`) y pásalos con `--var`.

### 3.2 Etiquetas

El bundle etiqueta lo que crea, y la app etiqueta su propio uso. El operador pasa las etiquetas una
sola vez al desplegar (`resource_tags`, `resource_tags_list`, `resource_tags_json` en `databricks.yml`;
`deploy.sh --tag k=v`). La guía completa, con las reglas de validación y el SQL para leer el costo
por etiqueta, está en [tags.md](tags.md). En resumen:

| Recurso o uso | Mecanismo |
|---|---|
| SQL Warehouse, proyecto Lakebase, job de auto-config | etiquetas en el bundle |
| Catálogo, schema, volume y función Python de la instalación | las define el job de auto-config |
| Llamadas al AI Gateway | `usage_context` en cada llamada (`server/llm.js`, `server/resourceTags.js`) |
| Sentencias del SQL Warehouse | `query_tags` en cada llamada |
| La propia App | no tiene el campo `tags`; usa una serverless usage policy ([§8](#8-databricks-app-spaces-beta)) |

Toda instalación lleva la etiqueta integrada `ai_prism_app=<nombre de la app>`, que no se puede
sobrescribir, y la clave `application` está reservada. Claves sugeridas para una flota (son solo
una convención; la app acepta cualquier clave válida): `instance` (nombre corto de la instalación),
`environment` (`dev` o `prod`), `owner_team` (chargeback).

### 3.3 Inventario

Mantén, por instalación, la lista de recursos que crearon el bundle y el operador. Es la base
del retiro (§7). Elementos que conviene registrar además de la tabla anterior:

- Schemas y volumes creados fuera del bundle (por ejemplo, el catálogo de imágenes cuando el
  auto-config no tiene permiso y un admin lo crea a mano).
- Paneles publicados manualmente, con el ID de la versión en producción.
- Conexiones MCP y catálogos MCP publicados por admins.

### 3.4 Versiones

`GET /api/health` (detrás de la misma autenticación que el resto de `/api`) responde
`{ status, db, version, commit, uptime_s }` (`server/routes/health.js`, `server/version.js`):
`version` es la versión de `package.json` estampada en el build. Registra también el SHA del commit
en el inventario (§3.3) en cada `apps deploy`, porque `version` cambia solo en un release.

### 3.5 Comparar instalaciones

Con el SHA registrado, `git diff <sha-A> <sha-B> -- server-dist client/dist` muestra si dos
instalaciones usan el mismo artefacto. Artefactos iguales garantizan el mismo código, pero no la
misma configuración del bundle.

---

## 4. Guardrails del bundle

Los límites de abajo están en `databricks.yml`. Son el piso de costo y de superficie de cada
instalación. Cambiarlos requiere revisión.

| Guardrail | Valor | Efecto |
|---|---|---|
| Lakebase autoscaling | 0,5 a 16 CU | Techo de capacidad y costo |
| Suspensión de Lakebase | `lakebase_suspend_timeout` sin uso (por defecto 600 s) | Deja de cobrar el compute ocioso |
| SQL Warehouse | 2X-Small, `max_num_clusters: 1`, auto-stop de 10 min | Techo de costo de la UDF y de las UC Functions |
| Scopes de OBO | `user_api_scopes`, con motivo por scope | Privilegio mínimo para las APIs usadas |
| Recursos de acceso | `CAN_USE` en el warehouse, `CAN_CONNECT_AND_CREATE` en Lakebase | Solo la app accede a estos recursos |
| Modo de despliegue | `dev` con `mode: development`; `prod` con `mode: production` | Distingue el entorno de producción |
| Búsqueda web | Solo con `WEB_SEARCH_CONNECTION` configurada | Desactivada por defecto |
| Transcripción | `TRANSCRIBE_DISABLED=1` desactiva la función | Control de costo y de datos |

**Brechas de guardrails:**

- No hay límite de gasto por usuario en la app (G4 del modelo de amenazas). Usa los
  presupuestos nativos del workspace.
- El bundle nunca crea una serverless usage policy (es un objeto de nivel de cuenta compartido
  entre workspaces). Para asociar una existente a la App y al job de auto-config, pasa su id en
  la variable `serverless_usage_policy_id` (`deploy.sh --usage-policy-id <id>`; ver
  [tags.md](tags.md#serverless-usage-policy)). Vacía por defecto: sin policy asignada.
- No hay una política sobre quién puede ser admin más allá de la tabla `app_admins`.

---

## 5. Atribución de costos

Tres fuentes, con finalidades distintas:

| Fuente | Qué mide | Granularidad | Limitación |
|---|---|---|---|
| `system.serving.endpoint_usage` filtrada por `usage_context['application']='ai-prism'` | Tokens y llamadas por usuario y endpoint | Usuario × endpoint × día | La atribución por equipo necesita las etiquetas de recurso del operador (`usage_context['<clave>']`, [tags.md](tags.md)); las llamadas hechas antes de desplegar las etiquetas llevan solo las integradas |
| `system.billing.usage` × `list_prices` (panel de costos) | Costo facturado del endpoint, prorrateado por los tokens del usuario | Endpoint × día, y usuario por aproximación | El costo prorrateado es una estimación; el total es real |
| `usage_ledger` (Lakebase, por llamada) | Costo por llamada y por sesión, en el taxímetro | Llamada | Queda en la base de datos de la app; no aparece en `system.*` |

**Regla para el informe mensual:** el total viene de `system.billing.usage` (facturado); la
división por usuario viene del panel de costos y se rotula como prorrateo. No sumes
`usage_ledger` al facturado: son vistas distintas del mismo gasto.

**Recursos de infraestructura** (Lakebase, warehouse, job) se facturan por separado y llevan las
etiquetas del operador en `system.billing.usage.custom_tags` (consulta en [tags.md](tags.md)); la App
se atribuye por su serverless usage policy (`usage_metadata.usage_policy_id`). El prorrateo por
usuario no les aplica.

---

## 6. Operación en flota

- **Actualización:** la misma secuencia (bundle deploy, apps deploy, auto-config, smoke) en cada
  instalación, con el smoke como barrera. No actualices todas a la vez: empieza por una
  instalación de prueba.
- **Divergencia de versión:** compara los SHAs del inventario (§3.4). Una divergencia que dura
  mucho tiempo es deuda operativa.
- **Incidente:** el responsable de la instalación sigue el runbook de
  [operations.md](operations.md#6-runbook). Los incidentes de seguridad siguen el
  [SECURITY.md](SECURITY.md).
- **Cambio de admin:** se hace desde la UI o con `POST /api/admins`, siempre por un admin
  existente. Registra el cambio también en el inventario. La app escribe todo cambio de admin, y
  la concesión del primer admin del despliegue, en su propia traza `admin_audit`, solo de inserción
  (G8, cerrada en el [modelo de amenazas](security-threat-model.md#7-brechas-declaradas)):
  `server/migrations/0007_settings_audit.up.sql:46` (tabla) y `:103-106` (RLS: solo los admins leen,
  sin política de UPDATE/DELETE), `server/audit.js:104` (`recordAdminAction`, en la transacción de la
  mutación) y `:137` (`recordBootstrapAdminSeeds`, llamada en `server/db.js:88`), leída por los admins
  con `GET /api/admin/audit` (`server/db/admin.js:92`). El actor es un hash
  (`auditHash`, `server/audit.js:43`), nunca el e-mail; configura `APP_AUDIT_HASH_KEY` para que el hash no se
  revierta por diccionario. Con la clave, el hash de auditoría difiere a propósito del `user_hash` de
  los logs; para buscar a una persona en ambos, consulta
  [security-threat-model.md §6.1](security-threat-model.md#61-correlacionar-la-traza-de-auditoría-con-los-logs).
  Usa la misma clave en todas las instalaciones solo si necesitas comparar las trazas; una clave
  distinta por instalación limita lo que expone una clave filtrada.

---

## 7. Retiro

Orden recomendado. Los pasos marcados con **(irreversible)** no tienen forma de deshacerse.

1. **Comunica** a los usuarios y define la fecha de corte. No hay exportación masiva de las
   conversaciones en la app: quien necesite guardar contenido debe hacerlo antes.
2. **Congela el acceso:** detén la app (`databricks apps stop ai-prism -p <PROFILE>`) y confirma
   que ya no responde.
3. **Revoca los admins:** quita las entradas de `app_admins` (o el acceso de los grupos
   asociados) para que no sobreviva ningún acceso administrativo.
4. **Exporta lo que debe quedarse** antes de los pasos irreversibles: el ledger de costos
   (`usage_ledger`), los paneles y cualquier artefacto que el equipo quiera conservar.
5. **Elimina el panel** del workspace (y el objeto en la papelera, si el nombre necesita
   reutilizarse). La API de Lakeview solo tiene `trash`, sin restauración.
6. **Elimina el job de auto-config y el warehouse** (`ai-prism`). Confirma que no hay ninguna
   ejecución en curso.
7. **Borra el proyecto de Lakebase** `ai-prism`. **(irreversible)** Borra conversaciones,
   artefactos, embeddings y el ledger. Revisa antes la política de respaldo de la plataforma.
8. **Borra los recursos de datos:** el Volume `ai_prism_images` (con las imágenes) y, si se
   crearon solo para esta instalación, el schema y el catálogo `ai_prism_*`. **(irreversible)**
   Confirma que el catálogo no se comparte con otra instalación.
9. **Borra la app** `ai-prism` y la UDF de Python (`ai_prism_python_exec`) del schema.
10. **Confirma la limpieza:** lista los recursos del bundle y verifica que no quedó nada
    (`databricks apps list`, la consola de Lakebase, los warehouses y los catálogos).
11. **Revoca las credenciales:** los tokens y secretos usados en el despliegue, y el acceso del SP
    de prueba, si lo hay.
12. **Actualiza el inventario** y registra la fecha y el responsable del retiro.
13. **Revisa la facturación:** en `system.billing.usage`, el costo de la instalación debe quedar en
    cero después del último día de uso.

*Atención:* los pasos 7 y 8 no se pueden revertir. Hazlos solo después de confirmar con el
responsable del costo y con el dueño de los datos.

---

## 8. Databricks App Spaces (Beta)

Los App Spaces son una funcionalidad de Databricks, en **Beta**, para gobernar quién crea apps en un
workspace y bajo qué límites. Todo lo de la primera lista de abajo viene de la documentación oficial:
[App Spaces](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/app-spaces),
[App authorization](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth) y
[Serverless usage policies](https://docs.databricks.com/aws/en/admin/usage/budget-policies).
El comportamiento Beta puede cambiar; lee las páginas vigentes antes de depender de él.

**Qué dice la documentación**

- Un admin del workspace debe habilitar **Governed agentic app-building** en la página Previews, y solo
  un admin del workspace puede crear un App Space.
- Permisos del space: `CAN CREATE APP` (desarrollar apps en el space), `CAN MANAGE` (cambiar la
  configuración del space) y `CAN READ` (ver el space sin crear apps). El nombre del space no se puede
  cambiar después de crearlo.
- El admin define qué scopes de autorización de usuario (on-behalf-of) pueden pedir las apps del space
  (un space nuevo parte del preset "Data + AI"), y puede restringir las apps a un rol. Las restricciones
  por rol usan grupos de cuenta y requieren RBAC habilitado a nivel de cuenta y de workspace; un rol no
  concede permisos nuevos.
- Las apps de un space se ejecutan bajo una serverless usage policy, cuyas etiquetas llegan a
  `system.billing.usage.custom_tags`.
- Cada app de Databricks recibe automáticamente su propio service principal dedicado.

**Cómo usarlo con AI Prism** (nuestra recomendación, no una regla de la plataforma)

| Pregunta | Convención |
|---|---|
| ¿Quién crea apps? | Concede `CAN CREATE APP` en el space solo al grupo que opera AI Prism; el resto recibe `CAN READ` o nada. |
| ¿Cuántas instalaciones por space? | Un AI Prism por space, para que los scopes y la política de gasto del space describan exactamente una instalación. |
| ¿Con qué identidad se ejecuta? | El service principal propio de la app (uno por app); nunca compartas un SP entre instalaciones. El acceso a Lakebase, al Volume y los grants de UC se dan solo a ese SP. |
| ¿Qué scopes? | Haz que los scopes permitidos del space sean un superconjunto de `user_api_scopes` en `databricks.yml` y no más amplios; un scope que el space no permite no puede ser pedido por la app. Verifícalo después de cada cambio en cualquiera de las dos listas. |
| ¿Qué política de gasto? | Una serverless usage policy por instalación o por responsable del costo, pasada al bundle como `serverless_usage_policy_id` ([tags.md](tags.md#serverless-usage-policy)). Etiquetas: [tags.md](tags.md). |
| ¿Qué no está verificado aquí? | Cómo `bundle deploy` coloca una app en un space dado (la página de la documentación no describe un paso de asignación) y si la lista de scopes del space interactúa con los scopes que aplica el bundle. Prueba ambos en un workspace que no sea de producción antes de depender de ellos. |

Las actualizaciones de esta sección exigen releer las tres páginas de arriba, porque la funcionalidad está en Beta.
