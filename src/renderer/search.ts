import type { PDFDocumentProxy } from 'pdfjs-dist'

/**
 * Find-in-document, kept honest and small.
 *
 * Deliberately NOT a reimplementation of pdf.js's PDFFindController, which is 1,100 lines and
 * exists to serve a UI we do not have: match diacritics, entire-word, per-page highlight state
 * machines and a scroll controller. What a reader actually asks for is "where does this string
 * appear, take me there, show me where it is", and that is this file.
 *
 * TWO DESIGN POINTS
 *
 * Offsets are into the page's text EXACTLY as pdf.js hands it over — items joined with nothing
 * between them. That is also exactly what ends up in the text layer's DOM (empty items produce no
 * node, and an end-of-line produces a <br> with no text), so an offset from the search is directly
 * usable as an offset into the rendered spans. Highlighting is then a DOM Range and the browser's
 * own `getClientRects`, which is correct for CJK, for right-to-left text and for a match that
 * wraps a line, none of which a hand-rolled box calculation gets right.
 *
 * Case folding is per code point, not `toLowerCase()` on the whole string, when the fast path
 * would change the string's LENGTH — 'İ'.toLowerCase() is two characters, and one such glyph on
 * the page would shift every subsequent match by one and highlight the wrong glyphs.
 */

export interface PdfMatch {
  page: number
  /** Half-open range into the page's text. */
  start: number
  end: number
}

export interface SearchProgress {
  matches: PdfMatch[]
  /** Pages scanned so far, out of the document's total. */
  scanned: number
  done: boolean
}

/**
 * One running scan, cancellable by whoever started it.
 *
 * Cancellation used to be a counter on the index, and that was fine while every pane built its
 * own. The index now lives in the document cache and is SHARED by every tab on one file, so a
 * counter would mean one pane's unmount — an ordinary tab switch — silently killing the search
 * another pane is still running against the same document.
 */
export class SearchScan {
  private live = true

  cancel(): void {
    this.live = false
  }

  get cancelled(): boolean {
    return !this.live
  }
}

/**
 * The extracted text of every page scanned so far, kept for the life of the DOCUMENT.
 *
 * Roughly 3 MB for a 500-page book, against a worker round-trip per page for every new query.
 * It hangs off the entry in `documents.ts` rather than off the pane, because the pane unmounts on
 * every tab switch and the document does not: rebuilding it there meant re-extracting all 500
 * pages the first time the reader searched again after coming back.
 */
export class SearchIndex {
  /**
   * Promises, not strings, because the index is shared.
   *
   * Two panes on one file (a split view) scan through this same map, and with plain strings a page
   * is only "cached" once its extraction has FINISHED — so the second scan, arriving while the
   * first is mid-flight, would post a duplicate getTextContent for every page it overtakes. The
   * worker is FIFO: that duplicate work is time the page column spends waiting to render.
   */
  private readonly pages = new Map<number, Promise<string>>()

  constructor(private readonly doc: PDFDocumentProxy) {}

  /** One page's text, extracting it if this is the first time it has been asked for. */
  text(n: number): Promise<string> {
    const cached = this.pages.get(n)
    if (cached) return cached
    const extracting = this.extract(n)
    this.pages.set(n, extracting)
    // A rejection must not be remembered: the usual cause is the document being torn down, and a
    // reopen that lands on this index would otherwise inherit a page that can never be searched.
    // The caller handles the rejection too; this handler only evicts.
    extracting.catch(() => {
      if (this.pages.get(n) === extracting) this.pages.delete(n)
    })
    return extracting
  }

  private async extract(n: number): Promise<string> {
    const page = await this.doc.getPage(n)
    const content = await page.getTextContent()
    return content.items.map((item) => ('str' in item ? item.str : '')).join('')
  }

  /**
   * Scan the whole document, reporting after every page.
   *
   * Progressive because it has to be: extracting a 500-page book is seconds of worker time, and a
   * reader who typed a word that appears on page 3 should not wait for page 500.
   *
   * Returns the handle to cancel it with. The caller owns that handle — see `SearchScan` for why
   * the index deliberately keeps no notion of "the" current scan.
   */
  run(query: string, report: (progress: SearchProgress) => void): SearchScan {
    const scan = new SearchScan()
    void this.sweep(query, report, scan)
    return scan
  }

