# UI design tokens

The client has one token layer: [`client/src/styles/tokens.css`](../client/src/styles/tokens.css).
Every colour, type size, spacing step, radius, shadow, z-index layer and motion
duration the UI needs is a CSS custom property there, defined for the dark
(default) and light themes. [`tailwind.config.js`](../tailwind.config.js) maps
each one to a Tailwind key, so `text-faint`, `bg-accent-strong`, `rounded-card`,
`z-modal` and `duration-fast` resolve to the same variables and switch with the
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
| `bg-accent-strong text-on-accent` for a filled button | `bg-[var(--accent)] text-white` | White on `--accent` is 3.6:1 (dark) and 4.3:1 (light). |
| `text-accent-text` for accent-coloured small text | `text-[var(--accent)]` on text | `--accent` is for icons, strokes and large marks. |
| `text-danger`, `bg-danger-soft` for errors | the brand accent, `text-red-400` | Errors and primary actions must not share one colour. |
| `bg-disabled text-disabled-text` | `disabled:opacity-50` on a filled button | A half-transparent accent reads as a soft enabled button. |
| `text-caption`, `text-label`, `text-body` … | `text-[11px]`, `text-[10.5px]` | Six sizes instead of 17 makes the hierarchy readable. |
| `gap-in-group` inside a group, `gap-between-groups` between groups | half steps such as `gap-1.5` or `gap-2.5` chosen ad hoc | Proximity: related things sit close, groups sit apart. |
| `rounded-card`, `rounded-control`, `rounded-badge`, `rounded-pill` | `rounded-xl` on one card, `rounded-2xl` on the next | Similar things look similar. |
| `z-modal`, `z-popover`, `z-toast` | `z-[75]`, `z-[130]` | One ordered scale. No more guessing a number that wins. |
| `duration-fast`, `duration-base`, `duration-slow` | bare `transition` with no duration | Motion has three speeds, and all of them stop under reduced motion. |

Focus: every focusable element gets the global ring
`outline: 2px solid var(--focus-ring); outline-offset: 2px` on `:focus-visible`,
including elements written with `outline-none`. To draw a different indicator,
use `focus-visible:` utilities (for example `focus-visible:outline-offset-0` or
`focus-visible:ring-2`); they have higher specificity than the global rule.
Never use `focus-visible:outline-none` without an equally visible replacement.

## Colour tokens

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0b0d0f` | `#f7f8fa` | Page background |
| `--surface` (Tailwind `surface`, `surface-1`) | `#111418` | `#ffffff` | Panels, cards, sidebar |
| `--surface-2` | `#161a1f` | `#f1f3f5` | Raised or hovered surface |
| `--surface-3` | `#1c2127` | `#e9edf1` | Highest surface, chips, inputs |
| `--border` / `--border-soft` | `#272d35` / `#1e242b` | `#e2e6ea` / `#eef1f4` | Lines and dividers |
| `--text` (Tailwind `fg`) | `#e8eaed` | `#1a1f24` | Body text |
| `--muted` | `#98a2b3` | `#5c6670` | Secondary text |
| `--faint` | `#858e9a` | `#626b75` | Tertiary text: meta, group labels, durations |
| `--accent` | `#ff3621` | `#e5341f` | Brand: icons, strokes, selection marks |
| `--accent-strong` | `#cc2c18` | `#c42a17` | Filled CTA background |
| `--accent-soft` | `rgba(255,54,33,.12)` | `rgba(229,52,31,.1)` | Selected row or tab fill |
| `--accent-text` | `#ff5a46` | `#b8281a` | Accent-coloured small text, also on `--accent-soft` |
| `--on-accent` | `#ffffff` | `#ffffff` | Label on `--accent-strong` |
| `--bubble-user` | `#1e2630` | `#eef2f6` | User message bubble |
| `--link` | `#5b9dff` | `#1d64d8` | Links in rendered markdown |
| `--danger` / `--danger-soft` | `#f2555a` | `#c62a2f` | Errors, destructive actions |
| `--success` / `--success-soft` | `#3dd68c` | `#18794e` | Completed, healthy |
| `--warning` / `--warning-soft` | `#f5a524` | `#9a5b00` | Needs attention |
| `--info` / `--info-soft` | `#6ea8ff` | `#1d64d8` | Neutral information |
| `--disabled-bg` / `--disabled-text` | `--surface-3` / `--faint` | `--surface-3` / `--faint` | Disabled controls |
| `--focus-ring` | `#6ea8ff` | `#1d64d8` | Keyboard focus outline |

