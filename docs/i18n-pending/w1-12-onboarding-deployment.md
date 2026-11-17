<!--
PENDING TRANSLATIONS: fold into the final docs layout, then delete this file.
Owner: whoever converts docs/onboarding-deployment.md to the EN-canonical layout
(docs i18n task W1-10). Source of truth today: the pt-BR text W1-12 changed in
docs/onboarding-deployment.md (prerequisites, §2 build, §3 option A and B, the
bundle resource table, §4 item 4, §5 UI/features, and three troubleshooting rows).
dashboards/README.md is already trilingual (EN + docs/pt-BR + docs/es).
-->

# W1-12 docs: English and Spanish versions (pending fold-in)

This file carries the **English (canonical)** and **Spanish** text of the parts of
`docs/onboarding-deployment.md` that W1-12 changed in Portuguese. That file is still
pt-BR only. When the trilingual layout lands, paste each part into its file and remove
this one.

- [English](#english)
- [Español](#español)

---

## English

### EN: prerequisites (Node)

- **Node.js 22+** and **npm**, with `npm ci --include=dev` done: `deploy.sh`/`deploy.ps1`
  builds the artifacts before deploying and runs the smoke afterwards (see step 3).

### EN: §2 Build the artifacts

The App runs the pre-built artifacts (`client/dist` + `server-dist/index.cjs`), not the
source. Feature PRs do not commit these artifacts, so the copy on disk can be older than
the code. `deploy.sh`/`deploy.ps1` (option A below) runs `npm run bundle` by itself before
deploying and stops if the build fails. With the manual commands (option B), **always**
rebuild before deploying.

### EN: §3 option A, extra examples

```bash
./deploy.sh --skip-build --skip-smoke <PROFILE>   # artifacts from disk, no smoke
```

```powershell
.\deploy.ps1 <PERFIL> -SkipBuild -SkipSmoke
```

### EN: §3 option A, options paragraph (added part)

`--skip-build` (does not run `npm run bundle`: deploys `client/dist` + `server-dist` as
they are on disk, for example from a release zip or on a machine without Node) and
`--skip-smoke` (does not run the smoke at the end). In PowerShell, `-SkipBuild` and
`-SkipSmoke`. Environment equivalents: `AI_PRISM_SKIP_BUILD=1`, `AI_PRISM_SKIP_SMOKE=1`.
The scripts print their messages in English.

### EN: §3 option A, what the script does

1. checks that the Lakebase project `ai-prism` was not left **soft-deleted** by an earlier
   `bundle destroy` (see *Troubleshooting*) and, if it was, stops before any change,
   printing the restore and purge commands. It never purges by itself;
2. runs `npm run bundle` (`client/dist` + `server-dist`). If the build fails, it stops
   before deploying anything;
3. writes the catalog and the tags into `app.yaml` (`AI_PRISM_RESOURCE_TAGS`) and into
   `.databricks/bundle/<target>/variable-overrides.json`;
4. runs `bundle deploy`, starts the app and publishes the code (`apps deploy`);
5. runs the auto-config job (SP role, UDF, volume, tags and bootstrap admin);
6. runs `npm run smoke` against the app URL with your OAuth token
   (`databricks auth token -p <PROFILE>`; the token only goes to the smoke's environment
   and is never printed). The smoke opens the SPA, checks the identity, runs one chat
   turn, reads it back, generates a document and deletes the test chat.

The script exits non-zero when any step fails, the smoke included. A failed smoke **does
not roll back** the deploy: the new version is already live, so read the smoke table
before giving users access. Without `npm` on PATH the script stops right at the start and
points to `--skip-build --skip-smoke`.

### EN: §3 the installer notebook (added part)

It runs the same `deploy.sh` on a cluster, which usually has no Node: there the deploy
uses the artifacts already built into the release zip and needs `AI_PRISM_SKIP_BUILD=1`
and `AI_PRISM_SKIP_SMOKE=1` (run the smoke afterwards from a machine with Node, as in
option B).

### EN: §3 option B, added commands

```bash
# 0) build the artifacts the App runs (client/dist + server-dist)
npm run bundle

# 4) post-deploy smoke against the app URL (exits != 0 when something breaks)
APP_URL=<app-URL> DATABRICKS_TOKEN=<oauth-token> npm run smoke
```

### EN: bundle resource table, dashboards row

| Resource | Configuration |
|---|---|
| **Dashboards** (`dashboards`) | two Lakeview dashboards over system tables: AI costs per user (published by the auto-config job) and operations (calls, users, tokens, latency; stays a draft until someone publishes it). See [`dashboards/README.md`](../../dashboards/README.md) |

### EN: §4 item 4

**Costs and operations**: auditing lives in two **AI/BI dashboards** provisioned by the
bundle (not in an app tab). The cost one comes out published by the auto-config job; the
operations one ("AI Prism — Operations") stays a draft: open it in the workspace and
**publish** it for the other admins. Details in
[`dashboards/README.md`](../../dashboards/README.md).

### EN: §5 UI/features

The code is yours: adjust texts, theme and behaviour, then redeploy with
`./deploy.sh <PROFILE>` (builds, deploys and runs the smoke).

### EN: troubleshooting rows

| Symptom | Likely cause | Action |
|---|---|---|
| Deploy stops with "The Lakebase project ... is soft-deleted" (or the API error mentions `delete ... purge`) | (unchanged) | (unchanged) |
| Deploy stops at "npm run bundle failed" (or "npm not found") | broken build, `npm ci` not done, or a machine without Node | run `npm ci --include=dev` and `npm run bundle` to see the error; to deploy the artifacts already on disk, use `--skip-build` (`-SkipBuild`) |
| Deploy ends with "smoke FAILED" | the new version is up, but a user path broke (identity, models, chat, Lakebase or artifact) | read the smoke table (the **FAIL** row names the step and the error) and the app logs; "could not get an OAuth token" asks for `databricks auth login -p <PROFILE>`. `--skip-smoke` deploys without this check |
| Code change has no effect | `bundle deploy` does not republish the App code, or the artifacts on disk are stale | run `./deploy.sh <PROFILE>` (builds and publishes); with the manual commands, `npm run bundle` then `databricks apps deploy ai-prism --source-code-path <SRC>` |

---

## Español

### ES: requisitos previos (Node)

- **Node.js 22+** y **npm**, con `npm ci --include=dev` hecho: `deploy.sh`/`deploy.ps1`
  compila los artefactos antes del despliegue y ejecuta el smoke después (ver el paso 3).

### ES: §2 Compilar los artefactos

La App ejecuta los artefactos precompilados (`client/dist` + `server-dist/index.cjs`), no
el código fuente. Los PR de funcionalidad no hacen commit de estos artefactos, así que la
copia en disco puede ser más antigua que el código. `deploy.sh`/`deploy.ps1` (opción A más
abajo) ejecuta `npm run bundle` por sí solo antes del despliegue y se detiene si la
compilación falla. Con los comandos manuales (opción B), **siempre** recompila antes de
desplegar.

### ES: §3 opción A, ejemplos adicionales

```bash
./deploy.sh --skip-build --skip-smoke <PROFILE>   # artifacts from disk, no smoke
```

```powershell
.\deploy.ps1 <PERFIL> -SkipBuild -SkipSmoke
```

### ES: §3 opción A, párrafo de opciones (parte nueva)

`--skip-build` (no ejecuta `npm run bundle`: despliega `client/dist` + `server-dist` tal
como están en disco, por ejemplo desde un zip de release o en una máquina sin Node) y
`--skip-smoke` (no ejecuta el smoke al final). En PowerShell, `-SkipBuild` y `-SkipSmoke`.
Variables de entorno equivalentes: `AI_PRISM_SKIP_BUILD=1`, `AI_PRISM_SKIP_SMOKE=1`. Los
scripts muestran sus mensajes en inglés.

### ES: §3 opción A, qué hace el script

1. comprueba que el proyecto Lakebase `ai-prism` no haya quedado **soft-deleted** por un
   `bundle destroy` anterior (ver *Solución de problemas*) y, si es así, se detiene antes
   de cualquier cambio y muestra los comandos para restaurar o purgar. Nunca purga por sí
   solo;
2. ejecuta `npm run bundle` (`client/dist` + `server-dist`). Si la compilación falla, se
   detiene antes de desplegar nada;
3. graba el catálogo y las etiquetas en `app.yaml` (`AI_PRISM_RESOURCE_TAGS`) y en
   `.databricks/bundle/<target>/variable-overrides.json`;
4. ejecuta `bundle deploy`, inicia la app y publica el código (`apps deploy`);
5. ejecuta el job de auto-config (rol del SP, UDF, volumen, etiquetas y admin inicial);
6. ejecuta `npm run smoke` contra la URL de la app con tu token OAuth
   (`databricks auth token -p <PROFILE>`; el token solo va al entorno del smoke y nunca se
   imprime). El smoke abre la SPA, comprueba la identidad, hace un turno de chat, lo lee de
   vuelta, genera un documento y borra el chat de prueba.

El script termina con un código distinto de cero si falla cualquier paso, incluido el
smoke. Un smoke que falla **no revierte** el despliegue: la versión nueva ya está en
producción, así que lee la tabla del smoke antes de dar acceso a los usuarios. Sin `npm`
en el PATH, el script se detiene al principio e indica `--skip-build --skip-smoke`.

### ES: §3 el notebook instalador (parte nueva)

Ejecuta el mismo `deploy.sh` en un clúster, donde normalmente no hay Node: allí el
despliegue usa los artefactos ya compilados del zip de release y necesita
`AI_PRISM_SKIP_BUILD=1` y `AI_PRISM_SKIP_SMOKE=1` (ejecuta el smoke después, desde una
máquina con Node, como en la opción B).

### ES: §3 opción B, comandos nuevos

```bash
# 0) build the artifacts the App runs (client/dist + server-dist)
npm run bundle

# 4) post-deploy smoke against the app URL (exits != 0 when something breaks)
APP_URL=<app-URL> DATABRICKS_TOKEN=<oauth-token> npm run smoke
```

### ES: tabla de recursos del bundle, fila de dashboards

| Recurso | Configuración |
|---|---|
| **Dashboards** (`dashboards`) | dos dashboards de Lakeview sobre system tables: costos de IA por usuario (publicado por el job de auto-config) y operación (llamadas, usuarios, tokens, latencia; queda como borrador hasta que alguien lo publique). Ver [`dashboards/README.md`](../../dashboards/README.md) |

### ES: §4 punto 4

**Costos y operación**: la auditoría vive en dos **dashboards de AI/BI** que aprovisiona el
bundle (no en una pestaña de la app). El de costos sale publicado por el job de
auto-config; el de operación ("AI Prism — Operations") queda como borrador: ábrelo en el
workspace y **publícalo** para los demás administradores. Detalles en
[`dashboards/README.md`](../../dashboards/README.md).

### ES: §5 UI/funcionalidades

El código es tuyo: ajusta textos, tema y comportamiento y vuelve a desplegar con
`./deploy.sh <PROFILE>` (compila, despliega y ejecuta el smoke).

### ES: filas de solución de problemas

| Síntoma | Causa probable | Acción |
|---|---|---|
| El despliegue se detiene con "The Lakebase project ... is soft-deleted" (o el error de la API menciona `delete ... purge`) | (sin cambios) | (sin cambios) |
| El despliegue se detiene en "npm run bundle failed" (o "npm not found") | compilación rota, `npm ci` sin hacer, o una máquina sin Node | ejecuta `npm ci --include=dev` y `npm run bundle` para ver el error; para desplegar los artefactos que ya están en disco, usa `--skip-build` (`-SkipBuild`) |
| El despliegue termina con "smoke FAILED" | la versión nueva está arriba, pero se rompió un camino de usuario (identidad, modelos, chat, Lakebase o artefacto) | lee la tabla del smoke (la fila **FAIL** indica el paso y el error) y los logs de la app; "could not get an OAuth token" pide `databricks auth login -p <PROFILE>`. `--skip-smoke` despliega sin esta comprobación |
| Un cambio en el código no tiene efecto | `bundle deploy` no republica el código de la App, o los artefactos en disco están desactualizados | ejecuta `./deploy.sh <PROFILE>` (compila y publica); con los comandos manuales, `npm run bundle` y después `databricks apps deploy ai-prism --source-code-path <SRC>` |
