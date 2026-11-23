# UI design tokens

**English** · [Português (Brasil)](pt-BR/ui-tokens.md) · [Español](es/ui-tokens.md)

The client has one token layer: [`client/src/styles/tokens.css`](../client/src/styles/tokens.css).
Every colour, type size, spacing step, radius, shadow, z-index layer and motion
duration the UI needs is a CSS custom property there, defined for the light and
dark themes. The default is the system theme: `:root` holds the light values,
`@media (prefers-color-scheme: dark)` repeats the dark ones until the theme hook
sets `data-theme`, and the hook's default setting is `system`. [`tailwind.config.js`](../tailwind.config.js) maps
each one to a Tailwind key, so `text-faint`, `bg-accent-strong`, `rounded-card`,
`z-modal`, `bg-raised` and `duration-fast` resolve to the same variables and switch with the
theme.

Why this matters in practice:

- **Accessibility is fixed once.** Contrast lives in the token values, so a
  component that uses `--faint` or `--accent-strong` passes WCAG AA without its
  own colour code. Before this layer, axe found 126 to 130 `color-contrast`
  failures (the count depends on the seeded data) across 16 runs: the four key
  screens (welcome, chat, Settings, Deck Studio) in both themes at 1440 px and
  390 px. With the layer, the same runs report 0.
- **A theme change touches one file.** Light and dark differ only in
  `tokens.css`. No component needs a `dark:` variant for colour.
- **Regressions fail a test, not a review.**
  [`client/src/styles/tokens.test.js`](../client/src/styles/tokens.test.js)
  recomputes every ratio below from the token values on each `node --test` run.
  [`client/src/styles/tokens.browser.test.js`](../client/src/styles/tokens.browser.test.js)
  compiles the stylesheet from source with the project's Vite config (in
  memory) and loads it in headless Chrome. It checks
  the computed focus ring on `outline-none` controls, reduced motion and the
  token bridges in both themes. It needs:
  - Node >= 22, for the built-in `WebSocket` that drives Chrome over the
    DevTools protocol;
  - the repository's existing devDependencies: `vite`, plus the `tailwindcss`,
    `postcss` and `autoprefixer` pipeline it loads through `postcss.config.js`
    (installed by `npm ci --include=dev`);
  - a Chrome or Chromium binary, found through `CHROME_PATH`, the Playwright
    browser cache or the usual install paths.

  It needs no browser-automation package (no Playwright or Puppeteer) and adds
  no dependency. Without a browser binary, it skips and prints why.

## How to use them

| Write this | Not this | Why |
|---|---|---|
| `text-faint` or `text-[var(--faint)]` | `text-gray-500`, `text-[#6b7480]` | Follows the theme and keeps AA contrast. |
| `bg-action text-on-action` for the primary button, send and toast | `bg-accent` for a primary button | Primary actions are ink on surface. The accent marks selection, toggles, links and focus. |
| `bg-accent-strong text-on-accent` for a filled accent control | `bg-[var(--accent)] text-white` | White on the dark `--accent` is below 4.5:1. |
| `text-accent-text` for accent-coloured small text | `text-[var(--accent)]` on text | `--accent` is for icons, strokes and large marks. |
| `text-danger`, `bg-danger-soft` for errors | the brand accent, `text-red-400` | Errors and primary actions must not share one colour. |
| `bg-disabled text-disabled-text` | `disabled:opacity-50` on a filled button | A half-transparent accent reads as a soft enabled button. |
| `text-caption`, `text-label`, `text-body` … | `text-[11px]`, `text-[10.5px]` | Seven sizes, none under 12 px. |
| `gap-in-group` inside a group, `gap-between-groups` between groups | half steps such as `gap-1.5` or `gap-2.5` chosen ad hoc | Proximity: related things sit close, groups sit apart. |
| `rounded-card`, `rounded-control`, `rounded-badge`, `rounded-pill` | `rounded-xl` on one card, `rounded-2xl` on the next | Similar things look similar. |
| `z-modal`, `z-popover`, `z-toast` | `z-[75]`, `z-[130]` | One ordered scale. No more guessing a number that wins. |
| `duration-fast`, `duration-base`, `duration-slow` | bare `transition` with no duration | Motion has three speeds, and all of them stop under reduced motion. |

