import { assetOptions, loadPdfjs } from './pdfjs'
import { pdf } from './rpc'
import { SearchIndex } from './search'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'

/**
 * Parsed documents, kept alive for as long as a tab shows them.
 *
 * A DELIBERATE CACHE, because the shell mounts panes with `key={tab.id}` and unmounts them on
 * every tab switch. Without one, flipping to a terminal and back would re-read the file over IPC,
 * spawn a new worker, re-parse the xref table and re-render from scratch — for a 300-page scan
 * that is a second of work and a visible white flash, every time.
 *
 * The invalidation rule is the whole design: an entry lives as long as at least one LIVE TAB
 * references it, and dies the moment the last one closes. Not "until the pane unmounts" (that is
 * a tab switch, the case we are here to survive) and not "forever" (that is a worker and its wasm
 * heaps leaked per file opened). `sweep` is driven by the shell's tab list, so closing a tab,
 * closing a workspace and quitting all take the same path.
 *
 * Scroll position and zoom are cached beside the document for exactly the same reason, keyed by
 * tab rather than by path: two tabs on one file are two reading positions.
 */

interface Entry {
  promise: Promise<PDFDocumentProxy>
  /** Set once the document resolves; the only thing that can terminate the worker. */
  loadingTask: PDFDocumentLoadingTask | null
  /** Set once the document resolves. Identity, so a stale caller can be told apart — see below. */
  doc: PDFDocumentProxy | null
  /**
   * Find-in-document's extracted text, built on first search and shared by every pane on the file.
   *
   * Here rather than in the pane for the same reason the document itself is: a tab switch unmounts
   * the pane, and an index rebuilt on remount would re-extract all 500 pages of a book the worker
   * has already read once — seconds of worker time that every page render then waits behind.
   */
  index: SearchIndex | null
  /** Tabs known to be showing this file. Pruned against the shell's list on every change. */
  tabs: Set<string>
  /**
   * Viewer teardowns recorded by unmounting panes.
   *
   * `loadingTask.destroy()` waits for in-flight renders before terminating the worker, but the
   * page-level cleanup has to happen first regardless — `page.cleanup()` is a silent no-op while
   * a render task is outstanding — so the destroy waits for these.
   */
  teardowns: Promise<void>[]
}

/** What a reader wants back when they return to a tab they left. */
export interface ViewState {
  scrollTop: number
  scale: number
  page: number
  /**
   * Whether `scale` is a fit-to-width rather than a number the reader chose.
   *
   * Carried with the position so that returning to a tab — or landing in a split copy, which is a
   * narrower column by definition — keeps fitting if it was fitting, instead of inheriting a
   * percentage computed for a pane of a different size.
   */
  fitted?: boolean
}

const entries = new Map<string, Entry>()
const viewStates = new Map<string, ViewState>()
/**
 * Where each MOUNTED pane is right now, asked rather than stored.
 *
 * `viewStates` is only written when a pane unmounts, which is the wrong moment for the one caller
 * that needs somebody else's position: the pane being split from is still on screen in the other
 * column, so its entry is whatever it had at the last tab switch — or nothing at all, for a
 * document that has never been left since it opened.
 */
const liveViewers = new Map<string, () => ViewState>()
let sweepTimer: ReturnType<typeof setTimeout> | undefined

export function acquireDocument(path: string, tabId: string): Promise<PDFDocumentProxy> {
  let entry = entries.get(path)
  if (!entry) {
    const created: Entry = {
      promise: null!,
      loadingTask: null,
      doc: null,
      index: null,
      tabs: new Set(),
      teardowns: []
    }
    entries.set(path, created)
    created.promise = open(path, created)
    // A failed open must not be cached: the file may have been half-written when we read it, and
    // the obvious response to the error is to close the tab and open it again. The loading task
    // still has to be destroyed — a document that rejected (a password, a broken xref) got that
    // far by starting a worker.
    created.promise.catch(() => {
      if (entries.get(path) === created) entries.delete(path)
      void created.loadingTask?.destroy().catch(() => { /* never started */ })
    })
    entry = created
  }
  entry.tabs.add(tabId)
  return entry.promise
}

/**
 * The search index for a document, built on first use and shared for as long as the document is.
 *
 * Panes ask for one instead of constructing one: a `new SearchIndex` per pane looked harmless
 * because the DOCUMENT was cached, but the extracted text is the expensive half. Switching to a
 * terminal tab and back threw the text away and the next search re-streamed getTextContent for
 * every page, saturating the worker and delaying every page render behind it.
 */
export function searchIndexFor(path: string, doc: PDFDocumentProxy): SearchIndex {
  const entry = entries.get(path)
  // Not the cache's document any more: the entry was swept while this pane was opening, or a
  // reopen has already replaced it. Storing an index against a document the entry does not own
  // would hand the next tab on this path text extracted from a document that is being destroyed,
  // so this one belongs to the caller alone and dies with it.
  if (!entry || entry.doc !== doc) return new SearchIndex(doc)
  return (entry.index ??= new SearchIndex(doc))
}

