**English** · [Português (Brasil)](README.pt-BR.md) · [Español](README.es.md)

# UI string catalogs

All text in the web UI comes from these catalogs, one per language: Portuguese (`pt`), English
(`en`) and Spanish (`es`). Each language is split into **domains**, one file per area of the UI,
so different parts of the UI can change their copy without editing the same file.

## Layout

```text
client/src/lib/locales/
├── index.js              # merges the domain files into one flat catalog per language
├── catalogs.test.js      # snapshot, parity and partition checks
├── __snapshots__/        # <domain>.json: the expected strings, all three languages
├── pt/  en/  es/         # same file names in each language
│   ├── common.js
│   ├── composer.js
│   ├── message.js
│   ├── sidebar.js
│   ├── welcome.js
│   ├── settings.js
│   ├── admin.js
│   ├── studios.js
│   └── errors.js
```

Each domain file exports a flat object of `'namespace.key': 'text'` entries.
`client/src/lib/i18n.jsx` imports the merged catalogs from `index.js`; components call
`useT()` and `t('sidebar.newChat')`. Placeholders such as `{name}` are filled from
`t(key, { name })`. If a language lacks a key, the UI shows the `pt` text, then the key itself.

## Which file holds a key

The **namespace** is the part of the key before the first dot (`sidebar` in
`sidebar.newChat`). Each namespace lives in exactly one domain file:

| Domain | Namespaces | UI |
|---|---|---|
| `common` | `common`, `notify`, `chat`, `compaction`, `skillCreator`, `tools`, `meter`, `time`, `shell`, `appError`, `modelPicker` | shared buttons, app shell (error screens, not found, turn errors), friendly error copy, header pickers (model, tools, cost meter), relative time |
| `composer` | `composer`, `voice` | message composer, voice mode |
| `message` | `message`, `reasoning`, `loading`, `deckQuestions`, `chart`, `table`, `spreadsheetBlock`, `deckBlock`, `imageBlock`, `docBlock` | chat messages and inline blocks |
| `sidebar` | `sidebar`, `history` | sidebar, history page |
| `welcome` | `welcome` | welcome screen |
| `settings` | `settings`, `personal`, `mcp`, `skills`, `templates`, `templateInspector` | settings tabs every user sees |
| `admin` | `admins`, `models`, `toolsAdmin`, `mcpAdmin` | organization admin tabs |
| `studios` | `docStudio`, `richText`, `deckStudio`, `deckPreview`, `layerTree`, `inspector`, `sheetStudio` | deck, spreadsheet and document studios |
| `errors` | `errors` (no keys yet) | error text shared across the UI |

Error text that belongs to one screen (for example `docStudio.saveError`) stays in that screen's
namespace, so one owner edits one file.

## Add or change a key

1. Find the file that owns the namespace (table above, or the comment at the top of each file).
2. Add or edit the entry in `pt/<domain>.js`, `en/<domain>.js` **and** `es/<domain>.js`, with the
   same key in all three.
3. Regenerate the snapshots and review the diff. It should show only your change:

   ```bash
   UPDATE_LOCALE_SNAPSHOTS=1 node --test client/src/lib/locales/catalogs.test.js
   git diff client/src/lib/locales/__snapshots__/
   ```

4. Run the tests without the variable (next section) and commit the catalogs and snapshots together.

A **new namespace** goes into the domain that owns its UI. Never add keys of an existing
namespace to another domain file; the tests reject that.

## Add a domain

1. Create `pt/<domain>.js`, `en/<domain>.js` and `es/<domain>.js` (start with `export default {}`).
2. In `index.js`, import the three files, append the domain to `DOMAINS` and add it to each
   language in `PARTS`.
3. Append the domain to the `DOMAINS` list in `catalogs.test.js`.
4. Regenerate the snapshots (step 3 above). This creates `__snapshots__/<domain>.json`.
5. Move whole namespaces only; a namespace can't be split between two domains.

## Tests

`catalogs.test.js` checks that:

- each domain file has exactly the strings recorded in `__snapshots__/<domain>.json`, and the
  merged catalogs match, so text can't change, disappear or appear without showing up in review;
- `pt`, `en` and `es` have the same keys, per domain and merged (no language silently falls back);
- each namespace lives in exactly one domain file, so the merge order in `index.js` can't matter;
- every value is a non-empty string.

Run it from the repository root:

```bash
node --test client/src/lib/locales/catalogs.test.js
```

It also runs with the rest of the unit tests (`node --test` over the `*.test.js` / `*.test.mjs`
files under `server shared scripts tests client/src`).
