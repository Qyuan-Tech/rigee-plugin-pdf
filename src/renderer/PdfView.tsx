import { icons } from '@rigee/plugin-api'
import { useCallback, useEffect, useRef, useState } from 'react'
import { duplicatedFrom, Notice, openedInBackground } from '@rigee/plugin-api'
import {
  acquireDocument,
  readViewState,
  registerViewer,
  retireViewer,
  saveViewState,
  searchIndexFor,
  seedViewState
} from './documents'
import { Outline } from './Outline'
import { createPageList, type PageList } from './pages'
import { loadPdfjs } from './pdfjs'
import { RenderQueue } from './queue'
import { hitOffset, paintHits, type PdfMatch, type SearchIndex, type SearchScan } from './search'
import { Thumbnails } from './Thumbnails'
import type { PluginEditorProps } from '@rigee/plugin-api'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import './pdf.css'

/**
 * The PDF pane: chrome, and the wiring between the document and the imperative page column.
 *
 * React owns the toolbar, the side pane and the scroll container. It owns NOTHING inside that
 * container — pages, canvases, text layers and search highlights are DOM the PageList builds and
 * destroys itself. That is the same split the Monaco pane uses, and for the same reason: a
 * 500-page column re-rendered through React on every scroll tick would spend the whole frame
 * budget reconciling divs whose contents are bitmaps.
 *
 * The parsed document outlives this component. See `documents.ts` for why and for how it is freed.
 */

type Sidebar = 'none' | 'outline' | 'thumbnails'

/** The zoom ladder, matching what every other reader offers. */
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4]
const MIN_ZOOM = 0.25
const MAX_ZOOM = 6

/** Long enough to finish typing a word, short enough that it feels like it is keeping up. */
const QUERY_DEBOUNCE = 250

/**
 * ONE queue for every PDF pane in the window, page columns and thumbnail rails alike.
 *
 * Module scope, not per pane, because the limit is a budget for the whole window and a per-pane
 * limit caps nothing: two PDFs side by side — the case editor groups exist for — allowed two of
 * these at 2 renders each, so four pdf.js renders ran concurrently against one worker and the cap
 * that stops a scroll from eating the frame budget was gone exactly when it was needed.
 *
 * Panes still cancel only their own work: `clear` takes the owner that queued the jobs, so one
 * pane closing cannot drop the pages another pane is waiting on. See queue.ts.
 */
const queue = new RenderQueue(2)

