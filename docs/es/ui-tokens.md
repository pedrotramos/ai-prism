<!-- i18n: source=docs/ui-tokens.md source-hash=b5b9a811f700cf12c4df636a1243082f8c5fd462 status=outdated -->
# Tokens de diseño de la UI

[English](../ui-tokens.md) · [Português (Brasil)](../pt-BR/ui-tokens.md) · **Español**

> Esta traducción fue hecha con ayuda de IA y espera revisión nativa. En caso de duda, la [versión en inglés](../ui-tokens.md) es la referencia.

El cliente tiene una única capa de tokens: [`client/src/styles/tokens.css`](../../client/src/styles/tokens.css).
Todo color, tamaño de texto, paso de espaciado, radio, sombra, capa de z-index y
duración de movimiento que la UI necesita es una propiedad CSS personalizada allí,
definida para los temas oscuro (por defecto) y claro. [`tailwind.config.js`](../../tailwind.config.js)
asigna cada una a una clave de Tailwind, de modo que `text-faint`, `bg-accent-strong`,
`rounded-card`, `z-modal` y `duration-fast` resuelven a las mismas variables y
cambian con el tema.

Por qué importa en la práctica:

- **La accesibilidad se resuelve una vez.** El contraste vive en los valores de los
  tokens, así que un componente que usa `--faint` o `--accent-strong` cumple WCAG AA
  sin código de color propio. Antes de esta capa, axe encontraba de 126 a 130 fallos
  de `color-contrast` (la cuenta depende de los datos sembrados) en 16 ejecuciones:
  las cuatro pantallas principales (bienvenida, chat, Configuración, Deck Studio) en
  ambos temas, a 1440 px y 390 px. Con la capa, las mismas ejecuciones reportan 0.
- **Cambiar de tema toca un archivo.** Claro y oscuro difieren solo en `tokens.css`.
  Ningún componente necesita una variante `dark:` para el color.
- **Las regresiones rompen una prueba, no una revisión.**
  [`client/src/styles/tokens.test.js`](../../client/src/styles/tokens.test.js)
  recalcula cada razón de abajo a partir de los valores de los tokens en cada
  ejecución de `node --test`.
  [`client/src/styles/tokens.browser.test.js`](../../client/src/styles/tokens.browser.test.js)
  compila la hoja de estilo desde el código fuente con la configuración de Vite del
  proyecto (en memoria) y la carga en Chrome headless. Comprueba el anillo de foco
  calculado en controles con `outline-none`, el movimiento reducido y los puentes de
  tokens en ambos temas. Necesita:
  - Node >= 22, por el `WebSocket` integrado que maneja Chrome mediante el protocolo
    DevTools;
  - las devDependencies que el repositorio ya tiene: `vite`, más el pipeline
    `tailwindcss`, `postcss` y `autoprefixer` que carga mediante `postcss.config.js`
    (instaladas con `npm ci --include=dev`);
  - un binario de Chrome o Chromium, encontrado mediante `CHROME_PATH`, la caché de
    navegadores de Playwright o las rutas de instalación habituales.

  No necesita ningún paquete de automatización de navegador (ni Playwright ni
  Puppeteer) y no añade dependencias. Sin un binario de navegador, se omite e imprime
  el motivo.

## Cómo usarlos