The `*-soft` variants are the base colour at 14% (dark) or 10% (light) over
transparent. Use them as badge or banner fills, with the base colour as text.

## Contrast matrix

WCAG 2.x contrast ratio of each foreground token on each surface of the same
theme. Text needs 4.5:1. A focus indicator needs 3:1. The minimum in every row
is at or above its floor.

**Dark**

| Token | Value | `--bg` | `--surface` | `--surface-2` | `--surface-3` | Floor |
|---|---|---|---|---|---|---|
| `--text` | `#e8eaed` | 16.15 | 15.32 | 14.50 | 13.44 | 4.5:1 |
| `--muted` | `#98a2b3` | 7.56 | 7.17 | 6.79 | 6.29 | 4.5:1 |
| `--faint` | `#858e9a` | 5.87 | 5.57 | 5.27 | 4.89 | 4.5:1 |
| `--accent-text` | `#ff5a46` | 6.31 | 5.98 | 5.66 | 5.25 | 4.5:1 |
| `--accent-text` on `--accent-soft` | | 5.74 | 5.40 | 5.11 | 4.72 | 4.5:1 |
| `--link` | `#5b9dff` | 7.15 | 6.78 | 6.42 | 5.95 | 4.5:1 |
| `--danger` | `#f2555a` | 5.77 | 5.47 | 5.18 | 4.80 | 4.5:1 |
| `--success` | `#3dd68c` | 10.38 | 9.85 | 9.32 | 8.64 | 4.5:1 |
| `--warning` | `#f5a524` | 9.54 | 9.05 | 8.56 | 7.94 | 4.5:1 |
| `--info` | `#6ea8ff` | 8.07 | 7.66 | 7.25 | 6.72 | 4.5:1 |
| `--focus-ring` | `#6ea8ff` | 8.07 | 7.66 | 7.25 | 6.72 | 3:1 |
| _previous_ `--faint` | `#6b7480` | 4.11 | 3.90 | 3.69 | 3.42 | |
| _previous_ `--accent` text on `--accent-soft` | `#ff3621` | 4.90 | 4.60 | 4.36 | 4.02 | |

`--on-accent` on `--accent-strong` (`#cc2c18`): **5.33:1**, and 4.54:1 at
`hover:brightness-110`. White on `--accent` (`#ff3621`) was 3.62:1.

**Light**

| Token | Value | `--bg` | `--surface` | `--surface-2` | `--surface-3` | Floor |
|---|---|---|---|---|---|---|
| `--text` | `#1a1f24` | 15.62 | 16.60 | 14.92 | 14.11 | 4.5:1 |
| `--muted` | `#5c6670` | 5.51 | 5.85 | 5.26 | 4.97 | 4.5:1 |
| `--faint` | `#626b75` | 5.09 | 5.41 | 4.87 | 4.60 | 4.5:1 |
| `--accent-text` | `#b8281a` | 5.89 | 6.26 | 5.62 | 5.32 | 4.5:1 |
| `--accent-text` on `--accent-soft` | | 5.09 | 5.42 | 4.90 | 4.66 | 4.5:1 |
| `--link` | `#1d64d8` | 5.11 | 5.43 | 4.88 | 4.62 | 4.5:1 |
| `--danger` | `#c62a2f` | 5.24 | 5.57 | 5.00 | 4.73 | 4.5:1 |
| `--success` | `#18794e` | 5.09 | 5.41 | 4.86 | 4.60 | 4.5:1 |
| `--warning` | `#9a5b00` | 5.11 | 5.43 | 4.88 | 4.61 | 4.5:1 |
| `--info` | `#1d64d8` | 5.11 | 5.43 | 4.88 | 4.62 | 4.5:1 |
| `--focus-ring` | `#1d64d8` | 5.11 | 5.43 | 4.88 | 4.62 | 3:1 |
| _previous_ `--faint` | `#8a939c` | 2.93 | 3.12 | 2.80 | 2.65 | |
| _previous_ `--accent` text on `--accent-soft` | `#e5341f` | 3.53 | 3.76 | 3.40 | 3.23 | |

