<!-- i18n: source=docs/onboarding-deployment.md source-hash=d4291f276fbdd9269c7a0692988a8247c86554d3 status=machine -->
# Onboarding: tu propio "ChatGPT" en Databricks en unos 20 minutos

[English](../onboarding-deployment.md) · [Português (Brasil)](../pt-BR/onboarding-deployment.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../onboarding-deployment.md) es la referencia.

> **Aviso.** AI Prism no es un producto oficial de Databricks y no tiene SLA. Es un
> acelerador de código abierto que **despliegas en tu propio workspace** y
> personalizas como quieras. Tus datos se quedan en tu cuenta de Databricks y no se
> usan para entrenar modelos de terceros.

Esta guía te lleva de un "workspace vacío" a una "app funcionando para el equipo" con
**un solo comando**. Toda la infraestructura (Lakebase, SQL Warehouse, App,
dashboards, UDF) la aprovisiona un **Databricks Asset Bundle**. No creas recursos a mano.

---

## Visión general del flujo

<!-- i18n: code-translated -->
```mermaid
flowchart LR
    A["1· Requisitos previos<br/>workspace + CLI"] --> B["2· npm run bundle<br/>compilar artefactos"]
    B --> C["3· deploy + apps deploy<br/>+ ejecutar auto-config"]
    C --> D["4· Primer acceso<br/>admin + modelos"]
    D --> E["5· Personalizar<br/>marca · plantillas · herramientas"]
    E --> F["6· Invitar al equipo<br/>permisos de la App"]
```

El paso 3 son tres comandos (detallados abajo). **`bundle deploy`** aprovisiona la
infraestructura: **Lakebase serverless** (producto *Autoscaling*: 0.5–16 CU,
apagado automático a los 30 min), un **SQL Warehouse serverless**, la **App** (con
Lakebase y el Warehouse conectados como recursos, que inyectan `PGHOST` y
`SQL_WAREHOUSE_ID` en el runtime) y los **dashboards de costos y de operación**. **`apps deploy`**
publica el código. **`bundle run ai_prism_auto_config`** crea el rol de Postgres para el
service principal, aprovisiona la UDF de Python y el Volume de imágenes, y registra a
quien hizo el despliegue como **bootstrap de admin**.

---

## 1. Requisitos previos (5 min)

- Un **workspace de Databricks** (AWS, Azure o GCP) con Unity Catalog habilitado.
- **AI Gateway / Foundation Model APIs** disponibles en tu región (endpoints
  `databricks-claude-*`, `databricks-gpt-*`, etc.).
- Un **Databricks CLI reciente (≥ ~1.x; idealmente ≥ 1.8)**, autenticado con un perfil
  para el workspace. Las CLI antiguas (por ejemplo, 0.29x) fallan al descargar el
  Terraform interno con `openpgp: key expired` durante `bundle deploy`. La CLI ≥ 1.8
  guarda la credencial en el llavero del sistema. Si un token antiguo en caché estorba,
  vuelve a ejecutar `databricks auth login` o exporta `DATABRICKS_AUTH_STORAGE=plaintext`.
  ```bash
  # Azure: usa el host de tu workspace (adb-<id>.<n>.azuredatabricks.net)
  databricks auth login --host https://<seu-workspace> -p <PROFILE>
  ```
- Permiso para crear una **Databricks App**, un **SQL Warehouse**, **Lakebase** y **Jobs**
  (el bundle crea todos). Para la UDF de Python y el Volume de imágenes, tienes que poder
  crear el catálogo `ai_prism` (o ya tenerlo). Si no tienes `CREATE CATALOG` en el
  metastore, apunta a un catálogo existente con
  `--var tools_catalog=<cat> --var image_volume_catalog=<cat>`.
- **Node.js 22.18+** y **npm** (`engines` de `package.json`; los tests end-to-end necesitan
  22.19+), con `npm ci --include=dev` hecho: `deploy.sh` / `deploy.ps1` compilan los artefactos
  antes del despliegue y ejecutan el smoke después (ver el paso 3).