| Escribe esto | No esto | Por qué |
|---|---|---|
| `text-faint` o `text-[var(--faint)]` | `text-gray-500`, `text-[#6b7480]` | Sigue el tema y mantiene el contraste AA. |
| `bg-accent-strong text-on-accent` para un botón relleno | `bg-[var(--accent)] text-white` | Blanco sobre `--accent` es 3,6:1 (oscuro) y 4,3:1 (claro). |
| `text-accent-text` para texto pequeño en el color de acento | `text-[var(--accent)]` en texto | `--accent` es para iconos, trazos y marcas grandes. |
| `text-danger`, `bg-danger-soft` para errores | el acento de la marca, `text-red-400` | Los errores y las acciones primarias no deben compartir un color. |
| `bg-disabled text-disabled-text` | `disabled:opacity-50` en un botón relleno | Un acento semitransparente parece un botón habilitado suave. |
| `text-caption`, `text-label`, `text-body` … | `text-[11px]`, `text-[10.5px]` | Seis tamaños en lugar de 17 hacen legible la jerarquía. |
| `gap-in-group` dentro de un grupo, `gap-between-groups` entre grupos | medios pasos como `gap-1.5` o `gap-2.5` elegidos al azar | Proximidad: lo relacionado va cerca, los grupos van separados. |
| `rounded-card`, `rounded-control`, `rounded-badge`, `rounded-pill` | `rounded-xl` en una tarjeta, `rounded-2xl` en la siguiente | Las cosas parecidas se ven parecidas. |
| `z-modal`, `z-popover`, `z-toast` | `z-[75]`, `z-[130]` | Una escala ordenada. Se acabó adivinar un número que gane. |
| `duration-fast`, `duration-base`, `duration-slow` | `transition` suelto sin duración | El movimiento tiene tres velocidades, y todas se detienen con movimiento reducido. |

Foco: todo elemento enfocable recibe el anillo global
`outline: 2px solid var(--focus-ring); outline-offset: 2px` en `:focus-visible`,
incluidos los elementos escritos con `outline-none`. Para dibujar otro indicador, usa
utilidades `focus-visible:` (por ejemplo `focus-visible:outline-offset-0` o
`focus-visible:ring-2`); tienen mayor especificidad que la regla global.
Nunca uses `focus-visible:outline-none` (ni `outline-0`, `ring-0`, `shadow-none`,
`…-transparent`) sin un anillo, contorno, borde o sombra `focus-visible:` igual de
visible en la misma línea que nada en ella cancele; `a11yBudget.test.js` lo rechaza.

## Tokens de color

| Token | Oscuro | Claro | Uso |
|---|---|---|---|
| `--bg` | `#0b0d0f` | `#f7f8fa` | Fondo de la página |
| `--surface` (Tailwind `surface`, `surface-1`) | `#111418` | `#ffffff` | Paneles, tarjetas, barra lateral |
| `--surface-2` | `#161a1f` | `#f1f3f5` | Superficie elevada o con hover |
| `--surface-3` | `#1c2127` | `#e9edf1` | Superficie más alta, chips, campos |
| `--border` / `--border-soft` | `#272d35` / `#1e242b` | `#e2e6ea` / `#eef1f4` | Líneas y divisores |
| `--text` (Tailwind `fg`) | `#e8eaed` | `#1a1f24` | Texto del cuerpo |
| `--muted` | `#98a2b3` | `#5c6670` | Texto secundario |
| `--faint` | `#858e9a` | `#626b75` | Texto terciario: metadatos, etiquetas de grupo, duraciones |
| `--accent` | `#ff3621` | `#e5341f` | Marca: iconos, trazos, marcas de selección |
| `--accent-strong` | `#cc2c18` | `#c42a17` | Fondo del botón de acción (CTA) relleno |
| `--accent-soft` | `rgba(255,54,33,.12)` | `rgba(229,52,31,.1)` | Relleno de fila o pestaña seleccionada |
| `--accent-text` | `#ff5a46` | `#b8281a` | Texto pequeño en el color de acento, también sobre `--accent-soft` |
| `--on-accent` | `#ffffff` | `#ffffff` | Etiqueta sobre `--accent-strong` |
| `--bubble-user` | `#1e2630` | `#eef2f6` | Burbuja de mensaje del usuario |
| `--link` | `#5b9dff` | `#1d64d8` | Enlaces en el markdown renderizado |
| `--danger` / `--danger-soft` | `#f2555a` | `#c62a2f` | Errores, acciones destructivas |
| `--success` / `--success-soft` | `#3dd68c` | `#18794e` | Completado, saludable |
| `--warning` / `--warning-soft` | `#f5a524` | `#9a5b00` | Requiere atención |
| `--info` / `--info-soft` | `#6ea8ff` | `#1d64d8` | Información neutra |
| `--disabled-bg` / `--disabled-text` | `--surface-3` / `--faint` | `--surface-3` / `--faint` | Controles deshabilitados |
| `--focus-ring` | `#6ea8ff` | `#1d64d8` | Contorno del foco de teclado |

