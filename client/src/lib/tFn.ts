// The translator `t` that `useT()` returns (lib/i18n.tsx). i18n is typed now, so
// this is only an alias kept for the components that annotate
// `const t: TFn = useT()`; `vars` accepts `Record<string, unknown>` like the runtime
// (`String(vars[k])`).
import type { useT } from './i18n.tsx'

export type TFn = ReturnType<typeof useT>
