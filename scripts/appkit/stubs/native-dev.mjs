// Production stand-ins for dev/codegen-only dependencies that AppKit imports statically:
//   @ast-grep/napi  (native .node addon, used by type generation and react source-loc plugin)
//   @babel/core     (dynamic import, used by @vitejs/plugin-react in dev)
//   fsevents        (native macOS watcher pulled in through the dev toolchain)
// None of them is reachable when NODE_ENV=production; they exist so the bundle links.
const devOnly = (name) => () => {
  throw new Error(`[appkit-stub] ${name} is dev/codegen-only and is not bundled in server-dist/appkit.mjs`)
}

export const Lang = {}
export const parse = devOnly('@ast-grep/napi.parse')
export const transform = devOnly('@babel/core.transform')
export const transformAsync = devOnly('@babel/core.transformAsync')
export const parseSync = devOnly('@babel/core.parseSync')
export default {}
