<!-- i18n: source=docs/install-from-zip.md source-hash=9bce60a2a7d2bbd0b5a0fae5735be508f8127e34 status=machine -->
# Instalar AI Prism desde un ZIP

[English](../install-from-zip.md) · [Português (Brasil)](../pt-BR/install-from-zip.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../install-from-zip.md) es la referencia.

Para quien recibe AI Prism como un archivo en lugar de clonar el repositorio. El ZIP trae la
app ya construida, así que quien instala no necesita git ni un build con Node: el notebook
del Workspace puede hacer toda la instalación, o puedes ejecutar `deploy.sh` /
`deploy.ps1` desde una terminal. En ambos casos, una **guarda de la carpeta** comprueba que
la carpeta sea exactamente lo que contenía el ZIP antes de enviar nada a tu workspace.

## Qué es el ZIP

`ai-prism-<version>.zip` lo arma quien mantiene el proyecto con
`scripts/build-customer-zip.sh`. Contiene:

- el código commiteado de esa versión más un `server-dist/` y un `client/dist/` **nuevos**
  (los artefactos que ejecuta la App), a partir de una lista explícita: el bundle,
  `app.yaml`, `deploy.sh`, `deploy.ps1`, el notebook instalador, `bundle/`, `dashboards/`,
  `server/`, `shared/`, `docs/`, los README, `CHANGELOG.md` y `LICENSE`. Sin tests, sin
  `node_modules`, sin archivos ocultos aparte de `.npmrc` y `.nvmrc`;
- todo dentro de una única carpeta raíz, **`ai-prism/`**, para que descomprimir nunca
  esparza archivos por el directorio actual. Cada carpeta tiene su propia entrada en el ZIP,
  antes de su contenido: el import del Workspace lo exige, o falla en el primer archivo;
- el `package-lock.json` apuntando al registry público de npm;
- el `ai-prism-manifest.txt`: la versión, el commit y una línea `<sha256>  <archivo>` por
  archivo (formato 2).

El ZIP es **reproducible**: el mismo commit produce el mismo archivo, byte a byte, en
cualquier zona horaria y con cualquier umask (cada entrada lleva la fecha del commit, o
`SOURCE_DATE_EPOCH`). Compara el sha256 del archivo con el que publique quien mantiene el
proyecto.

## Opción A: instalar desde el Workspace (un solo envío)

1. En el Workspace, crea una carpeta **nueva y vacía**.
2. Abre el menú de la carpeta (**⋮**) y elige **Import → File**, luego selecciona
   `ai-prism-<version>.zip`. Databricks lo descomprime en `ai-prism/`.
3. Abre `ai-prism/Install AI Prism` y deja vacío el campo **source**: el notebook encuentra
   el proyecto por sí solo y muestra la **versión del paquete** que encontró.
4. Conecta un cluster clásico con modo de acceso **Dedicated / Single user**, completa el
   **catalog** y ejecuta con **action = `check`**. No crea nada y ejecuta la misma guarda de
   la carpeta que el despliegue, así que una carpeta que mezcla versiones se rechaza ya aquí.
5. Cambia **action** a `install` y ejecuta de nuevo. La primera instalación tarda de 10 a 15
   minutos.

Los demás campos (serverless, suspensión de Lakebase, usage policy, tags) están descritos en
el notebook y en [onboarding-deployment.md](onboarding-deployment.md). Si prefieres, sube el
ZIP a un **Volume** de Unity Catalog e indica su ruta en **source**.

## Opción B: instalar desde una terminal

```bash
unzip ai-prism-<version>.zip          # crea la carpeta ai-prism/
cd ai-prism
./deploy.sh --check-tree              # opcional: solo comprueba la carpeta
npm ci --include=dev                  # una vez: los pasos de base de datos del deploy usan `pg`
./deploy.sh <PROFILE> [CATALOG]       # Windows: .\deploy.ps1 <PROFILE> [CATALOG]
```

En una carpeta de ZIP el despliegue **omite el build** (los artefactos vienen construidos y
el manifiesto fija su hash), así que no necesita herramientas de build. Consulta
[onboarding-deployment.md](onboarding-deployment.md) para las opciones y para lo que hace el
despliegue paso a paso.

## Actualizar