Las variantes `*-soft` son el color base al 14% (oscuro) o 10% (claro) sobre
transparente. Úsalas como relleno de badges o banners, con el color base como texto.

## Los artefactos no usan estos tokens

El chrome de la aplicación tiene un aspecto propio. Las diapositivas, documentos, hojas de cálculo, vistas previas del design system y tarjetas de plantilla siguen el design system que subió el workspace, mediante `HtmlSlideFrame`, `TemplateSlidePreview` y `lib/themePreview.ts`. La prueba [`dsIsolation.test.ts`](../../client/src/styles/dsIsolation.test.ts) falla si algún archivo de `components/deck/` (salvo el panel lateral del editor), `HtmlDeckPreview`, `TemplateSlidePreview` o `themePreview` lee un token exclusivo de la aplicación o nombra una familia IBM Plex.

## Fuentes

IBM Plex Sans, Serif y Mono, incluidas en la aplicación: `index.css` importa el subconjunto latino (cubre inglés, portugués y español) de los paquetes `@fontsource` y Vite emite los archivos en `client/dist/assets`. No hay peticiones a un servidor de fuentes, así que la CSP no necesita una excepción. Tailwind: `font-sans`, `font-serif`, `font-mono`. Use `.num` para cifras tabulares.

## Matriz de contraste

Razón de contraste WCAG 2.x de cada token de primer plano sobre cada superficie del
mismo tema. El texto necesita 4,5:1. Un indicador de foco necesita 3:1. El mínimo de
cada fila está en el piso o por encima.

**Oscuro**

| Token | Valor | `--bg` | `--surface` | `--surface-2` | `--surface-3` | Piso |
|---|---|---|---|---|---|---|
| `--text` | `#e8eaed` | 16.15 | 15.32 | 14.50 | 13.44 | 4.5:1 |
| `--muted` | `#98a2b3` | 7.56 | 7.17 | 6.79 | 6.29 | 4.5:1 |
| `--faint` | `#858e9a` | 5.87 | 5.57 | 5.27 | 4.89 | 4.5:1 |
| `--accent-text` | `#ff5a46` | 6.31 | 5.98 | 5.66 | 5.25 | 4.5:1 |
| `--accent-text` sobre `--accent-soft` | | 5.74 | 5.40 | 5.11 | 4.72 | 4.5:1 |
| `--link` | `#5b9dff` | 7.15 | 6.78 | 6.42 | 5.95 | 4.5:1 |
| `--danger` | `#f2555a` | 5.77 | 5.47 | 5.18 | 4.80 | 4.5:1 |
| `--success` | `#3dd68c` | 10.38 | 9.85 | 9.32 | 8.64 | 4.5:1 |
| `--warning` | `#f5a524` | 9.54 | 9.05 | 8.56 | 7.94 | 4.5:1 |
| `--info` | `#6ea8ff` | 8.07 | 7.66 | 7.25 | 6.72 | 4.5:1 |
| `--focus-ring` | `#6ea8ff` | 8.07 | 7.66 | 7.25 | 6.72 | 3:1 |
| `--faint` _anterior_ | `#6b7480` | 4.11 | 3.90 | 3.69 | 3.42 | |
| texto `--accent` _anterior_ sobre `--accent-soft` | `#ff3621` | 4.90 | 4.60 | 4.36 | 4.02 | |

`--on-accent` sobre `--accent-strong` (`#cc2c18`): **5,33:1**, y 4,54:1 con
`hover:brightness-110`. Blanco sobre `--accent` (`#ff3621`) era 3,62:1.

**Claro**

