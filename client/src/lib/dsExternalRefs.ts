// Finds the external http(s) references a design-system kit keeps (Google Fonts
// <link>, @import, CDN url() fonts/images, <img src>, <script src>). The app's
// CSP and the deck sanitizer drop all of them, so the importer reports them
// instead of letting a deck silently fall back later. Pure and offline: it only
// reads the text it is given and never fetches anything.

export type ExternalRefKind = 'fontStylesheet' | 'import' | 'fontUrl' | 'imageUrl' | 'img' | 'other'
export interface ExternalRef { kind: ExternalRefKind; host: string; count: number }

const ABS = String.raw`(?:https?:)?\/\/[^\s"'<>)]+`
const FONT_EXT = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i
const IMG_EXT = /\.(?:svg|png|jpe?g|gif|webp|avif|ico)(?:[?#]|$)/i

function hostOf(u: string): string {
  try {
    return new URL(u.startsWith('//') ? `https:${u}` : u).hostname || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Counts external references across the given HTML/CSS sources, grouped by kind + host. */
export function collectExternalRefs(sources: string[]): ExternalRef[] {
  const acc = new Map<string, ExternalRef>()
  const add = (kind: ExternalRefKind, url: string): void => {
    const host = hostOf(url.replace(/&amp;/g, '&'))
    const key = `${kind}|${host}`
    const cur = acc.get(key)
    if (cur) cur.count++
    else acc.set(key, { kind, host, count: 1 })
  }
  for (const src of sources) {
    let s = src || ''
    // @import first (and blank it) so its url() is not counted twice
    s = s.replace(new RegExp(String.raw`@import\s+(?:url\(\s*)?["']?(${ABS})["']?\s*\)?`, 'gi'), (_m, u: string) => (add('import', u), ' '))
    // <link href> pointing outside
    s = s.replace(new RegExp(String.raw`<link\b[^>]*\bhref\s*=\s*["']?(${ABS})["']?[^>]*>`, 'gi'), (m, u: string) => {
      const sheet = /rel\s*=\s*["']?stylesheet/i.test(m)
      add(sheet && (/font/i.test(u) || /family=/i.test(u)) ? 'fontStylesheet' : 'other', u)
      return ' '
    })
    s = s.replace(new RegExp(String.raw`<img\b[^>]*\bsrc\s*=\s*["']?(${ABS})["']?`, 'gi'), (_m, u: string) => (add('img', u), ' '))
    s = s.replace(new RegExp(String.raw`<script\b[^>]*\bsrc\s*=\s*["']?(${ABS})["']?`, 'gi'), (_m, u: string) => (add('other', u), ' '))
    s.replace(new RegExp(String.raw`url\(\s*["']?(${ABS})["']?\s*\)`, 'gi'), (_m, u: string) => {
      add(FONT_EXT.test(u) ? 'fontUrl' : IMG_EXT.test(u) ? 'imageUrl' : 'other', u)
      return ''
    })
  }
  return [...acc.values()].sort((a, b) => b.count - a.count || a.host.localeCompare(b.host) || a.kind.localeCompare(b.kind))
}