Importa (o descomprime) cada versión nueva en una **carpeta nueva y vacía**, o borra antes la
carpeta antigua. Importar un ZIP sobre una carpeta `ai-prism/` que ya existe **mezcla** los
archivos y puede conservar los de la versión antigua, por eso la guarda rechaza una carpeta
así. El estado de la instalación vive en tu workspace, no en esa carpeta: una carpeta nueva
actualiza la misma instalación.

## La guarda de la carpeta

`bundle deploy` envía la carpeta **completa** al workspace y a la App y, en una carpeta sin
git, no aplica el `.gitignore`. Un ZIP descomprimido en Descargas o en la carpeta del usuario
enviaría PDF, llaves y el `~/.databrickscfg`. Por eso `deploy.sh` y `deploy.ps1` comprueban
primero la carpeta, antes de cualquier llamada al workspace y sin forma de desactivarlo. El
despliegue se detiene, sin cambiar nada, cuando:

- la carpeta es tu carpeta de usuario o la raíz del disco;
- fuera de un checkout git: falta `ai-prism-manifest.txt`, no es formato 2, la carpeta tiene
  un archivo que no lista (o un enlace a carpeta), o un archivo listado falta o tiene otro
  sha256. Dos archivos solo necesitan existir: `app.yaml` (el despliegue lo reescribe) y
  `models.json`, si la versión trae uno. El notebook instalador es opcional: el Workspace lo
  convierte al importar;
- dentro de un checkout git: hay un archivo sin versionar que ni el `.gitignore` ni los
  excludes del sync de `databricks.yml` cubren (una llave, `credentials.json`, un PDF). Quien
  desarrolla y sabe lo que hace puede usar `AI_PRISM_ALLOW_UNTRACKED=1`.

La primera línea que muestran los scripts es `==> AI Prism <version> commit <sha>`.

`./deploy.sh --check-tree` (`.\deploy.ps1 -CheckTree`) ejecuta solo esta guarda, muestra la
versión del paquete y termina: sin CLI, sin perfil, sin red, sin escribir ni borrar nada.

Fuera de un checkout git el despliegue también borra los `sync-snapshots` locales de la CLI
antes de empezar, para que el sync sea completo: el ZIP sella sus archivos con la fecha del
commit, y un ZIP más antiguo descomprimido sobre una carpeta ya desplegada dejaría el código
nuevo fuera de la App. Nunca sigue un enlace al hacerlo: si cualquier parte de
`.databricks/bundle/<target>/sync-snapshots` es un enlace, el despliegue se detiene sin
borrar nada.

## Solución de problemas

| Mensaje o síntoma | Causa | Qué hacer |
|---|---|---|
| `this folder mixes versions of AI Prism` | Se importó un ZIP sobre una carpeta `ai-prism/` más antigua | Importa en una carpeta nueva y vacía, o borra antes la antigua |
| `file(s) that are not part of AI Prism` | Un archivo que el ZIP no tiene (copia de una llave, un PDF, un enlace) | Muévelo o bórralo: se enviaría al workspace |
| `ai-prism-manifest.txt is missing` | La carpeta no es un checkout git ni el árbol del ZIP | Descomprime en una carpeta vacía y ejecuta desde dentro de `ai-prism/` |
| `UNTRACKED file(s) outside .gitignore` | Un checkout git con archivos que el sync enviaría | Versiónalo, ignóralo, muévelo o usa `AI_PRISM_ALLOW_UNTRACKED=1` |
| `Error importing ai-prism-<version>.zip` | Un ZIP sin entradas de carpeta | Usa el ZIP armado por `scripts/build-customer-zip.sh` |

## Para quien mantiene: armar el ZIP

```bash
npm ci --include=dev                    # una vez: el .npmrc omite las devDependencies, donde viven vite y esbuild
./scripts/build-customer-zip.sh         # escribe dist/ai-prism-<version>.zip (dist/ no se versiona)
```

El script lee el árbol **commiteado** (`git archive HEAD`), así que los cambios sin commit no
entran (avisa). Construye `server-dist/` y `client/dist/` en una carpeta temporal y no tiene
`--skip-build`. Al final comprueba que nada solo de desarrollo (tests, `node_modules`, `.git`,
`.github`, archivos ocultos, logs, zips) entró en el paquete y que cada carpeta tiene su
entrada. `tests/customerZip.test.mjs` ejecuta todo esto, incluido un
`databricks bundle sync --dry-run` real en una carpeta sin git y en un checkout git.
