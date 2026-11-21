// sanitize-html ships no types and @types/sanitize-html is not a dependency: this declares
// only the surface server/sanitizeDsHtml.ts uses (the default export and the options it passes).
declare module 'sanitize-html' {
  interface Options {
    allowedTags?: string[]
    allowVulnerableTags?: boolean
    allowedAttributes?: Record<string, string[]>
    allowedSchemes?: string[]
    allowedSchemesByTag?: Record<string, string[]>
    allowedSchemesAppliedToAttributes?: string[]
    allowProtocolRelative?: boolean
    parseStyleAttributes?: boolean
    transformTags?: Record<string, (tagName: string, attribs: Record<string, string>) => { tagName: string; attribs: Record<string, string> }>
  }
  export default function sanitizeHtml(dirty: string, options?: Options): string
}