| Token | Valor | `--bg` | `--surface` | `--surface-2` | `--surface-3` | Piso |
|---|---|---|---|---|---|---|
| `--text` | `#1a1f24` | 15.62 | 16.60 | 14.92 | 14.11 | 4.5:1 |
| `--muted` | `#5c6670` | 5.51 | 5.85 | 5.26 | 4.97 | 4.5:1 |
| `--faint` | `#626b75` | 5.09 | 5.41 | 4.87 | 4.60 | 4.5:1 |
| `--accent-text` | `#b8281a` | 5.89 | 6.26 | 5.62 | 5.32 | 4.5:1 |
| `--accent-text` sobre `--accent-soft` | | 5.09 | 5.42 | 4.90 | 4.66 | 4.5:1 |
| `--link` | `#1d64d8` | 5.11 | 5.43 | 4.88 | 4.62 | 4.5:1 |
| `--danger` | `#c62a2f` | 5.24 | 5.57 | 5.00 | 4.73 | 4.5:1 |
| `--success` | `#18794e` | 5.09 | 5.41 | 4.86 | 4.60 | 4.5:1 |
| `--warning` | `#9a5b00` | 5.11 | 5.43 | 4.88 | 4.61 | 4.5:1 |
| `--info` | `#1d64d8` | 5.11 | 5.43 | 4.88 | 4.62 | 4.5:1 |
| `--focus-ring` | `#1d64d8` | 5.11 | 5.43 | 4.88 | 4.62 | 3:1 |
| `--faint` _anterior_ | `#8a939c` | 2.93 | 3.12 | 2.80 | 2.65 | |
| texto `--accent` _anterior_ sobre `--accent-soft` | `#e5341f` | 3.53 | 3.76 | 3.40 | 3.23 | |

`--on-accent` sobre `--accent-strong` (`#c42a17`): **5,69:1**, y 4,87:1 con
`hover:brightness-110`. Blanco sobre `--accent` (`#e5341f`) era 4,34:1.

En modo claro, `--faint` y `--muted` quedan cerca: ningún gris más claro llega a
4,5:1 sobre `--surface-3`. Expresa el nivel terciario también con el tamaño
(`text-caption`) o el peso, no solo con el color.

## Escala tipográfica

| Tailwind | Tamaño / altura de línea | Uso |
|---|---|---|
| `text-caption` | 11 / 16 px | Metadatos, marcas de tiempo, etiquetas de grupo de la barra lateral |
| `text-label` | 12 / 16 px | Controles, chips, celdas de tabla |
| `text-body` | 14 / 20 px | Texto predeterminado de la UI |
| `text-title` | 16 / 24 px | Títulos de tarjetas y paneles |
| `text-heading` | 20 / 28 px | Encabezados de página y de modal |
| `text-display` | 28 / 36 px | Hero de bienvenida |

La prosa del chat (`.prose-chat`, 0.95rem) y la prosa de documentos (`.prose-doc`)
conservan sus propios tamaños de lectura.

Reglas: escribe solo estas seis clases. No uses `text-xs`, `text-sm`, `text-base`,
`text-lg`, `text-xl`, `text-2xl` ni `text-[Npx]`. Equivalencias al migrar: `xs` →
`label`, `sm` → `body`, `base`/`lg` → `title`, `xl`/`2xl` → `heading`,
`[9px]`…`[11px]` → `caption`, `[15px]`/`[0.95rem]` → `body`. El texto del cuerpo
nunca baja de 14 px (`text-body`); 11 y 12 px son solo para metadatos y controles.
`client/src/a11yBudget.test.js` falla por encima de 6 clases de tamaño heredadas
distintas.

## Espaciado, radio, sombra

| Token | Valor | Tailwind |
|---|---|---|
| `--space-1` … `--space-8` | 4, 8, 12, 16, 24, 32 px | Los pasos por defecto de Tailwind `1 2 3 4 6 8` ya coinciden |
| `--space-in-group` | 8 px | `gap-in-group`, `p-in-group` |
| `--space-between-groups` | 24 px | `gap-between-groups`, `mt-between-groups` |
| `--space-section` | 32 px | `gap-section`, `py-section` |
| `--radius-card` | 12 px | `rounded-card` (tarjetas, paneles, modales) |
| `--radius-control` | 8 px | `rounded-control` (botones, campos) |
| `--radius-badge` | 6 px | `rounded-badge` (badges, chips pequeños) |
| `--radius-pill` | 9999 px | `rounded-pill` (toggles, píldoras, avatares) |
| `--shadow-raised` | pequeña, cercana | `shadow-raised` (tarjetas que se elevan al pasar el cursor) |
| `--shadow-overlay` | media | `shadow-overlay` (popovers, menús, toasts) |
| `--shadow-modal` | grande | `shadow-modal` (diálogos, studios) |