  private async sweep(
    query: string,
    report: (progress: SearchProgress) => void,
    scan: SearchScan
  ): Promise<void> {
    const needle = fold(query)
    const matches: PdfMatch[] = []
    if (!needle) { report({ matches, scanned: 0, done: true }); return }

    for (let n = 1; n <= this.doc.numPages; n++) {
      let haystack: string
      try {
        haystack = fold(await this.text(n))
      } catch {
        // The document went away underneath the scan — the last tab on this file closed while a
        // getTextContent was in flight. Swallowed and reported as final: letting it out would be
        // an unhandled rejection (a red overlay in development) and would leave the find bar
        // stuck saying "so far…" for a pane that is about to unmount anyway.
        if (!scan.cancelled) report({ matches: [...matches], scanned: n, done: true })
        return
      }
      if (scan.cancelled) return
      for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
        matches.push({ page: n, start: at, end: at + needle.length })
      }
      report({ matches: [...matches], scanned: n, done: n === this.doc.numPages })
    }
  }
}

/**
 * Draw the hits for one page over its text layer.
 *
 * Positions are written as per-cent of the page box rather than pixels, so a zoom — which is one
 * CSS variable write and no relayout — carries the highlights with it for free.
 */
export function paintHits(
  textEl: HTMLElement,
  hitsEl: HTMLElement,
  matches: PdfMatch[],
  active: PdfMatch | null
): void {
  hitsEl.replaceChildren()
  if (matches.length === 0) return

  const spans = textNodes(textEl)
  const base = hitsEl.getBoundingClientRect()
  if (base.width === 0 || base.height === 0) return

  for (const match of matches) {
    const range = rangeOf(spans, match)
    if (!range) continue
    for (const rect of range.getClientRects()) {
      const hit = document.createElement('div')
      hit.className = match === active ? 'pdf__hit pdf__hit--active' : 'pdf__hit'
      hit.style.left = `${((rect.left - base.left) / base.width) * 100}%`
      hit.style.top = `${((rect.top - base.top) / base.height) * 100}%`
      hit.style.width = `${(rect.width / base.width) * 100}%`
      hit.style.height = `${(rect.height / base.height) * 100}%`
      hitsEl.append(hit)
    }
  }
}

/** Where a match sits vertically in its page, in per-cent, for scrolling to it. */
export function hitOffset(textEl: HTMLElement, match: PdfMatch): number | null {
  const range = rangeOf(textNodes(textEl), match)
  if (!range) return null
  const rect = range.getBoundingClientRect()
  const base = textEl.getBoundingClientRect()
  if (base.height === 0) return null
  return ((rect.top - base.top) / base.height) * 100
}

interface Run {
  node: Text
  start: number
}

function textNodes(textEl: HTMLElement): Run[] {
  const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT)
  const runs: Run[] = []
  let offset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    runs.push({ node: node as Text, start: offset })
    offset += node.nodeValue?.length ?? 0
  }
  return runs
}

function rangeOf(runs: Run[], match: PdfMatch): Range | null {
  const from = locate(runs, match.start)
  const to = locate(runs, match.end)
  if (!from || !to) return null
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return range
}

function locate(runs: Run[], offset: number): { node: Text; offset: number } | null {
  // Linear from the end of the list backwards would be as good; a page has a few thousand runs and
  // a search paints at most a handful of matches, so neither shows up in a profile.
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!
    const length = run.node.nodeValue?.length ?? 0
    if (offset >= run.start && offset <= run.start + length) {
      return { node: run.node, offset: offset - run.start }
    }
  }
  return null
}

/**
 * Lower-case without ever changing the string's length.
 *
 * The whole-string call is tried first because it is one pass in native code; the per-code-point
 * loop only runs for the rare page that contains a character whose lower case is longer than it
 * is, and it keeps such characters as they are rather than let every later offset shift.
 */
function fold(s: string): string {
  const lower = s.toLowerCase()
  if (lower.length === s.length) return lower
  let out = ''
  for (const ch of s) {
    const folded = ch.toLowerCase()
    out += folded.length === ch.length ? folded : ch
  }
  return out
}
