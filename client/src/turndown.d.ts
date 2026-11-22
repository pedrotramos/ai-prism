// Minimal typings for the two untyped turndown packages RichTextEditor uses
// (only the calls it makes; no @types dependency added).
declare module 'turndown' {
  interface Options {
    headingStyle?: 'setext' | 'atx'
    codeBlockStyle?: 'indented' | 'fenced'
    bulletListMarker?: '-' | '+' | '*'
    emDelimiter?: '_' | '*'
  }
  interface Rule {
    filter: string | string[]
    replacement: (content: string) => string
  }
  export default class TurndownService {
    constructor(options?: Options)
    use(plugin: unknown): this
    addRule(key: string, rule: Rule): this
    turndown(html: string): string
  }
}

declare module 'turndown-plugin-gfm' {
  export const gfm: unknown
}