Las sombras son más oscuras en el tema oscuro para seguir siendo visibles sobre
superficies casi negras.

## Escala de z-index

Una escala ordenada. La columna de la derecha asigna los valores arbitrarios de hoy al
token que un componente debe adoptar la próxima vez que se edite.

| Token | Valor | Capa | Reemplaza hoy |
|---|---|---|---|
| `--z-raised` | 10 | Celdas fijas, hermanos superpuestos | `z-10`, `z-[1]` |
| `--z-sticky` | 20 | Encabezados fijos dentro de un panel | `z-20` |
| `--z-drawer` | 30 | Barra lateral, cajón móvil | `z-30` |
| `--z-dropdown` | 40 | Encabezado de la app y sus popovers | `z-40` |
| `--z-modal` | 50 | Configuración y diálogos a nivel de app | `z-50` |
| `--z-modal-nested` | 60 | Diálogos abiertos desde dentro de un modal (diálogos de Skills) | `z-[60]` |
| `--z-studio` | 70 | Studios a pantalla completa | `z-[70]`, `z-[80]` (Documento, Hoja de cálculo) |
| `--z-editor` | 90 | Editores a pantalla completa sobre modales y studios (inspector de plantilla) | `z-[90]` |
| `--z-popover` | 100 | Menús dentro de un studio | `z-[75]`/`z-[80]` (menú de exportación), `z-[130]` (menú contextual) |
| `--z-fullscreen` | 120 | Modo de presentación | `z-[120]` |
| `--z-dialog` | 140 | Confirmaciones | `z-[140]` |
| `--z-toast` | 200 | Notificaciones | `z-[60]` (toasts, que hoy quedan bajo los studios) |

No se permiten valores arbitrarios (`z-[75]`): añade un paso a `tokens.css` y a
`tailwind.config.js`. La prueba de guarda falla ante cualquier `z-[…]`.

## Anillo de foco y áreas táctiles

- **Anillo de foco.** El foco de teclado se dibuja una sola vez, con la regla global
  `:focus-visible`. Un control escrito con `outline-none` debe llevar un anillo,
  contorno, borde o sombra `focus-visible:` en la misma línea de clases, o quitar el
  `outline-none` (el anillo global ya se aplica). Una utilidad que quita u oculta el
  indicador (`focus-visible:outline-none`, `outline-0`, `ring-0`, `shadow-none`, o
  cualquier color `…-transparent` / `/0`) no es un reemplazo, y además cancela una
  utilidad positiva del mismo tipo en la línea (`focus-visible:outline-2
  focus-visible:outline-transparent` no dibuja nada). El marcador de importancia
  (`!`) se ignora al clasificar, así que `focus-visible:!outline-transparent` cancela
  igual. `outline-offset-*` por sí solo no dibuja nada. Comprueba el foco de teclado
  en el navegador, no solo el texto de las clases. Quien usa el mouse sigue sin ver
  anillo en los botones, porque `:focus-visible` no coincide con sus clics.
- **Áreas táctiles.** Todo botón, enlace y campo mide al menos 24 × 24 px (WCAG 2.2
  AA 2.5.8). Los controles de encabezado y de barras de herramientas miden al menos
  44 px de alto con 390 px de ancho: usa `min-h-11 min-w-11` (o `max-md:min-h-11`) y
  agranda las filas densas de escritorio solo en pantallas pequeñas para que las
  tablas conserven su ritmo.

## Valores sueltos

Props de estilo, literales hex y `rgb()`, clases de paleta crudas (`bg-white`) y
tamaños arbitrarios (`w-[380px]`) eluden los tokens. Usa primero un token o una
utilidad estándar (`bg-scrim` para el fondo de los diálogos, `text-on-accent`). Solo
los datos pueden quedarse: muestras de color del design system, rellenos derivados del
DS, el arte del logo, tamaños medidos en tiempo de ejecución. Márcalo con `/* data */`
en la misma línea o en la anterior, o envuelve un bloque en
`/* data:start */ … /* data:end */`. La prueba de guarda permite como máximo 60
valores sin marca.