/**
 * Record that a pane showing `path` has gone away.
 *
 * NOT a release: the tab is probably still open and the user has just looked at something else.
 * All this does is give the eventual destroy something to wait for.
 */
export function retireViewer(path: string, teardown: Promise<void>): void {
  const entry = entries.get(path)
  if (entry) entry.teardowns.push(teardown)
}

export function saveViewState(tabId: string, state: ViewState): void {
  viewStates.set(tabId, state)
}

export function readViewState(tabId: string): ViewState | undefined {
  return viewStates.get(tabId)
}

/**
 * Let a mounted pane be asked where it is. Returns its own undo, for the unmount.
 *
 * The undo compares before deleting because StrictMode mounts the replacement before it tears the
 * first one down; an unconditional delete there would unregister the live pane.
 */
export function registerViewer(tabId: string, snapshot: () => ViewState): () => void {
  liveViewers.set(tabId, snapshot)
  return () => {
    if (liveViewers.get(tabId) === snapshot) liveViewers.delete(tabId)
  }
}

/**
 * Give a tab the reading position of the tab it was split from.
 *
 * Splitting a book you are 143 pages into should give you page 143 in the new column. Without
 * this the copy has no state of its own, falls into the first-open branch, and opens fitted to
 * width at page one — the reader asked for a second view of what they were reading, not for the
 * front cover.
 *
 * Copied, not moved: the original is still open beside it and still wants its own place. Never
 * overwrites, because an existing entry is the newer answer — the copy has been read since.
 */
export function seedViewState(fromTabId: string, toTabId: string): void {
  if (viewStates.has(toTabId)) return
  const from = liveViewers.get(fromTabId)?.() ?? viewStates.get(fromTabId)
  if (from) viewStates.set(toTabId, { ...from })
}

/**
 * Drop every document and reading position whose tab no longer exists.
 *
 * Deferred by a turn, and that is not superstition: zustand notifies subscribers synchronously
 * inside `closeTab`, before React has committed the unmount, so sweeping immediately would destroy
 * the document out from under a pane that has not yet cancelled its render tasks.
 */
export function scheduleSweep(live: Set<string>): void {
  clearTimeout(sweepTimer)
  sweepTimer = setTimeout(() => { sweep(live) }, 0)
}

function sweep(live: Set<string>): void {
  for (const [path, entry] of entries) {
    for (const tabId of entry.tabs) {
      if (!live.has(tabId)) entry.tabs.delete(tabId)
    }
    if (entry.tabs.size === 0) {
      // Deleted before the (async) destroy starts, so reopening the same file immediately builds
      // a fresh entry instead of handing out a document that is being torn down.
      entries.delete(path)
      void destroy(entry)
    }
  }
  for (const tabId of viewStates.keys()) {
    if (!live.has(tabId)) viewStates.delete(tabId)
  }
}

/** Tear everything down. The plugin's own disposal path, so an unload leaks no workers. */
export async function closeAllDocuments(): Promise<void> {
  clearTimeout(sweepTimer)
  const all = [...entries.values()]
  entries.clear()
  viewStates.clear()
  liveViewers.clear()
  await Promise.all(all.map(destroy))
}

async function destroy(entry: Entry): Promise<void> {
  // The index goes now, not when the entry is finally collected: the awaits below can run for as
  // long as the slowest in-flight render, and an entry for a closed 500-page book has no business
  // pinning 3 MB of its text for that long. Dropping it here is also what guarantees a reopen of
  // the same path builds a fresh index — this entry is already off the map — rather than searching
  // a document whose worker is being terminated.
  entry.index = null
  entry.doc = null
  // Every viewer's teardown first: `destroy()` waits for in-flight renders before terminating the
  // worker, so cancelling them is what makes this prompt rather than merely correct.
  await Promise.allSettled(entry.teardowns)
  // Settled rather than awaited, because a document that REJECTED still started a worker.
  await Promise.allSettled([entry.promise])
  try {
    await entry.loadingTask?.destroy()
  } catch {
    // A worker that already went away — during app shutdown, say — is not news.
  }
}

async function open(path: string, entry: Entry): Promise<PDFDocumentProxy> {
  const [pdfjs, file] = await Promise.all([loadPdfjs(), pdf('pdf:read', { path })])

  // HAZARD: getDocument TRANSFERS this array into the worker and detaches it — verified,
  // byteLength 0 and buffer.detached true immediately afterwards. Nothing may retain or reuse
  // `file.bytes`; a reopen re-reads the file.
  const loadingTask = pdfjs.getDocument({ data: file.bytes, ...assetOptions() })
  entry.loadingTask = loadingTask
  const doc = await loadingTask.promise
  entry.doc = doc
  return doc
}
