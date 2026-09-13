// Streaming slide detection for the pure-HTML deck engine (task #25): as the
// model streams the `deck-html` prism-block, we surface each slide the instant
// its JSON string element in "slides":[…] is fully written — so the Studio shows
// the deck BUILDING (thumbnail by thumbnail) instead of a blind 5-minute spinner.
// See project_pure_html_deck_engine.
//
// The slides live as JSON-encoded strings inside the block:
//   {"type":"deck-html","title":"…","slides":["<section …>…</section>","<…>…"]}
// so within the array each slide is a quoted string with \" / \n escapes. We
// can't naively scan for </section> (attributes carry escaped quotes); instead
// we incrementally read one complete JSON string element at a time, respecting
// escapes, and decode it with JSON.parse only once it has fully closed.

// Creates a stateful scanner. Feed it the FULL accumulated turn content on each
// token flush (cheap: it resumes from a saved cursor). Calls onSlide(html, i)
// exactly once per slide, in order, as each closes; onTitle(title) once when the
// deck title is first readable. Never emits a partial slide.
export function makeSlideStreamScanner({ onSlide, onTitle } = {}) {
  let armed = false // saw "deck-html" → this turn is building an HTML deck
  // saw "deck-outline" → the two-phase engine (opção 1 — por slide). The outline
  // carries no HTML slides to stream (they're materialized later, server-side), so
  // we only emit the TITLE from it — enough to open the Studio promptly (matching
  // the deck-html UX) while the raw plan JSON is still streaming. The real
  // deck_slide events come from the Phase-2 generator, not this scanner.
  let outlineOnly = false
  let titleSent = false
  let arrayStart = -1 // index just past the '[' of "slides":[
  let cursor = -1 // scan position within the array
  let emitted = 0
  let done = false

  return function push(content) {
    if (done || !content) return
    if (!armed) {
      if (content.includes('"deck-html"') || content.includes("'deck-html'")) armed = true
      else if (content.includes('"deck-outline"') || content.includes("'deck-outline'")) {
        armed = true
        outlineOnly = true
      } else return
    }
    // title (best-effort, once): "title":"…"
    if (!titleSent && onTitle) {
      const m = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(content)
      if (m) {
        try {
          onTitle(JSON.parse(`"${m[1]}"`))
        } catch {
          /* incomplete escape — try again next flush */
        }
        titleSent = true
      }
    }
    // deck-outline: title is all we surface here; slides stream in Phase 2.
    if (outlineOnly) {
      if (titleSent) done = true // nothing left to scan on this turn
      return
    }
    // locate "slides":[ once
    if (arrayStart < 0) {
      const m = /"slides"\s*:\s*\[/.exec(content)
      if (!m) return
      arrayStart = m.index + m[0].length
      cursor = arrayStart
    }
    // read complete string elements from the cursor forward
    let i = cursor
    const n = content.length
    for (;;) {
      // skip whitespace and commas between elements
      while (i < n && (content[i] === ' ' || content[i] === '\n' || content[i] === '\r' || content[i] === '\t' || content[i] === ',')) i++
      if (i >= n) break
      if (content[i] === ']') {
        done = true
        break
      }
      if (content[i] !== '"') {
        // unexpected (e.g. an object element {"html":…}); bail out of streaming
        // detection — the final block resolution still catches everything.
        done = true
        break
      }
      // read a JSON string starting at i, honoring escapes
      const end = readJsonString(content, i)
      if (end < 0) break // incomplete — wait for more tokens
      let html
      try {
        html = JSON.parse(content.slice(i, end))
      } catch {
        break // shouldn't happen for a closed string, but be safe
      }
      emitted++
      onSlide?.(html, emitted - 1)
      cursor = end
      i = end
    }
    // save cursor at the last complete element boundary (i may point mid-string
    // when incomplete; only advance the saved cursor to fully-read boundaries)
    if (cursor > arrayStart) cursor = Math.max(cursor, arrayStart)
  }
}

// Returns the index just PAST the closing quote of the JSON string that starts
// at content[start] === '"', or -1 if the string hasn't closed yet.
function readJsonString(content, start) {
  const n = content.length
  let j = start + 1
  while (j < n) {
    const ch = content[j]
    if (ch === '\\') {
      if (j + 1 >= n) return -1 // escape at the very edge — incomplete
      j += 2
      continue
    }
    if (ch === '"') return j + 1
    j++
  }
  return -1
}