`--on-accent` on `--accent-strong` (`#c42a17`): **5.69:1**, and 4.87:1 at
`hover:brightness-110`. White on `--accent` (`#e5341f`) was 4.34:1.

In light mode, `--faint` and `--muted` are close: no lighter grey reaches 4.5:1
on `--surface-3`. Carry the tertiary level with size (`text-caption`) or weight
as well as colour.

## Type scale

| Tailwind | Size / line height | Use |
|---|---|---|
| `text-caption` | 11 / 16 px | Meta, timestamps, sidebar group labels |
| `text-label` | 12 / 16 px | Controls, chips, table cells |
| `text-body` | 14 / 20 px | Default UI text |
| `text-title` | 16 / 24 px | Card and panel titles |
| `text-heading` | 20 / 28 px | Page and modal headings |
| `text-display` | 28 / 36 px | Welcome hero |

Chat prose (`.prose-chat`, 0.95rem) and document prose (`.prose-doc`) keep their
own reading sizes.

Rules: write only these six classes. Do not use `text-xs`, `text-sm`,
`text-base`, `text-lg`, `text-xl`, `text-2xl` or `text-[Npx]`. Mapping when you
migrate: `xs` → `label`, `sm` → `body`, `base`/`lg` → `title`, `xl`/`2xl` →
`heading`, `[9px]`…`[11px]` → `caption`, `[15px]`/`[0.95rem]` → `body`. Body
text never goes below 14 px (`text-body`); 11 and 12 px are for meta and
controls only. `client/src/a11yBudget.test.js` fails above 6 distinct legacy
size classes.

## Spacing, radius, shadow

| Token | Value | Tailwind |
|---|---|---|
| `--space-1` … `--space-8` | 4, 8, 12, 16, 24, 32 px | Tailwind's default steps `1 2 3 4 6 8` already match |
| `--space-in-group` | 8 px | `gap-in-group`, `p-in-group` |
| `--space-between-groups` | 24 px | `gap-between-groups`, `mt-between-groups` |
| `--space-section` | 32 px | `gap-section`, `py-section` |
| `--radius-card` | 12 px | `rounded-card` (cards, panels, modals) |
| `--radius-control` | 8 px | `rounded-control` (buttons, inputs) |
| `--radius-badge` | 6 px | `rounded-badge` (badges, small chips) |
| `--radius-pill` | 9999 px | `rounded-pill` (toggles, pills, avatars) |
| `--shadow-raised` | small, close | `shadow-raised` (cards that lift on hover) |
| `--shadow-overlay` | medium | `shadow-overlay` (popovers, menus, toasts) |
| `--shadow-modal` | large | `shadow-modal` (dialogs, studios) |

Shadows are darker in the dark theme so they stay visible on near-black surfaces.

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
  `focus-visible:` utility on the same class line, or drop `outline-none`
  (the global ring already applies). Never `focus-visible:outline-none`
  without an equally visible replacement. Mouse users still see no ring on
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
| `--duration-fast` | 150 ms | Hover, press, colour changes (`duration-fast`) |
| `--duration-base` | 200 ms | Panels, drawers, popovers (`duration-base`) |
| `--duration-slow` | 300 ms | Page-level entrances (`duration-slow`) |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Most transitions (`ease-standard`) |
| `--ease-emphasized` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entrances (`ease-emphasized`) |

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

## Deprecated

- Tailwind `lava` is a deprecated alias: it resolves to `var(--accent)`, so the
  old fixed `#FF3621` is gone and the colour follows the theme. It stays only
  for the three gradient stops in `VoiceOverlay.jsx` (`from-lava`, `to-lava`),
  because component files were out of scope for the token change. It is removed
  in the Wave 2 task that migrates `VoiceOverlay.jsx` to `from-accent` /
  `to-accent`; do not add new uses.
- The `ink.*` palette and `lava.600`/`lava.700` are removed: they had no uses.
