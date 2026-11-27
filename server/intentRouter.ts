// RED stub: the real module lands in the next commit (see server/intentRouter.test.ts).
type Loose = any

export function resolveRoutes(_input: Loose): Loose {
  throw new Error('not implemented')
}
export function classifyIntentOpenJev(_token: string, _userText: string, _opts: Loose = {}): Promise<Loose> {
  throw new Error('not implemented')
}
export function routeIntent(_req: Loose, _userText: string, _history: Loose, _classifyOpts: Loose, _signal?: AbortSignal): Promise<Loose> {
  throw new Error('not implemented')
}
export function resetIntentRouterForTests(): void {}
