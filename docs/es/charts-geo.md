<!-- i18n: source=docs/charts-geo.md source-hash=2d98104a484f1701d177237f3f3b90b341972b3d status=machine -->
# Gráficos: anillo, mapa y gráficos del chat en presentaciones y documentos

[English](../charts-geo.md) · [Português (Brasil)](../pt-BR/charts-geo.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../charts-geo.md) es la referencia.

## Tipos de gráfico

Además de barras, líneas, área, circular, tabla dinámica, mapa de calor, dispersión e histograma, una
respuesta del chat puede traer:

- **anillo**: partes de un todo, con el total en el centro y la participación de cada porción en la leyenda.
  El servidor convierte una medida aditiva (ingresos, unidades) en hasta cinco porciones más "Otros".
- **mapa**: coroplético. Cada fila de los datos es una región y su valor; el tono sigue al valor.

Como en todo gráfico, los números salen de los datos (un adjunto o el resultado de una consulta), nunca de
números escritos por el modelo. El modelo solo elige qué gráfico mostrar.

## Conjuntos geográficos

Un mapa dibuja las regiones de un **conjunto geográfico**: formas ya proyectadas en un único `viewBox` SVG,
de modo que el navegador y el servidor dibujan la misma imagen y no se ejecuta ninguna biblioteca de mapas
ni proyección al pintar.

| Id del conjunto | Regiones | Coincide con etiquetas como |
|---|---|---|
| `world-countries` | 174 países | códigos ISO (`BR`, `BRA`) y nombres en inglés, portugués y español |
| `br-states` | 27 estados de Brasil | siglas (`SP`) y nombres. Un ejemplo de conjunto regional |

Una columna de datos se convierte en mapa solo cuando al menos el 70 % de sus etiquetas (y como mínimo 3)
nombran regiones de un mismo conjunto. Una etiqueta que no coincide con nada queda fuera del mapa y dentro
de la tabla de datos.

### Agregar un conjunto propio

1. Consigue un archivo GeoJSON de las regiones (Natural Earth, el instituto de estadística de tu país, ...).
2. Conviértelo:

   ```bash
   node scripts/build-geo.mjs regions.geojson \
     --id my-regions --name "My regions" --id-prop code --name-prop name \
     --aliases aliases.json --projection mercator --width 800 --json my-regions.json
   ```

   - `--id-prop` / `--name-prop`: las propiedades de las features con el código y el nombre de la región.
   - `--aliases`: opcional, `{ "SP": ["São Paulo", "Sao Paulo"] }`, otras grafías por código.
   - `--projection equirect|mercator`, `--width`, `--decimals`, `--tolerance`: tamaño frente a detalle (los
     conjuntos incluidos pesan unos 80 KB cada uno). `--bbox lonMin,latMin,lonMax,latMax` recorta la vista.
   - `--ts shared/geo/mySet.ts` escribe un módulo TypeScript, para incluir un conjunto en la app.
3. Pon el `.json` en un directorio y apunta `GEO_DATA_DIR` a él (variable de entorno de Apps). El servidor
   lee el directorio una vez, al iniciar: como máximo 20 archivos de 6 MiB y 400 regiones por conjunto. Un
   archivo que no es un conjunto válido se omite y se registra en el log. Un conjunto no reemplaza un id
   incluido en la app.

Nada más cambia. Al armar un mapa, el asistente puede indicar un conjunto como pista (la política lista los
ids incluidos); el servidor compara las etiquetas con todos los conjuntos, incluido el tuyo, y se queda con el
que mejor encaja. Si ninguno sirve, el mapa no se dibuja.

## Gráficos del chat en presentaciones y documentos

Cuando un turno puede crear una presentación o un documento, el asistente recibe además el **inventario de
visualizaciones** de la conversación: los gráficos ya mostrados (`viz_<mensaje>_<n>`) y los armados a partir
de adjuntos y consultas (`candidate_<n>`). Él decide cuáles respaldan una conclusión; nadie tiene que pedirlo.

- **Presentación**: una diapositiva `chart` trae `"viz": "<id>"`. El servidor dibuja el gráfico como PNG y lo
  coloca en la diapositiva, así que la vista previa del Studio y la exportación PPTX lo muestran. La edición
  por IA de una diapositiva conserva la figura.
- **Documento**: una línea `{{viz:<id>}}` se convierte en la figura más una pequeña tabla de datos. El Studio,
  la impresión y la exportación DOCX la llevan (el DOCX contiene la imagen misma).
- **"Usar en diapositivas"** en un gráfico del chat pone en el campo de mensaje una solicitud de
  presentación, para que el usuario la envíe.

Un id fuera del inventario se descarta, así que el modelo no puede mostrar un gráfico que la conversación no tiene.

### El motor de rasterizado

Los PNG se dibujan en el servidor con `@resvg/resvg-wasm` y la fuente Inter, con los tokens claros de AI Prism.
`npm run bundle` copia `resvg.wasm` y los tres archivos Inter junto al bundle del servidor. Si faltan, la app
registra `CHART_RASTER_UNAVAILABLE` al iniciar; los gráficos, los mapas y el resto de la app siguen
funcionando, las presentaciones y los documentos simplemente quedan sin la figura, y
`GET /api/sessions/:id/visuals/:vizId.png` responde 503.

## Comportamientos relacionados

- **Genie**: las llamadas a la API REST de Genie se reintentan dos veces (0,5 s y luego 1,5 s) cuando la
  conexión se cae o el gateway responde 429, 502, 503 o 504. Cualquier otro estado se informa de inmediato.
- **Varias pestañas**: cuando un turno termina en una pestaña del navegador, las otras pestañas del mismo
  navegador actualizan la lista de conversaciones y recargan esa conversación si es la que está abierta.
