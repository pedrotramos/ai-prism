### Added

- **Donut and map charts.** The assistant can answer with a donut (parts of a whole, total in the centre) or a
  map (choropleth by region), in the chat, with "View data" and PNG export like every other chart. Data you
  attach or query gets donut and map suggestions on its own when a measure adds up or a column names
  countries or states. Maps draw **geo sets**: pre-projected SVG regions bundled as `world-countries`
  (174 countries; ids, names in en/pt/es) and `br-states` (27 states, an example of a regional set).
  `scripts/build-geo.mjs` turns any GeoJSON into a set and `GEO_DATA_DIR` loads extra sets at start
  (`docs/charts-geo.md`, in English, Português and Español).
- **Chat charts in decks and documents.** For a deck or document turn the assistant receives the
  conversation's visual inventory (charts already shown and the ones built from attachments and queries) and
  chooses the ones that back a conclusion: a `chart` slide names `"viz"`, a document line `{{viz:<id>}}`. The
  numbers always come from the data, and an id outside the inventory is dropped. Charts are drawn on the server as
  PNG (`@resvg/resvg-wasm` + Inter, AI Prism light tokens), so the Studio preview, the PPTX export, print and
  the DOCX (a real picture plus a data table) all show them, and the AI edit of a slide keeps the figure.
  New routes: `GET /api/geo/:id` and `GET /api/sessions/:id/visuals/:vizId.png`.
- **"Use in slides"** on a chart of the chat puts a deck request naming it in the composer (never sent for you).
- **Tabs stay in step.** When a turn ends in one browser tab, the other tabs refresh the conversation list and
  reload that conversation if it is the open one (`BroadcastChannel`, no data in the message).

### Changed

- **Genie REST calls retry twice** (0.5 s, then 1.5 s, or the `Retry-After` up to 5 s) on a dropped connection
  or a 429, 502, 503 or 504; any other status is reported at once.
- **A deck slide may carry a base64 PNG figure** (up to 600 KB beyond the 60k-character markup cap), which is
  how a chart reaches the PPTX export.

### Deploy notes

- **New dependencies**: `@resvg/resvg-wasm` and `@expo-google-fonts/inter` (dev dependencies, bundled by
  `npm run bundle`). `npm run bundle` now copies `resvg.wasm` and the three Inter files next to
  `server-dist/index.cjs`. Without them the app logs `CHART_RASTER_UNAVAILABLE` at start and decks and
  documents go without chart figures; everything else works.
- **Optional**: `GEO_DATA_DIR` (directory of extra geo sets).
- No migration. The two new lock entries carry no `resolved` URL (the registry is resolved at install).