**Verificación:** `databricks current-user me -p <PROFILE>` devuelve tu correo electrónico.

> **Nota (agnóstico de nube):** `databricks.yml` **no** fija un host del workspace.
> El destino del despliegue viene por completo del perfil en `-p <PROFILE>`. El mismo
> bundle se despliega en AWS, Azure o GCP sin editar ningún archivo. Si tu CLI ≥ 1.8
> se queja de una credencial en caché de una versión anterior, exporta
> `DATABRICKS_AUTH_STORAGE=plaintext` o vuelve a ejecutar `databricks auth login`.

---

## 2. Generar los artefactos (2 min)

La App ejecuta artefactos ya compilados (`client/dist` + `server-dist/index.cjs`), no el
código fuente. Los pull requests de funcionalidades no hacen commit de esos artefactos, así
que la copia en disco puede ser más antigua que el código. `deploy.sh` / `deploy.ps1`
(Opción A, abajo) ejecutan `npm run bundle` por su cuenta antes del despliegue y se
detienen si el build falla. Con los comandos manuales (Opción B), **siempre** vuelve a
compilar antes de desplegar:

```bash
npm ci --include=dev   # solo la primera vez (ver la nota de devDeps más abajo)
npm run bundle         # client/dist + server-dist/index.cjs
```

> **Nota (devDeps):** en este proyecto, un `npm install <pkg>` sin más puede eliminar las
> devDependencies que necesita el build. Usa `npm ci --include=dev` o
> `npm install --include=dev`.

---

## 3. Desplegar la pila completa (5 min)

### Opción A: un solo comando (recomendada)

`deploy.sh` (Linux/macOS) y `deploy.ps1` (Windows) hacen todo lo siguiente en el orden
correcto. Reciben el perfil de la CLI como argumento (no se fija ningún host) y son
idempotentes:

```bash
./deploy.sh <PROFILE> [CATALOGO]                 # valor por defecto de CATALOGO: ai_prism
./deploy.sh --tag cost_center=1234 --tag area=Finanças <PROFILE>
./deploy.sh --lakebase-suspend-minutes 30 --usage-policy-id <id> <PROFILE>
./deploy.sh --skip-build --skip-smoke <PROFILE>   # artefactos tal cual, sin smoke
```

```powershell
.\deploy.ps1 <PERFIL> [CATALOGO] -Tag 'cost_center=1234','area=Finanças' -LakebaseSuspendMinutes 30 -UsagePolicyId <id>
.\deploy.ps1 <PERFIL> -SkipBuild -SkipSmoke
```

Opciones: `--tag key=value` (repetible, hasta 24; ver [docs/tags.md](../tags.md)),
`--lakebase-suspend-minutes N` (minutos sin uso antes de que Lakebase entre en reposo,
de 1 a 10080), `--usage-policy-id ID` (una política de uso serverless que un administrador
ya creó en la cuenta) y `--classic-cluster-id ID` (para un workspace sin serverless: el ID
de un cluster clásico de usuario único, Dedicated o Single. El warehouse pasa a ser Pro
clásico y el auto-config se ejecuta en ese cluster), `--skip-build` (no ejecuta
`npm run bundle`: despliega `client/dist` + `server-dist` tal como están en disco, por
ejemplo desde un zip de release o en una máquina sin Node) y `--skip-smoke` (no ejecuta
el smoke al final). En PowerShell son `-SkipBuild` y `-SkipSmoke`. Cada opción tiene una
variable de entorno equivalente (`TAGS`, `LAKEBASE_SUSPEND_MINUTES`,
`SERVERLESS_USAGE_POLICY_ID`, `CLASSIC_CLUSTER_ID`, `AI_PRISM_SKIP_BUILD=1`,
`AI_PRISM_SKIP_SMOKE=1`). Consulta `./deploy.sh --help`. Los scripts muestran sus
mensajes en inglés.

El script ejecuta estos pasos, en este orden:

1. Revisa si el proyecto de Lakebase `ai-prism` quedó **soft-deleted** por un
   `bundle destroy` anterior (ver *Solución de problemas comunes*). Si es así, el script
   se detiene antes de cambiar nada y muestra los comandos para restaurarlo o purgarlo.
   Nunca purga por su cuenta.
2. Ejecuta `npm run bundle` (`client/dist` + `server-dist`). Si el build falla, se
   detiene antes de desplegar nada.
3. Escribe el catálogo y las etiquetas en `app.yaml` (`AI_PRISM_RESOURCE_TAGS`) y en
   `.databricks/bundle/<destino>/variable-overrides.json`.
4. Ejecuta `bundle deploy` e inicia la app.
5. Ejecuta el job de auto-config (rol del SP, traspaso de propiedad en Lakebase, UDF,
   volume, etiquetas y admin bootstrap). Ver [Sobre los roles y permisos de Lakebase](#sobre-los-roles-y-permisos-de-lakebase).
6. Publica el código (`apps deploy`).
7. Ejecuta `npm run smoke` contra la URL de la app con tu token OAuth
   (`databricks auth token -p <PROFILE>`; el token solo va al entorno del smoke y nunca
   se imprime). El smoke abre la SPA, comprueba la identidad, hace un turno de chat, lo
   vuelve a leer, genera un documento y borra el chat de prueba.
8. Como tú (el dueño de la base de datos), ejecuta `node scripts/migrate.mjs up --role <SP de la app>`:
   las migraciones pendientes y luego los permisos de mínimo privilegio del service
   principal de la app. La credencial de la base se genera con la CLI y nunca se imprime.
   Sin `node` en el PATH, este paso se omite con un aviso que muestra el comando para
   ejecutarlo después.

El script termina con un código distinto de cero si falla cualquier paso, incluido el
smoke. Un smoke que falla **no revierte** el despliegue: la versión nueva ya está
publicada, así que lee la tabla del smoke antes de dar acceso a los usuarios. Sin `npm`
en el PATH, el script se detiene al inicio e indica `--skip-build --skip-smoke`.

El notebook **`Instalar AI Prism.py`** (en la raíz del proyecto, generado por
`scripts/build-installer-notebook.py`) hace lo mismo desde dentro del workspace, sin
terminal. Sus campos reflejan las opciones de arriba (catálogo, serverless, minutos de
Lakebase, política de uso y etiquetas). Empieza con `acao = verificar`, que no crea nada.
Ejecuta el mismo `deploy.sh` en un cluster, que normalmente no tiene Node: allí el
despliegue usa los artefactos ya compilados del zip de release y necesita
`AI_PRISM_SKIP_BUILD=1` y `AI_PRISM_SKIP_SMOKE=1` (ejecuta el smoke después, desde una
máquina con Node, como en la Opción B).

### Opción B: comandos manuales

Tres comandos aprovisionan la infraestructura, publican el código de la App y configuran
la App:

```bash
# valida la configuración del bundle (no crea nada)
databricks bundle validate -p <PROFILE> -t dev

# 0) compila los artefactos que ejecuta la App (client/dist + server-dist)
npm run bundle

# 1) aprovisiona Lakebase + Warehouse + App + dashboards + job
databricks bundle deploy -p <PROFILE> -t dev

# 2) ejecuta el job de auto-config: crea el rol PG del SP y el traspaso de propiedad,
#    aprovisiona la UDF de Python y el Volume de imágenes (catálogo ai_prism), y
#    registra el bootstrap de admin. Ejecútalo ANTES de publicar el código.
databricks bundle run ai_prism_auto_config -p <PROFILE> -t dev

# 3) publica el CÓDIGO de la App (bundle deploy por sí solo NO republica el proceso en ejecución).
#    <SRC> es la ruta que imprime el resumen de deploy / bundle,
#    normalmente /Workspace/Users/<você>/.bundle/ai-prism/dev/files
databricks apps deploy ai-prism --source-code-path <SRC> -p <PROFILE>

# 4) smoke posterior al despliegue contra la URL de la app (sale != 0 si algo falla)
APP_URL=<URL-do-app> DATABRICKS_TOKEN=<token-oauth> npm run smoke

# 5) como dueño de la base: migraciones pendientes + permisos de mínimo privilegio del SP
#    (PGHOST/PGUSER/PGPASSWORD: ver "Sobre los roles y permisos de Lakebase")
node scripts/migrate.mjs up --role <app SP client id>
```

El bundle (`databricks.yml`) gestiona estos recursos:

| Recurso | Configuración |
|---|---|
| **Lakebase** (`postgres_projects` + `postgres_endpoints`) | serverless, autoscaling **0.5–16 CU**, **apagado automático a los 30 min** |
| **SQL Warehouse** (`sql_warehouses`) | Serverless, 2X-Small, Photon, apagado automático a los 10 min |
| **App** (`apps`) | Lakebase y SQL Warehouse conectados como **recursos de la App** (el runtime inyecta `PGHOST` / `SQL_WAREHOUSE_ID`); variables estáticas en `app.yaml` |
| **Dashboards** (`dashboards`) | dos dashboards de Lakeview sobre tablas del sistema: costos de IA por usuario (lo publica el job de auto-config) y operación (llamadas, usuarios, tokens, latencia; queda como borrador hasta que alguien lo publique). Ver [`dashboards/README.md`](dashboards/README.md) |
| **Job de auto-config** (`jobs`) | crea el **rol de Postgres del SP de la app** en Lakebase (`databricks_create_role`) y el **traspaso de propiedad** (`ai_prism_owner`), la UDF `ai_prism_python_exec` y el Volume de imágenes (todo en el catálogo `ai_prism`), y **registra el bootstrap de admin** (quien hizo el despliegue) en la tabla `app_admins` |

> **Etiquetas de recursos y opciones avanzadas** (`--tag`, política de uso, minutos de
> Lakebase) existen solo en `deploy.sh`, `deploy.ps1` y el notebook. Con los comandos
> manuales, las etiquetas se aplican a los recursos del bundle. La app las usa en AI
> Gateway y en SQL solo después de actualizar `AI_PRISM_RESOURCE_TAGS` en `app.yaml`.
> Ver [docs/tags.md](../tags.md), "Caminho nativo do bundle".
>
> **Destinos:** `dev` (por defecto; antepone tu nombre de usuario a los nombres de los
> recursos, lo que sirve para pruebas) y `prod` (nombres limpios, para el despliegue
> oficial). Cambia `-t dev` por `-t prod` cuando pases a producción. Ningún destino fija
> un host. El workspace viene de `-p <PROFILE>`, así que no necesitas editar
> `databricks.yml`.

> **Sobre la conexión a Lakebase:** el runtime de la App inyecta `PGHOST` automáticamente
> desde el recurso `lakebase`. No está fijado en ningún lugar del código, por eso el mismo
> bundle funciona en cualquier nube. La app se conecta con **su propio service principal**
> (el job crea el rol de Postgres de ese SP). El aislamiento entre usuarios es a nivel de
> app (`WHERE user_email`). Los privilegios del SP en la base de datos están en
> [Sobre los roles y permisos de Lakebase](#sobre-los-roles-y-permisos-de-lakebase).

Al terminar, `databricks bundle summary -p <PROFILE> -t dev` muestra la URL pública de la
App (detrás de OAuth del workspace).

### Acerca de la UDF de Python (`execute_python`)

AI Prism trae su propia UDF (`ai_prism_python_exec`) en lugar de usar
`system.ai.python_exec`. La nuestra respeta una variable `result`, captura `stdout`
**y** maneja las excepciones devolviendo `"ERROR: ..."` sin fallar la consulta. La función
de la plataforma hace fallar toda la sentencia ante cualquier error. La definición vive en
`shared/pythonUdf.js` (la única fuente de verdad). El job de despliegue usa la versión
generada en `bundle/python_udf_ddl.py` (con `node scripts/gen-python-udf-ddl.mjs`), y la
app también la aprovisiona en tiempo de ejecución. Las dos son idénticas, byte por byte.

`TOOLS_CATALOG` y `TOOLS_SCHEMA` definen **solo dónde se crea esta UDF**. No limitan qué
UC Functions puede adjuntar un usuario como herramienta. El descubrimiento de UC Functions
recorre todos los catálogos y esquemas que el usuario puede ver (mediante
`system.information_schema.routines`, excepto `system`). Siempre se limita a los permisos
reales del usuario en Unity Catalog.

### Acerca del Volume de imágenes generadas

Las imágenes generadas o editadas en el chat son archivos binarios reales, así que van a un
**Volume de UC dedicado**. Se mantiene separado del catálogo de herramientas para que los
archivos no se mezclen con otros archivos. Puedes configurar la ruta con
`IMAGE_VOLUME_CATALOG` / `IMAGE_VOLUME_SCHEMA` / `IMAGE_VOLUME_NAME` (por defecto
`ai_prism.default.ai_prism_images`). El job de auto-config crea el catálogo, el esquema y el
volume, y concede `READ/WRITE VOLUME` al **service principal de la app**. La app lee y
escribe imágenes como el SP, no con el token OAuth del usuario. Así no depende de que el
scope `files` se vuelva a consentir en el navegador. El aislamiento entre usuarios sigue
siendo **a nivel de app** (`WHERE user_email` en `chat_images`), como cualquier artefacto.
El **modelo de imagen por defecto es Nano Banana 2**.

### Sobre los roles y permisos de Lakebase

Las tablas de la app están en un esquema de Postgres dedicado, **`ai_prism`**
(migración 0002), y no en `public`. La extensión `vector` sigue en `public`. La app se
conecta con `search_path = ai_prism, public`, definido una vez por conexión. Hay tres
roles:

| Rol | Quién | Qué puede hacer |
|---|---|---|
| **Dueño de la base de datos** | la identidad que despliega (crea el proyecto de Lakebase) | ejecuta `prepare`, `up` y `grants` desde el despliegue; es miembro del rol dueño |
| **`ai_prism_owner`** | un rol `NOLOGIN` que crea el job de auto-config | es dueño de todas las tablas de la app y del esquema `ai_prism` |
| **Service principal de la app** | el rol que `databricks_create_role` crea para el SP de la app | `USAGE` en `ai_prism`; `SELECT/INSERT/UPDATE/DELETE` en las tablas de la app; `USAGE/SELECT` en sus secuencias; `SELECT` en `schema_migrations`. No es dueño de ninguna tabla y no tiene permisos explícitos en `public` |

Un despliegue pasa por tres etapas. `deploy.sh` y `deploy.ps1` ejecutan las tres:

1. **Traspaso** (job de auto-config, antes de publicar el código). El job le pasa a
   `ai_prism_owner` las tablas de la app que son tuyas. También deja que el SP actúe
   como ese rol por poco tiempo. Los despliegues antiguos tienen propietarios mezclados
   (el SP creó la mayoría de las tablas, el despliegue creó `app_admins`), y ninguna de
   las dos identidades puede pasarle sus tablas a la otra. El rol neutro es lo que hace
   posible el cambio.
2. **Migración** (la primera solicitud de la app, como el SP). La migración 0002 le
   pasa las tablas del SP a `ai_prism_owner` y mueve todas a `ai_prism`. Sin el
   traspaso, la 0002 se **aplaza**: la app sigue funcionando en `public`, registra
   `migrations: 0002 schema_ai_prism deferred` y vuelve a intentarlo un minuto después.
3. **Permisos** (después del smoke, como tú): `node scripts/migrate.mjs up --role <SP>`
   aplica los permisos de mínimo privilegio del SP y quita su pertenencia a
   `ai_prism_owner`. Es idempotente: ejecutarlo dos veces deja el mismo estado.

Para ejecutar las etapas 1 y 3 a mano, conéctate como dueño de la base de datos con
una credencial de base de datos:

```bash
EP=projects/ai-prism/branches/production/endpoints/primary
export PGHOST=$(databricks postgres get-endpoint $EP -p <PROFILE> -o json | python3 -c "import sys,json; print(json.load(sys.stdin)['status']['hosts']['host'])")
export PGPASSWORD=$(databricks postgres generate-database-credential $EP -p <PROFILE> -o json | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
export PGUSER=<your e-mail> PGDATABASE=databricks_postgres PGSSLMODE=require
node scripts/migrate.mjs prepare --role <app SP client id>   # etapa 1
node scripts/migrate.mjs up --role <app SP client id>        # etapa 3 (y migraciones pendientes)
```

El client id del SP es `service_principal_client_id` en
`databricks apps get ai-prism -p <PROFILE> -o json`. Nunca pegues la credencial en un
archivo ni en un chat; caduca en menos de una hora.

**TLS.** La conexión siempre va cifrada. La cadena del servidor solo se verifica con
`PG_SSL_VERIFY=1` (el trust store de Node) o `PG_SSL_CA` (una CA fijada, que activa la
verificación). `PG_SSL_VERIFY=0` la desactiva para diagnóstico.
`PG_SSL_REJECT_UNAUTHORIZED` sigue funcionando como nombre antiguo de `PG_SSL_VERIFY`.

---

## 4. Primer acceso y configuración de modelos (5 min)

1. Abre la URL de la App e inicia sesión con tu cuenta del workspace.
2. Como quien hizo el despliegue, el job de auto-config ya te registró como **admin**
   (en la tabla `app_admins`). Así verás las pestañas de administración en *Configuración*.
3. **Modelos (LLM)**: habilita los endpoints de serving que debe usar tu equipo y define
   sus etiquetas y su orden. Los usuarios comunes solo ven los modelos habilitados.
4. **Costos y operación**: la auditoría vive en dos **dashboards de AI/BI** que aprovisiona
   el bundle, no en una pestaña de la app. El job de auto-config ya publica el de costos; el
   de operación ("AI Prism — Operations") queda como borrador: ábrelo en el workspace y
   **publícalo** para los demás admins. Los detalles están en
   [`dashboards/README.md`](dashboards/README.md).
5. **Límites de gasto (opcional)**: define presupuestos y alertas con las funciones nativas
   de Databricks para el workspace (ver [costs-and-positioning.md](costs-and-positioning.md)).
   Cada usuario ve su propio consumo en el taxímetro del encabezado. Para que el reinicio
   mensual use tu zona horaria local, define `USAGE_TIMEZONE` (por ejemplo,
   `America/Sao_Paulo`; por defecto es UTC).

---

## 5. Personalización (opcional)

- **Marca / design system**: en *Configuración → Design system*, importa el design system de
  tu empresa (colores, tipografías, logo, íconos), desde un `.pptx` de marca o desde un
  bundle. Así, las presentaciones y las hojas de cálculo salen con tu identidad visual.
- **Herramientas**: conecta **Genie Agents**, **UC Functions** y **Vector Search** como
  herramientas del chat. Agrega **conexiones MCP externas** si las necesitas.
- **Interfaz y funciones**: el código es tuyo. Cambia textos, tema y comportamiento y vuelve
  a desplegar con `./deploy.sh <PROFILE>` (compila, despliega y ejecuta el smoke; ver la
  sección 3).

---

## 6. Invita al equipo (2 min)

- Otorga a la App el permiso **CAN_USE** a los usuarios o grupos que deban acceder (desde la
  interfaz de permisos de la App o desde la API).
- Para agregar otros **administradores**, usa *Configuración → Administradores* dentro de la
  app. El autocompletado sugiere personas que ya tienen acceso.
- Cada usuario trabaja con **su propia identidad**. Las conversaciones, los permisos de datos
  y el costo se atribuyen a ese usuario.

---

## Solución de problemas comunes

| Síntoma | Causa probable | Acción |
|---|---|---|
| `bundle deploy` falla en Lakebase / endpoint | el recurso de Postgres serverless no está disponible en la región o en la cuenta | confirma la disponibilidad de Lakebase serverless; ajusta `databricks.yml` |
| El despliegue se detiene con "The Lakebase project ... is soft-deleted" (o el error de la API menciona `delete ... purge`) | un `databricks bundle destroy` anterior eliminó el proyecto `ai-prism` de forma **reversible**, y todavía ocupa el nombre | `deploy.sh`, `deploy.ps1` y el notebook muestran los dos comandos. Para **recuperar los datos**: `databricks postgres undelete-project projects/ai-prism -p <PROFILE>`. Para **borrarlo definitivamente** (destructivo, se pierden los datos): `databricks postgres delete-project projects/ai-prism -p <PROFILE> --purge`. Ningún script purga por su cuenta |
| El despliegue se detiene en "npm run bundle failed" (o "npm not found") | build roto, `npm ci` sin hacer o una máquina sin Node | ejecuta `npm ci --include=dev` y `npm run bundle` para ver el error; para desplegar los artefactos que ya están en disco, usa `--skip-build` (`-SkipBuild`) |
| El despliegue termina con "smoke FAILED" | la versión nueva está publicada, pero un recorrido de usuario falla (identidad, modelos, chat, Lakebase o artefacto) | lee la tabla del smoke (la fila **FAIL** indica el paso y el error) y los logs de la app; "could not get an OAuth token" pide `databricks auth login -p <PROFILE>`. `--skip-smoke` despliega sin esta comprobación |
| Costo sin la etiqueta que pasaste | la etiqueta no llegó al runtime de la app, o fue rechazada | revisa el log de auto-config (`AVISO`) y [docs/tags.md](../tags.md). Verifica `AI_PRISM_RESOURCE_TAGS` en `app.yaml` y luego vuelve a ejecutar `apps deploy` |
| `migrations: 0002 schema_ai_prism deferred … ownership not normalized` en el log de la app | el traspaso de propiedad no se ejecutó antes de publicar el código nuevo (despliegue manual, o un `deploy.sh` antiguo) | ejecuta el job de auto-config (o `node scripts/migrate.mjs prepare --role <SP>` como dueño de la base); la app lo reintenta en menos de un minuto; luego `node scripts/migrate.mjs grants --role <SP>`. Ver [Sobre los roles y permisos de Lakebase](#sobre-los-roles-y-permisos-de-lakebase) |
| El chat falla con **"External authorization failed"** / 0 tablas en Lakebase | el login del SP en Lakebase fue rechazado (SQLSTATE 28000): no se creó el rol del SP, o `PGHOST` apunta a otro Lakebase (¡nunca escribas el host en `app.yaml`!) | ejecuta `databricks bundle run ai_prism_auto_config` (crea el rol del SP). Confirma que el recurso `lakebase` está conectado a la App |
| Falta la herramienta `execute_python` | la UDF no está aprovisionada | ejecuta `databricks bundle run ai_prism_auto_config` (o la app la crea en el primer uso) |
| No aparecen los modelos | ningún endpoint habilitado en el catálogo | Admin → *Modelos (LLM)* → habilitar |
| Faltan las pestañas de administración | el bootstrap de admin no se registró | ejecuta `databricks bundle run ai_prism_auto_config` (registra a quien hizo el despliegue en `app_admins`) |
| Un cambio en el código no tiene efecto | `bundle deploy` no vuelve a publicar el código de la App, o los artefactos en disco son antiguos | ejecuta `./deploy.sh <PROFILE>` (compila y publica); con los comandos manuales, `npm run bundle` y luego `databricks apps deploy ai-prism --source-code-path <SRC>` |

---

*Flujo pensado para la empresa que despliega y opera AI Prism en su propio workspace. El
host **nunca** se edita en `databricks.yml`. Viene de `-p <PROFILE>`, así que el mismo
bundle corre en AWS, Azure o GCP. Ajusta solo los destinos y los nombres de los recursos si
lo deseas.*
