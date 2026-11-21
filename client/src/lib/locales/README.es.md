[English](README.md) · [Português (Brasil)](README.pt-BR.md) · **Español**

# Catálogos de cadenas de la UI

Todo el texto de la interfaz web sale de estos catálogos, uno por idioma: portugués (`pt`),
inglés (`en`) y español (`es`). Cada idioma se divide en **dominios**, un archivo por área de la
UI, para que distintas partes de la UI cambien sus textos sin editar el mismo archivo.

## Estructura

```text
client/src/lib/locales/
├── index.ts              # merges the domain files into one flat catalog per language
├── catalogs.test.ts      # snapshot, parity and partition checks
├── __snapshots__/        # <domain>.json: the expected strings, all three languages
├── pt/  en/  es/         # same file names in each language
│   ├── common.ts
│   ├── composer.ts
│   ├── message.ts
│   ├── sidebar.ts
│   ├── welcome.ts
│   ├── settings.ts
│   ├── admin.ts
│   ├── studios.ts
│   └── errors.ts
```

Cada archivo de dominio exporta un objeto plano con entradas `'namespace.clave': 'texto'`.
`client/src/lib/i18n.jsx` importa los catálogos unidos desde `index.ts`; los componentes llaman a
`useT()` y `t('sidebar.newChat')`. Los marcadores como `{name}` se completan con
`t(clave, { name })`. Si a un idioma le falta una clave, la UI muestra el texto en `pt` y, después,
la propia clave.

## Qué archivo guarda una clave

El **namespace** es la parte de la clave antes del primer punto (`sidebar` en `sidebar.newChat`).
Cada namespace vive en exactamente un archivo de dominio:

| Dominio | Namespaces | UI |
|---|---|---|
| `common` | `common`, `notify`, `chat`, `compaction`, `skillCreator`, `tools`, `meter`, `time`, `shell`, `appError`, `modelPicker` | botones comunes, estructura de la app (pantallas de error, no encontrado, errores de turno), textos de error amigables, selectores de la cabecera (modelo, tools, taxímetro), tiempo relativo |
| `composer` | `composer`, `voice` | cuadro de mensaje, modo de voz |
| `message` | `message`, `reasoning`, `loading`, `deckQuestions`, `chart`, `table`, `spreadsheetBlock`, `deckBlock`, `imageBlock`, `docBlock` | mensajes del chat y bloques en línea |
| `sidebar` | `sidebar`, `history` | barra lateral, página de historial |
| `welcome` | `welcome` | pantalla de bienvenida |
| `settings` | `settings`, `personal`, `mcp`, `skills`, `templates`, `templateInspector` | pestañas de configuración que ve todo usuario |
| `admin` | `admins`, `models`, `toolsAdmin`, `mcpAdmin`, `costs` | pestañas de administración de la organización, página de Costos |
| `studios` | `docStudio`, `richText`, `deckStudio`, `deckPreview`, `layerTree`, `inspector`, `sheetStudio` | estudios de presentación, hoja de cálculo y documento |
| `errors` | `errors` (todavía sin claves) | texto de error común a toda la UI |

El texto de error de una sola pantalla (por ejemplo `docStudio.saveError`) queda en el namespace
de esa pantalla, para que un único responsable edite un único archivo.

## Agregar o cambiar una clave

1. Busca el archivo dueño del namespace (tabla de arriba o el comentario al inicio de cada archivo).
2. Agrega o edita la entrada en `pt/<dominio>.ts`, `en/<dominio>.ts` **y** `es/<dominio>.ts`, con
   la misma clave en los tres.
3. Regenera los snapshots y revisa el diff. Debe mostrar solo tu cambio:

   ```bash
   UPDATE_LOCALE_SNAPSHOTS=1 node --test client/src/lib/locales/catalogs.test.ts
   git diff client/src/lib/locales/__snapshots__/
   ```

4. Ejecuta las pruebas sin la variable (sección siguiente) y haz commit de catálogos y snapshots
   juntos.

Un **namespace nuevo** va al dominio dueño de su UI. Nunca agregues claves de un namespace
existente en otro archivo de dominio; las pruebas lo rechazan.

## Agregar un dominio

1. Crea `pt/<dominio>.ts`, `en/<dominio>.ts` y `es/<dominio>.ts` (empieza con `export default {}`; en `pt` y `es` tipalo como `Record<keyof typeof en, string>`, igual que los otros dominios).
2. En `index.ts`, importa los tres archivos, agrega el dominio a `DOMAINS` e inclúyelo en cada
   idioma de `PARTS`.
3. Agrega el dominio a la lista `DOMAINS` de `catalogs.test.ts`.
4. Regenera los snapshots (paso 3 de arriba). Esto crea `__snapshots__/<dominio>.json`.
5. Mueve solo namespaces completos; un namespace no puede quedar dividido entre dos dominios.

## Pruebas

`catalogs.test.ts` verifica que:

- cada archivo de dominio tiene exactamente las cadenas guardadas en `__snapshots__/<dominio>.json`,
  y los catálogos unidos coinciden, así ningún texto cambia, desaparece o aparece sin verse en la
  revisión;
- `pt`, `en` y `es` tienen las mismas claves, por dominio y en total (ningún idioma cae en el
  respaldo en silencio);
- cada namespace vive en exactamente un archivo de dominio, así el orden del merge en `index.ts`
  no importa;
- todo valor es una cadena no vacía.

Ejecútalo desde la raíz del repositorio:

```bash
node --test client/src/lib/locales/catalogs.test.ts
```

También se ejecuta junto con las demás pruebas unitarias (`node --test` sobre los archivos
`*.test.js` / `*.test.mjs` en `server shared scripts tests client/src`).