Focus: every focusable element gets the global ring
`outline: 2px solid var(--focus-ring); outline-offset: 2px` on `:focus-visible`,
including elements written with `outline-none`. To draw a different indicator,
use `focus-visible:` utilities (for example `focus-visible:outline-offset-0` or
`focus-visible:ring-2`); they have higher specificity than the global rule.
Never use `focus-visible:outline-none` (or `outline-0`, `ring-0`,
`shadow-none`, `…-transparent`) without an equally visible `focus-visible:`
ring, outline, border or shadow on the same line that nothing else on the
line cancels; `a11yBudget.test.js` rejects it.

## Colour tokens

Light is the base; dark is `:root[data-theme='dark']`. Roles keep their names;
the mockup's names are in the last column.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#eceef1` | `#121519` | App and sidebar background |
| `--surface` (Tailwind `surface`, `surface-1`) | `#fafafb` | `#181c21` | Chat area |
| `--raised` (Tailwind `raised`) | `#ffffff` | `#1f242a` | Cards, composer, popovers |
| `--surface-2` (Tailwind `sunk`, `surface-2`) | `#f2f3f5` | `#15191d` | Sunk wells, chips, hovered rows |
| `--surface-3` | `#e8ebef` | `#242930` | Highest surface, inputs |
| `--border` / `--border-soft` | `#dadee4` / `#e8ebef` | `#2d333c` / `#242930` | Lines and dividers (`--line` / `--line-2`) |
| `--text` (Tailwind `fg`) | `#1d2229` | `#e6e9ed` | Body text (`--ink`) |
| `--muted` | `#4b5360` | `#aeb5c0` | Secondary text (`--ink-2`) |
| `--faint` | `#616975` | `#8d95a2` | Tertiary text: meta, group labels (`--ink-3`) |
| `--accent` | `#3d4fd6` | `#8c98ff` | Indigo: selection, toggles, focus, icons, strokes |
| `--accent-strong` | `#3442b8` | `#4553d6` | Filled accent control background |
| `--accent-soft` | `#e8eafb` | `#262b4d` | Selected row or tab fill |
| `--accent-text` | `#3442b8` | `#aab3ff` | Accent-coloured small text, also on `--accent-soft` |
| `--on-accent` | `#ffffff` | `#ffffff` | Label on `--accent-strong` |
| `--action` / `--on-action` | `--text` / `--surface` | `--text` / `--surface` | Primary buttons, send, toast: ink on surface |
| `--bubble-user` | `--surface-2` | `--surface-2` | User message bubble |
| `--link` | `--accent-text` | `--accent-text` | Links in rendered markdown |
| `--danger` | `#b83d37` | `#ee7b73` | Errors, destructive actions (`--bad`) |
| `--success` / `--success-soft` | `#197650` / `#e3f3ea` | `#5cc08e` / `#17342a` | Completed, healthy (`--good`) |
| `--warning` / `--warning-soft` | `#8f5a0c` / `#fbf1de` | `#e2a94b` / `#352914` | Needs attention (`--warn`) |
| `--info` | `#2a5fa8` | `#7db0f0` | Neutral information |
| `--chart-1` … `--chart-5` | `#3d4fd6` `#b8650f` `#1a7f6d` `#a82f85` `#5a6270` | `#8c98ff` `#e8a13b` `#4fc3a8` `#e07bc6` `#9aa3b0` | Categorical series in app-chrome charts: 3:1 on `--surface-2`, every pair 7 CIELAB dE apart under protan, deutan and tritan |
| `--chart-neg` | `#c8524b` | `#e07a71` | Negative values in app-chrome charts only (`--neg`) |
| `--code-bg` (Tailwind `code`) | `#f3f4f7` | `#14171b` | Code blocks |
| `--spectrum` / `--spectrum-conic` | gradient | same | Indigo, teal, green, amber, coral. AI activity and the logo only |
| `--disabled-bg` / `--disabled-text` | `--surface-3` / `--faint` | same | Disabled controls |
| `--focus-ring` | `--accent` | `--accent` | Keyboard focus outline |

