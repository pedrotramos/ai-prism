# Charts: donut, map, and chat charts in decks and documents

**English** · [Português (Brasil)](pt-BR/charts-geo.md) · [Español](es/charts-geo.md)

## Chart kinds

Besides bar, line, area, pie, pivot, heatmap, scatter and histogram, a chat answer can carry:

- **donut**: parts of a whole, with the total in the middle and each share in the legend.
  The server turns a measure that adds up (revenue, units) into at most five slices plus "Others".
- **map**: a choropleth. Each row of the data is a region and its value; the shade follows the value.

As with every chart, the numbers come from the data (an attachment or a query result), never from
numbers the model wrote. The model only chooses which chart to show.

## Geo sets

A map draws the regions of a **geo set**: shapes already projected into one SVG `viewBox`, so the
browser and the server draw the same picture and no map library or projection runs at paint time.

| Set id | Regions | Matches labels such as |
|---|---|---|
| `world-countries` | 174 countries | ISO codes (`BR`, `BRA`) and names in English, Portuguese and Spanish |
| `br-states` | 27 states of Brazil | state codes (`SP`) and names. An example of a regional set |

A data column becomes a map only when at least 70 % of its labels (and at least 3) name regions of one
set. A label that matches nothing stays out of the map and in the data table.

### Adding your own set

1. Get a GeoJSON file of the regions (Natural Earth, your national statistics office, ...).
2. Convert it:

   ```bash
   node scripts/build-geo.mjs regions.geojson \
     --id my-regions --name "My regions" --id-prop code --name-prop name \
     --aliases aliases.json --projection mercator --width 800 --json my-regions.json
   ```

   - `--id-prop` / `--name-prop`: the feature properties holding the region code and name.
   - `--aliases`: optional `{ "SP": ["São Paulo", "Sao Paulo"] }`, other spellings per code.
   - `--projection equirect|mercator`, `--width`, `--decimals`, `--tolerance`: size versus detail (the bundled sets are
     about 80 KB each). `--bbox lonMin,latMin,lonMax,latMax` crops the view.
   - `--ts shared/geo/mySet.ts` writes a TypeScript module instead, to bundle a set with the app.
3. Put the `.json` file in a directory and set `GEO_DATA_DIR` to it (an Apps environment variable).
   The server reads the directory once at start: at most 20 files of 6 MiB, at most 400 regions per set.
   A file that is not a valid set is skipped and logged. A set cannot replace one of the bundled ids.

Nothing else changes. When the assistant makes a map it may name a set as a hint (the policy lists the
bundled ids); the server matches the labels against every set, yours included, and keeps the one that
fits best. If none fits, the map is not drawn.

## Charts of the chat in decks and documents

When a turn can create a deck or a document, the assistant also receives the **visual inventory** of the
conversation: the charts already shown (`viz_<message>_<n>`) and the ones built from attachments and
queries (`candidate_<n>`). It decides which ones back a conclusion; nobody has to ask.

- **Deck**: a `chart` slide names `"viz": "<id>"`. The server draws the chart as a PNG and places it in the
  slide, so the Studio preview and the PPTX export show it. The AI edit of a slide keeps the figure.
- **Document**: a line `{{viz:<id>}}` becomes the figure plus a small data table. The Studio, print
  and DOCX export carry it (the DOCX holds the picture itself).
- **"Use in slides"** on a chart of the chat puts a deck request in the composer for the user to send.

An id outside the inventory is dropped, so a model cannot show a chart the conversation does not have.

### The raster engine

The PNGs are drawn on the server with `@resvg/resvg-wasm` and the Inter font, in the light AI Prism
tokens. `npm run bundle` copies `resvg.wasm` and the three Inter files next to the server bundle.
If they are missing, the app logs `CHART_RASTER_UNAVAILABLE` at start; charts, maps and the rest of the
app keep working, decks and documents simply go without the figure, and
`GET /api/sessions/:id/visuals/:vizId.png` answers 503.

## Related behaviour

- **Genie**: calls to the Genie REST API retry twice (0.5 s, then 1.5 s) when the connection drops or the
  gateway answers 429, 502, 503 or 504. Any other status is reported at once.
- **Several tabs**: when a turn ends in one browser tab, the other tabs of the same browser refresh the
  conversation list and reload that conversation if it is the open one.
