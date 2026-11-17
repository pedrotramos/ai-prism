// Production stand-in for `vite`, bundled into server-dist/appkit.mjs instead of the
// real package. AppKit statically imports vite for its dev server and @vitejs/plugin-react;
// the deployed app runs with NODE_ENV=production and has no node_modules, so those
// code paths must never execute. Calling any of them throws loudly.
const devOnly = (name) => () => {
  throw new Error(`[appkit-stub] ${name} is dev-only and is not bundled in server-dist/appkit.mjs`)
}

export const createFilter = devOnly('vite.createFilter')
export const createServer = devOnly('vite.createServer')
export const loadConfigFromFile = devOnly('vite.loadConfigFromFile')
export const mergeConfig = devOnly('vite.mergeConfig')
export default {}