## Movimiento

| Token | Valor | Uso |
|---|---|---|
| `--duration-fast` | 150 ms | Hover, presionar, cambios de color (`duration-fast`) |
| `--duration-base` | 200 ms | Paneles, cajones, popovers (`duration-base`) |
| `--duration-slow` | 300 ms | Entradas a nivel de página (`duration-slow`) |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | La mayoría de las transiciones (`ease-standard`) |
| `--ease-emphasized` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entradas (`ease-emphasized`) |

Cuando el SO pide movimiento reducido (`prefers-reduced-motion: reduce`), `index.css`
establece `animation: none` y `transition: none` (con `!important`) en todo elemento y
pseudoelemento, además de `scroll-behavior: auto`. Fundidos, deslizamientos, shimmer,
pulso, bounce, spinners y el cursor de streaming se detienen. El cursor sigue visible,
y las animaciones de entrada no dejan contenido oculto. `animationend` y
`transitionend` **no** se disparan en este modo, así que nunca hagas que el estado de
la UI dependa de ellos; hoy nada en el cliente depende.

## Reglas globales en `client/src/index.css`

Los cambios aquí y en `tokens.css` llegan a los usuarios mediante el `client/dist`
compilado, que se reconstruye en los PR de release, no en los de feature. Para ver un
cambio en local, usa `npm run dev:local` (Vite compila al vuelo).

- `@import './styles/tokens.css'` es la primera sentencia.
- `:focus-visible` dibuja `2px solid var(--focus-ring)` con 2px de desplazamiento. La
  regla no está en una capa (layer) y va después de `@tailwind utilities`, así que, con
  la misma especificidad, gana a `outline-none` (todo control que aún lo tiene). Una
  utilidad `focus-visible:` sigue sobrescribiéndola.
- `prefers-reduced-motion: reduce` desactiva el movimiento, como se describió arriba.
- **Puentes de tokens:** el marcado escrito como `bg-[var(--accent)] text-white`
  recibe `--accent-strong` como fondo. El marcado escrito como
  `bg-[var(--accent-soft)] text-[var(--accent)]` recibe `--accent-text` como color.
  Estos dos selectores hacen que los botones y pestañas activas existentes cumplan AA
  sin editar componentes. Elimina cada puente cuando ningún componente use ya su par
  de clases.

## Tinta sobre un color del design system

Las diapositivas de los decks, los encabezados de sección de las hojas de cálculo y
las vistas previas de plantillas colorean el texto que va sobre un color del design
system (primario, de acento, de fondo, una banda de sección) con `contrastOn` en
`shared/deckTheme.ts`. Compara la razón de contraste WCAG 2.x del blanco (`#FFFFFF`) y
del casi negro (`#1A1A1A`) sobre ese color y devuelve la mayor; un empate exacto
devuelve el casi negro. No usa un umbral de luminancia, así que un color de marca de
tono medio recibe la tinta que mejor se lee, en lugar de blanco a 3,6:1. Cuando
cualquiera de las dos tintas llega a 4,5:1, la elegida también llega.
`relativeLuminance` y `contrastRatio` se exportan junto a ella. Ningún color del tema
cambia: solo la tinta elegida encima. La elección del lockup del logo
(`pickLogoForBg`) sigue usando a propósito la división gruesa claro/oscuro.

## Obsoleto

- El `lava` de Tailwind es un alias obsoleto: resuelve a `var(--accent)`, así que el
  antiguo `#FF3621` fijo desaparece y el color sigue el tema. Solo permanece en los
  tres puntos de degradado de `VoiceOverlay.tsx` (`from-lava`, `to-lava`), porque los
  archivos de componentes estaban fuera del alcance del cambio de tokens. Se eliminará
  en la tarea de la Wave 2 que migra `VoiceOverlay.tsx` a `from-accent` / `to-accent`;
  no añadas usos nuevos.
- La paleta `ink.*` y `lava.600`/`lava.700` se eliminaron: no tenían usos.
