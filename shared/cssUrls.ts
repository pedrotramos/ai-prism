// CSS Syntax tokenizer reduced to what egress telemetry needs: the URLs a stylesheet makes a browser fetch.
// Internal to shared/urlEgressPolicy.ts (not part of its public API).

const isNewline = (c: string): boolean => c === '\n' || c === '\r' || c === '\f'
const isWs = (c: string): boolean => c === ' ' || c === '\t' || isNewline(c)
const isHex = (c: string): boolean => /^[0-9a-f]$/i.test(c)
const isNameChar = (c: string): boolean => /^[a-z0-9_-]$/i.test(c) || c > '\u007f'

/**
 * The URLs a CSS text can make a browser fetch, found with the tokenizer of CSS Syntax Level 3 §4: comments, strings
 * (an escaped quote or a `\` + newline continuation stays inside the string, a raw newline ends it as a bad-string),
 * escapes (decoded inside a token only, never across token boundaries), `url(` as an ident or function (so `u\72l(`
 * counts), url tokens (an escaped space or quote is content; a raw quote, `(`, whitespace + more text is a bad-url,
 * which loads nothing and is not reported) and `@import` + string. One pass, each character is looked at once:
 * `ops` (when given) counts the loop steps so a test can assert linear work.
 */
export function cssUrlsOf(css: string, ops?: { n: number }): string[] {
  const out: string[] = []
  const n = css.length
  let i = 0
  const tick = (): void => {
    if (ops) ops.n++
  }
  // consume an escape after the backslash at css[i]; returns the decoded text, leaves i after it
  const escape = (): string => {
    i++ // the backslash
    if (i >= n) return '�'
    const c = css[i] as string
    if (isHex(c)) {
      let h = ''
      while (i < n && h.length < 6 && isHex(css[i] as string)) h += css[i++]
      if (css[i] === '\r' && css[i + 1] === '\n') i += 2
      else if (i < n && isWs(css[i] as string)) i++
      const cp = parseInt(h, 16)
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp)
    }
    i++
    return c
  }
  const validEscape = (at: number): boolean => css[at] === '\\' && at + 1 < n && !isNewline(css[at + 1] as string)
  const name = (): string => {
    let r = ''
    while (i < n) {
      tick()
      const c = css[i] as string
      if (isNameChar(c)) {
        r += c
        i++
      } else if (validEscape(i)) r += escape()
      else break
    }
    return r
  }
  // a quoted string starting at css[i] (the quote); returns its value and leaves i after the closing quote
  const str = (): string => {
    const q = css[i++] as string
    let r = ''
    while (i < n) {
      tick()
      const c = css[i] as string
      if (c === q) {
        i++
        return r
      }
      if (isNewline(c)) return r // bad-string: the newline is not consumed, the string is not a URL
      if (c === '\\') {
        if (i + 1 >= n) {
          i++
          return r
        }
        if (isNewline(css[i + 1] as string)) {
          i += css[i + 1] === '\r' && css[i + 2] === '\n' ? 3 : 2 // line continuation
          continue
        }
        r += escape()
      } else {
        r += c
        i++
      }
    }
    return r
  }
  // `comments` false: inside a url( token a comment is URL data, only whitespace is skipped
  const skipWs = (comments = true): void => {
    while (i < n) {
      tick()
      if (isWs(css[i] as string)) i++
      else if (comments && css[i] === '/' && css[i + 1] === '*') {
        const e = css.indexOf('*/', i + 2)
        i = e < 0 ? n : e + 2
      } else break
    }
  }
  const closesFunction = (): boolean => {
    skipWs()
    return i >= n || css[i] === ')'
  }
  // open functions: true for image-set()/-webkit-image-set(), whose bare string arguments are image URLs
  const fn: boolean[] = []
  while (i < n) {
    tick()
    const c = css[i] as string
    if (c === '/' && css[i + 1] === '*') {
      const e = css.indexOf('*/', i + 2)
      i = e < 0 ? n : e + 2
    } else if (c === '"' || c === "'") {
      const q = c
      const v = str()
      if (fn[fn.length - 1] === true && css[i - 1] === q && i > 0) out.push(v)
    } else if (c === '(') {
      fn.push(false)
      i++
    } else if (c === ')') {
      fn.pop()
      i++
    } else if (c === '@') {
      i++
      if (isNameChar(css[i] ?? '') || validEscape(i)) {
        if (name().toLowerCase() === 'import') {
          skipWs()
          if (css[i] === '"' || css[i] === "'") {
            const q = css[i] as string
            const v = str()
            if (i > 0 && css[i - 1] === q) out.push(v)
          }
        }
      }
    } else if (isNameChar(c) || validEscape(i)) {
      const nm = name().toLowerCase()
      if (css[i] === '(' && (nm === 'image-set' || nm === '-webkit-image-set')) {
        fn.push(true)
        i++
      } else if (css[i] === '(' && nm === 'url') {
        i++
        const at = i
        skipWs(false)
        if (css[i] === '"' || css[i] === "'") {
          const q = css[i] as string
          const v = str()
          if (css[i - 1] === q && i > at && closesFunction()) out.push(v)
        } else {
          // url token: until `)`; whitespace may only be followed by `)`
          let v = ''
          let bad = false
          while (i < n) {
            tick()
            const ch = css[i] as string
            if (ch === ')') {
              i++
              break
            }
            if (isWs(ch)) {
              skipWs(false)
              if (i < n && css[i] !== ')') bad = true
              continue
            }
            if (ch === '"' || ch === "'" || ch === '(' || ch <= '\b' || ch === '\u000b' || (ch >= '\u000e' && ch <= '\u001f') || ch === '\u007f') {
              bad = true
              i++
            } else if (ch === '\\') {
              if (validEscape(i)) v += escape()
              else {
                bad = true
                i++
              }
            } else {
              v += ch
              i++
            }
          }
          if (!bad) out.push(v)
        }
      }
    } else i++
  }
  return out
}
