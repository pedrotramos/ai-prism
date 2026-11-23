// Local stand-in for lib/projectColor.ts (owned by W1-1). The dot colour of a project comes from its id, client-side,
// out of the chart tokens, so it follows the theme (Q10-A). W2-4 reconciles this with the shared helper and deletes it.
export const PROJECT_COLOR_VARS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'] as const

export function projectColorVar(id: string | number | null | undefined): string {
  const s = String(id ?? '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0
  return PROJECT_COLOR_VARS[h % PROJECT_COLOR_VARS.length] as string
}

// Literal class names so Tailwind generates them (a class built from the var name would not exist in the CSS).
export const PROJECT_COLOR_CLASSES = ['bg-[var(--chart-1)]', 'bg-[var(--chart-2)]', 'bg-[var(--chart-3)]', 'bg-[var(--chart-4)]', 'bg-[var(--chart-5)]'] as const

export function projectColorClass(id: string | number | null | undefined): string {
  return PROJECT_COLOR_CLASSES[PROJECT_COLOR_VARS.indexOf(projectColorVar(id) as (typeof PROJECT_COLOR_VARS)[number])] as string
}