export function PdfView({ filePath, tabId }: PluginEditorProps): React.ReactElement {
  const viewport = useRef<HTMLDivElement>(null)
  const list = useRef<PageList | null>(null)
  /*
   * The tab this one was split from, read ONCE. `duplicatedFrom` is consume-once, and the effect
   * below is double-invoked by StrictMode — asking there would hand the second pass nothing. A
   * lazy initialiser runs on the first render of each mount, which is the only moment the answer
   * exists.
   */
  const [splitFrom] = useState(() => duplicatedFrom(tabId))
  /** Whether this pane has had its chance at the keyboard: only on opening, not on a rename. */
  const focused = useRef(false)

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [draft, setDraft] = useState('1')
  const [scale, setScale] = useState(1)
  /**
   * Whether the current zoom came from fitting the page to the pane, rather than from the reader
   * choosing a number.
   *
   * It has to be remembered, not inferred: 119% may be a fit or a deliberate choice, and the two
   * must behave differently when the pane changes width. Splitting the editor is exactly that —
   * the column halves, and a page still drawn at the old fit is clipped with a horizontal
   * scrollbar, which is the first thing you see after splitting a PDF beside a terminal.
   */
  const [fitted, setFitted] = useState(true)
  // Mirrored, because the two places that record the reading position — the live snapshot another
  // pane may ask for, and the save on unmount — are closures created once and would otherwise
  // report whatever `fitted` was when they were made.
  const fittedRef = useRef(true)
  const [sidebar, setSidebar] = useState<Sidebar>('none')
  const [hasOutline, setHasOutline] = useState(false)

  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<PdfMatch[]>([])
  const [active, setActive] = useState(0)
  /** Pages scanned so far while a search is running; 0 when idle. */
  const [scanned, setScanned] = useState(0)

  // The index belongs to the document, the scan belongs to this pane. Keeping them apart is what
  // lets two tabs on one file share the extracted text without one tab's unmount cancelling the
  // other's running search.
  const index = useRef<SearchIndex | null>(null)
  const scan = useRef<SearchScan | null>(null)
  const findBox = useRef<HTMLInputElement>(null)
  /*
   * The hits, the selected hit and the page we still owe a scroll to, held in refs as well as in
   * state. The PageList calls back from outside React — when a page it realised has finished
   * painting — and a stale closure there would paint the previous query's highlights.
   */
  const hits = useRef<PdfMatch[]>([])
  const selected = useRef<PdfMatch | null>(null)
  const owed = useRef(0)

  /** Draw the current query's hits over one page, once its text layer exists. */
  const paint = useCallback((n: number) => {
    const live = list.current
    const overlay = live?.overlayOf(n)
    if (!live || !overlay) return
    paintHits(overlay.text, overlay.hits, hits.current.filter((m) => m.page === n), selected.current)

    // The jump to a match that was off screen finishes here: only now do we know where on the page
    // the match actually sits.
    if (owed.current === n) {
      owed.current = 0
      const target = selected.current
      if (target?.page === n) {
        const offset = hitOffset(overlay.text, target)
        if (offset !== null) live.scrollToSpot(n, offset)
      }
    }
  }, [])

  const repaint = useCallback(() => {
    const live = list.current
    if (!live) return
    for (let n = 1; n <= live.pageCount; n++) {
      if (live.overlayOf(n)) paint(n)
    }
  }, [paint])

  // ---------------------------------------------------------------------------
  // The document, and the column that shows it
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let disposed = false
    let unregister: (() => void) | null = null

    void (async () => {
      try {
        const [pdfjs, opened] = await Promise.all([loadPdfjs(), acquireDocument(filePath, tabId)])
        if (disposed || !viewport.current) return

        // Before our own state is read, and only ever a seed: a split copy has none of its own
        // yet, so without this it takes the first-open path below and starts at page 1.
        if (splitFrom) seedViewState(splitFrom, tabId)
        const saved = readViewState(tabId)
        const built = await createPageList({
          pdfjs,
          doc: opened,
          container: viewport.current,
          queue,
          scale: saved?.scale ?? 1,
          onPage: setPage,
          onRealized: paint
        })
        // StrictMode double-invokes this effect, so the cleanup may already have run while we were
        // awaiting. Destroying the column we just built is the only thing that stops the second
        // mount from finding two of everything.
        if (disposed) { retireViewer(filePath, built.destroy()); return }

        list.current = built
        // Answerable while mounted, so the pane a split copies FROM can be asked where it is
        // rather than guessed at from whatever it saved the last time it was unmounted.
        unregister = registerViewer(tabId, () => ({ ...built.snapshot(), fitted: fittedRef.current }))
        // Asked for, not constructed: the document cache owns it, so the text extracted by a
        // search survives the unmount that every tab switch puts this pane through.
        index.current = searchIndexFor(filePath, opened)
        // Fit to the width of the pane on a first open; a reader returning to a tab keeps the zoom
        // and the scroll position they left. The observers have not fired yet — their callbacks
        // are always asynchronous — so nothing is re-rendered by this.
        if (!saved) built.setScale(clamp(built.fitWidth()))
        setFitted(saved?.fitted ?? true)
        setDoc(opened)
        setScale(built.currentScale)
        if (saved) {
          built.restore(saved.scrollTop)
          setPage(saved.page)
        }
        // Same as the Monaco pane: the viewer that just opened takes the keyboard, so PageDown,
        // space and ⌘F all work without clicking into the page first — unless it was opened in the
        // background, from a single click in the file tree, which keeps the keyboard.
        if (!focused.current) {
          focused.current = true
          if (!openedInBackground(tabId)) viewport.current.focus()
        }

        const outline = await opened.getOutline()
        if (!disposed) setHasOutline((outline?.length ?? 0) > 0)
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      disposed = true
      unregister?.()
      const live = list.current
      list.current = null
      // The SCAN stops; the index does not. It is the document cache's, and the text it has
      // already extracted is what makes the search after the next tab switch instant instead of
      // another 500 trips to the worker.
      scan.current?.cancel()
      scan.current = null
      index.current = null
      if (live) {
        // Where the reader was, so returning to this tab does not start at page 1.
        saveViewState(tabId, { ...live.snapshot(), fitted: fittedRef.current })
        // The document itself stays: it dies with the TAB, not with the pane. `retireViewer` gives
        // the eventual destroy something to wait for, because `loadingTask.destroy()` must not run
        // until every render task here has been cancelled.
        retireViewer(filePath, live.destroy())
      }
    }
  }, [filePath, tabId, paint, splitFrom])

  useEffect(() => { fittedRef.current = fitted }, [fitted])
  useEffect(() => { list.current?.setScale(scale) }, [scale])

  /**
   * Re-fit when the pane changes width, but only while the zoom IS a fit.
   *
   * Splitting the editor, dragging the divider between two groups and collapsing a side panel all
   * resize this container; a reader who asked for 200% means 200% through all of it, and a reader
   * on fit-width means fit-width. Observing the element rather than the window because the window
   * is not what changes when a group is split.
   */
  useEffect(() => {
    const el = viewport.current
    if (!el || !fitted) return
    const observer = new ResizeObserver(() => {
      const live = list.current
      if (live) setScale(clamp(live.fitWidth()))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [fitted])
  useEffect(() => { setDraft(String(page)) }, [page])
  useEffect(() => { repaint() }, [matches, active, repaint])

  // Ctrl/Cmd + wheel is the zoom every other reader has trained people to expect. Non-passive,
  // because the point is to stop the scroller from scrolling.
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setScale((s) => clamp(s * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [])

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const engine = index.current
    if (!engine) return

    const wanted = query.trim()
    if (!finding || !wanted) {
      hits.current = []
      selected.current = null
      setMatches([])
      setActive(0)
      setScanned(0)
      return
    }

    const timer = setTimeout(() => {
      setScanned(1)
      let reported = -1
      scan.current = engine.run(wanted, ({ matches: found, scanned: at, done }) => {
        // The ref is always current; React hears about it only when there is something new to
        // say. A 500-page scan otherwise re-renders the pane — and the whole thumbnail rail —
        // 500 times, most of them to redraw the same two numbers.
        hits.current = found
        if (done || found.length !== reported) {
          reported = found.length
          setMatches(found)
        }
        if (done || at % 8 === 0) setScanned(done ? 0 : at)
      })
    }, QUERY_DEBOUNCE)

    return () => {
      clearTimeout(timer)
      // Only this pane's scan. The index is shared, so cancelling through it would abandon a
      // search another tab on the same file is halfway through.
      scan.current?.cancel()
      scan.current = null
    }
  }, [query, finding, doc])

  const goToMatch = useCallback((i: number) => {
    const found = hits.current
    if (found.length === 0) return
    const at = ((i % found.length) + found.length) % found.length
    const match = found[at]!
    selected.current = match
    setActive(at)

    const live = list.current
    if (!live) return
    const overlay = live.overlayOf(match.page)
    if (overlay) {
      const offset = hitOffset(overlay.text, match)
      if (offset !== null) live.scrollToSpot(match.page, offset)
      return
    }
    // Not rendered yet: get the page on screen and finish the jump in `paint`, which runs when
    // its text layer is ready.
    owed.current = match.page
    live.scrollToPage(match.page)
  }, [])

  // The first result of a new query selects itself; after that the reader drives.
  useEffect(() => {
    if (matches.length > 0 && selected.current === null) goToMatch(0)
  }, [matches, goToMatch])

  const closeFind = useCallback(() => {
    setFinding(false)
    setQuery('')
    viewport.current?.focus()
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setFinding(true)
        // Selecting the existing text makes a second Cmd+F mean "search for something else",
        // which is what every other find bar does.
        requestAnimationFrame(() => findBox.current?.select())
        return
      }
      if (e.key === 'Escape' && finding) { closeFind(); return }
      if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        setScale((s) => clamp(step(s, 1)))
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '-') {
        e.preventDefault()
        setScale((s) => clamp(step(s, -1)))
      }
    },
    [closeFind, finding]
  )

  const goToPage = useCallback((n: number) => {
    list.current?.scrollToPage(n)
    setPage(n)
  }, [])

  const canCleanup = useCallback((n: number) => !(list.current?.isRealized(n) ?? false), [])

  // ---------------------------------------------------------------------------

  if (error) return <Notice tone="error">{error}</Notice>

  const total = doc?.numPages ?? 0
  const status = scanned > 0
    ? `${matches.length} so far…`
    : matches.length > 0
      ? `${active + 1} of ${matches.length}`
      : query.trim() ? 'No results' : ''

  return (
    <div className="pdf" onKeyDown={onKeyDown}>
      <div className="pdf__bar">
        <button
          className={sidebar === 'thumbnails' ? 'btn pdf__btn--on' : 'btn'}
          disabled={!doc}
          onClick={() => setSidebar((s) => (s === 'thumbnails' ? 'none' : 'thumbnails'))}
          title="Page thumbnails"
        >
          Pages
        </button>
        <button
          className={sidebar === 'outline' ? 'btn pdf__btn--on' : 'btn'}
          disabled={!hasOutline}
          onClick={() => setSidebar((s) => (s === 'outline' ? 'none' : 'outline'))}
          title={hasOutline ? 'Document outline' : 'This document has no outline'}
        >
          Outline
        </button>

        <span className="pdf__sep" />

        <button
          className="btn"
          disabled={!doc}
          onClick={() => { setFitted(false); setScale((s) => clamp(step(s, -1))) }}
        >
          −
        </button>
        <span className="pdf__zoom">{Math.round(scale * 100)}%</span>
        <button
          className="btn"
          disabled={!doc}
          onClick={() => { setFitted(false); setScale((s) => clamp(step(s, 1))) }}
        >
          +
        </button>
        <button
          className={doc && fitted ? 'btn btn--primary' : 'btn'}
          disabled={!doc}
          onClick={() => {
            const live = list.current
            if (!live) return
            setFitted(true)
            setScale(clamp(live.fitWidth()))
          }}
        >
          Fit
        </button>

        <span className="pdf__sep" />

        <input
          className="pdf__pagebox"
          value={draft}
          disabled={!doc}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            const n = Number(draft)
            if (Number.isFinite(n) && n >= 1 && n <= total) goToPage(Math.floor(n))
            else setDraft(String(page))
          }}
          onBlur={() => setDraft(String(page))}
          aria-label="Page number"
        />
        <span className="pdf__count">/ {total || '—'}</span>

        <span className="pdf__spacer" />

        {finding ? (
          <div className="pdf__find">
            <input
              className="pdf__findbox"
              ref={findBox}
              value={query}
              autoFocus
              placeholder="Find in document"
              onChange={(e) => { selected.current = null; setQuery(e.target.value) }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                goToMatch(active + (e.shiftKey ? -1 : 1))
              }}
            />
            <span className="pdf__findcount">{status}</span>
            <button
              className="btn"
              disabled={matches.length === 0}
              onClick={() => goToMatch(active - 1)}
              title="Previous match (⇧⏎)"
            >
              ‹
            </button>
            <button
              className="btn"
              disabled={matches.length === 0}
              onClick={() => goToMatch(active + 1)}
              title="Next match (⏎)"
            >
              ›
            </button>
            <button className="btn" onClick={closeFind} title="Close (Esc)">
              <icons.Close />
            </button>
          </div>
        ) : (
          <button className="btn" disabled={!doc} onClick={() => setFinding(true)} title="Find (⌘F)">
            Find
          </button>
        )}
      </div>

      <div className="pdf__body">
        {sidebar !== 'none' && doc && (
          <div className="pdf__side">
            <div className="pdf__side-head">
              <span>{sidebar === 'outline' ? 'Outline' : 'Pages'}</span>
              <button className="pdf__twisty" onClick={() => setSidebar('none')} title="Hide">
                <icons.Chevron />
              </button>
            </div>
            {sidebar === 'outline' ? (
              <Outline doc={doc} onGo={goToPage} />
            ) : (
              <Thumbnails
                doc={doc}
                queue={queue}
                current={page}
                canCleanup={canCleanup}
                onGo={goToPage}
              />
            )}
          </div>
        )}

        {/* The PageList appends its column here and owns every node inside it, so React must not
            render children into this element — hence the overlay below is a sibling. */}
        <div className="pdf__viewport" ref={viewport} tabIndex={0} />

        {!doc && (
          <div className="pdf__opening">
            <icons.File />
            <span className="muted">Opening {basename(filePath)}…</span>
          </div>
        )}
      </div>
    </div>
  )
}

const clamp = (scale: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale))

/** Both separators, because a workspace opened on Windows carries backslashes through. */
const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** The next rung of the zoom ladder in `direction`, or a proportional step past either end. */
function step(scale: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOMS.find((z) => z > scale + 1e-6) ?? scale * 1.25
  return [...ZOOMS].reverse().find((z) => z < scale - 1e-6) ?? scale / 1.25
}