Three values differ from the mockup because the mockup fails WCAG AA: `--faint`
(`#7A828F` light, `#7F8794` dark), `--warning` on its soft fill (`#A86B12`), and
`--success` on the page background (`#1F8457`). `--faint` in light is one notch
darker than the design note's `#646C78`, which is 4.44:1 on `--surface-3`.

The `*-soft` variants of danger and info are the base colour at 10% (light) or
14% (dark) over transparent. Use them as badge or banner fills, with the base
colour as text.

## Artifacts do not use these tokens

The app chrome has its own look. Slides, documents, spreadsheets, design-system
previews and template cards follow the design system the workspace uploads,
through `HtmlSlideFrame`, `TemplateSlidePreview` and `lib/themePreview.ts`.
[`dsIsolation.test.ts`](../client/src/styles/dsIsolation.test.ts) fails if any
file under `components/deck/` (except the editor's side panel), `HtmlDeckPreview`,
`TemplateSlidePreview` or `themePreview` reads an app-only token or names an IBM
Plex family.

## Fonts

IBM Plex Sans, Serif and Mono, bundled with the app: `index.css` imports the
Latin subset (covers English, Portuguese and Spanish) from the `@fontsource`
packages and Vite emits the files into `client/dist/assets`. There is no request
to a font host, so the CSP needs no allowance for one. Tailwind: `font-sans`,
`font-serif`, `font-mono`. Use `.num` for tabular figures.

## Contrast matrix

WCAG 2.x contrast ratio of each foreground token on each surface of the same
theme. Text needs 4.5:1. A focus indicator needs 3:1. The minimum in every row
is at or above its floor, and `tokens.test.js` recomputes them.

**Light**

| Token | Value | `--bg` | `--surface` | `--surface-2` | `--surface-3` | `--raised` | Floor |
|---|---|---|---|---|---|---|---|
| `--text` | `#1d2229` | 13.76 | 15.33 | 14.40 | 13.37 | 15.99 | 4.5:1 |
| `--muted` | `#4b5360` | 6.68 | 7.44 | 6.99 | 6.49 | 7.76 | 4.5:1 |
| `--faint` | `#616975` | 4.77 | 5.32 | 5.00 | 4.64 | 5.55 | 4.5:1 |
| `--accent-text` | `#3442b8` | 6.90 | 7.69 | 7.23 | 6.71 | 8.02 | 4.5:1 |
| `--link` | `#3442b8` | 6.90 | 7.69 | 7.23 | 6.71 | 8.02 | 4.5:1 |
| `--danger` | `#b83d37` | 4.80 | 5.35 | 5.03 | 4.67 | 5.58 | 4.5:1 |
| `--success` | `#197650` | 4.82 | 5.37 | 5.05 | 4.68 | 5.60 | 4.5:1 |
| `--warning` | `#8f5a0c` | 4.97 | 5.54 | 5.20 | 4.83 | 5.78 | 4.5:1 |
| `--info` | `#2a5fa8` | 5.47 | 6.10 | 5.73 | 5.32 | 6.36 | 4.5:1 |
| `--focus-ring` | `#3d4fd6` | 5.49 | 6.12 | 5.75 | 5.34 | 6.39 | 3:1 |
| `--accent-text` on `--accent-soft` | | 6.72 | | | | | 4.5:1 |

`--on-accent` on `--accent-strong` (`#3442b8`): **8.02:1**

**Dark**

| Token | Value | `--bg` | `--surface` | `--surface-2` | `--surface-3` | `--raised` | Floor |
|---|---|---|---|---|---|---|---|
| `--text` | `#e6e9ed` | 15.03 | 14.05 | 14.51 | 12.02 | 12.83 | 4.5:1 |
| `--muted` | `#aeb5c0` | 8.87 | 8.29 | 8.56 | 7.09 | 7.57 | 4.5:1 |
| `--faint` | `#8d95a2` | 6.06 | 5.67 | 5.85 | 4.85 | 5.17 | 4.5:1 |
| `--accent-text` | `#aab3ff` | 9.24 | 8.64 | 8.92 | 7.39 | 7.89 | 4.5:1 |
| `--link` | `#aab3ff` | 9.24 | 8.64 | 8.92 | 7.39 | 7.89 | 4.5:1 |
| `--danger` | `#ee7b73` | 6.73 | 6.29 | 6.49 | 5.38 | 5.74 | 4.5:1 |
| `--success` | `#5cc08e` | 8.18 | 7.65 | 7.90 | 6.54 | 6.98 | 4.5:1 |
| `--warning` | `#e2a94b` | 8.73 | 8.16 | 8.42 | 6.98 | 7.45 | 4.5:1 |
| `--info` | `#7db0f0` | 8.14 | 7.61 | 7.86 | 6.51 | 6.95 | 4.5:1 |
| `--focus-ring` | `#8c98ff` | 7.02 | 6.56 | 6.77 | 5.61 | 5.99 | 3:1 |
| `--accent-text` on `--accent-soft` | | 6.91 | | | | | 4.5:1 |

`--on-accent` on `--accent-strong` (`#4553d6`): **6.07:1**


`--accent-text` on `--accent-soft`: 6.72:1 (light), 6.91:1 (dark). `--faint` on
`--accent-soft`: 4.65:1 (light), 4.53:1 (dark). `--warning` on `--warning-soft`:
5.15:1 (light). `--action` on `--on-action` is `--text` on `--surface`: 15.33:1
(light), 14.05:1 (dark).

## Type scale

| Tailwind | Size / line height | Use |
|---|---|---|
| `text-caption` | 12 / 16 px | Meta, timestamps, help text |
| `text-label` | 13.5 / 20 px | Nav items, buttons, chips, menus |
| `text-body` | 14 / 21 px | Chrome text, tables |
| `text-reading` | 15.5 / 26 px | Answers and the document page (user bubble and composer: 15/23) |
| `text-title` | 16 / 22 px | Panel and modal titles |
| `text-heading` | 22 / 28 px | Page titles |
| `text-display` | 30 / 36 px | Home greeting (24/30 at 760 px and below) |

Nothing is smaller than 12 px. Document prose (`.prose-doc`) keeps its own
sizes.

Rules: write only these seven classes. Do not use `text-xs`, `text-sm`,
`text-base`, `text-lg`, `text-xl`, `text-2xl` or `text-[Npx]`. Mapping when you
migrate: `xs` → `label`, `sm` → `body`, `base`/`lg` → `title`, `xl`/`2xl` →
`heading`, `[9px]`…`[11px]` → `caption`, `[15px]`/`[0.95rem]` → `reading`.
`client/src/a11yBudget.test.js` fails above 6 distinct legacy size classes.

## Spacing, radius, shadow

| Token | Value | Tailwind |
|---|---|---|
| `--space-1` … `--space-8` | 4, 8, 12, 16, 24, 32 px | Tailwind's default steps `1 2 3 4 6 8` already match |
| `--space-in-group` | 8 px | `gap-in-group`, `p-in-group` |
| `--space-between-groups` | 24 px | `gap-between-groups`, `mt-between-groups` |
| `--space-section` | 32 px | `gap-section`, `py-section` |
| `--radius-card` | 12 px | `rounded-card` (cards, popovers) |
| `--radius-panel` | 14 px | `rounded-panel` (blocks, artifact card) |
| `--radius-modal` | 16 px | `rounded-modal` (modal, user bubble) |
| `--radius-composer` | 18 px | `rounded-composer` |
| `--radius-control` | 8 px | `rounded-control` (buttons, inputs) |
| `--radius-badge` | 6 px | `rounded-badge` (badges, small chips) |
| `--radius-pill` | 999 px | `rounded-pill` (toggles, pills, avatars) |
| `--shadow-raised` | small, close | `shadow-raised` (cards that lift on hover) |
| `--shadow-overlay` | medium (the mockup's `--shadow`: composer, popovers, the slide) | `shadow-overlay` (popovers, menus, toasts) |
| `--shadow-modal` | large | `shadow-modal` (dialogs, studios) |

Shadows are darker in the dark theme so they stay visible on near-black surfaces.

Breakpoints are tokens for documentation (`--bp-overlay` 1100 px, `--bp-mobile`
760 px), since CSS cannot read a variable in `@media`. Tailwind's `ov:` variant
applies from 1101 px up.

## Z-index scale

One ordered scale. The right column maps today's arbitrary values to the token
a component should adopt when it is next edited.

| Token | Value | Layer | Replaces today |
|---|---|---|---|
| `--z-raised` | 10 | Sticky cells, overlapping siblings | `z-10`, `z-[1]` |
| `--z-sticky` | 20 | Sticky headers inside a pane | `z-20` |
| `--z-drawer` | 30 | Sidebar, mobile drawer | `z-30` |
| `--z-dropdown` | 40 | App header and its popovers | `z-40` |
| `--z-modal` | 50 | Settings and app-level dialogs | `z-50` |
| `--z-modal-nested` | 60 | Dialogs opened from inside a modal (Skills dialogs) | `z-[60]` |
| `--z-studio` | 70 | Full-screen studios | `z-[70]`, `z-[80]` (Document, Spreadsheet) |
| `--z-editor` | 90 | Full-screen editors over modals and studios (template inspector) | `z-[90]` |
| `--z-popover` | 100 | Menus inside a studio | `z-[75]`/`z-[80]` (export menu), `z-[130]` (context menu) |
| `--z-fullscreen` | 120 | Presentation mode | `z-[120]` |
| `--z-dialog` | 140 | Confirmations | `z-[140]` |
| `--z-toast` | 200 | Notifications | `z-[60]` (toasts, which today sit under the studios) |

Arbitrary values (`z-[75]`) are not allowed: add a step to `tokens.css` and
`tailwind.config.js` instead. The guard test fails on any `z-[…]`.

## Focus ring and touch targets

- **Focus ring.** Keyboard focus is drawn once, by the global
  `:focus-visible` rule. A control written with `outline-none` must carry a
  `focus-visible:` ring, outline, border or shadow on the same class line,
  or drop `outline-none` (the global ring already applies). A utility that
  removes or hides the indicator (`focus-visible:outline-none`, `outline-0`,
  `ring-0`, `shadow-none`, or any `…-transparent` / `/0` colour) is not a
  replacement, and it also cancels a positive utility of the same kind on the
  line (`focus-visible:outline-2 focus-visible:outline-transparent` draws
  nothing). The important marker is ignored when classifying, so
  `focus-visible:!outline-transparent` cancels the same way. `outline-offset-*`
  alone draws nothing. Check keyboard focus in the browser, not only the class text. Mouse users still see no ring on
  buttons, because `:focus-visible` does not match their clicks.
- **Touch targets.** Every button, link and input is at least 24 × 24 px
  (WCAG 2.2 AA 2.5.8). Header and toolbar controls are at least 44 px high
  at 390 px wide: use `min-h-11 min-w-11` (or `max-md:min-h-11`) and grow
  dense desktop rows only on small screens so tables keep their rhythm.

## One-off values

Style props, hex and `rgb()` literals, raw palette classes (`bg-white`) and
arbitrary sizes (`w-[380px]`) bypass the tokens. Use a token or a standard
utility first (`bg-scrim` for dialog backdrops, `text-on-accent`). Only data
may stay: design-system swatches, DS-derived fills, the logo artwork, sizes
measured at runtime. Tag it with `/* data */` on the same or the previous
line, or wrap a block in `/* data:start */ … /* data:end */`. The guard test
allows at most 60 untagged values.

## Motion

| Token | Value | Use |
|---|---|---|
| `--duration-fast` | 140 ms | Hover, press, colour changes (`duration-fast`) |
| `--duration-base` | 200 ms | Panels, drawers, popovers (`duration-base`) |
| `--duration-slow` | 320 ms | Page-level entrances (`duration-slow`) |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Most transitions (`ease-standard`) |
| `--ease-emphasized` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | Entrances (`ease-emphasized`) |

When the OS asks for reduced motion (`prefers-reduced-motion: reduce`),
`index.css` sets `animation: none` and `transition: none` (with `!important`)
on every element and pseudo-element, plus `scroll-behavior: auto`. Fades,
slides, shimmer, pulse, bounce, spinners and the stream cursor all stop. The
cursor stays visible, and entrance animations do not leave content hidden.
`animationend` and `transitionend` do **not** fire in this mode, so never make
UI state depend on them; nothing in the client does today.

## Global rules in `client/src/index.css`

Changes here and in `tokens.css` reach users through the built `client/dist`,
which is rebuilt in release PRs, not in feature PRs. To see a change locally,
use `npm run dev:local` (Vite compiles on the fly).

- `@import './styles/tokens.css'` is the first statement.
- `:focus-visible` draws `2px solid var(--focus-ring)` with a 2px offset. The
  rule is unlayered and comes after `@tailwind utilities`, so at equal
  specificity it beats `outline-none` (every control that still has it). A `focus-visible:`
  utility still overrides it.
- `prefers-reduced-motion: reduce` turns motion off, as described above.
- **Token bridges:** markup written as `bg-[var(--accent)] text-white` gets
  `--accent-strong` as its background. Markup written as `bg-[var(--accent-soft)]
  text-[var(--accent)]` gets `--accent-text` as its colour. These two
  selectors make the existing buttons and active tabs pass AA without editing
  components. Delete each bridge once no component uses its class pair.

## Ink on a design-system colour

Deck slides, spreadsheet section headers and the template previews colour text
that sits on a design-system colour (primary, accent, background, a section
band) with `contrastOn` in `shared/deckTheme.ts`. It compares the WCAG 2.x
contrast ratio of white (`#FFFFFF`) and near-black (`#1A1A1A`) on that colour
and returns the higher one; an exact tie returns the near-black. It does not use
a luminance threshold, so a mid-tone brand colour gets the ink that reads best
instead of white at 3.6:1. When either ink reaches 4.5:1, the chosen one does.
`relativeLuminance` and `contrastRatio` are exported next to it. No theme colour
changes: only the ink picked on top of it. The logo lockup choice
(`pickLogoForBg`) still uses the coarse light/dark split on purpose.

## Deprecated

- Tailwind `lava` is a deprecated alias: it resolves to `var(--accent)`, so the
  old fixed `#FF3621` is gone and the colour follows the theme. It stays only
  for the three gradient stops in `VoiceOverlay.tsx` (`from-lava`, `to-lava`),
  because component files were out of scope for the token change. It is removed
  in the Wave 2 task that migrates `VoiceOverlay.tsx` to `from-accent` /
  `to-accent`; do not add new uses.
- The `ink.*` palette and `lava.600`/`lava.700` are removed: they had no uses.
