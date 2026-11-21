import { stripUnsafeMarkdownHtml } from '../../../../shared/markdownSafety.js'

// Every markdown string the chat renders (answer prose, tool questions, tool
// results) passes through here before ReactMarkdown. Outside code, the shared
// helper escapes raw HTML and turns script-bearing link destinations into
// "#", the same rule documents get (shared/markdownSafety.js). Inside fenced
// code and inline code spans the text is left exactly as written: there
// markdown shows `<` literally, and escaping it would print `&lt;div>` in
// every HTML/JSX/generic-type snippet.
//
// Skipping code is safe on this path, unlike the marked + innerHTML path the
// helper was written for: ReactMarkdown never renders raw HTML (no
// rehype-raw), so if this scan ever misjudged a code boundary the worst case
// is a tag shown as text, never markup that runs. The helper is defence in
// depth on top of that.

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const PARAGRAPH_BREAK = /(\n[ \t]*\n)/

function escapedAt(s: string, at: number): boolean {
  let n = 0
  for (let i = at - 1; i >= 0 && s[i] === '\\'; i--) n++
  return n % 2 === 1
}

// One paragraph: code spans (a run of N backticks closed by the next run of
// exactly N) are kept; everything else goes through the helper. An unmatched
// run is literal text, as in CommonMark.
function safeParagraph(s: string): string {
  let out = ''
  let prose = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === '`' && !escapedAt(s, i)) {
      let j = i
      while (s[j] === '`') j++
      const n = j - i
      let close = -1
      for (let k = s.indexOf('`', j); k !== -1; ) {
        let e = k
        while (s[e] === '`') e++
        if (e - k === n) {
          close = k
          break
        }
        k = s.indexOf('`', e)
      }
      if (close !== -1) {
        out += stripUnsafeMarkdownHtml(prose) + s.slice(i, close + n)
        prose = ''
        i = close + n
        continue
      }
      prose += s.slice(i, j)
      i = j
      continue
    }
    prose += s[i]
    i++
  }
  return out + stripUnsafeMarkdownHtml(prose)
}

// Prose between fences: code spans never cross a blank line, so each
// paragraph is scanned on its own.
const safeProse = (s: string): string =>
  s
    .split(PARAGRAPH_BREAK)
    .map((part, i) => (i % 2 ? part : safeParagraph(part)))
    .join('')

/** Markdown with raw HTML and unsafe links neutralised outside code. */
export function safeMessageMarkdown(text: unknown): string {
  if (typeof text !== 'string') return ''
  const out: string[] = []
  let prose: string[] = []
  let code: string[] = []
  let fence: string | null = null
  const flushProse = () => {
    if (prose.length) out.push(safeProse(prose.join('\n')))
    prose = []
  }
  for (const line of text.split('\n')) {
    if (fence) {
      code.push(line)
      const m = FENCE_CLOSE.exec(line)
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) {
        out.push(code.join('\n'))
        code = []
        fence = null
      }
      continue
    }
    const m = FENCE_OPEN.exec(line)
    // a backtick fence's info string cannot contain a backtick (CommonMark)
    if (m && !(m[1]![0] === '`' && line.slice(m[0].length).includes('`'))) {
      flushProse()
      fence = m[1]!
      code = [line]
      continue
    }
    prose.push(line)
  }
  flushProse()
  // an unclosed fence (still streaming) is code to the end, as markdown renders it
  if (fence) out.push(code.join('\n'))
  return out.join('\n')
}
