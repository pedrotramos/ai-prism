// Type of the translator returned by `useT()` (lib/i18n.jsx). That module is
// still JavaScript, so tsc infers `t` as `(key) => …`; components that pass
// interpolation vars annotate `const t: TFn = useT()`. Drop this file when
// i18n.jsx is converted and exports the real type.
export type TFn = (key: string, vars?: Record<string, unknown>) => string
