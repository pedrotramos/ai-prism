// The colour of a project's dot in the sidebar and pickers. Derived from the
// project id (never stored), from 8 tokens in styles/tokens.css, so a project
// keeps its colour in every browser and for every member.
export const PROJECT_COLOR_COUNT = 8

export type ProjectColor = `var(--project-${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7})`

export function projectColor(id: number): ProjectColor {
  const n = Math.trunc(Number(id))
  const slot = Number.isFinite(n) ? ((n % PROJECT_COLOR_COUNT) + PROJECT_COLOR_COUNT) % PROJECT_COLOR_COUNT : 0
  return `var(--project-${slot})` as ProjectColor
}

// Full class names, written out so Tailwind sees them (a built-up `bg-[var(--project-${n})]` would not be generated).
const DOT_CLASSES = [
  'bg-[var(--project-0)]',
  'bg-[var(--project-1)]',
  'bg-[var(--project-2)]',
  'bg-[var(--project-3)]',
  'bg-[var(--project-4)]',
  'bg-[var(--project-5)]',
  'bg-[var(--project-6)]',
  'bg-[var(--project-7)]',
] as const

/** The background class of a project's dot: the same slot as projectColor(id), without an inline style. */
export function projectDotClass(id: number): (typeof DOT_CLASSES)[number] {
  return DOT_CLASSES[Number(projectColor(id).slice(-2, -1))]!
}
