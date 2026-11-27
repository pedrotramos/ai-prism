// Re-export shim: the source is ./urlEgressPolicy.ts (docs/adr/0006-typescript.md). Importers keep
// the .js specifier; Node 22.18+ strips the types, esbuild and Vite compile them.
export * from './urlEgressPolicy.ts'
